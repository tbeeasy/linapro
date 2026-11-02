# 考勤员工端数据权限设计

> 制定日期：2026-08-10 / 修订日期：2026-11-02
> 关联文档：[ADR 0003 飞书长连接接入](../adr/0003-feishu-ws-lifecycle-constraints.md)
>
> 目标：设计考勤插件的**员工端数据权限层**（主管看部门、员工看自己），基于 `linapro-employee-core` 提供的身份能力，**不再自建认证链**。

> ⚠️ **前提注记（2026-11-02）**：本文设计依赖员工部门数据，而 `linapro-employee-core` 目前**不下发部门**——Moka 同步不含部门、登录也不写部门，`employee_dept` 恒为空（见该变更规格「部门归属作为预留的员工身份属性」）。所以「主管看部门」这条链现在跑不通。
>
> 本文描述的是**部门数据接通之后的目标状态**，尚未实现（`applyEmpScope`、`resolveManagerScope` 在代码中均无对应实现）。保留它的原因是：员工端接口清单、数据范围过滤逻辑、打卡事件盖主部门章这些设计在 OpenSpec 的 `linapro-employee-core` 规格里没有对应内容，重想一遍要花时间。**定位是考勤正式插件走 OpenSpec 时的输入材料，不是已落地的实现记录。**

## 一、职责边界

认证/身份由 `linapro-employee-core` 插件统一提供，考勤插件作为消费方：

| 职责 | 由谁负责 |
|---|---|
| 飞书免登、换 open_id | `linapro-employee-core` |
| 员工表（EmpID、status、部门归属） | `linapro-employee-core`（`plugin_linapro_employee_core_employee*`） |
| JWT 签发/校验、`EmpAuth()` 中间件 | `linapro-employee-core`（`cap/empcap`） |
| `EmpContext{EmpID, TenantID}` 注入 | `linapro-employee-core` |
| **数据权限过滤（self/dept/tenant）** | **考勤插件**（本文范围） |
| 打卡事件盖「主部门」章 | **考勤插件** |
| 主管子树解析（`resolveManagerScope`） | **考勤插件** |

`sys_user` + RBAC 继续只服务登录后台的管理员。员工不进 `sys_user`。

## 二、考勤插件如何消费 empcap

考勤插件的员工端路由挂 `empcap.EmpAuth()` 中间件，之后从 ctx 取 `EmpContext`：

```go
// empcap.EmpContext 由 linapro-employee-core 注入，只含身份，不含权限
// type EmpContext struct {
//     EmpID    int
//     TenantID int
// }
emp, ok := empcap.EmpFromContext(ctx)
```

数据权限（scope、managed dept）不在 `EmpContext` 里，由考勤插件**自建补充表**存储：

```sql
-- 考勤员工权限扩展表（考勤插件自建，emp_id 引用 employee-core 的 EmpID）
CREATE TABLE IF NOT EXISTS plugin_attendance_employee_scope (
    "tenant_id"        INT      NOT NULL DEFAULT 0,
    "emp_id"           INT      NOT NULL,                    -- 引用 employee-core EmpID
    "scope"            SMALLINT NOT NULL DEFAULT 4,          -- 2=tenant 3=dept 4=self
    "primary_dept_id"  INT      NOT NULL DEFAULT 0,          -- 主部门（org-core 部门 ID）
    "managed_dept_ids" VARCHAR(256) NOT NULL DEFAULT '',     -- 主管负责的部门根，逗号分隔
    "updated_at"       TIMESTAMPTZ,
    PRIMARY KEY ("tenant_id", "emp_id")
);
```

**字段说明**：

- `scope`：数据范围枚举，对齐 `sys_role.data_scope`。普通员工 `4`(self)、部门主管 `3`(dept)、区域管理员 `2`(tenant)。
- `primary_dept_id`：主部门冗余，供打卡事件盖章。值来自 empcap 部门表 `employee_dept` 中 `is_primary=1` 的行，通过「Lark dept id → org-core dept id」映射换算（依赖主动同步功能，见风险 R1）。
- `managed_dept_ids`：主管负责的部门根列表，从飞书「部门负责人」字段同步，或后台手工配。普通员工为空。

