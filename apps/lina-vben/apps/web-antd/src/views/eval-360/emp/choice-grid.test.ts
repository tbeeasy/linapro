import type { EvaluateeRow, QuestionNode } from '#/api/eval-360/emp-model';

import { flushPromises, mount } from '@vue/test-utils';

import { afterEach, describe, expect, it, vi } from 'vitest';

import ChoiceGrid from './choice-grid.vue';

vi.mock('#/locales', () => ({ $t: (key: string) => key }));

// 图标组件在测试环境会尝试联网拉取图标数据，替换为空壳。
vi.mock('@vben/icons', () => ({ IconifyIcon: { template: '<i />' } }));

const rows: EvaluateeRow[] = [
  { evaluateeName: '张三', relationId: 1, roleName: '同事', submitted: false },
];

function matrixQuestion(scores: string[]): QuestionNode {
  return {
    description: '',
    dimensionId: 1,
    id: 10,
    matrixColumns: scores.map((score, i) => ({
      id: i + 1,
      label: `列${i + 1}`,
      score,
      sort: i,
      allowComment: 0,
      commentRequired: 0,
      commentPlaceholder: '',
      commentPresets: [],
      commentAllowCustom: 0,
    })),
    options: [],
    required: 1,
    rowRelationIds: [1],
    sort: 0,
    title: '矩阵题',
    type: 'matrix',
  };
}

// 带评语配置的矩阵题：首列允许评语，可按需覆盖必填/提示语/预设/自定义。
function commentMatrixQuestion(
  overrides: Partial<QuestionNode['matrixColumns'][number]> = {},
): QuestionNode {
  const q = matrixQuestion(['5']);
  q.matrixColumns[0] = {
    id: 1,
    label: '优秀',
    score: '5',
    sort: 0,
    allowComment: 1,
    commentRequired: 0,
    commentPlaceholder: '请举例说明',
    commentPresets: [],
    commentAllowCustom: 0,
    ...overrides,
  };
  return q;
}

describe('choice-grid.vue 矩阵分值行', () => {
  // 0 分（含留空保存后的 0 与后端 NUMERIC 返回的 "0.00"）不显示，非 0 分照常显示。
  it('hides zero scores and keeps non-zero scores', () => {
    const wrapper = mount(ChoiceGrid, {
      global: { mocks: { $t: (key: string) => key } },
      props: {
        disabled: false,
        question: matrixQuestion(['5', '4.5', '0', '0.00']),
        rows,
        value: {},
      },
    });

    const scores = wrapper
      .findAll('[data-testid="eval360-emp-matrix-score"]')
      .map((th) => th.text());
    // 列数不变：0 分列仍占位（单元格留空），保证与评价项文案行对齐。
    expect(scores).toEqual(['5', '4.5', '', '']);
  });
});

