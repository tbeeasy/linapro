<script lang="ts" setup>
// result.vue 员工端提交结果页：显示本次批量提交的人数与提交时间。
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Button as AButton, Result as AResult } from 'ant-design-vue';

import { $t } from '#/locales';

const route = useRoute();
const router = useRouter();

const submittedAt = computed(() => {
  const v = route.query.submittedAt as string | undefined;
  if (!v) return '';
  // submittedAt 走 query 传参会被序列化为字符串，此处按 Unix 毫秒时间戳解析。
  const ms = Number(v);
  if (Number.isNaN(ms)) return v;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
});

const idempotent = computed(() => route.query.idempotent === '1');

// 本次（或幂等命中的）提交人数。
const count = computed(() => Number(route.query.count || 0));

function back() {
  void router.replace('/eval-360/emp/todo');
}
</script>

<template>
  <div
    class="mx-auto flex w-full max-w-[720px] flex-col items-center p-6"
    data-testid="eval360-emp-result"
  >
    <AResult
      status="success"
      :title="$t('page.eval360Emp.result.title')"
      :sub-title="
        idempotent
          ? $t('page.eval360Emp.result.idempotent', { count })
          : $t('page.eval360Emp.result.subtitle', { count, time: submittedAt })
      "
    >
      <template #extra>
        <AButton type="primary" @click="back">
          {{ $t('page.eval360Emp.result.backToTodo') }}
        </AButton>
      </template>
    </AResult>
  </div>
</template>
