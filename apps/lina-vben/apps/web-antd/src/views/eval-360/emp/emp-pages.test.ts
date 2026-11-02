import type { TodoItem } from '#/api/eval-360/emp-model';

import { flushPromises, mount } from '@vue/test-utils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import Dashboard from './dashboard.vue';
import Todo from './todo.vue';

vi.mock('#/locales', () => ({
  $t: (key: string, args?: Record<string, unknown>) =>
    args ? `${key}:${JSON.stringify(args)}` : key,
}));

// IconifyIcon 运行时会联网拉图标，单测里替换为空组件。
vi.mock('@vben/icons', () => ({ IconifyIcon: { render: () => null } }));

const push = vi.fn();
const routeQuery: Record<string, string> = {};
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => ({ push, replace: vi.fn() }),
}));

vi.mock('#/store/emp-auth', () => ({
  useEmpAuthStore: () => ({
    empProfile: {
      empId: 1,
      mokaEmployeeNo: 'GZ001',
      name: '王五',
      tenantId: 1,
    },
  }),
}));

const todoList: TodoItem[] = [];
vi.mock('#/api/eval-360/emp', () => ({
  evalEmpTodo: () => Promise.resolve({ list: todoList }),
}));

// 取第 i 个元素，不存在直接失败（替代非空断言）。
function nth<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`missing element ${i}`);
  return v;
}

function item(over: Partial<TodoItem>): TodoItem {
  return {
    completedCount: 0,
    derivedStatus: 'pending',
    endAt: Date.UTC(2026, 7, 31),
    evaluatees: [],
    projectId: 1,
    projectName: '2026Q4 项目',
    questionnaireId: 10,
    questionnaireTitle: '领导力',
    startAt: Date.UTC(2026, 7, 1),
    total: 0,
    ...over,
  };
}

beforeEach(() => {
  push.mockReset();
  routeQuery.projectId = '';
  routeQuery.tab = '';
  todoList.splice(
    0,
    todoList.length,
    item({
      completedCount: 1,
      evaluatees: [
        {
          department: '美术部',
          evaluateeName: '张琪',
          jobTitle: '主美',
          relationId: 101,
          roleName: '同事',
          submitted: false,
        },
        {
          department: '',
          evaluateeName: '李四',
          jobTitle: '',
          relationId: 102,
          roleName: '上级',
          submitted: true,
        },
      ],
      total: 2,
    }),
    item({
      completedCount: 0,
      derivedStatus: 'voided',
      evaluatees: [
        {
          department: '',
          evaluateeName: '赵六',
          jobTitle: '',
          relationId: 201,
          roleName: '同事',
          submitted: false,
        },
      ],
      projectId: 2,
      projectName: '已截止项目',
      questionnaireId: 20,
      total: 1,
    }),
  );
});

describe('我的评估', () => {
  it('同一问卷合并为一张卡片、姓名以「、」拼接，按待办/已完成分页签，截止未填标已逾期', async () => {
    // 问卷 10 再追加一名未提交者，验证同问卷多人合并。
    nth(todoList, 0).evaluatees.push({
      department: '',
      evaluateeName: '王五',
      jobTitle: '',
      relationId: 103,
      roleName: '同事',
      submitted: false,
    });
    const w = mount(Todo);
    await flushPromises();
    const cards = () =>
      w.findAll('[data-testid="eval360-emp-assessment-card"]');
    const names = (i: number) =>
      nth(cards(), i)
        .find('[data-testid="eval360-emp-assessment-evaluatees"]')
        .text();
    // 待办页签：问卷 10 的未提交者合并一卡（不展示职务/部门）+ 问卷 20 赵六（已逾期）。
    expect(cards()).toHaveLength(2);
    expect(names(0)).toBe('张琪、王五');
    expect(nth(cards(), 0).text()).not.toContain('主美');
    expect(nth(cards(), 0).text()).not.toContain('美术部');
    expect(names(1)).toBe('赵六');
    expect(
      nth(cards(), 1)
        .find('[data-testid="eval360-emp-assessment-overdue"]')
        .exists(),
    ).toBe(true);

    await w.find('[data-testid="eval360-emp-tab-done"]').trigger('click');
    expect(cards()).toHaveLength(1);
    expect(names(0)).toBe('李四');

    // 已完成卡片仅展示，点击不跳转。
    await nth(cards(), 0).trigger('click');
    expect(push).not.toHaveBeenCalled();

    // 待办卡片点击进入作答页。
    await w.find('[data-testid="eval360-emp-tab-pending"]').trigger('click');
    await nth(cards(), 0).trigger('click');
    expect(push).toHaveBeenCalledWith({
      path: '/eval-360/emp/answer',
      query: { questionnaireId: 10 },
    });
  });

  it('projectId 筛选只显示该项目', async () => {
    routeQuery.projectId = '2';
    const w = mount(Todo);
    await flushPromises();
    const cards = w.findAll('[data-testid="eval360-emp-assessment-card"]');
    expect(cards).toHaveLength(1);
    expect(nth(cards, 0).text()).toContain('赵六');
  });
});

describe('仪表盘', () => {
  it('按项目聚合统计与最近测评任务', async () => {
    const w = mount(Dashboard);
    await flushPromises();
    const stat = (key: string) =>
      w
        .find(
          `[data-testid="eval360-emp-stat-${key}"] [data-testid="eval360-emp-stat-value"]`,
        )
        .text();
    expect(stat('total')).toBe('2');
    expect(stat('inProgress')).toBe('1');
    expect(stat('completed')).toBe('0');
    expect(stat('evaluations')).toBe('3');

    // 角色分布必须带视角：角色名是「我以什么身份评价对方」，不能只渲染裸角色名。
    expect(w.text()).toContain('page.eval360Emp.dashboard.roles');
    expect(w.text()).toContain('page.eval360Emp.dashboard.rolesHint');
    const roles = w
      .findAll('[data-testid="eval360-emp-role-count"]')
      .map((r) => r.text());
    expect(roles).toEqual([
      'page.eval360Emp.dashboard.roleCount:{"role":"同事","count":2}',
      'page.eval360Emp.dashboard.roleCount:{"role":"上级","count":1}',
    ]);

    const rows = w.findAll('[data-testid="eval360-emp-recent-project"]');
    expect(rows).toHaveLength(2);
    // 进行中排在已截止之前。
    expect(nth(rows, 0).text()).toContain('2026Q4 项目');
    expect(nth(rows, 0).text()).toContain('2026-08-01 ~ 2026-08-31');
    await nth(rows, 0).trigger('click');
    expect(push).toHaveBeenCalledWith({
      name: 'Eval360EmpTodo',
      query: { projectId: 1 },
    });
  });
});
