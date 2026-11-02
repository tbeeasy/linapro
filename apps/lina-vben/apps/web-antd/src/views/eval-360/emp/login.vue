<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Result as AResult, Spin as ASpin } from 'ant-design-vue';

import {
  buildLarkOauthURL,
  readEmpOauthCallback,
  resolveEmpLarkAppId,
  resolveEmpPageURL,
  sanitizeEmpRedirect,
  stripEmpOauthSearch,
} from '#/api/emp/lark';
import { empLoginApi, toEmpProfile } from '#/api/emp/login';
import { $t } from '#/locales';
import { useEmpAuthStore } from '#/store/emp-auth';

const defaultRedirect = '/eval-360/emp/todo';

const route = useRoute();
const router = useRouter();
const empStore = useEmpAuthStore();

const status = ref<'error' | 'exchanging' | 'idle' | 'missing-appid'>('idle');
const errorMsg = ref('');

// 进入页面时一次性解析：飞书回调（code + state）、企业应用 id 与回跳目标。
// 企业应用 id：路由 query → 授权 state → store（卡片链接写入/上次登录）→ 构建期默认值。
// 回跳目标：路由 query → 授权 state → 待办页；只接受站内路径。
const callback = readEmpOauthCallback(route.query);
const queryLarkAppId =
  typeof route.query.larkAppId === 'string' ? route.query.larkAppId.trim() : '';
const larkAppId =
  queryLarkAppId || callback.state?.larkAppId || resolveEmpLarkAppId();
const redirect = sanitizeEmpRedirect(
  route.query.redirect ?? callback.state?.redirect,
  defaultRedirect,
);

async function exchange(code: string) {
  status.value = 'exchanging';
  try {
    const res = await empLoginApi({ larkAppId, code });
    empStore.setToken(res.token, toEmpProfile(res), larkAppId);
    await router.replace(redirect);
  } catch (error: any) {
    status.value = 'error';
    errorMsg.value = error?.message || $t('page.eval360Emp.login.exchanging');
    // code 一次性有效：失败后从地址栏移除，避免刷新重放。
    await router.replace({ path: route.path, query: { redirect } });
  }
}

function redirectToLark() {
  // redirect_uri 为不带参数的登录页地址；企业应用 id 与回跳目标经 state 往返。
  window.location.href = buildLarkOauthURL(
    resolveEmpPageURL(router, route.path),
    { larkAppId, loginPath: route.path, redirect },
  );
}

onMounted(() => {
  // 回调参数若位于页面真实 query（hash 路由下飞书插在 # 之前），读取后立即清理。
  stripEmpOauthSearch();
  if (!larkAppId) {
    status.value = 'missing-appid';
    return;
  }
  if (callback.code) {
    exchange(callback.code);
  } else {
    // 无 code → 跳飞书授权页换 code。
    redirectToLark();
  }
});
</script>

<template>
  <div class="flex-center h-screen">
    <ASpin
      v-if="status === 'exchanging'"
      size="large"
      :tip="$t('page.eval360Emp.login.exchanging')"
    />
    <AResult
      v-else-if="status === 'missing-appid'"
      status="warning"
      :title="$t('page.eval360Emp.login.appIdMissing')"
    >
      <template #extra>
        <span class="text-sm text-gray-400">
          {{ $t('page.eval360Emp.login.appIdMissingHint') }}
        </span>
      </template>
    </AResult>
    <AResult
      v-else-if="status === 'error'"
      status="error"
      :title="$t('page.eval360Emp.login.errorTitle')"
      :sub-title="errorMsg"
    >
      <template #extra>
        <a-button
          data-testid="eval360-emp-login-retry"
          type="primary"
          @click="redirectToLark"
        >
          {{ $t('page.eval360Emp.login.retry') }}
        </a-button>
      </template>
    </AResult>
    <ASpin v-else size="large" />
  </div>
</template>
