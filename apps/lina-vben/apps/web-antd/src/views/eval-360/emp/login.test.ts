// login.test.ts 覆盖员工登录页编排：非飞书环境提示、原地免登成功回跳、失败展示原因与「重试」重新取 code。
// 免登流程本身（SDK 加载、requestAuthCode、换票合并）由 #/api/emp/lark 的单测覆盖，这里只替身其出口。
import { flushPromises, mount } from '@vue/test-utils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import Login from './login.vue';

vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

const replace = vi.fn();
// 每个用例前整体替换 query 对象，useRoute 在组件 setup 时读取当前引用。
const route = { query: {} as Record<string, string> };
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ replace }),
}));

const empStore = { empToken: '', larkAppId: '' };
vi.mock('#/store/emp-auth', () => ({
  useEmpAuthStore: () => empStore,
}));

const larkState = { inLark: true };
const loginWithLark = vi.fn();
vi.mock('#/api/emp/lark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/emp/lark')>();
  return {
    ...actual,
    isLarkClient: () => larkState.inLark,
    loginWithLark: (appId: string) => loginWithLark(appId),
    resolveEmpLarkAppId: () => empStore.larkAppId,
  };
});

function mountLogin() {
  return mount(Login, {
    global: {
      stubs: {
        // a-button 是全局注册组件，单测里替换为原生按钮以便点击。
        'a-button': { template: '<button v-bind="$attrs"><slot /></button>' },
      },
    },
  });
}

describe('员工登录页编排', () => {
  beforeEach(() => {
    replace.mockReset();
    loginWithLark.mockReset();
    route.query = {};
    empStore.empToken = '';
    empStore.larkAppId = '';
    larkState.inLark = true;
  });

  it('非飞书环境：提示「请在飞书中打开」，不发起任何授权', async () => {
    larkState.inLark = false;
    route.query.larkAppId = 'cli_a';
    const wrapper = mountLogin();
    await flushPromises();

    expect(wrapper.find('[data-testid="emp-login-not-in-lark"]').exists()).toBe(
      true,
    );
    expect(wrapper.text()).toContain('page.empLayout.login.notInLark');
    expect(loginWithLark).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('飞书内：用路由 query 的企业应用 id 原地免登，成功后回到 redirect', async () => {
    route.query.larkAppId = 'cli_query';
    route.query.redirect = '/eval-360/emp/answer?questionnaireId=7';
    empStore.larkAppId = 'cli_store';
    loginWithLark.mockResolvedValue(undefined);
    mountLogin();
    await flushPromises();

    expect(loginWithLark).toHaveBeenCalledWith('cli_query');
    expect(replace).toHaveBeenCalledWith(
      '/eval-360/emp/answer?questionnaireId=7',
    );
  });

  it('飞书内无 query 时回退 store 中的企业应用 id；站外 redirect 回退待办页', async () => {
    empStore.larkAppId = 'cli_store';
    route.query.redirect = '//evil.example.com';
    loginWithLark.mockResolvedValue(undefined);
    mountLogin();
    await flushPromises();

    expect(loginWithLark).toHaveBeenCalledWith('cli_store');
    expect(replace).toHaveBeenCalledWith('/eval-360/emp/todo');
  });

  it('换票失败：展示后端原因；点「重试」重新走一次免登（重新取 code），成功后回跳', async () => {
    route.query.larkAppId = 'cli_a';
    loginWithLark
      .mockRejectedValueOnce(new Error('身份未登记'))
      .mockResolvedValueOnce(undefined);
    const wrapper = mountLogin();
    await flushPromises();

    expect(wrapper.text()).toContain('身份未登记');
    expect(replace).not.toHaveBeenCalled();

    await wrapper
      .find('[data-testid="eval360-emp-login-retry"]')
      .trigger('click');
    await flushPromises();

    expect(loginWithLark).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith('/eval-360/emp/todo');
  });

  it('飞书内缺企业应用 id：提示缺失，不发起免登', async () => {
    const wrapper = mountLogin();
    await flushPromises();

    expect(wrapper.text()).toContain('page.eval360Emp.login.appIdMissing');
    expect(loginWithLark).not.toHaveBeenCalled();
  });

  it('已有员工会话（如本地 emptoken 脚本写入）：直接回目标页，不发起免登', async () => {
    empStore.empToken = 'dev-token';
    route.query.redirect = '/eval-360/emp/dashboard';
    mountLogin();
    await flushPromises();

    expect(loginWithLark).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/eval-360/emp/dashboard');
  });
});