> **归属 vs 管辖是两码事**：`employee-core` 的 `employee_dept` 是「这个人**属于**哪些部门」；`managed_dept_ids` 是「这个人作为主管**管**哪些部门」。二者常不一致——王五主部门可能是「大区总经办」，却管着「上海+杭州两个分公司」。前者由 core 管，后者考勤自建。

## 三、员工端接口清单（MVP）

| 接口 | 方法 | 中间件 | 说明 |
|---|---|---|---|
| `/api/v1/attend/emp/login` | POST | 无（公开） | **由 employee-core 提供**，考勤不重复建 |
| `/api/v1/attend/emp/me` | GET | `empcap.EmpAuth()` | **由 employee-core 提供**，返回员工身份+部门 |
| `/api/v1/attend/emp/events` | GET | `empcap.EmpAuth()` | 打卡记录列表，套 `applyEmpScope` |
| `/api/v1/attend/emp/summary` | GET | `empcap.EmpAuth()` | 本人/本部门考勤汇总，套同一过滤 |

考勤插件的员工端路由只挂 `empcap.EmpAuth()`，**不挂**宿主 `middlewares.Permission()`（员工无按钮权限码体系）。管理端路由沿用 `Auth()` + `Permission()`。

## 四、数据范围过滤纯函数

考勤插件持有 `applyEmpScope`，管理端和员工端共用：

```go
// applyEmpScope 按数据范围收窄查询。
//
// scope 语义对齐 sys_role.data_scope：
//   2(tenant) → 不加行级过滤（租户过滤已由 ApplyPluginTableFilter 完成）
//   3(dept)   → WHERE dept_id IN (管辖各部门根的子树并集)；空集时降级 self
//   4(self)   → WHERE user_id = userID
//   其他       → fail-closed（返回零行）
func applyEmpScope(model *gdb.Model, scope, userID int, deptIDs []int) *gdb.Model {
    switch scope {
    case dataScopeTenant: // 2
        return model
    case dataScopeDept: // 3
        if len(deptIDs) == 0 {
            return model.Where(colUserID, userID)
        }
        return model.WhereIn(colDeptID, deptIDs)
    case dataScopeSelf: // 4
        return model.Where(colUserID, userID)
    default:
        return model.Where("1=0") // fail-closed
    }
}
```

### 两端如何各自调用

**管理端**（主体来自 bizctx，不变）：

```go
current := s.bizCtxSvc.Current(ctx)
if !current.PlatformBypass {
    var deptIDs []int
    if current.DataScope == dataScopeDept && s.orgSvc.Available(ctx) {
        deptIDs, _ = s.orgSvc.Assignment().GetUserDeptIDs(ctx, current.UserID)
    }
    model = applyEmpScope(model, current.DataScope, current.UserID, deptIDs)
}
```

**员工端**（主体来自 empcap，scope 从考勤补充表查）：

```go
emp, _ := empcap.EmpFromContext(ctx)
// 从考勤补充表取 scope + managed_dept_ids
empScope, _ := s.getEmpScope(ctx, emp.TenantID, emp.EmpID)
var deptIDs []int
if empScope.Scope == dataScopeDept {
    deptIDs, _ = s.resolveManagerScope(ctx, empScope)
}
model = applyEmpScope(model, empScope.Scope, emp.EmpID, deptIDs)
```

### 主管多部门：resolveManagerScope 取子树并集

