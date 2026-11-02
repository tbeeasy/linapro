<script lang="ts" setup>
// dashboard.vue 员工端「仪表盘」：当前员工参与的测评项目全局概览与快捷入口。
// 数据全部由「我的待办」接口派生（按项目聚合问卷待办），不另设接口：
//   - 测评任务 = 参与的项目；进行中 / 已完成按项目下名下评价是否全部提交、项目是否截止派生；
//   - 评价人次 = 名下评价关系总数；角色分布按关系角色计数；
//   - 最近测评任务按项目列出进度，点击进入「我的评估」并按项目筛选。
import type { TodoItem } from '#/api/eval-360/emp-model';

import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { IconifyIcon } from '@vben/icons';

import {
  Button as AButton,
  Empty as AEmpty,
  Progress as AProgress,
  Spin as ASpin,
  Tag as ATag,
} from 'ant-design-vue';
import dayjs from 'dayjs';

import { evalEmpTodo } from '#/api/eval-360/emp';
import { $t } from '#/locales';

type ProjectStatus = 'closed' | 'completed' | 'inProgress';

interface ProjectSummary {
  projectId: number;
  projectName: string;
  startAt: null | number;
  endAt: null | number;
  total: number;
  completed: number;
  status: ProjectStatus;
}

const router = useRouter();

const list = ref<TodoItem[]>([]);
const loading = ref(false);

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

// 按项目聚合：全部提交 = 已完成；否则任一问卷已作废（项目截止）= 已截止；否则进行中。
const projects = computed<ProjectSummary[]>(() => {
  const byId = new Map<number, ProjectSummary>();
  for (const it of list.value) {
    let p = byId.get(it.projectId);
    if (!p) {
      p = {
        projectId: it.projectId,
        projectName: it.projectName,
        startAt: it.startAt,
        endAt: it.endAt,
        total: 0,
        completed: 0,
        status: 'inProgress',
      };
      byId.set(it.projectId, p);
    }
    p.total += it.total;
    p.completed += it.completedCount;
    if (it.derivedStatus === 'voided') p.status = 'closed';
  }
  const out = [...byId.values()];
  for (const p of out) {
    if (p.total > 0 && p.completed >= p.total) p.status = 'completed';
  }
  const rank: Record<ProjectStatus, number> = {
    inProgress: 0,
    completed: 1,
    closed: 2,
  };
  return out.toSorted(
    (a, b) => rank[a.status] - rank[b.status] || b.projectId - a.projectId,
  );
});

const stats = computed(() => {
  let relations = 0;
  let submitted = 0;
  for (const p of projects.value) {
    relations += p.total;
    submitted += p.completed;
  }
  return [
    {
      key: 'total',
      color: '#8b5cf6',
      icon: 'lucide:clipboard-list',
      value: projects.value.length,
      hint: $t('page.eval360Emp.dashboard.stats.totalHint'),
    },
    {
      key: 'inProgress',
      color: '#3b82f6',
      icon: 'lucide:clock',
      value: projects.value.filter((p) => p.status === 'inProgress').length,
      hint: $t('page.eval360Emp.dashboard.stats.inProgressHint'),
    },
    {
      key: 'completed',
      color: '#10b981',
      icon: 'lucide:circle-check',
      value: projects.value.filter((p) => p.status === 'completed').length,
      hint: $t('page.eval360Emp.dashboard.stats.completedHint'),
    },
    {
      key: 'evaluations',
      color: '#f59e0b',
      icon: 'lucide:users',
      value: relations,
      hint: $t('page.eval360Emp.dashboard.stats.evaluationsHint', {
        done: submitted,
      }),
    },
  ];
});

// 角色分布：名下评价关系按角色计数（角色由导入关系生成，无内置角色）。
const roleCounts = computed(() => {
  const m = new Map<string, number>();
  for (const it of list.value) {
    for (const e of it.evaluatees ?? []) {
      const name = e.roleName || '-';
      m.set(name, (m.get(name) ?? 0) + 1);
    }
  }
  return [...m.entries()].map(([name, count]) => ({ name, count }));
});

// 最近测评任务：最多展示 5 个项目，其余经「查看全部」进入我的评估。
const recentProjects = computed(() => projects.value.slice(0, 5));

function percent(p: ProjectSummary) {
  return p.total > 0 ? Math.round((p.completed / p.total) * 100) : 0;
}

function fmtDate(at: null | number) {
  return at ? dayjs(at).format('YYYY-MM-DD') : '';
}

function dateRange(p: ProjectSummary) {
  const s = fmtDate(p.startAt);
  const e = fmtDate(p.endAt);
  if (!s && !e) return '';
  return `${s || '-'} ~ ${e || '-'}`;
}

const statusColor: Record<ProjectStatus, string> = {
  inProgress: 'success',
  completed: 'processing',
  closed: 'default',
};

function openAssessments(projectId?: number) {
  void router.push({
    name: 'Eval360EmpTodo',
    query: projectId ? { projectId } : undefined,
  });
}
</script>

