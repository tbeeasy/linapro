// request.ts 员工端独立请求客户端。
// 与 admin requestClient 区别：挂员工 JWT（非 admin token）、无刷新令牌、
// 401 触发飞书免登原地重换并重放原请求（ADR-0002）。eval-360 员工接口经 pluginApiPath 拼全路径。
import type { RequestClientOptions } from '@vben/request';

import { preferences } from '@vben/preferences';
import {
  defaultResponseInterceptor,
  errorMessageResponseInterceptor,
  RequestClient,
} from '@vben/request';

import { message } from 'ant-design-vue';

import { resolveRuntimeErrorMessage } from '#/api/request';
import { useEmpAuthStore } from '#/store/emp-auth';

const defaultEmpBaseURL = '/api/v1';

// 员工端接口均为插件接口，在调用处用 pluginApiPath 拼成绝对路径：认证类（emp/login、emp/me）
// 属 linapro-employee-core，eval-360 员工接口属 linapro-eval-360（'eval/emp/...'）；
// axios 对带 origin 的绝对 URL 原样使用。
function createEmpRequestClient(
  baseURL: string,
  options?: RequestClientOptions,
) {
  const client = new RequestClient({ ...options, baseURL });

  // 请求拦截：挂员工 JWT + Accept-Language；记下本次所用 token，401 时据此判断是否已被并发请求换过票。
  client.addRequestInterceptor({
    fulfilled: async (config) => {
      const empStore = useEmpAuthStore();
      (config as any).__empToken = empStore.empToken;
      config.headers.Authorization = empStore.empToken
        ? `Bearer ${empStore.empToken}`
        : null;
      config.headers['Accept-Language'] =
        typeof document === 'undefined'
          ? preferences.app.locale
          : document.documentElement.lang || preferences.app.locale;
      return config;
    },
  });

  // 复用 {code,data,message} 解包，successCode 0。
  client.addResponseInterceptor(
    defaultResponseInterceptor({
      codeField: 'code',
      dataField: 'data',
      successCode: 0,
    }),
  );

  // 401 → 原地飞书免登重换后重放原请求（ADR-0002：2h JWT、无刷新令牌）。
  // - 并发：重换经 loginWithLark 合并为一次；请求所用 token 已不是 store 当前 token，说明别的请求
  //   已换过票，直接用新票重放、不再取 code；
  // - 重放请求带 __isEmpRetry，再次 401 不再重换，防止死循环；
  // - 重换失败（不在飞书内、取 code 失败、换票失败）清除旧票并回到登录页，由其展示原因与「重试」。
  client.addResponseInterceptor({
    rejected: async (error: any) => {
      const { config, response } = error || {};
      if (response?.status !== 401 || !config || config.__isEmpRetry) {
        throw error;
      }
      // 换票接口本身的 401（身份未登记）不得再触发重换，直接抛给登录页展示失败原因。
      if (String(config.url ?? '').endsWith('/emp/login')) {
        throw error;
      }
      // 动态引入：lark.ts 依赖 login.ts → 本模块，静态引入会形成循环依赖。
      const { redirectToEmpLogin, reissueEmpTokenInPlace } =
        await import('./lark');
      const empStore = useEmpAuthStore();
      if (!empStore.empToken || empStore.empToken === config.__empToken) {
        try {
          await reissueEmpTokenInPlace();
        } catch {
          empStore.clearToken();
          await redirectToEmpLogin();
          throw error;
        }
      }
      config.__isEmpRetry = true;
      return client.request(config.url, { ...config });
    },
  });

  // 错误提示：复用 host 的 messageKey 解析，员工端用 message.error。
  client.addResponseInterceptor(
    errorMessageResponseInterceptor((msg: string, error: any) => {
      const responseData = (error?.response?.data ?? {}) as any;
      const errorMessage = resolveRuntimeErrorMessage(responseData);
      message.error(errorMessage || msg);
    }),
  );

  return client;
}

export const empRequestClient = createEmpRequestClient(defaultEmpBaseURL, {
  paramsSerializer: 'brackets',
  responseReturn: 'data',
});

// 兼容旧引用名。
export const empClient = empRequestClient;
