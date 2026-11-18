import type { VueWrapper } from '@vue/test-utils';

import type { QuestionnaireSet, QuestionNode } from '#/api/eval-360/emp-model';

import { flushPromises, mount } from '@vue/test-utils';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
// 当前员工 id；为 0 时模拟取不到身份（whoami 失败）。
let whoamiEmpId = 7;
const submit = vi.fn();
vi.mock('#/api/eval-360/emp', () => ({
  evalEmpQuestions: () => Promise.resolve({ set: questionSet }),
  evalEmpWhoami: () =>
    whoamiEmpId
      ? Promise.resolve({ empId: whoamiEmpId, tenantId: 1 })
      : Promise.reject(new Error('unauthorized')),
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
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

// 作答页卸载时会把答案落到 localStorage：每个用例结束后卸载仍挂载的页面、
// 每个用例开始前清空存储，保证用例之间不经由暂存互相影响。
const mounted: VueWrapper[] = [];
beforeEach(() => {
  localStorage.clear();
  whoamiEmpId = 7;
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) {
    if (!wrapper.vm.$.isUnmounted) wrapper.unmount();
  }
});

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
    // 被评估人旁不显示评价者角色。
    expect(wrapper.text()).not.toContain('page.eval360Emp.answer.roleAs');
    expect(wrapper.text()).not.toContain('同事');
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
});

