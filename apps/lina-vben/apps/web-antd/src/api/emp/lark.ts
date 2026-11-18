// lark.ts 员工端飞书免登（平台级，eval-360、考勤等员工端共用，不绑定任何业务路径）。
//
// 流程：判断在飞书客户端内 → 加载飞书 H5 JS SDK 并等待 h5sdk.ready → tt.requestAuthCode({ appId })
// 原地取免登 code → POST /emp/login { larkAppId, code } 换员工 JWT → 写入 useEmpAuthStore。全程不整页跳转。
//
// 依据飞书开放平台文档（来源见 openspec/changes/linapro-employee-core/design.md D27）：
// - SDK 只能经官方 CDN 脚本引入，JSAPI 须在 window.h5sdk.ready 回调触发后调用；
// - requestAuthCode 属免鉴权 JSAPI，无需先调 h5sdk.config 签名；success 返回 { code }，
//   code 5 分钟有效且只能用一次——换票失败后不得重试同一个 code，必须重新取；
// - SDK 只在飞书客户端内定义 window.h5sdk（其内部按 UA 中的 Lark/Feishu 判定），故 UA 不含
//   这两个关键字时直接判定「不在飞书内」、不加载第三方脚本；UA 命中但加载后仍无 h5sdk 视为 SDK 不可用。
// - 调用页地址（不含 ? 与 # 之后部分）须登记在该应用「重定向 URL」中，否则 fail 返回 errCode 10236。
import { $t } from '#/locales';
import { useEmpAuthStore } from '#/store/emp-auth';

import { empLoginApi, toEmpProfile } from './login';

// 飞书 H5 JS SDK 官方 CDN 地址（文档标注的当前最新版本）。
export const larkH5SdkURL =
  'https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.48.js';

// SDK 加载 + ready 的最长等待时间：超时视为 SDK 不可用，交给错误页「重试」。
const larkSdkReadyTimeoutMs = 15_000;

// 员工端飞书免登失败原因（错误页按原因展示文案）。
export type EmpLarkAuthErrorReason =
  | 'auth-code-failed' // tt.requestAuthCode 返回 fail
  | 'missing-app-id' // 无飞书企业应用 id，无法取 code
  | 'not-in-lark' // 不在飞书客户端内
  | 'sdk-unavailable'; // SDK 脚本加载失败、超时或加载后无 h5sdk

// 员工端飞书免登错误：reason 区分失败环节，detail 为飞书返回的错误码等诊断信息。
export class EmpLarkAuthError extends Error {
  readonly detail: string;
  readonly reason: EmpLarkAuthErrorReason;

  constructor(reason: EmpLarkAuthErrorReason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'EmpLarkAuthError';
    this.reason = reason;
    this.detail = detail;
  }
}

// requestAuthCode 的 fail 回调结构：errCode 与 errno 均可能出现，均表示错误码。
interface LarkJsapiFailure {
  errCode?: number | string;
  errMsg?: string;
  errno?: number | string;
  errString?: string;
}

// 本模块用到的飞书 H5 SDK 全局对象最小投影（SDK 注入 window.h5sdk 与 window.tt）。
interface LarkH5Window {
  h5sdk?: { ready: (callback: () => void) => void };
  tt?: {
    requestAuthCode: (options: {
      appId: string;
      fail: (error: LarkJsapiFailure) => void;
      success: (result: { code?: string }) => void;
    }) => void;
  };
}

function larkWindow(): LarkH5Window {
  return window as unknown as LarkH5Window;
}

// 当前是否运行在飞书客户端内（PC 与移动端 UA 均含 Lark 或 Feishu）。
export function isLarkClient(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  return /lark|feishu/i.test(userAgent);
}

let sdkReady: null | Promise<void> = null;

// 加载飞书 H5 SDK 并等待 ready。成功结果在页面生命周期内复用；失败会清空缓存，「重试」时重新加载。
export function loadLarkH5Sdk(): Promise<void> {
  if (!sdkReady) {
    sdkReady = waitLarkSdkReady().catch((error) => {
      sdkReady = null;
      throw error;
    });
  }
  return sdkReady;
}

function waitLarkSdkReady(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new EmpLarkAuthError('sdk-unavailable', 'timeout')),
      larkSdkReadyTimeoutMs,
    );
    const done = (error?: EmpLarkAuthError) => {
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onLoaded = () => {
      const sdk = larkWindow().h5sdk;
      if (!sdk || !larkWindow().tt) {
        done(new EmpLarkAuthError('sdk-unavailable', 'h5sdk missing'));
        return;
      }
      sdk.ready(() => done());
    };
    // 已有 SDK（页面内重复调用、或宿主已引入）直接等 ready，不重复插入脚本。
    if (larkWindow().h5sdk) {
      onLoaded();
      return;
    }
    const script = document.createElement('script');
    script.async = true;
    script.src = larkH5SdkURL;
    script.addEventListener('load', onLoaded);
    script.addEventListener('error', () => {
      script.remove();
      done(new EmpLarkAuthError('sdk-unavailable', 'script load failed'));
    });
    document.head.append(script);
  });
}

