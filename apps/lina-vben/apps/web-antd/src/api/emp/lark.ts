// lark.ts 员工端飞书网页授权：授权 URL 构造、回调参数解析与 401 静默重登。
//
// - redirect_uri 固定为员工登录页地址且不带 query（hash 路由形如 https://host/admin/#/eval-360/emp/login），
//   便于飞书「重定向 URL」白名单精确匹配；企业应用 id、登录页路径与回跳目标经 OAuth state 往返。
// - hash 路由下飞书回跳时 code/state 可能被拼进 hash 路由 query，也可能被插入页面真实 query（# 之前），
//   readEmpOauthCallback 两处都读；真实 query 中的回调参数由 stripEmpOauthSearch 清理，防刷新重放。
// - PC 网页授权无法原地静默，故 silentlyReissueEmpToken 直接整页跳飞书授权页。
import type { Router } from 'vue-router';

import { useEmpAuthStore } from '#/store/emp-auth';

// state 标记：区分员工端授权回调与其它携带 code/state 的地址。
const empOauthStateMarker = 'lina-emp';

// 员工端授权往返上下文（编码进 OAuth state）。
export interface EmpOauthState {
  larkAppId: string;
  loginPath: string;
  redirect: string;
}

// 飞书授权回调参数：code 为空表示当前不是授权回调。
export interface EmpOauthCallback {
  code: string;
  state: EmpOauthState | null;
}

// 构造飞书网页授权 URL。redirectUri 为登录页完整地址（见 resolveEmpPageURL）。
export function buildLarkOauthURL(redirectUri: string, state: EmpOauthState) {
  const params = new URLSearchParams({
    app_id: state.larkAppId,
    redirect_uri: redirectUri,
    state: JSON.stringify({
      a: state.larkAppId,
      k: empOauthStateMarker,
      l: state.loginPath,
      r: state.redirect,
    }),
  });
  return `https://open.feishu.cn/open-apis/authen/v1/index?${params.toString()}`;
}

// 解析 OAuth state；非员工端标记或登录页路径非法时返回 null。
export function parseEmpOauthState(raw: unknown): EmpOauthState | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.k !== empOauthStateMarker) return null;
    const loginPath = String(value.l ?? '');
    if (!isInternalPath(loginPath)) return null;
    return {
      larkAppId: String(value.a ?? ''),
      loginPath,
      redirect: String(value.r ?? ''),
    };
  } catch {
    return null;
  }
}

// 读取页面真实 query（# 之前）中的员工端授权回调参数。
function readLocationCallback(): EmpOauthCallback | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code')?.trim() || '';
  const state = parseEmpOauthState(params.get('state'));
  if (!code || !state) return null;
  return { code, state };
}

// 读取授权回调参数：优先路由 query，其次页面真实 query。
export function readEmpOauthCallback(
  query: Record<string, unknown>,
): EmpOauthCallback {
  const code = typeof query.code === 'string' ? query.code.trim() : '';
  if (code) {
    return { code, state: parseEmpOauthState(query.state) };
  }
  return readLocationCallback() ?? { code: '', state: null };
}

// 页面真实 query 中待处理的员工端授权回调所属登录页；无回调时返回空串。
// 供路由守卫把落在非登录页（回跳地址 # 段被剥离）的回调接回登录页换票。
export function pendingEmpOauthLoginPath(): string {
  return readLocationCallback()?.state?.loginPath || '';
}

// 清理页面真实 query 中的授权回调参数（保留 path 与 hash），防止刷新后重放已用过的 code。
export function stripEmpOauthSearch() {
  if (typeof window === 'undefined' || !readLocationCallback()) return;
  const { hash, origin, pathname } = window.location;
  window.history.replaceState(
    window.history.state,
    '',
    `${origin}${pathname}${hash}`,
  );
}

// 校验并返回站内回跳路径；非站内路径（含协议相对地址）回退 fallback。
export function sanitizeEmpRedirect(raw: unknown, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return isInternalPath(value) ? value : fallback;
}

// 把员工端路由路径解析为完整页面地址（自动适配 history / hash 路由与部署 base）。
// hash 路由的 href 只有「#/path」、不含部署 base，须拼在当前页面路径（即 base，如 /admin/）之后，
// 并丢弃页面真实 query；history 路由的 href 已含 base，按站点根解析。
export function resolveEmpPageURL(router: Router, path: string): string {
  const href = router.resolve(path).href;
  if (href.startsWith('#')) {
    const { origin, pathname } = window.location;
    return `${origin}${pathname}${href}`;
  }
  return new URL(href, window.location.origin).href;
}

// 解析当前可用的飞书企业应用 id：store（卡片链接写入或上次登录）优先，回退构建期默认值。
export function resolveEmpLarkAppId(): string {
  const empStore = useEmpAuthStore();
  return (
    empStore.larkAppId ||
    (import.meta.env.VITE_EVAL360_LARK_APP_ID as string | undefined)?.trim() ||
    ''
  );
}

// 触发飞书免登重换。返回永不 resolve 的 Promise，中断调用链（页面将整体跳转）。
// 动态引入路由实例，避免 api 层与路由模块的静态循环依赖。
export async function silentlyReissueEmpToken(): Promise<never> {
  const { router } = await import('#/router');
  const route = router.currentRoute.value;
  const loginPath = route.meta.empLoginPath;
  const larkAppId = resolveEmpLarkAppId();
  if (loginPath && larkAppId) {
    window.location.href = buildLarkOauthURL(
      resolveEmpPageURL(router, loginPath),
      { larkAppId, loginPath, redirect: route.fullPath },
    );
  } else if (loginPath) {
    // 无企业应用 id 无法发起授权，回登录页由其提示缺失原因。
    await router.replace({
      path: loginPath,
      query: { redirect: route.fullPath },
    });
  }
  return new Promise(() => {});
}

// 站内路径：以单个 / 开头（排除 //host 协议相对地址）。
function isInternalPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}
