// emp-auth.ts 员工端认证 store。
// 员工 JWT 与 admin token 生命周期隔离：员工拿的是 empcap 短时 JWT（2h、无刷新），
// 不进 useAccessStore 的 SecureLS（避免 admin 登出 resetAllStores 误清员工会话）。
// token 与 larkAppId 持久到 localStorage，其余 profile 内存驻留、按需 GET /emp/me 回填。
import { ref } from 'vue';

import { defineStore } from 'pinia';

export interface EmpProfile {
  empId: number;
  tenantId: number;
  openId?: string;
  name: string;
  mokaEmployeeNo?: string;
}

const tokenKey = 'linapro:emp-auth-token';
const larkAppIdKey = 'linapro:emp-lark-app-id';

function loadToken(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(tokenKey) || '';
}

function loadLarkAppId(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(larkAppIdKey) || '';
}

export const useEmpAuthStore = defineStore('emp-auth', () => {
  const empToken = ref<string>(loadToken());
  const larkAppId = ref<string>(loadLarkAppId());
  const empProfile = ref<EmpProfile | null>(null);

  function setToken(token: string, profile?: EmpProfile, appId?: string) {
    empToken.value = token;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(tokenKey, token);
    }
    if (profile) {
      empProfile.value = profile;
    }
    if (appId) {
      larkAppId.value = appId;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(larkAppIdKey, appId);
      }
    }
  }

  function setProfile(profile: EmpProfile | null) {
    empProfile.value = profile;
  }

  // 记录飞书企业应用 id（员工卡片链接携带的 larkAppId），供登录换票与 401 重登选用对应应用。
  function setLarkAppId(appId: string) {
    larkAppId.value = appId;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(larkAppIdKey, appId);
    }
  }

  function clearToken() {
    empToken.value = '';
    empProfile.value = null;
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(tokenKey);
    }
  }

  return {
    empToken,
    larkAppId,
    empProfile,
    setToken,
    setProfile,
    setLarkAppId,
    clearToken,
  };
});
