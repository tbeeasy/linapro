// me.ts 当前员工身份（需 JWT）。刷新内存 profile。
import type { EmpProfile } from '#/store/emp-auth';

import { pluginApiPath } from '#/api/request';

import { empRequestClient } from './request';

// 员工身份接口由 linapro-employee-core 插件提供（插件路由前缀 /x/<plugin-id>/api/v1）。
const employeeCorePluginId = 'linapro-employee-core';

export interface EmpMeResult {
  empId: number;
  tenantId: number;
  name: string;
  mokaEmployeeNo: string;
  status: number;
  departmentIds: number[];
}

export function empMeApi() {
  return empRequestClient.get<EmpMeResult>(
    pluginApiPath(employeeCorePluginId, 'emp/me'),
  );
}

export function toEmpProfile(res: EmpMeResult): EmpProfile {
  return {
    empId: res.empId,
    tenantId: res.tenantId,
    name: res.name,
    mokaEmployeeNo: res.mokaEmployeeNo,
  };
}
