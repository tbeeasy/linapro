<script lang="ts" setup>
import type {
  AnswerDTO,
  EvaluateeRow,
  QuestionnaireSet,
  QuestionNode,
  SubmitItemDTO,
} from '#/api/eval-360/emp-model';

import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  Alert as AAlert,
  Button as AButton,
  Card as ACard,
  Input as AInput,
  Result as AResult,
  Spin as ASpin,
  Textarea as ATextarea,
  message,
} from 'ant-design-vue';

import { evalEmpQuestions, evalEmpSubmit } from '#/api/eval-360/emp';
import { $t } from '#/locales';

import ChoiceGrid from './choice-grid.vue';

// answer.vue 员工作答页（按问卷批量作答）：每题同时作答该评价者名下全部被评估人。
// 一题一页：题目卡片下方「上一题 / 下一题」翻页；当前题为必答且未答完时不能进入下一题；必填全部答完才显示提交按钮。
// 布局「按题走」：单选/矩阵渲染成「行=被评估人 × 列=选项/评价项」表格（choice-grid.vue）；
// 文本题每个可见被评估人一行「姓名 + 输入框」。每题渲染哪些行由服务端 rowRelationIds 决定，前端不做可见性判断。
// 已提交的被评估人行只读并回显答案；全部已提交或项目已截止 → 整页只读、隐藏提交按钮。
// 提交范围 = 页面加载时所有未提交的人（打开页面后管理员新增的人不在本次，留在待办里）。
// 计时（design D7）：加载完成起算，提交时算 durationSeconds 上传（整场一次），不向答题人展示；组件未 keep-alive，每次进入即重置。
// 本地无飞书应用时无法走通登录；可临时手贴后端 dev 签发的员工 JWT 到 localStorage['linapro:emp-auth-token']
// 后直访本页对运行中的后端验证渲染与提交。

// 单格答案：单选/矩阵用 optionId（单选的选项级评语放 text）；文本题用 text。
interface CellAnswer {
  optionId: number;
  text: string;
}

const route = useRoute();
const router = useRouter();

const questionnaireId = computed(() =>
  Number(route.query.questionnaireId || 0),
);
const questionSet = ref<null | QuestionnaireSet>(null);
const loading = ref(true);
const submitting = ref(false);

// 答案状态：questionId → relationId → 单格答案。
const answers = ref<Record<number, Record<number, CellAnswer>>>({});

function cell(qid: number, rid: number): CellAnswer | undefined {
  return answers.value[qid]?.[rid];
}

function setCell(qid: number, rid: number, patch: Partial<CellAnswer>) {
  // 整体替换该题的行答案对象，保证新增行答案可被响应式追踪。
  const prev = answers.value[qid] ?? {};
  answers.value[qid] = {
    ...prev,
    [rid]: { optionId: 0, text: '', ...prev[rid], ...patch },
  };
}

// ---- 被评估人行 ----
const evaluateeById = computed(() => {
  const out: Record<number, EvaluateeRow> = {};
  for (const e of questionSet.value?.evaluatees ?? []) {
    out[e.relationId] = e;
  }
  return out;
});

// 本次提交范围：页面加载时所有未提交的被评估人。
const pendingIds = computed(() =>
  (questionSet.value?.evaluatees ?? [])
    .filter((e) => !e.submitted)
    .map((e) => e.relationId),
);

const submittedCount = computed(
  () => (questionSet.value?.evaluatees ?? []).filter((e) => e.submitted).length,
);

const allQuestions = computed<QuestionNode[]>(() =>
  (questionSet.value?.dimensions ?? []).flatMap((d) => d.questions),
);

// 整页只读：项目已截止或名下全部已提交。
const readonly = computed(
  () => !!questionSet.value?.closed || pendingIds.value.length === 0,
);

function rowsFor(q: QuestionNode): EvaluateeRow[] {
  return q.rowRelationIds
    .map((id) => evaluateeById.value[id])
    .filter((e): e is EvaluateeRow => !!e);
}

function rowValues(q: QuestionNode): Record<number, CellAnswer | undefined> {
  return answers.value[q.id] ?? {};
}

function isTextQuestion(q: QuestionNode): boolean {
  return q.type === 'text_short' || q.type === 'text_long';
}

function rowReadonly(row: EvaluateeRow): boolean {
  return readonly.value || row.submitted;
}

// ---- 计时（仅用于提交时上报，不展示） ----
let startedAt = 0;

// ---- 必填校验：按「题 × 未提交行」计 ----
function isCellAnswered(q: QuestionNode, rid: number): boolean {
  const a = cell(q.id, rid);
  if (!a) return false;
  if (isTextQuestion(q)) return a.text.trim().length > 0;
  return a.optionId > 0;
}