// matrixColumns 构造两列评价项：均为「允许评语」，必填由参数决定。
function matrixColumns(commentRequired: number) {
  return [
    {
      allowComment: 1,
      commentAllowCustom: 0,
      commentPlaceholder: '优秀评语',
      commentPresets: [],
      commentRequired,
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
  ];
}

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
              matrixColumns: matrixColumns(0),
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
  it('必填评语未填时不能进入下一题，填完即可继续；非必填列不受影响', async () => {
    // 两题一页一题：矩阵题（第 1 题）选「优秀」且评语必填，后接一道文本题（第 3 题）。
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
              matrixColumns: matrixColumns(1),
            }),
            question({ id: 3, title: '后续题' }),
          ],
          sort: 0,
        },
      ],
    });
    const wrapper = await mountAnswer();
    const nextBtn = () => wrapper.find(byTestId('eval360-emp-next'));
    const currentTitle = () =>
      wrapper.find(byTestId('eval360-emp-question')).text();
    const clickCell = async (index: number) => {
      await matrixCell(wrapper, index).find('input').trigger('change');
      await flushPromises();
    };
    const comment = () =>
      document.body.querySelector(
        byTestId('eval360-emp-matrix-comment'),
      ) as HTMLTextAreaElement;

    // 未选题：矩阵题必答，本就禁用。
    expect(nextBtn().attributes('disabled')).toBeDefined();

    // 选「优秀」（评语必填）但评语空：仍视为未答完。
    await clickCell(0);
    expect(nextBtn().attributes('disabled')).toBeDefined();
    await nextBtn().trigger('click');
    expect(currentTitle()).toContain('矩阵题');

    // 空白评语不算填。
    await typeComment(comment(), '   ');
    expect(nextBtn().attributes('disabled')).toBeDefined();

    // 填上评语即可进入下一题。
    await typeComment(comment(), '沟通清晰');
    expect(nextBtn().attributes('disabled')).toBeUndefined();
    await nextBtn().trigger('click');
    expect(currentTitle()).toContain('后续题');

    // 回到矩阵题改选「良好」（评语非必填）：评语被清空但不再拦翻页。
    await wrapper.find(byTestId('eval360-emp-prev')).trigger('click');
    await clickCell(1);
    expect(nextBtn().attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('必填评语漏填时提交仍被拦截，不调用接口（兜底）', async () => {
    // 只有一道矩阵题（必答）：评语必填不参与 canSubmit，故提交按钮会照常出现；
    // 这道兜底保证即便用户不靠翻页（或未来出现绕过翻页的路径）也不会漏评语提交。
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
              matrixColumns: matrixColumns(1),
            }),
          ],
          sort: 0,
        },
      ],
    });
    const wrapper = await mountAnswer();
    await matrixCell(wrapper, 0).find('input').trigger('change');
    await flushPromises();

    const submitBtn = wrapper.find(byTestId('eval360-emp-submit'));
    expect(submitBtn.exists()).toBe(true);
    await submitBtn.trigger('click');
    await flushPromises();
    expect(submit).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('answer.vue 本地暂存', () => {
  const key = 'linapro:eval360:answer-draft:10:7';
  const currentTitle = (wrapper: VueWrapper) =>
    wrapper.find(byTestId('eval360-emp-question')).text();
  const textValue = (wrapper: VueWrapper) =>
    (wrapper.find(byTestId('eval360-emp-text')).element as HTMLInputElement)
      .value;

  beforeEach(() => {
    questionSet = buildSet();
    submit.mockClear();
  });

  // 刷新 = 卸载（触发立即落盘）后重新挂载。
  async function answerThenRefresh() {
    const first = await mountAnswer();
    await first.find(byTestId('eval360-emp-text')).setValue('第一题答案');
    await first.find(byTestId('eval360-emp-next')).trigger('click');
    await first.find(byTestId('eval360-emp-text')).setValue('选填答案');
    first.unmount();
    return mountAnswer();
  }

  it('刷新后恢复未提交答案与页码', async () => {
    const wrapper = await answerThenRefresh();
    expect(currentTitle(wrapper)).toContain('选填题');
    expect(textValue(wrapper)).toBe('选填答案');
    await wrapper.find(byTestId('eval360-emp-prev')).trigger('click');
    expect(textValue(wrapper)).toBe('第一题答案');
    wrapper.unmount();
  });

  it('页码不越过因过滤而失效的必答题', async () => {
    const first = await mountAnswer();
    await first.find(byTestId('eval360-emp-text')).setValue('第一题答案');
    await first.find(byTestId('eval360-emp-next')).trigger('click');
    await first.find(byTestId('eval360-emp-next')).trigger('click');
    expect(currentTitle(first)).toContain('第三题');
    first.unmount();

    // 刷新前第一题被删除重建（id 变化）：暂存答案失效，应回到这道未答的必答题。
    const rebuilt = buildSet();
    questionSet = {
      ...rebuilt,
      dimensions: rebuilt.dimensions.map((d, i) =>
        i === 0
          ? {
              ...d,
              questions: d.questions.map((q) =>
                q.id === 1 ? { ...q, id: 5 } : q,
              ),
            }
          : d,
      ),
    };
    const wrapper = await mountAnswer();
    expect(currentTitle(wrapper)).toContain('第一题');
    expect(textValue(wrapper)).toBe('');
    wrapper.unmount();
  });

  it('暂存按员工隔离：换人登录看不到上一人的答案', async () => {
    const first = await mountAnswer();
    await first.find(byTestId('eval360-emp-text')).setValue('甲的答案');
    first.unmount();
    expect(localStorage.getItem(key)).not.toBeNull();

    whoamiEmpId = 8;
    const wrapper = await mountAnswer();
    expect(textValue(wrapper)).toBe('');
    wrapper.unmount();
  });

  it('取不到员工身份时不读写暂存', async () => {
    whoamiEmpId = 0;
    const first = await mountAnswer();
    await first.find(byTestId('eval360-emp-text')).setValue('答案');
    first.unmount();
    const draftKeys = Object.keys(localStorage).filter((k) =>
      k.startsWith('linapro:eval360:answer-draft:'),
    );
    expect(draftKeys).toEqual([]);
  });

  it('已提交的行不从暂存恢复，整页只读时清除暂存', async () => {
    const first = await mountAnswer();
    await first.find(byTestId('eval360-emp-text')).setValue('本地答案');
    first.unmount();

    questionSet = buildSet({
      evaluatees: [
        {
          evaluateeName: '张三',
          relationId: 100,
          roleName: '同事',
          submitted: true,
        },
      ],
      submittedAnswers: [
        {
          optionId: 0,
          questionId: 1,
          relationId: 100,
          textValue: '服务端答案',
        },
      ],
    });
    const wrapper = await mountAnswer();
    expect(textValue(wrapper)).toBe('服务端答案');
    expect(localStorage.getItem(key)).toBeNull();
    wrapper.unmount();
  });

  it('提交成功后清除暂存', async () => {
    const wrapper = await mountAnswer();
    await wrapper.find(byTestId('eval360-emp-text')).setValue('第一题答案');
    await wrapper.find(byTestId('eval360-emp-next')).trigger('click');
    await wrapper.find(byTestId('eval360-emp-next')).trigger('click');
    await wrapper.find(byTestId('eval360-emp-text')).setValue('第三题答案');
    // 先落盘一次，确认提交前确有暂存。
    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(key)).not.toBeNull();

    await wrapper.find(byTestId('eval360-emp-submit')).trigger('click');
    await flushPromises();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBeNull();
    wrapper.unmount();
    expect(localStorage.getItem(key)).toBeNull();
  });
});

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
