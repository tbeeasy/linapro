// request.ts 员工端独立请求客户端。
// 与 admin requestClient 区别：挂员工 JWT（非 admin token）、无刷新令牌、
// 401 触发飞书免登重换（ADR-0002）。eval-360 员工接口经 pluginApiPath 拼全路径。
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

import { silentlyReissueEmpToken } from './lark';

const defaultEmpBaseURL = '/api/v1';

// 员工端接口均为插件接口，在调用处用 pluginApiPath 拼成绝对路径：认证类（emp/login、emp/me）
// 属 linapro-employee-core，eval-360 员工接口属 linapro-eval-360（'eval/emp/...'）；
// axios 对带 origin 的绝对 URL 原样使用。
function createEmpRequestClient(
  baseURL: string,
  options?: RequestClientOptions,
) {
  const client = new RequestClient({ ...options, baseURL });

  // 请求拦截：挂员工 JWT + Accept-Language。
  client.addRequestInterceptor({
    fulfilled: async (config) => {
      const empStore = useEmpAuthStore();
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

  // 401 → 静默飞书免登重换（ADR-0002：2h JWT、无刷新令牌）。
  // PC 网页授权无法原地静默，故整页跳飞书 oauth；返回页面后由 login.vue 完成换票。
  client.addResponseInterceptor({
    rejected: async (error: any) => {
      const { config, response } = error || {};
      if (response?.status !== 401 || config?.__isEmpRetry) {
        throw error;
      }
      // 换票接口本身的 401（身份未登记）不得再触发重换，否则会在飞书授权页与登录页间无限往返；
      // 直接抛给登录页展示失败原因。
      if (String(config?.url ?? '').endsWith('/emp/login')) {
        throw error;
      }
      const empStore = useEmpAuthStore();
      empStore.clearToken();
      // 触发飞书免登；该 Promise 永不 resolve（页面将整体跳转）。
      await silentlyReissueEmpToken();
      throw error;
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
