// login.ts 员工登录 API（飞书 code 换 JWT）。公开接口，无需会话。
import type { EmpProfile } from '#/store/emp-auth';

import { pluginApiPath } from '#/api/request';

import { empRequestClient } from './request';

// 员工认证接口由 linapro-employee-core 插件提供，挂在插件路由前缀 /x/<plugin-id>/api/v1 下。
const employeeCorePluginId = 'linapro-employee-core';

export interface EmpLoginInput {
  larkAppId: string;
  code: string;
}

export interface EmpLoginResult {
  token: string;
  empId: number;
  tenantId: number;
  openId: string;
  name: string;
  mokaEmployeeNo: string;
}

export function empLoginApi(input: EmpLoginInput) {
  return empRequestClient.post<EmpLoginResult>(
    pluginApiPath(employeeCorePluginId, 'emp/login'),
    input,
  );
}

// 把登录结果转为 profile（存 store 内存）。
export function toEmpProfile(res: EmpLoginResult): EmpProfile {
  return {
    empId: res.empId,
    tenantId: res.tenantId,
    openId: res.openId,
    name: res.name,
    mokaEmployeeNo: res.mokaEmployeeNo,
  };
}
