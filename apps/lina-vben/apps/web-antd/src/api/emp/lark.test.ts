import type { RouterHistory } from 'vue-router';

import {
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildLarkOauthURL, resolveEmpPageURL } from './lark';

vi.mock('#/store/emp-auth', () => ({
  useEmpAuthStore: () => ({ larkAppId: '' }),
}));

const loginPath = '/eval-360/emp/login';

function setPageURL(url: string) {
  (
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM.setURL(url);
}

function routerWith(history: RouterHistory) {
  return createRouter({
    history,
    routes: [{ component: { template: '<div />' }, path: loginPath }],
  });
}

describe('resolveEmpPageURL', () => {
  afterEach(() => {
    setPageURL('http://localhost:3000/');
  });

  // 生产 hash 路由：router.resolve().href 只有「#/path」，不含部署 base；
  // 回调地址必须保留工作台 base（如 /admin/），否则落到站点根、不在飞书重定向白名单内（20029）。
  it('keeps the workspace base under hash history', () => {
    setPageURL(
      'https://emp.example.com/admin/#/eval-360/emp/todo?larkAppId=cli_a',
    );
    const router = routerWith(createWebHashHistory('/admin/'));
    expect(resolveEmpPageURL(router, loginPath)).toBe(
      'https://emp.example.com/admin/#/eval-360/emp/login',
    );
  });

  // hash 路由下页面真实 query（如未清理的授权回调参数）不得带进回调地址。
  it('drops the page search under hash history', () => {
    setPageURL(
      'https://emp.example.com/admin/?code=used&state=x#/eval-360/emp/login',
    );
    const router = routerWith(createWebHashHistory('/admin/'));
    expect(resolveEmpPageURL(router, loginPath)).toBe(
      'https://emp.example.com/admin/#/eval-360/emp/login',
    );
  });

  it('keeps the root base under hash history', () => {
    setPageURL('https://emp.example.com/#/eval-360/emp/todo');
    const router = routerWith(createWebHashHistory('/'));
    expect(resolveEmpPageURL(router, loginPath)).toBe(
      'https://emp.example.com/#/eval-360/emp/login',
    );
  });

  // history 路由：href 已含部署 base，按站点根解析。
  it('resolves against the origin under web history', () => {
    setPageURL(
      'https://emp.example.com/admin/eval-360/emp/todo?larkAppId=cli_a',
    );
    const router = routerWith(createWebHistory('/admin/'));
    expect(resolveEmpPageURL(router, loginPath)).toBe(
      'https://emp.example.com/admin/eval-360/emp/login',
    );
  });
});

describe('buildFeishuOauthURL', () => {
  it('encodes the hash redirect uri and round-trips the state', () => {
    const url = new URL(
      buildLarkOauthURL('https://emp.example.com/admin/#/eval-360/emp/login', {
        larkAppId: 'cli_a',
        loginPath,
        redirect: '/eval-360/emp/todo?larkAppId=cli_a',
      }),
    );
    expect(url.searchParams.get('app_id')).toBe('cli_a');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://emp.example.com/admin/#/eval-360/emp/login',
    );
    expect(JSON.parse(url.searchParams.get('state') ?? '')).toMatchObject({
      a: 'cli_a',
      l: loginPath,
      r: '/eval-360/emp/todo?larkAppId=cli_a',
    });
  });
});
