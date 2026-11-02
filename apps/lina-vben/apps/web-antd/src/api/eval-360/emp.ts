import type * as Model from './emp-model';

import { empRequestClient } from '#/api/emp/request';
import { pluginApiPath } from '#/api/request';

// emp.ts eval-360 员工端 API（/x/linapro-eval-360/api/v1/eval/emp/*）。
// 用 pluginApiPath 拼绝对路径（带 origin），axios 原样使用。

const pluginID = 'linapro-eval-360';

function evalEmpApi(pathName: string) {
  return pluginApiPath(pluginID, `eval/emp/${pathName}`);
}

export function evalEmpTodo() {
  return empRequestClient.get<{ list: Model.TodoItem[] }>(evalEmpApi('todo'));
}

export function evalEmpQuestions(questionnaireId: number) {
  return empRequestClient.get<{ set: Model.QuestionnaireSet }>(
    evalEmpApi('questions'),
    { params: { questionnaireId } },
  );
}

// 批量提交：items 为页面加载时展示的全部未提交被评估人，单事务全成全败。
export interface EmpSubmitInput {
  questionnaireId: number;
  durationSeconds: number;
  items: Model.SubmitItemDTO[];
}

export function evalEmpSubmit(input: EmpSubmitInput) {
  return empRequestClient.post<Model.SubmitResult>(evalEmpApi('submit'), input);
}

export function evalEmpWhoami() {
  return empRequestClient.get<{ empId: number; tenantId: number }>(
    evalEmpApi('whoami'),
  );
}
