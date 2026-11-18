// lark.test.ts 覆盖员工端飞书 JSAPI 免登：在容器内成功、非飞书环境、SDK 不可用（加载失败 / 加载后无
// h5sdk）后可重试、requestAuthCode 失败、换票失败后重试取新 code、并发调用只换一次票，以及错误页文案。
// 模块内有 SDK 加载与换票的单例状态，每个用例 resetModules 后重新导入，保证顺序无关。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const empLoginApi = vi.fn();
vi.mock('./login', () => ({
  empLoginApi: (input: unknown) => empLoginApi(input),
  toEmpProfile: (res: { empId: number; name: string }) => ({
    empId: res.empId,
    name: res.name,
    tenantId: 1,
  }),
}));

const empStore = {
  larkAppId: '',
  setToken: vi.fn(),
};
vi.mock('#/store/emp-auth', () => ({ useEmpAuthStore: () => empStore }));

vi.mock('#/locales', () => ({
  $t: (key: string, args?: Record<string, unknown>) =>
    args ? `${key}:${JSON.stringify(args)}` : key,
}));

const larkUA =
  'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Lark/7.30.8 LarkLocale/zh_CN WebApp';
const browserUA =
  'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';

type AuthCodeOptions = {
  appId: string;
  fail: (error: Record<string, unknown>) => void;
  success: (result: { code?: string }) => void;
};

const requestAuthCode = vi.fn<(options: AuthCodeOptions) => void>();
const win = window as unknown as Record<string, unknown>;

// 模拟飞书客户端加载 SDK：脚本插入后注入 h5sdk / tt 并触发 load；sdkPresent=false 时只触发 load
// （等价于 SDK 在非飞书 UA 下不定义全局对象），loadError=true 时触发 error。
function stubScriptLoading(opts: {
  loadError?: boolean;
  sdkPresent?: boolean;
}) {
  const injected: HTMLScriptElement[] = [];
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    const script = nodes[0] as HTMLScriptElement;
    injected.push(script);
    queueMicrotask(() => {
      if (opts.loadError) {
        script.dispatchEvent(new Event('error'));
        return;
      }
      if (opts.sdkPresent) {
        win.h5sdk = { ready: (cb: () => void) => cb() };
        win.tt = { requestAuthCode };
      }
      script.dispatchEvent(new Event('load'));
    });
  });
  return injected;
}

function setUserAgent(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
}

async function importLark() {
  vi.resetModules();
  return import('./lark');
}

function loginResult(token: string) {
  return {
    empId: 7,
    mokaEmployeeNo: 'GZ001',
    name: '张三',
    openId: 'ou',
    tenantId: 1,
    token,
  };
}

