// emp-model.ts eval-360 员工端 TS 类型，镜像 backend/api/emp/v1/todo.go。
// 注意：score 以 string 承载 NUMERIC；allowText/required 为 int(0/1)。
// 作答按问卷聚合：一份问卷一条待办，进入后一屏批量作答名下全部被评估人。

export type QuestionType =
  | 'matrix'
  | 'single_choice'
  | 'text_long'
  | 'text_short';

export type DerivedStatus = 'filled' | 'pending' | 'voided';

export interface TodoItem {
  questionnaireId: number;
  projectId: number;
  projectName: string;
  questionnaireTitle: string;
  startAt: null | number; // 项目开始时间，Unix 毫秒时间戳
  endAt: null | number; // Unix 毫秒时间戳
  total: number; // 名下被评估人总数
  completedCount: number; // 已提交人数
  derivedStatus: DerivedStatus;
  evaluatees: TodoEvaluatee[]; // 名下被评估人明细（按关系 id 升序）
}

// 待办下的一个被评估人（对应一条评价关系）。
export interface TodoEvaluatee {
  relationId: number;
  evaluateeName: string;
  jobTitle: string;
  department: string;
  roleName: string;
  submitted: boolean;
}

export interface OptionNode {
  id: number;
  label: string;
  score: string;
  allowText: number;
  sort: number;
}

export interface MatrixColumnNode {
  id: number;
  label: string;
  score: string;
  sort: number;
  // 评语配置：allowComment 为开关；commentRequired 仅开关开启时生效（提交时校验）；
  // commentPlaceholder 为评语输入框占位提示；commentPresets 为空表示无预设（自由输入）；
  // commentAllowCustom 表示有预设时是否还允许自定义输入。
  allowComment: number;
  commentRequired: number;
  commentPlaceholder: string;
  commentPresets: string[];
  commentAllowCustom: number;
}

export interface QuestionNode {
  id: number;
  dimensionId: number;
  type: QuestionType;
  title: string;
  description: string;
  required: number;
  sort: number;
  options: OptionNode[];
  matrixColumns: MatrixColumnNode[];
  // 该题要渲染的被评估人行（评价关系 id），服务端已判定可见性，前端只照着渲染。
  rowRelationIds: number[];
}

export interface DimensionNode {
  id: number;
  name: string;
  sort: number;
  questions: QuestionNode[];
}

export interface EvaluateeRow {
  relationId: number;
  evaluateeName: string;
  roleName: string;
  submitted: boolean;
}

export interface SubmittedAnswer {
  relationId: number;
  questionId: number;
  optionId: number;
  textValue: string;
}

export interface QuestionnaireSet {
  questionnaireId: number;
  questionnaireTitle: string;
  evaluatees: EvaluateeRow[];
  dimensions: DimensionNode[];
  submittedAnswers: SubmittedAnswer[];
  closed: boolean; // 项目已截止
}

export interface AnswerDTO {
  questionId: number;
  optionId: number; // 单选选项 id / 矩阵列 id / 文本为 0
  textValue: string; // 文本答案 或 选项级评语
}

export interface SubmitItemDTO {
  relationId: number;
  answers: AnswerDTO[];
}

export interface SubmitResult {
  submittedCount: number;
  submittedAt: null | number; // Unix 毫秒时间戳
  idempotent: boolean;
}
