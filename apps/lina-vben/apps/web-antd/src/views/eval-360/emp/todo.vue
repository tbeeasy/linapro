<script lang="ts" setup>
// todo.vue 员工端「我的评估」：按问卷列出评估任务，分「待办评估 / 已完成评估」两个页签。
// 数据来自按问卷聚合的待办接口（每份问卷附名下被评估人明细）：同一问卷在每个页签合并为一张卡片，
// 卡片标题为该页签下被评估人姓名以「、」拼接（待办=未提交的人，已完成=已提交的人）；
// 待办卡片点击进入该问卷的作答页（名下全部被评估人批量作答）；已完成卡片仅展示，不可点击查看详情。
// 路由 query：projectId 按项目筛选（仪表盘「最近测评任务」跳转携带）；tab=done 默认打开已完成页签。
import type { DerivedStatus, TodoItem } from '#/api/eval-360/emp-model';

import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { IconifyIcon } from '@vben/icons';

import { Empty as AEmpty, Spin as ASpin, Tag as ATag } from 'ant-design-vue';
import dayjs from 'dayjs';

import { evalEmpTodo } from '#/api/eval-360/emp';
import { $t } from '#/locales';

type TabKey = 'done' | 'pending';

interface AssessmentCard {
  questionnaireId: number;
  projectName: string;
  questionnaireTitle: string;
  endAt: null | number;
  evaluateeNames: string;
  submitted: boolean;
  questionnaireStatus: DerivedStatus;
}

const route = useRoute();
const router = useRouter();

const list = ref<TodoItem[]>([]);
const loading = ref(false);
const activeTab = ref<TabKey>(route.query.tab === 'done' ? 'done' : 'pending');

async function refresh() {
  loading.value = true;
  try {
    const res = await evalEmpTodo();
    list.value = res.list ?? [];
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

const projectFilter = computed(() => {
  const v = Number(route.query.projectId);
  return Number.isFinite(v) && v > 0 ? v : 0;
});

const filterProjectName = computed(
  () =>
    list.value.find((it) => it.projectId === projectFilter.value)
      ?.projectName ?? '',
);

const filteredList = computed(() =>
  projectFilter.value
    ? list.value.filter((it) => it.projectId === projectFilter.value)
    : list.value,
);

// 一份问卷在某页签下的卡片：只取该页签状态的被评估人，无人则不出卡片（顺序沿用接口）。
function buildCards(submitted: boolean): AssessmentCard[] {
  const out: AssessmentCard[] = [];
  for (const it of filteredList.value) {
    const names = (it.evaluatees ?? [])
      .filter((e) => e.submitted === submitted)
      .map((e) => e.evaluateeName);
    if (names.length === 0) continue;
    out.push({
      questionnaireId: it.questionnaireId,
      projectName: it.projectName,
      questionnaireTitle: it.questionnaireTitle,
      endAt: it.endAt,
      evaluateeNames: names.join('、'),
      submitted,
      questionnaireStatus: it.derivedStatus,
    });
  }
  return out;
}

const pendingCards = computed(() => buildCards(false));
const doneCards = computed(() => buildCards(true));
const visibleCards = computed(() =>
  activeTab.value === 'done' ? doneCards.value : pendingCards.value,
);

const tabs = computed(() => [
  {
    key: 'pending' as const,
    icon: 'lucide:clock',
    label: $t('page.eval360Emp.todo.tabPending'),
    count: pendingCards.value.length,
  },
  {
    key: 'done' as const,
    icon: 'lucide:circle-check',
    label: $t('page.eval360Emp.todo.tabDone'),
    count: doneCards.value.length,
  },
]);

// 未提交且项目已截止（问卷派生为已作废）= 已逾期。
function isOverdue(c: AssessmentCard) {
  return !c.submitted && c.questionnaireStatus === 'voided';
}

function accentClass(c: AssessmentCard) {
  if (c.submitted) return 'border-l-emerald-500';
  return 'border-l-orange-500';
}

function fmtDate(at: null | number) {
  return at ? dayjs(at).format('YYYY-MM-DD') : '';
}

function clearProjectFilter() {
  void router.replace({ query: { ...route.query, projectId: undefined } });
}

function open(c: AssessmentCard) {
  if (c.submitted) return;
  void router.push({
    path: '/eval-360/emp/answer',
    query: { questionnaireId: c.questionnaireId },
  });
}
</script>

<template>
  <div class="flex flex-col gap-4 p-6" data-testid="eval360-emp-todo">
    <div>
      <div class="text-xl font-semibold">
        {{ $t('page.eval360Emp.todo.title') }}
      </div>
      <div class="mt-1 text-sm text-gray-500">
        {{ $t('page.eval360Emp.todo.subtitle') }}
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <div class="inline-flex gap-1 rounded-lg bg-gray-200/60 p-1">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors"
          :class="
            activeTab === t.key
              ? 'bg-white font-medium shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          "
          :data-testid="`eval360-emp-tab-${t.key}`"
          @click="activeTab = t.key"
        >
          <IconifyIcon :icon="t.icon" class="size-4" />
          <span>{{ t.label }}</span>
          <span v-if="t.count > 0" class="text-xs text-gray-400">
            {{ t.count }}
          </span>
        </button>
      </div>
      <ATag
        v-if="projectFilter && filterProjectName"
        closable
        color="blue"
        data-testid="eval360-emp-project-filter"
        @close="clearProjectFilter"
      >
        {{ filterProjectName }}
      </ATag>
    </div>

    <ASpin v-if="loading" class="self-center py-10" />
    <AEmpty
      v-else-if="visibleCards.length === 0"
      class="py-10"
      :description="
        activeTab === 'done'
          ? $t('page.eval360Emp.todo.emptyDone')
          : $t('page.eval360Emp.todo.emptyPending')
      "
    />
    <div v-else class="flex flex-col gap-3">
      <div
        v-for="c in visibleCards"
        :key="c.questionnaireId"
        class="flex items-center gap-4 rounded-lg border border-l-4 bg-white px-6 py-4"
        :class="[
          accentClass(c),
          c.submitted ? '' : 'cursor-pointer transition-shadow hover:shadow-md',
        ]"
        data-testid="eval360-emp-assessment-card"
        :data-questionnaire-id="c.questionnaireId"
        @click="open(c)"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <span class="text-base font-medium break-all">
            {{ c.projectName }} · {{ c.questionnaireTitle }}
          </span>
          <div
            class="text-sm text-gray-600"
            data-testid="eval360-emp-assessment-evaluatees"
          >
            {{ c.evaluateeNames }}
          </div>
          <div class="flex items-center gap-2 text-sm text-gray-500">
            <span v-if="c.endAt" class="inline-flex items-center gap-1">
              <IconifyIcon icon="lucide:calendar" class="size-4" />
              {{ $t('page.eval360Emp.todo.deadline') }}：{{ fmtDate(c.endAt) }}
            </span>
            <span
              v-if="isOverdue(c)"
              class="text-orange-500"
              data-testid="eval360-emp-assessment-overdue"
            >
              {{ $t('page.eval360Emp.todo.overdue') }}
            </span>
            <span v-else-if="c.submitted" class="text-emerald-600">
              {{ $t('page.eval360Emp.todo.submitted') }}
            </span>
          </div>
        </div>
        <IconifyIcon
          v-if="!c.submitted"
          icon="lucide:chevron-right"
          class="size-5 shrink-0 text-gray-400"
        />
      </div>
    </div>
  </div>
</template>