// matrixColumn 返回该矩阵题中所选评价项节点；单选或未选返回 undefined。
function matrixColumn(q: QuestionNode, rid: number) {
  if (q.type !== 'matrix') return undefined;
  const id = cell(q.id, rid)?.optionId ?? 0;
  return q.matrixColumns.find((c) => c.id === id);
}

// commentRequiredMissing 该行是否漏填了「允许评语 + 必填」评价项的评语。
// 只在提交前拦截：作答过程中允许先选列后补评语、来回切换。
function commentRequiredMissing(q: QuestionNode, rid: number): boolean {
  const col = matrixColumn(q, rid);
  if (!col || col.allowComment !== 1 || col.commentRequired !== 1) return false;
  return (cell(q.id, rid)?.text ?? '').trim().length === 0;
}

const missingCount = computed(() => {
  let n = 0;
  for (const q of allQuestions.value) {
    if (q.required !== 1) continue;
    for (const row of rowsFor(q)) {
      if (!row.submitted && !isCellAnswered(q, row.relationId)) n++;
    }
  }
  return n;
});

// 评语必填与题目必填相互独立：题必填决定「选不选」，评价项必填决定「填不填评语」。
// 评语必填只在点击提交时拦截（见 handleSubmit），不参与 canSubmit——
// 否则按钮会直接消失，用户不知道缺在哪，且作答过程中来回切换列属于正常操作。
const missingCommentCount = computed(() => {
  let n = 0;
  for (const q of allQuestions.value) {
    for (const row of rowsFor(q)) {
      if (!row.submitted && commentRequiredMissing(q, row.relationId)) n++;
    }
  }
  return n;
});

// 首个漏填必填评语的「题 × 被评估人」，用于提交时定位并翻到该页。
function firstMissingComment():
  | undefined
  | { pageIndex: number; question: QuestionNode; row: EvaluateeRow } {
  for (const [index, page] of pages.value.entries()) {
    for (const row of rowsFor(page.question)) {
      if (
        !row.submitted &&
        commentRequiredMissing(page.question, row.relationId)
      ) {
        return { pageIndex: index, question: page.question, row };
      }
    }
  }
  return undefined;
}

const canSubmit = computed(() => !readonly.value && missingCount.value === 0);

// ---- 一题一页 ----
// 题目按维度顺序平铺并带上维度名；无可见行的题（无可作答内容）不进入翻页。
const pages = computed(() =>
  (questionSet.value?.dimensions ?? []).flatMap((d) =>
    d.questions
      .filter((q) => rowsFor(q).length > 0)
      .map((q) => ({ dimensionName: d.name, question: q })),
  ),
);
const pageIndex = ref(0);
const currentPage = computed(() => pages.value[pageIndex.value]);
const isLastPage = computed(() => pageIndex.value >= pages.value.length - 1);

const rootRef = ref<HTMLElement>();

function goToPage(index: number) {
  if (index < 0 || index >= pages.value.length) return;
  pageIndex.value = index;
  // 布局的滚动容器是 main 而非 window，用 scrollIntoView 回到页首。
  rootRef.value?.scrollIntoView?.({ block: 'start' });
}

function isQuestionDone(q: QuestionNode): boolean {
  if (q.required !== 1) return true;
  return rowsFor(q).every(
    (row) => row.submitted || isCellAnswered(q, row.relationId),
  );
}

// 当前题为必答且未答完时不能进入下一题；整页只读时仅查看，不拦截。
const canGoNext = computed(
  () =>
    readonly.value ||
    !currentPage.value ||
    isQuestionDone(currentPage.value.question),
);

// 当前题的写入快捷方法：模板内事件回调里 currentPage 可能被收窄失效，统一在此取题目 id。
function setCurrentCell(rid: number, patch: Partial<CellAnswer>) {
  const q = currentPage.value?.question;
  if (q) setCell(q.id, rid, patch);
}

// selectCell 切换所选选项 / 评价项：评语从属于「所选的这一列」，
// 换列时必须一并清空，否则会把上一列写的评语当成新列的评语保存与导出。
// 重复点击同一列不清空（避免误丢已填内容）。
function selectCell(rid: number, optionId: number) {
  const q = currentPage.value?.question;
  if (!q) return;
  if ((cell(q.id, rid)?.optionId ?? 0) === optionId) return;
  setCell(q.id, rid, { optionId, text: '' });
}

