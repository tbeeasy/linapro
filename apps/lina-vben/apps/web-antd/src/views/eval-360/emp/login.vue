<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Result as AResult, Spin as ASpin } from 'ant-design-vue';

import {
  describeEmpLoginError,
  EmpLarkAuthError,
  isLarkClient,
  loginWithLark,
  resolveEmpLarkAppId,
  sanitizeEmpRedirect,
} from '#/api/emp/lark';
import { $t } from '#/locales';
import { useEmpAuthStore } from '#/store/emp-auth';

// 登录页只做编排：免登流程（取 code、换票、写 store）与错误文案都在平台级 #/api/emp/lark。
const defaultRedirect = '/eval-360/emp/todo';

const route = useRoute();
const router = useRouter();
const empStore = useEmpAuthStore();

const status = ref<
  'authenticating' | 'error' | 'missing-appid' | 'not-in-lark'
>('authenticating');
const errorMsg = ref('');

// 企业应用 id：路由 query → store（卡片链接写入/上次登录）→ 构建期默认值。
// 回跳目标：路由 query → 待办页；只接受站内路径。
const queryLarkAppId =
  typeof route.query.larkAppId === 'string' ? route.query.larkAppId.trim() : '';
const larkAppId = queryLarkAppId || resolveEmpLarkAppId();
const redirect = sanitizeEmpRedirect(route.query.redirect, defaultRedirect);

// 在飞书内原地免登，成功后回到目标页；失败展示原因，「重试」会重新取 code（不复用旧 code）。
async function signIn() {
  status.value = 'authenticating';
  try {
    await loginWithLark(larkAppId);
    await router.replace(redirect);
  } catch (error) {
    if (error instanceof EmpLarkAuthError && error.reason === 'not-in-lark') {
      status.value = 'not-in-lark';
      return;
    }
    status.value = 'error';
    errorMsg.value = describeEmpLoginError(error);
  }
}

onMounted(() => {
  // 已有员工会话（如本地开发用 emptoken 脚本写入 localStorage）直接回目标页；过期时由 401 原地重登兜底。
  if (empStore.empToken) {
    router.replace(redirect);
    return;
  }
  if (!isLarkClient()) {
    status.value = 'not-in-lark';
    return;
  }
  if (!larkAppId) {
    status.value = 'missing-appid';
    return;
  }
  signIn();
});
</script>

<template>
  <div class="flex-center h-screen">
    <ASpin
      v-if="status === 'authenticating'"
      size="large"
      :tip="$t('page.eval360Emp.login.exchanging')"
    />
    <AResult
      v-else-if="status === 'not-in-lark'"
      data-testid="emp-login-not-in-lark"
      status="info"
      :title="$t('page.empLayout.login.notInLark')"
      :sub-title="$t('page.empLayout.login.notInLarkHint')"
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
      v-else
      status="error"
      :title="$t('page.eval360Emp.login.errorTitle')"
      :sub-title="errorMsg"
    >
      <template #extra>
        <a-button
          data-testid="eval360-emp-login-retry"
          type="primary"
          @click="signIn"
        >
          {{ $t('page.eval360Emp.login.retry') }}
        </a-button>
      </template>
    </AResult>
  </div>
</template>
