<script lang="ts" setup>
import type { EvaluateeRow, QuestionNode } from '#/api/eval-360/emp-model';

import { computed, ref } from 'vue';

import { IconifyIcon } from '@vben/icons';

import {
  AutoComplete as AAutoComplete,
  Input as AInput,
  Popover as APopover,
  Radio as ARadio,
  Select as ASelect,
  Tag as ATag,
  Textarea as ATextarea,
} from 'ant-design-vue';

import { $t } from '#/locales';

// choice-grid.vue 员工作答页的「按题走」选择表格：单选题与矩阵题共用。
// 行 = 该题可见的被评估人（姓名 + 角色），列 = 单选选项 或 矩阵评价项；每行选一列。
// 矩阵表头两行：第一行评价项文案、第二行分值；单选若有选项允许评语，末尾加「评语」列，
// 该行所选选项允许评语时才可填。已提交行（或整页只读）禁用并回显答案。
// 矩阵的评语不是独立列：所选评价项开启「允许评语」时，单选钮旁出现评语图标，评语框以浮层弹出：
// 选中该列即自动弹出、点浮层外收起，再点图标可重新打开；已填评语时图标标蓝。
// 用浮层而非内嵌在格内：避免撑高整行、挤压相邻列。
// 控件：有预设且不允许自定义 → 单行下拉只能选预设；有预设且允许自定义 → 可选预设也可输入的文本框；
// 无预设 → 自由输入文本框。文本框默认一行、随内容自动增高（上限 4 行）。

interface CellAnswer {
  optionId: number;
  text: string;
}

interface GridColumn {
  id: number;
  label: string;
  score: string;
  allowText: boolean;
  // 评语配置（矩阵列才有意义）：必填/占位提示/预设候选/是否允许自定义。
  commentRequired: boolean;
  commentPlaceholder: string;
  commentPresets: string[];
  commentAllowCustom: boolean;
}

const props = defineProps<{
  // 整页只读（全部已提交或项目已截止）。
  disabled: boolean;
  question: QuestionNode;
  rows: EvaluateeRow[];
  // relationId → 该行答案。
  value: Record<number, CellAnswer | undefined>;
}>();

const emit = defineEmits<{
  comment: [relationId: number, text: string];
  select: [relationId: number, optionId: number];
}>();

const isMatrix = computed(() => props.question.type === 'matrix');

const columns = computed<GridColumn[]>(() =>
  isMatrix.value
    ? props.question.matrixColumns.map((c) => ({
        id: c.id,
        label: c.label,
        score: c.score,
        allowText: (c.allowComment ?? 0) === 1,
        commentRequired: (c.commentRequired ?? 0) === 1,
        commentPlaceholder: c.commentPlaceholder ?? '',
        commentPresets: c.commentPresets ?? [],
        commentAllowCustom: (c.commentAllowCustom ?? 0) === 1,
      }))
    : props.question.options.map((o) => ({
        id: o.id,
        label: o.label,
        score: o.score,
        allowText: o.allowText === 1,
        commentRequired: false,
        commentPlaceholder: '',
        commentPresets: [],
        commentAllowCustom: false,
      })),
);

// 只有单选题且存在允许评语的选项时才渲染独立的「评语」列；
// 矩阵的评语内嵌在单元格里，故恒为 false。
const hasCommentColumn = computed(
  () => !isMatrix.value && columns.value.some((c) => c.allowText),
);

const cellTestId = computed(() =>
  isMatrix.value ? 'eval360-emp-matrix-cell' : 'eval360-emp-choice-cell',
);

function rowReadonly(row: EvaluateeRow): boolean {
  return props.disabled || row.submitted;
}

function selectedId(row: EvaluateeRow): number {
  return props.value[row.relationId]?.optionId ?? 0;
}

// rowAllowsComment 单选口径：该行所选选项允许评语时，末尾的评语框才可填。
function rowAllowsComment(row: EvaluateeRow): boolean {
  const id = selectedId(row);
  return columns.value.some((c) => c.id === id && c.allowText);
}

// cellComment 该行当前评语原文（单选列与矩阵格共用同一份 text）。
function cellComment(row: EvaluateeRow): string {
  return props.value[row.relationId]?.text ?? '';
}

