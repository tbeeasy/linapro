// request.test.ts 覆盖员工端请求客户端的 401 原地重登：走真实 empRequestClient 与 lark.ts，
// 只替身 axios 适配器（后端）与飞书 window.h5sdk / tt（客户端）。
//   - 多个请求同时 401：只取一次 code、只换一次票，全部用新票重放并拿到结果，不整页跳转；
//   - 重放后仍 401：不再重换（防死循环）；
//   - 重登失败：清除旧票、回到登录页（带回跳目标），由登录页展示原因与重试。
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEmpAuthStore } from '#/store/emp-auth';

import { empRequestClient } from './request';

vi.mock('#/api/request', () => ({
  pluginApiPath: (pluginId: string, path: string) =>
    `http://api.test/x/${pluginId}/api/v1/${path}`,
  resolveRuntimeErrorMessage: () => '',
}));
vi.mock('#/locales', () => ({ $t: (key: string) => key }));
vi.mock('@vben/preferences', () => ({
  preferences: { app: { locale: 'zh-CN' } },
}));
vi.mock('ant-design-vue', () => ({ message: { error: vi.fn() } }));

const routerReplace = vi.fn();
vi.mock('#/router', () => ({
  router: {
    currentRoute: {
      value: {
        fullPath: '/eval-360/emp/answer?questionnaireId=9',
        meta: { empLoginPath: '/eval-360/emp/login' },
        path: '/eval-360/emp/answer',
      },
    },
    replace: (to: unknown) => routerReplace(to),
  },
}));

type AuthCodeOptions = {
  appId: string;
  fail: (error: Record<string, unknown>) => void;
  success: (result: { code?: string }) => void;
};
const requestAuthCode = vi.fn<(options: AuthCodeOptions) => void>();
const win = window as unknown as Record<string, unknown>;

// 后端替身：/emp/login 签发 issuedToken；业务接口只认 validToken，否则 401。
let loginCalls: Array<{ code: string; larkAppId: string }> = [];
let businessCalls: Array<{ auth: string; url: string }> = [];
let issuedToken = 'jwt-new';
let validToken = 'jwt-new';

// axios 适配器替身：成功时返回响应对象；状态码 ≥ 400 时按 axios 约定拒绝（错误带 config 与 response）。
function respond(config: any, status: number, data: unknown) {
  const response = { config, data, headers: {}, status, statusText: '' };
  if (status >= 400) {
    return Promise.reject(
      Object.assign(new Error(`status ${status}`), {
        config,
        isAxiosError: true,
        response,
      }),
    );
  }
  return Promise.resolve(response);
}

const adapter = (config: any) => {
  const url = String(config.url);
  if (url.endsWith('/emp/login')) {
    const body = JSON.parse(String(config.data));
    loginCalls.push(body);
    return respond(config, 200, {
      code: 0,
      data: { empId: 1, name: '张三', tenantId: 1, token: issuedToken },
      message: 'ok',
    });
  }
  const auth = String(config.headers?.Authorization ?? '');
  businessCalls.push({ auth, url });
  if (auth !== `Bearer ${validToken}`) {
    return respond(config, 401, { code: 401, message: 'unauthorized' });
  }
  return respond(config, 200, { code: 0, data: { url }, message: 'ok' });
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  loginCalls = [];
  businessCalls = [];
  issuedToken = 'jwt-new';
  validToken = 'jwt-new';
  routerReplace.mockReset();
  requestAuthCode.mockReset();
  empRequestClient.instance.defaults.adapter = adapter;
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 AppleWebKit Lark/7.30.8 WebApp',
  );
  win.h5sdk = { ready: (cb: () => void) => cb() };
  win.tt = { requestAuthCode };
  useEmpAuthStore().setToken('jwt-expired', undefined, 'cli_a');
});

afterEach(() => {
  vi.restoreAllMocks();
  delete win.h5sdk;
  delete win.tt;
});

describe('empRequestClient 401 原地重登', () => {
  it('多个请求同时 401：只换一次票，全部用新票重放并返回结果', async () => {
    requestAuthCode.mockImplementation((o) =>
      setTimeout(() => o.success({ code: 'code-1' }), 5),
    );

    const results = await Promise.all([
      empRequestClient.get<{ url: string }>('http://api.test/a'),
      empRequestClient.get<{ url: string }>('http://api.test/b'),
      empRequestClient.get<{ url: string }>('http://api.test/c'),
    ]);

    expect(results.map((r) => r.url)).toEqual([
      'http://api.test/a',
      'http://api.test/b',
      'http://api.test/c',
    ]);
    expect(requestAuthCode).toHaveBeenCalledTimes(1);
    expect(loginCalls).toEqual([{ code: 'code-1', larkAppId: 'cli_a' }]);
    expect(useEmpAuthStore().empToken).toBe('jwt-new');
    // 每个请求恰好两次：旧票 401 一次、新票重放一次。
    expect(
      businessCalls.filter((c) => c.auth === 'Bearer jwt-new'),
    ).toHaveLength(3);
    expect(businessCalls).toHaveLength(6);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('换票后到达的旧票 401 直接用新票重放，不再取 code', async () => {
    requestAuthCode.mockImplementation((o) => o.success({ code: 'code-1' }));
    await empRequestClient.get('http://api.test/a');
    expect(loginCalls).toHaveLength(1);

    // 模拟一个更早发出、携带旧票的请求在换票完成后才返回 401。
    const late = await empRequestClient.request<{ url: string }>(
      'http://api.test/late',
      { headers: {}, method: 'GET' },
    );
    expect(late.url).toBe('http://api.test/late');
    expect(loginCalls).toHaveLength(1);
    expect(requestAuthCode).toHaveBeenCalledTimes(1);
  });

  it('重放后仍 401：不再重换，错误抛给调用方', async () => {
    requestAuthCode.mockImplementation((o) => o.success({ code: 'code-1' }));
    validToken = 'never-valid';

    await expect(
      empRequestClient.get('http://api.test/a'),
    ).rejects.toBeTruthy();
    expect(loginCalls).toHaveLength(1);
    expect(requestAuthCode).toHaveBeenCalledTimes(1);
  });

  it('重登失败（取 code 失败）：清除旧票并回到登录页，带原目标', async () => {
    requestAuthCode.mockImplementation((o) => o.fail({ errCode: 10_236 }));

    await expect(
      empRequestClient.get('http://api.test/a'),
    ).rejects.toBeTruthy();

    expect(loginCalls).toHaveLength(0);
    expect(useEmpAuthStore().empToken).toBe('');
    expect(routerReplace).toHaveBeenCalledWith({
      path: '/eval-360/emp/login',
      query: { redirect: '/eval-360/emp/answer?questionnaireId=9' },
    });
  });
});
