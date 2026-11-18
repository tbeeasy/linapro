// emp-guard.test.ts 覆盖员工端守卫 setupEmpGuard：无员工 JWT 时转登录页（带 redirect）、卡片 larkAppId
// 持久化、有 JWT 放行，以及删除 OAuth 后页面真实 query 中残留的 code/state 不再劫持导航。
import type { RouteRecordRaw } from 'vue-router';

import { createMemoryHistory, createRouter } from 'vue-router';

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEmpAuthStore } from '#/store/emp-auth';

import { setupEmpGuard } from './guard';

// guard.ts 同时包含 admin 守卫，这里只测员工端守卫，admin 侧依赖全部替身。
vi.mock('#/router/routes', () => ({ accessRoutes: [], coreRouteNames: [] }));
vi.mock('#/store', async () => {
  const { useEmpAuthStore } = await import('#/store/emp-auth');
  return { useAuthStore: vi.fn(), useEmpAuthStore, useTenantStore: vi.fn() };
});
vi.mock('@vben/stores', () => ({
  useAccessStore: vi.fn(),
  useUserStore: vi.fn(),
}));
vi.mock('@vben/preferences', () => ({ preferences: { app: {} } }));
vi.mock('./access', () => ({ generateAccess: vi.fn() }));
vi.mock('./tenant-access', () => ({ canAccessTenantLocation: vi.fn() }));

const blank = { render: () => null };
const loginPath = '/eval-360/emp/login';

const routes: RouteRecordRaw[] = [
  {
    children: [
      {
        component: blank,
        meta: { empPublic: true, title: 'login' },
        path: 'login',
      },
      { component: blank, path: 'todo' },
    ],
    component: blank,
    meta: { empLoginPath: loginPath, empRegion: true, title: 'emp' },
    path: '/eval-360/emp',
  },
  { component: blank, path: '/other' },
];

function newRouter() {
  const router = createRouter({ history: createMemoryHistory(), routes });
  setupEmpGuard(router);
  return router;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('setupEmpGuard', () => {
  it('无员工 JWT：转登录页并带原始目标；卡片 larkAppId 持久化供免登选用企业应用', async () => {
    const router = newRouter();

    await router.push('/eval-360/emp/todo?larkAppId=cli_card');

    const route = router.currentRoute.value;
    expect(route.path).toBe(loginPath);
    expect(route.query.redirect).toBe('/eval-360/emp/todo?larkAppId=cli_card');
    expect(localStorage.getItem('linapro:emp-lark-app-id')).toBe('cli_card');
  });

  it('有员工 JWT：放行员工页；登录页（empPublic）始终放行', async () => {
    useEmpAuthStore().setToken('jwt');
    const router = newRouter();

    await router.push('/eval-360/emp/todo');
    expect(router.currentRoute.value.path).toBe('/eval-360/emp/todo');

    await router.push(loginPath);
    expect(router.currentRoute.value.path).toBe(loginPath);
  });

  it('页面真实 query 残留旧 OAuth 回调参数时不再劫持导航（OAuth 已删除）', async () => {
    const state = JSON.stringify({ k: 'lina-emp', l: loginPath, r: '/x' });
    window.history.replaceState(
      null,
      '',
      `/?code=used&state=${encodeURIComponent(state)}`,
    );
    const router = newRouter();

    await router.push('/other');

    expect(router.currentRoute.value.path).toBe('/other');
    window.history.replaceState(null, '', '/');
  });
});
