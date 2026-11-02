import type { VueWrapper } from '@vue/test-utils';

import type { QuestionnaireSet, QuestionNode } from '#/api/eval-360/emp-model';

import { flushPromises, mount } from '@vue/test-utils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import Answer from './answer.vue';

vi.mock('#/locales', () => ({
  $t: (key: string, args?: Record<string, unknown>) =>
    args ? `${key}:${JSON.stringify(args)}` : key,
}));

// 图标组件在测试环境会尝试联网拉取图标数据，替换为空壳。
vi.mock('@vben/icons', () => ({ IconifyIcon: { template: '<i />' } }));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { questionnaireId: '10' } }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

let questionSet: QuestionnaireSet;
const submit = vi.fn();
vi.mock('#/api/eval-360/emp', () => ({
  evalEmpQuestions: () => Promise.resolve({ set: questionSet }),
  evalEmpSubmit: (data: unknown) => {
    submit(data);
    return Promise.resolve({
      idempotent: false,
      submittedAt: '',
      submittedCount: 1,
    });
  },
}));

function question(over: Partial<QuestionNode>): QuestionNode {
  return {
    description: '',
    dimensionId: 1,
    id: 1,
    matrixColumns: [],
    options: [],
    required: 1,
    rowRelationIds: [100],
    sort: 0,
    title: '题目',
    type: 'text_short',
    ...over,
  };
}

function buildSet(over: Partial<QuestionnaireSet> = {}): QuestionnaireSet {
  return {
    closed: false,
    dimensions: [
      {
        id: 1,
        name: '维度一',
        questions: [
          question({ id: 1, title: '第一题' }),
          question({ id: 2, required: 0, title: '选填题' }),
        ],
        sort: 0,
      },
      {
        id: 2,
        name: '维度二',
        questions: [
          question({ id: 3, title: '第三题' }),
          // 本评价者无可见行的题不进入翻页。
          question({ id: 4, rowRelationIds: [], title: '不可见题' }),
        ],
        sort: 1,
      },
    ],
    evaluatees: [
      {
        evaluateeName: '张三',
        relationId: 100,
        roleName: '同事',
        submitted: false,
      },
    ],
    questionnaireId: 10,
    questionnaireTitle: '领导力',
    submittedAnswers: [],
    ...over,
  };
}

async function mountAnswer() {
  const wrapper = mount(Answer, {
    // 挂到 document：矩阵评语浮层 teleport 到 body，测试需从 document 查询。
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  });
  await flushPromises();
  return wrapper;
}

const byTestId = (id: string) => `[data-testid="${id}"]`;

describe('answer.vue 一题一页', () => {
  beforeEach(() => {
    questionSet = buildSet();
    submit.mockClear();
  });

  it('每页只渲染一题，上一题/下一题翻页，跳过无可见行的题', async () => {
    const wrapper = await mountAnswer();
    const questionTitles = () =>
      wrapper.findAll(byTestId('eval360-emp-question')).map((q) => q.text());

    expect(questionTitles()).toHaveLength(1);
    expect(questionTitles()[0]).toContain('第一题');
    expect(wrapper.text()).toContain('维度一');
    // 角色带「作为」前缀，避免被读成「谁来评价我」。
    expect(wrapper.text()).toContain(
      'page.eval360Emp.answer.roleAs:{"role":"同事"}',
    );
    expect(wrapper.find(byTestId('eval360-emp-question-index')).text()).toBe(
      'page.eval360Emp.answer.questionIndex:{"current":1,"total":3}',
    );
    expect(
      wrapper.find(byTestId('eval360-emp-prev')).attributes('disabled'),
    ).toBeDefined();

    await wrapper.find(byTestId('eval360-emp-text')).setValue('答案');
    await wrapper.find(byTestId('eval360-emp-next')).trigger('click');
    expect(questionTitles()[0]).toContain('选填题');

    await wrapper.find(byTestId('eval360-emp-next')).trigger('click');
    expect(questionTitles()[0]).toContain('第三题');
    expect(wrapper.text()).toContain('维度二');
    // 末页无「下一题」。
    expect(wrapper.find(byTestId('eval360-emp-next')).exists()).toBe(false);

    await wrapper.find(byTestId('eval360-emp-prev')).trigger('click');
    expect(questionTitles()[0]).toContain('选填题');
  });

  it('必答题未答完不能进入下一题，选填题可跳过；必填全部答完才出现提交按钮', async () => {
    const wrapper = await mountAnswer();
    const fillCurrent = (text: string) =>
      wrapper.find(byTestId('eval360-emp-text')).setValue(text);
    const nextBtn = () => wrapper.find(byTestId('eval360-emp-next'));
    const submitBtn = () => wrapper.find(byTestId('eval360-emp-submit'));
    const currentTitle = () =>
      wrapper.find(byTestId('eval360-emp-question')).text();

    // 第一题必答未填：下一题禁用，点击也不翻页。
    expect(nextBtn().attributes('disabled')).toBeDefined();
    await nextBtn().trigger('click');
    expect(currentTitle()).toContain('第一题');

    // 只填空白不算作答。
    await fillCurrent('   ');
    expect(nextBtn().attributes('disabled')).toBeDefined();

    await fillCurrent('第一题答案');
    expect(nextBtn().attributes('disabled')).toBeUndefined();
    await nextBtn().trigger('click');

    // 选填题不填也可进入下一题。
    expect(currentTitle()).toContain('选填题');
    expect(nextBtn().attributes('disabled')).toBeUndefined();
    await nextBtn().trigger('click');

    // 末页必答未填：不出现提交按钮；填完即出现。
    expect(currentTitle()).toContain('第三题');
    expect(submitBtn().exists()).toBe(false);
    await fillCurrent('第三题答案');
    expect(submitBtn().exists()).toBe(true);

    await submitBtn().trigger('click');
    await flushPromises();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      items: [
        {
          answers: [
            { optionId: 0, questionId: 1, textValue: '第一题答案' },
            { optionId: 0, questionId: 3, textValue: '第三题答案' },
          ],
          relationId: 100,
        },
      ],
      questionnaireId: 10,
    });
  });

  it('整页只读（已截止）时未作答也可翻页查看，且不出现提交按钮', async () => {
    questionSet = buildSet({ closed: true });
    const wrapper = await mountAnswer();
    await wrapper.find(byTestId('eval360-emp-next')).trigger('click');
    await wrapper.find(byTestId('eval360-emp-next')).trigger('click');
    expect(wrapper.find(byTestId('eval360-emp-question')).text()).toContain(
      '第三题',
    );
    expect(wrapper.find(byTestId('eval360-emp-submit')).exists()).toBe(false);
  });

  it('角色名为空时前缀不残缺（兜底为「-」）', async () => {
    const base = buildSet();
    questionSet = buildSet({
      evaluatees: base.evaluatees.map((e) => ({ ...e, roleName: '' })),
    });
    const wrapper = await mountAnswer();
    expect(wrapper.text()).toContain(
      'page.eval360Emp.answer.roleAs:{"role":"-"}',
    );
  });
});