// commentPlaceholder 评语输入框的占位文案：优先用评价项配置的提示语，
// 未配置时回落到通用文案（与单选一致）。
function commentPlaceholder(col: GridColumn): string {
  return (
    col.commentPlaceholder || $t('page.eval360Emp.answer.commentPlaceholder')
  );
}

// ---- 矩阵评语浮层 ----
// 当前打开的浮层（受控，同一时刻最多一个）：键为「行 relationId : 列 id」。
const openCommentKey = ref<null | string>(null);

function commentKey(row: EvaluateeRow, col: GridColumn): string {
  return `${row.relationId}:${col.id}`;
}

// 该格是否挂评语入口：矩阵题、该列允许评语、且本行选中的正是这一列。
function hasCellComment(row: EvaluateeRow, col: GridColumn): boolean {
  return isMatrix.value && col.allowText && selectedId(row) === col.id;
}

function onCommentOpenChange(key: string, open: boolean) {
  if (open) {
    openCommentKey.value = key;
  } else if (openCommentKey.value === key) {
    openCommentKey.value = null;
  }
}

// selectCell 选中某列：交给父级记录答案；若该列允许评语且本行可编辑，则自动弹出评语浮层。
function selectCell(row: EvaluateeRow, col: GridColumn) {
  emit('select', row.relationId, col.id);
  if (isMatrix.value && col.allowText && !rowReadonly(row)) {
    openCommentKey.value = commentKey(row, col);
  }
}

// 浮层内的下拉（预设候选）挂在浮层内部：默认挂 body 时点选项会被浮层判定为「点外面」而收起。
function popupInParent(trigger: HTMLElement): HTMLElement {
  return trigger.parentElement ?? document.body;
}

// 文本框默认一行，随内容增高到 4 行后出现滚动条。
const commentAutoSize = { minRows: 1, maxRows: 4 };