<template>
  <div class="flex flex-col gap-4 p-6" data-testid="eval360-emp-dashboard">
    <div>
      <div class="text-xl font-semibold">
        {{ $t('page.eval360Emp.dashboard.title') }}
      </div>
      <div class="mt-1 text-sm text-gray-500">
        {{ $t('page.eval360Emp.dashboard.subtitle') }}
      </div>
    </div>

    <ASpin :spinning="loading">
      <div class="flex flex-col gap-4">
        <!-- 统计卡 -->
        <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div
            v-for="s in stats"
            :key="s.key"
            class="rounded-lg border-t-4 bg-white px-5 py-4"
            :style="{ borderTopColor: s.color }"
            :data-testid="`eval360-emp-stat-${s.key}`"
          >
            <div class="text-sm text-gray-600">
              {{ $t(`page.eval360Emp.dashboard.stats.${s.key}`) }}
            </div>
            <div class="mt-2 flex items-center justify-between">
              <span
                class="text-3xl font-semibold"
                data-testid="eval360-emp-stat-value"
              >
                {{ s.value }}
              </span>
              <IconifyIcon :icon="s.icon" class="size-5 text-gray-500" />
            </div>
            <div class="mt-2 text-xs text-gray-500">{{ s.hint }}</div>
          </div>
        </div>

        <!-- 评价角色分布：角色名是「我以什么身份评价对方」，不是「谁来评价我」，故显式标注视角 -->
        <div v-if="roleCounts.length > 0" class="rounded-lg bg-white">
          <div class="flex flex-wrap items-baseline gap-x-2 border-b px-5 py-3">
            <span
              class="border-l-4 border-emerald-400 pl-2 text-base font-semibold"
            >
              {{ $t('page.eval360Emp.dashboard.roles') }}
            </span>
            <span class="text-xs text-gray-500">
              {{ $t('page.eval360Emp.dashboard.rolesHint') }}
            </span>
          </div>
          <div class="grid grid-cols-2 gap-4 p-5 lg:grid-cols-4">
            <div
              v-for="r in roleCounts"
              :key="r.name"
              class="flex flex-col items-center gap-2 rounded-lg bg-gray-50 py-5"
              data-testid="eval360-emp-role-count"
            >
              <span class="flex h-7 items-end gap-1">
                <span class="h-6 w-3 rounded-sm bg-emerald-400"></span>
                <span class="h-7 w-4 rounded-sm bg-emerald-500"></span>
                <span class="h-4 w-3 rounded-sm bg-emerald-300"></span>
              </span>
              <span class="text-sm text-gray-600">
                {{
                  $t('page.eval360Emp.dashboard.roleCount', {
                    role: r.name,
                    count: r.count,
                  })
                }}
              </span>
            </div>
          </div>
        </div>

        <!-- 最近测评任务 -->
        <div class="rounded-lg bg-white">
          <div class="flex items-center justify-between border-b px-5 py-3">
            <span
              class="border-l-4 border-amber-400 pl-2 text-base font-semibold"
            >
              {{ $t('page.eval360Emp.dashboard.recent') }}
            </span>
            <AButton size="small" @click="openAssessments()">
              {{ $t('page.eval360Emp.dashboard.viewAll') }}
              <IconifyIcon icon="lucide:chevron-right" class="ml-1 size-4" />
            </AButton>
          </div>
          <AEmpty
            v-if="recentProjects.length === 0"
            class="py-6"
            :description="$t('page.eval360Emp.dashboard.recentEmpty')"
          />
          <div
            v-for="p in recentProjects"
            :key="p.projectId"
            class="flex cursor-pointer flex-wrap items-center gap-x-6 gap-y-2 border-b px-5 py-4 last:border-b-0 hover:bg-gray-50"
            data-testid="eval360-emp-recent-project"
            :data-project-id="p.projectId"
            @click="openAssessments(p.projectId)"
          >
            <div class="flex min-w-[200px] flex-1 flex-col">
              <span class="font-medium">{{ p.projectName }}</span>
              <span class="text-xs text-gray-500">{{ dateRange(p) }}</span>
            </div>
            <ATag :color="statusColor[p.status]" class="mr-0!">
              {{ $t(`page.eval360Emp.dashboard.status.${p.status}`) }}
            </ATag>
            <div class="flex w-[300px] max-w-full items-center gap-3">
              <AProgress
                class="m-0! flex-1"
                :percent="percent(p)"
                :show-info="false"
                size="small"
              />
              <span class="w-10 text-right text-xs text-gray-500">
                {{ percent(p) }}%
              </span>
            </div>
            <span
              class="text-sm text-gray-600"
              data-testid="eval360-emp-recent-progress"
            >
              {{
                $t('page.eval360Emp.dashboard.recordProgress', {
                  done: p.completed,
                  total: p.total,
                })
              }}
            </span>
            <IconifyIcon
              icon="lucide:chevron-right"
              class="size-4 text-gray-400"
            />
          </div>
        </div>
      </div>
    </ASpin>
  </div>
</template>