describe('answer.vue 矩阵评语', () => {
  // 两列都允许评语：切换所选评价项时，上一列写的评语必须清空，
  // 否则会被当成新列的评语保存并导出（评语从属于「所选的这一列」）。
  beforeEach(() => {
    document.body.innerHTML = '';
    submit.mockClear();
    questionSet = buildSet({
      dimensions: [
        {
          id: 1,
          name: '维度一',
          questions: [
            question({
              id: 1,
              title: '矩阵题',
              type: 'matrix',
              matrixColumns: [
                {
                  allowComment: 1,
                  commentAllowCustom: 0,
                  commentPlaceholder: '优秀评语',
                  commentPresets: [],
                  commentRequired: 0,
                  id: 1,
                  label: '优秀',
                  score: '5',
                  sort: 0,
                },
                {
                  allowComment: 1,
                  commentAllowCustom: 0,
                  commentPlaceholder: '良好评语',
                  commentPresets: [],
                  commentRequired: 0,
                  id: 2,
                  label: '良好',
                  score: '4',
                  sort: 1,
                },
              ],
            }),
          ],
          sort: 0,
        },
      ],
    });
  });

  it('换列清空已填评语；重复点同一列不清空', async () => {
    const wrapper = await mountAnswer();
    const pick = (index: number) => matrixCell(wrapper, index);
    // 评语框在浮层里，浮层 teleport 到 body，需从 document 查。
    const comment = () =>
      document.body.querySelector(
        byTestId('eval360-emp-matrix-comment'),
      ) as HTMLTextAreaElement;
    // antd 的 Radio 渲染成 label + 内部 input，change 事件要打在 input 上。
    const clickCell = async (index: number) => {
      await pick(index).find('input').trigger('change');
      await flushPromises();
    };

    // 选「优秀」：浮层自动弹出，写评语。
    await clickCell(0);
    await typeComment(comment(), '沟通清晰');
    expect(comment().value).toBe('沟通清晰');

    // 重复点同一列：评语保留。
    await clickCell(0);
    expect(comment().value).toBe('沟通清晰');

    // 换到「良好」：评语清空，且 placeholder 换成新列的提示语。
    await clickCell(1);
    expect(comment().value).toBe('');
    expect(comment().getAttribute('placeholder')).toBe('良好评语');
    wrapper.unmount();
  });

  it('换列后提交只上送新列的空评语，不带走上一条评语', async () => {
    const wrapper = await mountAnswer();
    const pick = (index: number) => matrixCell(wrapper, index);

    await pick(0).find('input').trigger('change');
    await flushPromises();
    await typeComment(
      document.body.querySelector(
        byTestId('eval360-emp-matrix-comment'),
      ) as HTMLTextAreaElement,
      '沟通清晰',
    );
    await pick(1).find('input').trigger('change');
    await flushPromises();

    expect(wrapper.find(byTestId('eval360-emp-submit')).exists()).toBe(true);
    await wrapper.find(byTestId('eval360-emp-submit')).trigger('click');
    await flushPromises();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      items: [
        {
          answers: [{ optionId: 2, questionId: 1, textValue: '' }],
          relationId: 100,
        },
      ],
    });
    wrapper.unmount();
  });
});

// matrixCell 取第 index 个矩阵单元格（不存在即让用例失败，避免后续空引用）。
function matrixCell(wrapper: VueWrapper, index: number) {
  const el = wrapper.findAll(byTestId('eval360-emp-matrix-cell')).at(index);
  if (!el) throw new Error(`矩阵单元格 ${index} 不存在`);
  return el;
}

// typeComment 向浮层内的评语框输入文本（浮层不在 wrapper 内，需直接操作 DOM 并派发 input）。
async function typeComment(el: HTMLTextAreaElement, text: string) {
  el.value = text;
  el.dispatchEvent(new Event('input'));
  await flushPromises();
}