// 矩阵分值行：0 分（含 "0.00"）不显示，单元格留空。
function displayScore(score: string): string {
  return Number(score) === 0 ? '' : score;
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="eval360-grid w-full border-collapse text-sm">
      <thead>
        <tr>
          <th :rowspan="isMatrix ? 2 : 1" class="eval360-grid-name text-left">
            {{ $t('page.eval360Emp.answer.evaluatee') }}
          </th>
          <th v-for="c in columns" :key="c.id">
            <div class="flex-center gap-1">
              <span>{{ c.label }}</span>
              <!-- 必填评语的列在表头以星标提示（校验发生在提交时）。 -->
              <span
                v-if="isMatrix && c.allowText && c.commentRequired"
                class="text-red-500"
              >
                *
              </span>
            </div>
          </th>
          <th v-if="hasCommentColumn" class="min-w-[160px]">
            {{ $t('page.eval360Emp.answer.commentColumn') }}
          </th>
        </tr>
        <tr v-if="isMatrix">
          <th
            v-for="c in columns"
            :key="c.id"
            class="font-normal text-gray-500"
            data-testid="eval360-emp-matrix-score"
          >
            {{ displayScore(c.score) }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.relationId"
          :data-relation-id="row.relationId"
          data-testid="eval360-emp-grid-row"
        >
          <td class="eval360-grid-name">
            <div class="flex flex-wrap items-center gap-1">
              <span>{{ row.evaluateeName }}</span>
              <span class="text-xs text-gray-400">
                {{
                  $t('page.eval360Emp.answer.roleAs', {
                    role: row.roleName || '-',
                  })
                }}
              </span>
              <ATag v-if="row.submitted" color="success" class="mr-0!">
                {{ $t('page.eval360Emp.answer.submittedTag') }}
              </ATag>
            </div>
          </td>
          <td
            v-for="c in columns"
            :key="c.id"
            class="text-center align-middle"
            :class="isMatrix ? 'min-w-[140px]' : undefined"
          >
            <div class="inline-flex items-center gap-1">
              <ARadio
                class="mr-0!"
                :checked="selectedId(row) === c.id"
                :disabled="rowReadonly(row)"
                :data-relation-id="row.relationId"
                :data-oid="c.id"
                :data-testid="cellTestId"
                @change="selectCell(row, c)"
              />
              <!-- 矩阵评语：只有该行选中了这一列、且该列允许评语时，单选钮旁出现评语图标与浮层。 -->
              <APopover
                v-if="hasCellComment(row, c)"
                :open="openCommentKey === commentKey(row, c)"
                placement="bottom"
                trigger="click"
                @open-change="
                  (open: boolean) =>
                    onCommentOpenChange(commentKey(row, c), open)
                "
              >
                <button
                  type="button"
                  class="inline-flex cursor-pointer items-center border-0 bg-transparent p-0"
                  :class="
                    cellComment(row).trim() ? 'text-primary' : 'text-gray-400'
                  "
                  :data-relation-id="row.relationId"
                  :data-oid="c.id"
                  data-testid="eval360-emp-matrix-comment-toggle"
                >
                  <IconifyIcon
                    icon="lucide:message-square-text"
                    class="size-4"
                  />
                </button>
                <template #content>
                  <div class="w-[240px] max-w-[70vw] text-left">
                    <!-- 有预设且不允许自定义：单行下拉，只能选预设。 -->
                    <ASelect
                      v-if="
                        c.commentPresets.length > 0 && !c.commentAllowCustom
                      "
                      class="w-full"
                      :value="cellComment(row) || undefined"
                      :options="
                        c.commentPresets.map((p) => ({ label: p, value: p }))
                      "
                      :placeholder="commentPlaceholder(c)"
                      :disabled="rowReadonly(row)"
                      :get-popup-container="popupInParent"
                      :data-relation-id="row.relationId"
                      :data-oid="c.id"
                      data-testid="eval360-emp-matrix-comment-select"
                      @change="
                        (v: any) =>
                          emit('comment', row.relationId, String(v ?? ''))
                      "
                    />
                    <!-- 有预设且允许自定义：可从预设挑，也可直接输入（文本框默认一行、自动增高）。 -->
                    <AAutoComplete
                      v-else-if="c.commentPresets.length > 0"
                      class="w-full"
                      :value="cellComment(row)"
                      :options="c.commentPresets.map((p) => ({ value: p }))"
                      :disabled="rowReadonly(row)"
                      :get-popup-container="popupInParent"
                      :data-relation-id="row.relationId"
                      :data-oid="c.id"
                      data-testid="eval360-emp-matrix-comment-autocomplete"
                      @change="
                        (v: any) =>
                          emit('comment', row.relationId, String(v ?? ''))
                      "
                    >
                      <ATextarea
                        :auto-size="commentAutoSize"
                        :placeholder="commentPlaceholder(c)"
                      />
                    </AAutoComplete>
                    <!-- 无预设：自由输入文本框（默认一行、自动增高）。 -->
                    <ATextarea
                      v-else
                      :auto-size="commentAutoSize"
                      :value="cellComment(row)"
                      :placeholder="commentPlaceholder(c)"
                      :disabled="rowReadonly(row)"
                      :data-relation-id="row.relationId"
                      :data-oid="c.id"
                      data-testid="eval360-emp-matrix-comment"
                      @input="
                        (e: any) =>
                          emit('comment', row.relationId, e.target.value)
                      "
                    />
                  </div>
                </template>
              </APopover>
            </div>
          </td>
          <td v-if="hasCommentColumn">
            <AInput
              size="small"
              data-testid="eval360-emp-comment"
              :data-relation-id="row.relationId"
              :disabled="rowReadonly(row) || !rowAllowsComment(row)"
              :placeholder="$t('page.eval360Emp.answer.commentPlaceholder')"
              :value="value[row.relationId]?.text ?? ''"
              @input="
                (e: any) => emit('comment', row.relationId, e.target.value)
              "
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.eval360-grid th,
.eval360-grid td {
  padding: 6px 8px;
  border: 1px solid #f0f0f0;
}

.eval360-grid thead th {
  font-weight: 500;
  background: #fafafa;
}

/* 被评估人列：窄屏横向滚动时固定在左侧。 */
.eval360-grid .eval360-grid-name {
  position: sticky;
  left: 0;
  z-index: 1;
  min-width: 120px;
  background: #fff;
}

.eval360-grid thead .eval360-grid-name {
  background: #fafafa;
}
</style>