// ---- 加载 ----
async function load() {
  loading.value = true;
  try {
    const res = await evalEmpQuestions(questionnaireId.value);
    questionSet.value = res.set;
    // 已提交关系的答案回填，供只读回显。
    const filled: Record<number, Record<number, CellAnswer>> = {};
    for (const a of res.set.submittedAnswers ?? []) {
      (filled[a.questionId] ??= {})[a.relationId] = {
        optionId: a.optionId,
        text: a.textValue,
      };
    }
    answers.value = filled;
    pageIndex.value = 0;
    startedAt = Date.now();
  } catch {
    questionSet.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// ---- 提交 ----
// 单选的选项级评语：仅当所选选项允许评语时上送；
// 矩阵的评价项评语同理：仅当所选评价项允许评语时上送，口径一致。
function commentFor(q: QuestionNode, a: CellAnswer): string {
  if (q.type === 'matrix') {
    const col = q.matrixColumns.find((c) => c.id === a.optionId);
    return col && col.allowComment === 1 ? a.text.trim() : '';
  }
  const opt = q.options.find((o) => o.id === a.optionId);
  return opt && opt.allowText === 1 ? a.text.trim() : '';
}

function buildItems(): SubmitItemDTO[] {
  return pendingIds.value.map((rid) => {
    const out: AnswerDTO[] = [];
    for (const q of allQuestions.value) {
      if (!q.rowRelationIds.includes(rid)) continue;
      const a = cell(q.id, rid);
      if (!a) continue;
      if (isTextQuestion(q)) {
        if (a.text.trim()) {
          out.push({ questionId: q.id, optionId: 0, textValue: a.text });
        }
      } else if (a.optionId > 0) {
        out.push({
          questionId: q.id,
          optionId: a.optionId,
          textValue: commentFor(q, a),
        });
      }
    }
    return { relationId: rid, answers: out };
  });
}

async function handleSubmit() {
  if (!canSubmit.value || submitting.value || !questionSet.value) return;
  // 评语必填：提交时统一拦截，翻到首个缺评语的题并提示是哪个被评估人。
  if (missingCommentCount.value > 0) {
    const target = firstMissingComment();
    if (target) {
      goToPage(target.pageIndex);
      message.warning(
        $t('page.eval360Emp.answer.commentRequired', {
          evaluatee: target.row.evaluateeName,
        }),
      );
    }
    return;
  }
  submitting.value = true;
  try {
    const durationSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const result = await evalEmpSubmit({
      questionnaireId: questionnaireId.value,
      durationSeconds,
      items: buildItems(),
    });
    void router.replace({
      path: '/eval-360/emp/result',
      query: {
        count: result.submittedCount,
        submittedAt: result.submittedAt || '',
        idempotent: result.idempotent ? '1' : '0',
      },
    });
  } catch {
    // 错误提示由请求拦截器处理（如「部分被评估人已提交，请刷新」）。
  } finally {
    submitting.value = false;
  }
}

function back() {
  void router.replace('/eval-360/emp/todo');
}
</script>

<template>
  <div
    ref="rootRef"
    class="mx-auto flex w-full max-w-[960px] flex-col gap-3 p-4"
    data-testid="eval360-emp-answer"
  >
    <div class="flex items-center justify-between gap-2">
      <AButton @click="back">
        {{ $t('page.eval360Emp.answer.back') }}
      </AButton>
      <div v-if="questionSet" class="flex flex-col items-end text-sm">
        <span class="font-semibold">{{ questionSet.questionnaireTitle }}</span>
        <span class="text-gray-500" data-testid="eval360-emp-answer-progress">
          {{
            $t('page.eval360Emp.answer.progress', {
              done: submittedCount,
              total: questionSet.evaluatees.length,
            })
          }}
        </span>
      </div>
    </div>

    <ASpin v-if="loading" class="self-center py-10" />
    <AResult
      v-else-if="!questionSet"
      status="404"
      :title="$t('page.eval360Emp.answer.notFound')"
    >
      <template #extra>
        <AButton @click="back">
          {{ $t('page.eval360Emp.answer.back') }}
        </AButton>
      </template>
    </AResult>

    <template v-else>
      <AAlert
        v-if="questionSet.closed"
        type="warning"
        show-icon
        data-testid="eval360-emp-readonly"
        :message="$t('page.eval360Emp.answer.closedHint')"
      />
      <AAlert
        v-else-if="pendingIds.length === 0"
        type="success"
        show-icon
        data-testid="eval360-emp-readonly"
        :message="$t('page.eval360Emp.answer.allSubmittedHint')"
      />
      <AAlert
        v-else-if="submittedCount > 0"
        type="info"
        show-icon
        :message="
          $t('page.eval360Emp.answer.partialHint', { count: pendingIds.length })
        "
      />

      <template v-if="currentPage">
        <ACard size="small">
          <template #title>{{ currentPage.dimensionName }}</template>
          <template #extra>
            <span
              class="text-xs text-gray-500"
              data-testid="eval360-emp-question-index"
            >
              {{
                $t('page.eval360Emp.answer.questionIndex', {
                  current: pageIndex + 1,
                  total: pages.length,
                })
              }}
            </span>
          </template>
          <div
            :key="currentPage.question.id"
            class="flex flex-col gap-2"
            :data-qid="currentPage.question.id"
            :data-qtype="currentPage.question.type"
            data-testid="eval360-emp-question"
          >
            <div class="eval360-rich-inline text-sm font-semibold">
              <span v-html="currentPage.question.title"></span>
              <span
                v-if="currentPage.question.required === 1"
                class="text-red-500"
              >
                *
              </span>
            </div>
            <div
              v-if="currentPage.question.description"
              class="eval360-rich-block text-sm text-gray-500"
              v-html="currentPage.question.description"
            ></div>

            <!-- 单选 / 矩阵：行=被评估人 × 列=选项/评价项 -->
            <ChoiceGrid
              v-if="
                currentPage.question.type === 'single_choice' ||
                currentPage.question.type === 'matrix'
              "
              :disabled="readonly"
              :question="currentPage.question"
              :rows="rowsFor(currentPage.question)"
              :value="rowValues(currentPage.question)"
              @comment="(rid, text) => setCurrentCell(rid, { text })"
              @select="(rid, oid) => selectCell(rid, oid)"
            />

            <!-- 文本题：每个可见被评估人一行「姓名 + 输入框」 -->
            <template v-else-if="isTextQuestion(currentPage.question)">
              <div
                v-for="row in rowsFor(currentPage.question)"
                :key="row.relationId"
                class="flex items-start gap-3"
                :data-relation-id="row.relationId"
              >
                <div class="w-28 shrink-0 pt-1 text-sm">
                  <div>{{ row.evaluateeName }}</div>
                  <div class="text-xs text-gray-400">
                    {{
                      $t('page.eval360Emp.answer.roleAs', {
                        role: row.roleName || '-',
                      })
                    }}
                    <span v-if="row.submitted" class="text-green-600">
                      · {{ $t('page.eval360Emp.answer.submittedTag') }}
                    </span>
                  </div>
                </div>
                <AInput
                  v-if="currentPage.question.type === 'text_short'"
                  data-testid="eval360-emp-text"
                  :data-relation-id="row.relationId"
                  :disabled="rowReadonly(row)"
                  :value="
                    cell(currentPage.question.id, row.relationId)?.text ?? ''
                  "
                  @input="
                    (e: any) =>
                      setCurrentCell(row.relationId, { text: e.target.value })
                  "
                />
                <ATextarea
                  v-else
                  data-testid="eval360-emp-textarea"
                  :data-relation-id="row.relationId"
                  :disabled="rowReadonly(row)"
                  :rows="3"
                  :value="
                    cell(currentPage.question.id, row.relationId)?.text ?? ''
                  "
                  @input="
                    (e: any) =>
                      setCurrentCell(row.relationId, { text: e.target.value })
                  "
                />
              </div>
            </template>
          </div>
        </ACard>

        <!-- 翻页与提交：必答题未答完禁用「下一题」；提交按钮仅在必填全部答完时出现（整页只读时不出现） -->
        <div class="flex items-center justify-between gap-2">
          <AButton
            data-testid="eval360-emp-prev"
            :disabled="pageIndex === 0"
            @click="goToPage(pageIndex - 1)"
          >
            {{ $t('page.eval360Emp.answer.prev') }}
          </AButton>
          <div class="flex items-center gap-2">
            <AButton
              v-if="!isLastPage"
              data-testid="eval360-emp-next"
              :disabled="!canGoNext"
              @click="goToPage(pageIndex + 1)"
            >
              {{ $t('page.eval360Emp.answer.next') }}
            </AButton>
            <AButton
              v-if="canSubmit"
              type="primary"
              data-testid="eval360-emp-submit"
              :loading="submitting"
              @click="handleSubmit"
            >
              {{
                $t('page.eval360Emp.answer.submit', {
                  count: pendingIds.length,
                })
              }}
            </AButton>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* 题目标题为富文本（HTML）：段落内联渲染，必填星标紧随其后。 */
.eval360-rich-inline :deep(p) {
  display: inline;
  margin: 0;
}

/* 题目描述为富文本块：恢复段落正常块级边距。 */
.eval360-rich-block :deep(p) {
  margin: 0 0 0.25em;
}

.eval360-rich-block :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