beforeEach(() => {
  empLoginApi.mockReset();
  requestAuthCode.mockReset();
  empStore.setToken.mockReset();
  empStore.larkAppId = '';
  delete win.h5sdk;
  delete win.tt;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loginWithLark', () => {
  it('在飞书容器内：加载官方 SDK、等 ready 后取 code 换票并写入员工 store', async () => {
    setUserAgent(larkUA);
    const injected = stubScriptLoading({ sdkPresent: true });
    requestAuthCode.mockImplementation((o) => o.success({ code: 'code-1' }));
    empLoginApi.mockResolvedValue(loginResult('jwt-1'));
    const lark = await importLark();

    await lark.loginWithLark('cli_a');

    expect(injected).toHaveLength(1);
    expect(injected[0]?.src).toBe(lark.larkH5SdkURL);
    expect(requestAuthCode).toHaveBeenCalledTimes(1);
    expect(requestAuthCode.mock.calls[0]?.[0].appId).toBe('cli_a');
    expect(empLoginApi).toHaveBeenCalledWith({
      code: 'code-1',
      larkAppId: 'cli_a',
    });
    expect(empStore.setToken).toHaveBeenCalledWith(
      'jwt-1',
      expect.objectContaining({ empId: 7 }),
      'cli_a',
    );
  });

  it('非飞书环境：直接判定 not-in-lark，不加载 SDK、不发起任何授权', async () => {
    setUserAgent(browserUA);
    const injected = stubScriptLoading({ sdkPresent: true });
    const lark = await importLark();

    await expect(lark.loginWithLark('cli_a')).rejects.toMatchObject({
      reason: 'not-in-lark',
    });
    expect(injected).toHaveLength(0);
    expect(requestAuthCode).not.toHaveBeenCalled();
    expect(empLoginApi).not.toHaveBeenCalled();
  });

  it('飞书 SDK 加载后不存在 h5sdk：判定 sdk-unavailable；重试会重新加载脚本', async () => {
    setUserAgent(larkUA);
    const injected = stubScriptLoading({ sdkPresent: false });
    const lark = await importLark();

    await expect(lark.loginWithLark('cli_a')).rejects.toMatchObject({
      reason: 'sdk-unavailable',
    });
    await expect(lark.loginWithLark('cli_a')).rejects.toMatchObject({
      reason: 'sdk-unavailable',
    });
    expect(injected).toHaveLength(2);
    expect(empLoginApi).not.toHaveBeenCalled();
  });

  it('飞书 SDK 脚本加载失败：判定 sdk-unavailable，不换票', async () => {
    setUserAgent(larkUA);
    stubScriptLoading({ loadError: true });
    const lark = await importLark();

    const error = await lark.loginWithLark('cli_a').catch((error_) => error_);
    expect(error).toBeInstanceOf(lark.EmpLarkAuthError);
    expect(error.reason).toBe('sdk-unavailable');
    expect(empLoginApi).not.toHaveBeenCalled();
  });

  it('requestAuthCode 失败：判定 auth-code-failed 并带上飞书错误码，不换票', async () => {
    setUserAgent(larkUA);
    stubScriptLoading({ sdkPresent: true });
    requestAuthCode.mockImplementation((o) =>
      o.fail({ errCode: 10_236, errMsg: 'url not in redirect list' }),
    );
    const lark = await importLark();

    const error = await lark.loginWithLark('cli_a').catch((error_) => error_);
    expect(error.reason).toBe('auth-code-failed');
    expect(error.detail).toContain('10236');
    expect(empLoginApi).not.toHaveBeenCalled();
  });

  it('换票失败后重试：重新取新 code，不复用已用过的 code', async () => {
    setUserAgent(larkUA);
    stubScriptLoading({ sdkPresent: true });
    let seq = 0;
    requestAuthCode.mockImplementation((o) =>
      o.success({ code: `code-${++seq}` }),
    );
    empLoginApi
      .mockRejectedValueOnce({ code: 1, message: '登录码无效' })
      .mockResolvedValueOnce(loginResult('jwt-2'));
    const lark = await importLark();

    await expect(lark.loginWithLark('cli_a')).rejects.toMatchObject({
      message: '登录码无效',
    });
    await lark.loginWithLark('cli_a');

    expect(requestAuthCode).toHaveBeenCalledTimes(2);
    expect(empLoginApi.mock.calls.map((c) => c[0].code)).toEqual([
      'code-1',
      'code-2',
    ]);
    expect(empStore.setToken).toHaveBeenCalledTimes(1);
    expect(empStore.setToken.mock.calls[0]?.[0]).toBe('jwt-2');
  });

  it('并发调用（多个请求同时 401）只取一次 code、只换一次票', async () => {
    setUserAgent(larkUA);
    stubScriptLoading({ sdkPresent: true });
    requestAuthCode.mockImplementation((o) =>
      setTimeout(() => o.success({ code: 'code-x' }), 5),
    );
    empLoginApi.mockResolvedValue(loginResult('jwt-x'));
    empStore.larkAppId = 'cli_b';
    const lark = await importLark();

    await Promise.all([
      lark.reissueEmpTokenInPlace(),
      lark.reissueEmpTokenInPlace(),
      lark.loginWithLark('cli_b'),
    ]);

    expect(requestAuthCode).toHaveBeenCalledTimes(1);
    expect(empLoginApi).toHaveBeenCalledTimes(1);
    expect(empLoginApi).toHaveBeenCalledWith({
      code: 'code-x',
      larkAppId: 'cli_b',
    });
  });

  it('缺少企业应用 id：判定 missing-app-id，不取 code', async () => {
    setUserAgent(larkUA);
    stubScriptLoading({ sdkPresent: true });
    const lark = await importLark();

    await expect(lark.reissueEmpTokenInPlace()).rejects.toMatchObject({
      reason: 'missing-app-id',
    });
    expect(requestAuthCode).not.toHaveBeenCalled();
  });
});

describe('isLarkClient', () => {
  it('按 UA 中的 Lark / Feishu 识别 PC 与移动端飞书', async () => {
    const { isLarkClient } = await importLark();
    expect(isLarkClient(larkUA)).toBe(true);
    expect(
      isLarkClient('Mozilla/5.0 (iPhone) AppleWebKit Mobile Feishu/7.30.0'),
    ).toBe(true);
    expect(isLarkClient(browserUA)).toBe(false);
  });
});

describe('describeEmpLoginError', () => {
  it('免登各环节给出平台级文案，换票失败沿用后端消息', async () => {
    const lark = await importLark();
    expect(
      lark.describeEmpLoginError(new lark.EmpLarkAuthError('sdk-unavailable')),
    ).toBe('page.empLayout.login.sdkUnavailable');
    expect(
      lark.describeEmpLoginError(
        new lark.EmpLarkAuthError('auth-code-failed', '10236 bad url'),
      ),
    ).toBe('page.empLayout.login.authCodeFailed:{"detail":"10236 bad url"}');
    expect(lark.describeEmpLoginError({ message: '身份未登记' })).toBe(
      '身份未登记',
    );
    expect(lark.describeEmpLoginError(undefined)).toBe(
      'page.empLayout.login.failed',
    );
  });
});

describe('sanitizeEmpRedirect', () => {
  it('只接受站内路径', async () => {
    const { sanitizeEmpRedirect } = await importLark();
    expect(sanitizeEmpRedirect('/eval-360/emp/answer?id=1', '/x')).toBe(
      '/eval-360/emp/answer?id=1',
    );
    expect(sanitizeEmpRedirect('//evil.com', '/x')).toBe('/x');
    expect(sanitizeEmpRedirect('https://evil.com', '/x')).toBe('/x');
  });
});
