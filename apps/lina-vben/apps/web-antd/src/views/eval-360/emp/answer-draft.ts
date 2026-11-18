import type { QuestionNode } from '#/api/eval-360/emp-model';

// answer-draft.ts 员工作答页的本地暂存（localStorage）：刷新后恢复未提交的答案与页码。
// 服务端仍是作答的唯一权威数据源，暂存只是前端便利：换设备/清缓存即丢失属预期。
// key 按「问卷 + empId」隔离，拿不到 empId 时调用方不得读写（避免同设备换人串答案）。
// 恢复时以服务端 live 结构逐格过滤（restoreDraftCells），问卷被就地编辑后不会恢复出失效答案。

// 单格答案：单选/矩阵用 optionId（评语放 text）；文本题用 text。与 answer.vue 的 CellAnswer 同构。
export interface DraftCell {
  optionId: number;
  text: string;
}

// questionId → relationId → 单格答案。
export type DraftCells = Record<number, Record<number, DraftCell>>;

export interface AnswerDraft {
  savedAt: number;
  pageIndex: number;
  answers: DraftCells;
}

const keyPrefix = 'linapro:eval360:answer-draft:';

// 暂存有效期：超过即视为过期，读取时丢弃并在页面加载时顺带清理。
export const draftTTL = 7 * 24 * 60 * 60 * 1000;

function storage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

export function draftKey(questionnaireId: number, empId: number): string {
  return `${keyPrefix}${questionnaireId}:${empId}`;
}

function isExpired(draft: AnswerDraft, now: number): boolean {
  return !(draft.savedAt > 0) || now - draft.savedAt > draftTTL;
}

function parseDraft(raw: null | string): AnswerDraft | undefined {
  if (!raw) return undefined;
  try {
    const draft = JSON.parse(raw) as AnswerDraft;
    if (
      !draft ||
      typeof draft !== 'object' ||
      typeof draft.answers !== 'object'
    ) {
      return undefined;
    }
    return draft;
  } catch {
    return undefined;
  }
}

// loadDraft 读取暂存；不存在、损坏或已过期返回 undefined（损坏/过期的顺手删除）。
export function loadDraft(
  key: string,
  now = Date.now(),
): AnswerDraft | undefined {
  const store = storage();
  if (!store) return undefined;
  const draft = parseDraft(store.getItem(key));
  if (!draft || isExpired(draft, now)) {
    store.removeItem(key);
    return undefined;
  }
  return draft;
}

// saveDraft 写入暂存；无任何答案时改为删除，避免留下空壳。
// 存储配额满或被禁用（隐私模式）时静默放弃：暂存只是便利，不能影响作答。
export function saveDraft(
  key: string,
  answers: DraftCells,
  pageIndex: number,
  now = Date.now(),
) {
  const store = storage();
  if (!store) return;
  const hasCell = Object.values(answers).some(
    (row) => Object.keys(row).length > 0,
  );
  if (!hasCell) {
    store.removeItem(key);
    return;
  }
  const draft: AnswerDraft = { answers, pageIndex, savedAt: now };
  try {
    store.setItem(key, JSON.stringify(draft));
  } catch {
    // 配额满等异常：放弃本次暂存。
  }
}

export function clearDraft(key: string) {
  storage()?.removeItem(key);
}

// pruneExpiredDrafts 清理所有过期或损坏的作答暂存（含其他问卷/其他员工的）。
export function pruneExpiredDrafts(now = Date.now()) {
  const store = storage();
  if (!store) return;
  const stale: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key?.startsWith(keyPrefix)) continue;
    const draft = parseDraft(store.getItem(key));
    if (!draft || isExpired(draft, now)) stale.push(key);
  }
  for (const key of stale) store.removeItem(key);
}

// pickPendingCells 从页面答案中只取未提交行，作为暂存内容（已提交行以服务端回显为准，不暂存）。
export function pickPendingCells(
  answers: DraftCells,
  pendingIds: number[],
): DraftCells {
  const pending = new Set(pendingIds);
  const out: DraftCells = {};
  for (const [qid, row] of Object.entries(answers)) {
    for (const [rid, cell] of Object.entries(row)) {
      if (!pending.has(Number(rid))) continue;
      (out[Number(qid)] ??= {})[Number(rid)] = cell;
    }
  }
  return out;
}

// restoreCell 按题目 live 结构校验单格，无效返回 undefined。
// 评语只在所选选项/评价项允许评语时保留，与提交口径（commentFor）一致。
function restoreCell(q: QuestionNode, cell: DraftCell): DraftCell | undefined {
  const text = typeof cell?.text === 'string' ? cell.text : '';
  if (q.type === 'text_short' || q.type === 'text_long') {
    return text ? { optionId: 0, text } : undefined;
  }
  const optionId = Number(cell?.optionId) || 0;
  if (q.type === 'matrix') {
    const col = q.matrixColumns.find((c) => c.id === optionId);
    if (!col) return undefined;
    return { optionId, text: col.allowComment === 1 ? text : '' };
  }
  const opt = q.options.find((o) => o.id === optionId);
  if (!opt) return undefined;
  return { optionId, text: opt.allowText === 1 ? text : '' };
}

// restoreDraftCells 以服务端 live 结构过滤暂存：只保留「关系仍未提交 + 仍在该题可见行 +
// 选项/评价项仍存在」的格子；题目已删、关系已提交或已不可见的一律丢弃。
export function restoreDraftCells(
  cells: DraftCells,
  questions: QuestionNode[],
  pendingIds: number[],
): DraftCells {
  const pending = new Set(pendingIds);
  const out: DraftCells = {};
  for (const q of questions) {
    const row = cells[q.id];
    if (!row) continue;
    for (const rid of q.rowRelationIds) {
      if (!pending.has(rid) || !row[rid]) continue;
      const cell = restoreCell(q, row[rid]);
      if (cell) (out[q.id] ??= {})[rid] = cell;
    }
  }
  return out;
}