```go
func (s *serviceImpl) resolveManagerScope(ctx context.Context, empScope EmpScopeRow) ([]int, error) {
    roots := parseDeptIDs(empScope.ManagedDeptIDs)
    if len(roots) == 0 {
        roots = []int{empScope.PrimaryDeptID}
    }
    all := map[int]struct{}{}
    for _, root := range roots {
        sub, err := s.resolveDeptSubtree(ctx, root)
        if err != nil {
            return nil, err
        }
        for _, id := range sub {
            all[id] = struct{}{}
        }
    }
    return keys(all), nil
}

func (s *serviceImpl) resolveDeptSubtree(ctx context.Context, rootDeptID int) ([]int, error) {
    if !s.orgSvc.Available(ctx) {
        return []int{rootDeptID}, nil
    }
    tree, err := s.orgSvc.Department().ListTree(ctx, orgcap.DeptTreeInput{})
    if err != nil {
        return nil, err
    }
    node := findNode(tree.Items, rootDeptID)
    if node == nil {
        return []int{rootDeptID}, nil
    }
    var ids []int
    var walk func(n *orgcap.DeptTreeNode)
    walk = func(n *orgcap.DeptTreeNode) {
        ids = append(ids, n.Id)
        for _, c := range n.Children {
            walk(c)
        }
    }
    walk(node)
    return ids, nil
}
```

> `ListTree` 有 500 节点上限（`MaxDeptTreeNodes`）。超限改用 `Department().List()` 扁平列表 + 内存 BFS。
> 若业务只需「直属部门、不含下级」，`resolveDeptSubtree` 退化为 `[]int{root}`。**是否含下级是业务决策，须先定。**

## 五、打卡事件盖「主部门」章

员工可能属于多部门，但打卡事件表的 `dept_id` **只盖主部门这一个值**：

```
李四: 主部门=103(销售)，兼属=104(技术)
      ↓ 每次打卡落库
plugin_attendance_event(user_id=李四.EmpID, dept_id=103)   ← 只盖 primary_dept_id
```

理由：事件 `dept_id` 保持单值，`WHERE dept_id IN (子树)` 过滤不变；语义清晰——销售线主管看得到他、技术线主管看不到。若确需「兼职部门主管也能看到」需改多对多，复杂度陡增，**除非业务明确要求，否则不做**。

> **口径一致性约束**（落地须在同步与落库处校验）：
> - 打卡事件表 `user_id` 存 `empcap` 的 `EmpID`（**不是** `sys_user.id`）
> - 打卡事件表 `dept_id` 存打卡时的 `primary_dept_id`（org-core 部门 ID）
> - `primary_dept_id`、`managed_dept_ids`、事件 `dept_id` 全部是**同一套 org-core 部门编号**

## 六、风险与落地校验点

| # | 风险 | 说明 | 落地前动作 |
|---|---|---|---|
| R1 | **Lark dept id → org-core dept id 映射** | `employee-core` 当前存 `lark_department_id`；`primary_dept_id`、`managed_dept_ids` 需 org-core 整数 ID。映射由主动同步功能维护，本变更尚未实现。 | 同步任务须维护「Lark 部门 ↔ org-core 部门 ID」映射表，完成前 `primary_dept_id` 可为 0（降级 self） |
| R2 | **考勤补充表的初始化** | `plugin_attendance_employee_scope` 的 `scope`/`managed_dept_ids` 需由飞书同步或后台手工填入；未填则默认 `4`(self) 降级。 | 同步任务维护此表；或后台提供手工配置页 |
| R3 | **多部门归属业务口径** | ① 兼职部门主管能否看到该员工？② 主管「管哪些部门」怎么定？ | ① 默认否（只盖主部门章）；② 飞书部门负责人自动同步 / 后台手工配 |
| R4 | **`ListTree` 子树展开** | 500 节点上限。单租户通常远小于此。 | 超限改扁平列表 + 内存 BFS |
| R5 | **回调/定时任务中 open_id→EmpID 解析** | 由 employee-core 的唯一索引 `(tenant_id, lark_open_id)` 查询，trivial；但需先确认 employee-core 暴露此查询接口。 | empcap 是否暴露 `ResolveByOpenID` 在 employee-core 的 tasks 中确认 |

## 七、一句话总结

> 认证/身份完全委托 `linapro-employee-core`（empcap），考勤插件通过 `empcap.EmpAuth()` 中间件取得 `EmpContext{EmpID, TenantID}`，再从自建的 `plugin_attendance_employee_scope` 表查出 scope 和管辖部门，驱动 `applyEmpScope` 纯函数过滤。打卡事件盖主部门章保持 `dept_id` 单值；主管可见范围 = 管辖各部门根的子树并集（`ListTree` 展开）。