describe('choice-grid.vue 矩阵评价项评语', () => {
  // 浮层经 teleport 渲染到 body：每例结束清空，避免上例残留的浮层干扰查询。
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const inBody = (testId: string) =>
    document.body.querySelector(`[data-testid="${testId}"]`);

  // 允许评语的列：选中前格内无评语入口；选中后单选钮旁出现评语图标，评语框以浮层自动弹出，
  // 且不再内嵌在单元格里（格内不出现输入框）。
  it('pops the comment box beside the radio after selecting an allowing column', async () => {
    const wrapper = mount(ChoiceGrid, {
      attachTo: document.body,
      global: { mocks: { $t: (key: string) => key } },
      props: {
        disabled: false,
        question: commentMatrixQuestion(),
        rows,
        value: {},
      },
    });
    expect(
      wrapper
        .find('[data-testid="eval360-emp-matrix-comment-toggle"]')
        .exists(),
    ).toBe(false);

    // 点选该列：组件上抛 select，父级回写答案后浮层自动弹出。
    await wrapper
      .find('[data-testid="eval360-emp-matrix-cell"] input')
      .trigger('change');
    expect(wrapper.emitted('select')).toEqual([[1, 1]]);
    await wrapper.setProps({ value: { 1: { optionId: 1, text: '' } } });
    await flushPromises();

    expect(
      wrapper
        .find('[data-testid="eval360-emp-matrix-comment-toggle"]')
        .exists(),
    ).toBe(true);
    // 输入框在浮层里（body 下），不在单元格内。
    expect(
      wrapper.find('td [data-testid="eval360-emp-matrix-comment"]').exists(),
    ).toBe(false);
    const box = inBody('eval360-emp-matrix-comment') as HTMLTextAreaElement;
    expect(box).not.toBeNull();
    expect(box.getAttribute('placeholder')).toBe('请举例说明');
    wrapper.unmount();
  });

  // 只是回显已选列（未经点选）时浮层不自动弹出，点评语图标才打开。
  it('opens the popover from the comment icon', async () => {
    const wrapper = mount(ChoiceGrid, {
      attachTo: document.body,
      global: { mocks: { $t: (key: string) => key } },
      props: {
        disabled: false,
        question: commentMatrixQuestion(),
        rows,
        value: { 1: { optionId: 1, text: '' } },
      },
    });
    expect(inBody('eval360-emp-matrix-comment')).toBeNull();
    await wrapper
      .find('[data-testid="eval360-emp-matrix-comment-toggle"]')
      .trigger('click');
    await flushPromises();
    expect(inBody('eval360-emp-matrix-comment')).not.toBeNull();
    wrapper.unmount();
  });

  // 未开启「允许自定义」且有预设：单行下拉，只能选预设，不出现文本框。
  it('renders a single-line select when presets exist and custom input is disabled', async () => {
    const wrapper = mount(ChoiceGrid, {
      attachTo: document.body,
      global: { mocks: { $t: (key: string) => key } },
      props: {
        disabled: false,
        question: commentMatrixQuestion({
          commentPresets: ['沟通清晰', '逻辑严谨'],
          commentAllowCustom: 0,
        }),
        rows,
        value: { 1: { optionId: 1, text: '' } },
      },
    });
    await wrapper
      .find('[data-testid="eval360-emp-matrix-comment-toggle"]')
      .trigger('click');
    await flushPromises();
    const select = inBody('eval360-emp-matrix-comment-select');
    expect(select).not.toBeNull();
    expect(select?.querySelector('textarea') ?? null).toBeNull();
    expect(inBody('eval360-emp-matrix-comment')).toBeNull();
    wrapper.unmount();
  });

  // 有预设且允许自定义：可选预设也可输入，输入控件为文本框（默认一行、自动增高）。
  it('renders an autocomplete textarea when presets exist and custom input is allowed', async () => {
    const wrapper = mount(ChoiceGrid, {
      attachTo: document.body,
      global: { mocks: { $t: (key: string) => key } },
      props: {
        disabled: false,
        question: commentMatrixQuestion({
          commentPresets: ['沟通清晰'],
          commentAllowCustom: 1,
        }),
        rows,
        value: { 1: { optionId: 1, text: '' } },
      },
    });
    await wrapper
      .find('[data-testid="eval360-emp-matrix-comment-toggle"]')
      .trigger('click');
    await flushPromises();
    const auto = inBody('eval360-emp-matrix-comment-autocomplete');
    expect(auto).not.toBeNull();
    const textarea = auto?.querySelector('textarea') ?? null;
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute('placeholder')).toBe('请举例说明');
    wrapper.unmount();
  });

  // 回显：已填评语时图标标蓝；打开浮层后文本框带出原文，已提交行禁用。
  it('echoes the saved comment and disables the box for submitted rows', async () => {
    const submittedRow: EvaluateeRow = {
      evaluateeName: '张三',
      relationId: 1,
      roleName: '同事',
      submitted: true,
    };
    const wrapper = mount(ChoiceGrid, {
      attachTo: document.body,
      global: { mocks: { $t: (key: string) => key } },
      props: {
        disabled: false,
        question: commentMatrixQuestion(),
        rows: [submittedRow],
        value: { 1: { optionId: 1, text: '沟通清晰，逻辑严密' } },
      },
    });
    const toggle = wrapper.find(
      '[data-testid="eval360-emp-matrix-comment-toggle"]',
    );
    expect(toggle.classes()).toContain('text-primary');
    await toggle.trigger('click');
    await flushPromises();
    const box = inBody('eval360-emp-matrix-comment') as HTMLTextAreaElement;
    expect(box.value).toBe('沟通清晰，逻辑严密');
    expect(box.hasAttribute('disabled')).toBe(true);
    wrapper.unmount();
  });

  // 必填评语的列头带星标，仅在「允许评语 + 必填」同时成立时出现。
  it('marks required comments in the header', () => {
    const optional = mount(ChoiceGrid, {
      global: { mocks: { $t: (key: string) => key } },
      props: {
        disabled: false,
        question: commentMatrixQuestion(),
        rows,
        value: { 1: { optionId: 1, text: '' } },
      },
    });
    expect(optional.text()).not.toContain('*');

    const required = mount(ChoiceGrid, {
      global: { mocks: { $t: (key: string) => key } },
      props: {
        disabled: false,
        question: commentMatrixQuestion({ commentRequired: 1 }),
        rows,
        value: { 1: { optionId: 1, text: '' } },
      },
    });
    expect(required.text()).toContain('*');
  });
});
