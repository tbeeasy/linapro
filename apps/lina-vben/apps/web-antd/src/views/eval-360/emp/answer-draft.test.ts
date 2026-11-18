import type { QuestionNode } from '#/api/eval-360/emp-model';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearDraft,
  draftKey,
  draftTTL,
  loadDraft,
  pickPendingCells,
  pruneExpiredDrafts,
  restoreDraftCells,
  saveDraft,
} from './answer-draft';

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

describe('answer-draft 读写与过期', () => {
  beforeEach(() => localStorage.clear());

  it('key 按问卷 + 员工隔离', () => {
    expect(draftKey(10, 1)).not.toBe(draftKey(10, 2));
    expect(draftKey(10, 1)).not.toBe(draftKey(11, 1));
  });

  it('写入后可读回；无答案时删除而不是留空壳', () => {
    const key = draftKey(10, 1);
    saveDraft(key, { 1: { 100: { optionId: 0, text: '答案' } } }, 2, 1000);
    expect(loadDraft(key, 1000)).toEqual({
      answers: { 1: { 100: { optionId: 0, text: '答案' } } },
      pageIndex: 2,
      savedAt: 1000,
    });
    saveDraft(key, { 1: {} }, 0, 1000);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('过期或损坏的暂存读取时丢弃并删除', () => {
    const key = draftKey(10, 1);
    saveDraft(key, { 1: { 100: { optionId: 0, text: 'x' } } }, 0, 1000);
    expect(loadDraft(key, 1000 + draftTTL + 1)).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();

    localStorage.setItem(key, '{broken');
    expect(loadDraft(key)).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('pruneExpiredDrafts 只清理本模块过期 key，不碰其他存储', () => {
    const fresh = draftKey(10, 1);
    const stale = draftKey(11, 2);
    saveDraft(fresh, { 1: { 100: { optionId: 0, text: 'a' } } }, 0, draftTTL);
    saveDraft(stale, { 1: { 100: { optionId: 0, text: 'b' } } }, 0, 1);
    localStorage.setItem('linapro:emp-auth-token', 'token');

    pruneExpiredDrafts(draftTTL + 10);
    expect(localStorage.getItem(fresh)).not.toBeNull();
    expect(localStorage.getItem(stale)).toBeNull();
    expect(localStorage.getItem('linapro:emp-auth-token')).toBe('token');

    clearDraft(fresh);
    expect(localStorage.getItem(fresh)).toBeNull();
  });
});

describe('answer-draft 恢复过滤', () => {
  const single = question({
    id: 1,
    options: [
      { allowText: 1, id: 11, label: '优秀', score: '5', sort: 0 },
      { allowText: 0, id: 12, label: '良好', score: '4', sort: 1 },
    ],
    rowRelationIds: [100, 101],
    type: 'single_choice',
  });
  const text = question({ id: 2, rowRelationIds: [100] });

  it('只暂存未提交行', () => {
    expect(
      pickPendingCells(
        {
          1: {
            100: { optionId: 11, text: '' },
            200: { optionId: 12, text: '' },
          },
        },
        [100],
      ),
    ).toEqual({ 1: { 100: { optionId: 11, text: '' } } });
  });

  it('丢弃已提交行、不可见行、失效选项与已删题；评语只在允许评语时保留', () => {
    const restored = restoreDraftCells(
      {
        1: {
          100: { optionId: 11, text: '配合度高' },
          // 选项已删除。
          101: { optionId: 99, text: '' },
          // 已不在该题可见行。
          102: { optionId: 11, text: '' },
        },
        2: {
          // 关系已在别处提交。
          300: { optionId: 0, text: '已提交' },
          100: { optionId: 0, text: '文本' },
        },
        // 题目已删除。
        9: { 100: { optionId: 0, text: '旧题' } },
      },
      [single, text],
      [100, 101, 102],
    );
    expect(restored).toEqual({
      1: { 100: { optionId: 11, text: '配合度高' } },
      2: { 100: { optionId: 0, text: '文本' } },
    });

    // 所选选项已改为不允许评语：评语不随之恢复。
    expect(
      restoreDraftCells(
        { 1: { 100: { optionId: 12, text: '残留评语' } } },
        [single],
        [100],
      ),
    ).toEqual({ 1: { 100: { optionId: 12, text: '' } } });
  });

  it('矩阵按评价项校验', () => {
    const matrix = question({
      id: 3,
      matrixColumns: [
        {
          allowComment: 1,
          commentAllowCustom: 0,
          commentPlaceholder: '',
          commentPresets: [],
          commentRequired: 0,
          id: 31,
          label: '优秀',
          score: '5',
          sort: 0,
        },
      ],
      type: 'matrix',
    });
    expect(
      restoreDraftCells(
        { 3: { 100: { optionId: 31, text: '评语' } } },
        [matrix],
        [100],
      ),
    ).toEqual({ 3: { 100: { optionId: 31, text: '评语' } } });
    expect(
      restoreDraftCells(
        { 3: { 100: { optionId: 32, text: '' } } },
        [matrix],
        [100],
      ),
    ).toEqual({});
  });
});