// 调 tt.requestAuthCode 取一次性免登 code（每次调用都取新 code）。
export async function requestLarkAuthCode(appId: string): Promise<string> {
  await loadLarkH5Sdk();
  const tt = larkWindow().tt;
  if (!tt) {
    throw new EmpLarkAuthError('sdk-unavailable', 'tt missing');
  }
  return new Promise<string>((resolve, reject) => {
    tt.requestAuthCode({
      appId,
      fail: (error) =>
        reject(new EmpLarkAuthError('auth-code-failed', formatFailure(error))),
      success: (result) => {
        if (result?.code) {
          resolve(result.code);
        } else {
          reject(new EmpLarkAuthError('auth-code-failed', 'empty code'));
        }
      },
    });
  });
}

function formatFailure(error: LarkJsapiFailure | undefined): string {
  const code = error?.errCode ?? error?.errno ?? '';
  const message = error?.errMsg ?? error?.errString ?? '';
  return [code, message].filter((part) => part !== '').join(' ');
}

let loginInFlight: null | Promise<void> = null;

// 飞书免登换票：取新 code → /emp/login → 写入员工 store。并发调用合并为同一次换票
// （多个请求同时 401 只换一次票）；结束后（无论成败）再调用会重新取 code，不复用已用过的 code。
export function loginWithLark(larkAppId: string): Promise<void> {
  if (!loginInFlight) {
    loginInFlight = exchangeLarkCode(larkAppId).finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

async function exchangeLarkCode(larkAppId: string): Promise<void> {
  if (!isLarkClient()) {
    throw new EmpLarkAuthError('not-in-lark');
  }
  if (!larkAppId) {
    throw new EmpLarkAuthError('missing-app-id');
  }
  const code = await requestLarkAuthCode(larkAppId);
  const res = await empLoginApi({ code, larkAppId });
  useEmpAuthStore().setToken(res.token, toEmpProfile(res), larkAppId);
}

// 员工 JWT 过期（401）后原地重登：用当前企业应用 id 重新取 code、换票。失败抛出，由调用方决定去向。
export function reissueEmpTokenInPlace(): Promise<void> {
  return loginWithLark(resolveEmpLarkAppId());
}

// 原地重登失败后回到当前员工端区域的登录页（带回跳目标），由登录页展示原因与「重试」。
// 动态引入路由实例，避免 api 层与路由模块的静态循环依赖。
export async function redirectToEmpLogin(): Promise<void> {
  const { router } = await import('#/router');
  const route = router.currentRoute.value;
  const loginPath = route.meta.empLoginPath;
  if (!loginPath || route.path === loginPath) {
    return;
  }
  await router.replace({
    path: loginPath,
    query: { redirect: route.fullPath },
  });
}

// 错误页文案：飞书免登环节给出对应原因，换票接口失败沿用后端返回的消息。
export function describeEmpLoginError(error: unknown): string {
  if (error instanceof EmpLarkAuthError) {
    switch (error.reason) {
      case 'auth-code-failed': {
        return $t('page.empLayout.login.authCodeFailed', {
          detail: error.detail || '-',
        });
      }
      case 'missing-app-id': {
        return $t('page.empLayout.login.appIdMissing');
      }
      case 'not-in-lark': {
        return $t('page.empLayout.login.notInLarkHint');
      }
      case 'sdk-unavailable': {
        return $t('page.empLayout.login.sdkUnavailable');
      }
    }
  }
  const message = (error as undefined | { message?: unknown })?.message;
  return typeof message === 'string' && message
    ? message
    : $t('page.empLayout.login.failed');
}

// 校验并返回站内回跳路径；非站内路径（含协议相对地址）回退 fallback。
export function sanitizeEmpRedirect(raw: unknown, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return isInternalPath(value) ? value : fallback;
}

// 解析当前可用的飞书企业应用 id：store（卡片链接写入或上次登录）优先，回退构建期默认值。
// 应用 id 决定换票使用哪个飞书企业的凭据（多企业）。
export function resolveEmpLarkAppId(): string {
  const empStore = useEmpAuthStore();
  return (
    empStore.larkAppId ||
    (import.meta.env.VITE_EVAL360_LARK_APP_ID as string | undefined)?.trim() ||
    ''
  );
}

// 站内路径：以单个 / 开头（排除 //host 协议相对地址）。
function isInternalPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}
