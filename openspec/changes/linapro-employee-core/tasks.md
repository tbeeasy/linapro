## 1. 模块骨架

- [x] 1.1 创建 `apps/lina-plugins/linapro-employee-core/`，照抄 `linapro-extlogin-core` 结构
- [x] 1.2 编写 `go.mod`（module `lina-plugin-linapro-employee-core`，require `gogf/gf/v2 v2.10.1`、`golang-jwt/jwt/v5 v5.3.1`、`larksuite/oapi-sdk-go/v3`、`lina-core v0.0.0`，`replace lina-core => ../../lina-core`）
- [x] 1.3 编写 `plugin_embed.go`（`//go:embed plugin.yaml manifest`）
- [x] 1.4 编写 `plugin.yaml`（`type: source`、`distribution: managed`、i18n）
- [x] 1.5 编写 `Makefile` 与 README

## 2. 数据库 Schema（linapro-employee-core）

- [x] 2.1 `manifest/sql/001-...schema.sql`：`plugin_linapro_employee_core_employee`（EmpID 主键、`tenant_id`、`name`、`employee_no`、`status`、`sys_user_id`、时间戳），唯一索引 `uk(tenant_id, lark_open_id)`
- [x] 2.2 同脚本追加 `plugin_linapro_employee_core_employee_dept`（`emp_id`、`lark_department_id`、`is_primary`）
- [x] 2.3 同脚本追加 `plugin_linapro_employee_core_lark_app`（`tenant_id` 主键、`app_id`、`app_secret`、`allow_auto_provision`、时间戳）
- [x] 2.4 `manifest/sql/uninstall/001-...schema.sql`（同名同编号 DROP 三表）
- [x] 2.5 生成 DAO/DO/entity（`internal/dao`、`internal/model/{do,entity}`）

## 3. 写入网关与员工查询（linapro-employee-core）

- [x] 3.1 core 写入网关：`ResolveEmployee`（get-or-create：查到不覆盖资料、未查到按 `allowCreate` 建初始快照/拒）、`UpsertEmployee`（同步用，覆盖资料）、`MarkDeparted`，守 EmpID/去重/status 不变量
- [x] 3.2 员工查询：ByID/ByOpenID，返回身份含部门
- [x] 3.3 单测：已存在不覆盖资料 / allowCreate 首建 / 非 allowCreate 拒 / UpsertEmployee 覆盖 / 多部门与主部门（2026-08-14：改为真·集成测试 `employee_integration_test.go`，按插件 DB 测试惯例（仿 extlogin-core identity 测试）连本地 Postgres、`CREATE TABLE IF NOT EXISTS`、按唯一 tenant 隔离并自清理。5 个用例全绿，覆盖 `uk(tenant_id,lark_open_id)` 存活行去重、部门替换、事务写入等只有真库能证的不变量。go.mod 经 `go mod tidy` 补入 pgsql 驱动 indirect 依赖（与 extlogin-core 同款：gf v2.10.1 + pgsql v2.10.0）。）

## 4. cap/empcap 公共门面包（linapro-employee-core）

- [x] 4.1 `empcap.go`：宽接口 `Service`（员工解析/查询含部门）+ `EmpContext{EmpID,TenantID}` + `OwnerPluginID`
- [x] 4.2 `empcap_facade.go`：进程级 facade + `BindEmployeeService` + pending 缓冲（照抄 `extidcap_catalog.go`）
- [x] 4.3 `empcap_code.go`：bizerr 错误码
- [x] 4.4 单测：Bind 前 Register→Bind 后 flush 往返；编译期 `var _ empcap.Service` 断言

## 5. Lark 凭证与真登录（linapro-employee-core）

- [x] 5.1 租户级凭证+开关读取：按 `tenant_id` 查 `_lark_app`（`app_id`/`app_secret`/`allow_auto_provision`）；凭证缺失 fail-closed；secret mask 惯例（参考 oidc-google settings）
- [x] 5.2 `internal/lark/`：provider 接口 `ExchangeCode(ctx, tenantID, code)` + 取用户信息（姓名/部门）方法，用真 `larksuite/oapi-sdk-go/v3` 实现；Lark 细节不外泄
- [x] 5.3 `internal/controller/emp/`：`/emp/login`（编排 换 open_id→取信息→ResolveEmployee(allowCreate=开关)→签 JWT；已存在不覆盖资料）、`/emp/me`
- [x] 5.4 单测：登录编排用 fake provider（开关开首登建、已存在不改资料、开关关拒未登记、无效 code 失败）；凭证缺失 fail-closed
- [ ] 5.5 真机联调（独立验收）：真 Lark App + 设备跑通免登→登录→拿到含部门身份

## 6. 员工 JWT 与 EmpAuth（linapro-employee-core）

- [x] 6.1 `empcap_auth.go`：`WithEmpContext`/`EmpFromContext`
- [x] 6.2 员工 JWT 签发/校验（HS256、独立 Claims、2h），仿宿主 `auth_impl.go`
- [x] 6.3 JWT 密钥读独立键 `plugin.linapro-employee-core.emp_jwt_secret`；缺失 fail-closed
- [x] 6.4 `EmpAuth()`：每请求验签 →按 EmpID 查 status →离职即拒 →注入 `EmpContext`
- [x] 6.5 单测：往返（2h 过期）；员工/管理员密钥隔离；离职员工持未过期 token 被拦；密钥缺失 fail-closed

## 7. 装配与门禁

- [x] 7.1 `plugin.go`：`init()` 中 `empcap.BindEmployeeService(shared)` → `NewDeclarations` → 注册 `/emp/*` 路由组（挂 `empcap.EmpAuth()`，登录接口除外，不挂宿主 Auth/Permission）→ `RegisterSourcePlugin`
- [x] 7.2 DI 来源检查记录：新增依赖 owner、创建位置、传递路径、是否复用启动期共享实例
- [x] 7.3 `cd apps/lina-plugins/linapro-employee-core && go build ./...` 编译通过
- [x] 7.4 `go test ./...` 全部单测通过
- [x] 7.5 `openspec validate employee-core-extraction --strict` 通过
- [x] 7.6 影响分析记录：i18n、缓存一致性、数据权限、跨平台、测试策略（无影响项显式标注）
- [x] 7.7 调用 `lina-review` 完成代码与规范审查（2026-08-13：读 AGENTS.md + 9 个命中规则域并行审 + 跑门禁；8 个 severe 全部修复——i18n bizerr/manifest/apidoc×3、EmpId int→int64×2、写网关事务×1、README.zh-CN×1、lark bizerr；`make lint`/`make i18n.check`(本插件)/`openspec validate --strict`/`go build,test` 全绿。剩余 warning 见记忆 employee-core-impl-status，非阻塞。）

## 8. Schema 迁移（linapro-employee-core）

- [x] 8.1 修改 `manifest/sql/001-...schema.sql`：employee 表唯一键从 `uk(tenant_id, lark_open_id)` 改为 `uk(tenant_id, employee_no)`；`lark_open_id` 改为可空列（去掉 NOT NULL）；`employee_no` 改为 NOT NULL（2026-10-29 对齐：已按变更后的设计完成——唯一键为存活行上的 `(tenant_id, moka_employee_no)`（仅非空工号）；`lark_open_id` 未降为可空列，而是 FB-2 整列移出员工表、改存 `lark_identity`）
- [x] 8.2 新增迁移脚本 `manifest/sql/002-...migrate-uk.sql`：`ALTER TABLE` 删旧唯一索引、加新唯一索引、调整列约束（供已安装实例升级用）（2026-10-29 对齐：已取代、未按原文实现——项目无兼容性负担，`001` 直接改为最终 schema，仓库中不存在 `002` 迁移；早期已安装实例的增量迁移为 `003`（lark_user_id）、`004`（id_source））
- [x] 8.3 同步更新 entity/do/dao（重新生成或手工调整 `entity/employee.go`、`do/employee.go` 对应字段 tag）（2026-10-29 对齐：已完成，见 FB-6（`make dao` 真库重生成））
- [x] 8.4 改写集成测试 `employee_integration_test.go`：将"存活行去重"用例语义改为 `uk(tenant_id, employee_no)`；登录查询改为按 open_id 过滤的测试用例保持不变（open_id 是查询键，不再是唯一键）（2026-10-29 对齐：已完成，`TestUpsertDedupsByEmployeeNo` 验证 `(tenant_id, moka_employee_no)` 去重）

## 9. Moka 全量同步 Job（linapro-employee-core）

- [x] 9.1 `go.mod` 追加 `require lina-plugin-linapro-moka-hcm v0.0.0` 和 `replace lina-plugin-linapro-moka-hcm => ../linapro-moka-hcm`（依赖 change `linapro-moka-hcm` 先完成，提供 `ListAllEmployees`）（2026-10-29 对齐：已完成，go.mod 已含 require + replace）
- [x] 9.2 新增 `internal/sync/` 包：`syncer.go` 编排全量同步流程（Moka 拉全量 → 排序 → Upsert → 飞书 JOIN → 回填 open_id → 对账离职）（2026-10-29 对齐：已完成；实际匹配键为工号，非原文的姓名 JOIN（见 FB-12/FB-20））
- [x] 9.3 `internal/sync/moka.go`：调 `hcm.Client.ListAllEmployees`，读 `sys_config` 键 `plugin.linapro-employee-core.dept_tenant_map`（JSON `{"部门ID": tenant_id}`）做部门→租户映射；`department_id` 不在映射表的员工记 warning + 跳过（2026-10-29 对齐：已完成，但与原文有两处差异——Moka 拉取在 `syncer.go` + `plugin_sync.go` 适配器中实现，`moka.go` 仅为说明；`dept_tenant_map` 的键是 Moka 部门路径的顶层部门名，而非部门 ID）
- [x] 9.4 `internal/sync/lark.go`：枚举飞书 own 租户（`contact.User.List`，需 `contact:contact:readonly` scope）+ 关联组织（`directory.CollaborationTenant.List` 列关联组织 + 递归 `directory.CollaborationShareEntity.List` 拉各租户共享成员，`Source="assoc"`；**app 级配置开关 gating**，默认关，仅对写表格所需 app 开启；关联组织枚举 soft-fail 不阻断同步）。按姓名 JOIN（JOIN 前 trim + 全/半角归一）；每 open_id 各 upsert 一行 `lark_identity`（own/assoc 分别落 `id_source`），均指向同一 emp_id。**删除**原"同名对应多个 open_id 记 warning 两条都不写"的折叠逻辑——真实歧义由姓名→emp 层兜底（该层已确认不触发）。【注：FB-5 曾删除关联组织枚举改为 own-only；本任务按最终设计（D15/D17/D19/D20）重新引入，仅用于写人员字段、非登录。】
- [x] 9.5 `internal/sync/lark.go`：飞书同一员工在 own 租户和关联组织都出现时，各写一行 `lark_identity`（`id_source` 分别 `own`/`assoc`），均指向同一 emp_id——**不判歧义、不跳过**（原"记 warning + 只取 own"语义废弃，见 D15/D20）。
- [x] 9.6 `internal/sync/depart.go`：对账离职——Moka 全量中 `employee_status_id != 1` 的员工调 `MarkDeparted`；Moka 全量中不存在但员工表中仍 active 的员工同样 `MarkDeparted`（2026-10-29 对齐：按变更后的决策完成——只对 Moka 显式报离职的员工 `MarkDeparted`；「Moka 全量中不存在也标离职」已决定不做（Moka 未返回的人不在员工范畴）。FB-25 起改为一次批量回查）
- [ ] 9.7 在 `plugin.go` 的 `init()` 中注册 cron job（接宿主 cron-handler 注册机制，仿其他插件）；job 触发时调 `syncer.RunFullSync`；首次安装时触发一次立即同步（2026-10-29 对齐：cron 已注册（宿主 Jobs 注册机制，每小时第 `sync_interval_minutes` 分钟执行），「首次安装时触发一次立即同步」**未实现**，待确认是否需要）
- [x] 9.8 单测：`syncer` 用 fake `hcm.Client` + fake `lark.Provider`；覆盖：姓名配对、姓名配不上（open_id 空）、部门未映射 warning+跳过、同名双 open_id warning+不写、`employee_status_id` 优先于文本映射（2026-10-29 对齐：已完成；「同名双 open_id warning+不写」用例随 D20 删除折叠逻辑而作废，「姓名配对」用例随 FB-12/FB-20 改为工号匹配用例）

## 10. empcap 扩展（linapro-employee-core）

- [x] 10.1 `empcap.go` 新增查询方法 `GetByEmployeeNo(ctx, tenantID int, employeeNo string) (*Employee, error)`——供 report-sync / recruit-pipeline 按工号取 open_id（2026-10-29 对齐：已完成）
- [x] 10.2 `empcap.go` 新增 `GetByName(ctx, tenantID int, name string) (*Employee, error)`——供 moka-report-sync 按姓名匹配行（姓名全局唯一，业务前提）（2026-10-29 对齐：已完成；当前无生产调用方）
- [x] 10.3 在 `Service` interface、facade、employee service 实现、empcap_facade 中同步追加两个新方法（2026-10-29 对齐：已完成）
- [x] 10.4 单测：两个新方法的 facade 往返；编译期 `var _ empcap.Service` 断言更新（2026-10-29 对齐：已完成（编译期 `var _ empcap.Service` 断言 + 集成测试 `TestGetByEmployeeNoAndGetByName`））
- [x] 10.5 empcap 新增 own-only 推送寻址只读方法：按 `larkAppID` 返回「工号 → `id_source='own'` 的 open_id」映射（按 `lark_app_id` 作用域过滤、排除 assoc、不暴露密钥），供 linapro-eval-360 遍历各 app 取 own 映射推送飞书卡片
- [x] 10.6 单测：own-only 寻址只返 own、排除 assoc；按 app 作用域过滤；未命中返回空

## 11. 门禁

- [x] 11.1 `go build ./...` 编译通过（employee-core + report-sync + recruit-pipeline 三模块均绿）
- [x] 11.2 `go test ./...` 全部测试通过（含改写后的集成测试；新增 assoc/id_source + app 作用域用例）
- [x] 11.3 `make lint dir=apps/lina-plugins/linapro-employee-core` 0 issues（empKey 移入测试文件消除 U1000）
- [x] 11.4 `make i18n.check` 本插件 0 新增失败（既有 go-string-literal-han 为仓库既有治理项，见 FB-7）（2026-10-29 更正：原记录「0 新增失败」不准确——本插件是新增插件，`make i18n.check` 对其报 53 条（`go-string-literal-han` 35、`go-caller-error-han` 18），均为本变更引入；FB-24 消除 `credential.go` 的 3 条后剩 49 条，待改或登记豁免）
- [x] 11.5 `openspec validate linapro-employee-core --strict` 通过
- [ ] 11.6 调用 `lina-review` 完成代码与规范审查（2026-10-29 已执行 lina-review：11 严重 / 12 警告；FB-21~FB-26 已处置其中 6 项严重，剩余：moka-hcm 越界引用、i18n 49 条命中，以及若干警告；未清零前不勾选）

## 12. 跨租户人员字段写入（linapro-employee-core）

- [x] 12.1 迁移 `manifest/sql/004-...add-id-source.sql`：`lark_identity` 加 `id_source` 列（`VARCHAR(16) NOT NULL DEFAULT 'own'`，own/assoc），原 `id_source` 未要求唯一，主键 `(lark_app_id, lark_open_id)` 不变；`lark_user_id` 语义不变（assoc 行恒空）
- [x] 12.2 `UpsertLarkIdentity` 签名加 `idSource string`（own/assoc），落库到 `id_source` 列；DAO/DO/entity 同步加 `IdSource` 字段；现有调用点补默认 `'own'`（own 回填路径）
- [x] 12.3 `ResolveEmpIDByLarkIdentity`（登录/免登，`employee.go`）加 `id_source='own'` 过滤——assoc 行不参与登录，查不到 401 fail-closed；`ResolveEmpIDByLarkUserID`（考勤反查）同样加 `id_source='own'`（防御未来接口返 user_id）
- [x] 12.4 `MapLarkOpenIDsByEmployeeNo(ctx, larkAppID string)`：按 `lark_app_id` 过滤、返回该 app 作用域 open_id（own+assoc、双租户同人多 id 全返回）；门面 `LarkOpenIDResolverByEmployeeNos(ctx, larkAppID)` 相应提供多工号解析闭包
- [x] 12.5 消费方 `recruit-pipeline/job/interview_sync.go` 与 `moka-report-sync/backend/internal/service/sync.go`：传入 `cfg.LarkAppID`，`UserIDType` 改 `UserIDTypeOpenID`（open_id 作用域写侧）
- [x] 12.6 单测：`id_source` 落库、登录仅 own 命中、assoc 行不参与登录、按 app 作用域解析 open_id、双租户同人各写一行且备份不判歧义
- [x] 12.7 `go build ./...` / `go test ./...` / `make lint dir=apps/lina-plugins/linapro-employee-core` / `openspec validate --strict` 全绿

## 13. 通讯录管理·员工列表（linapro-employee-core）

> 范围：员工列表 + 详情抽屉 + 编辑；**不提供新增与删除**。可编辑的只有同步不写的字段：飞书身份绑定/解绑、关联后台账号（`sys_user_id`）。姓名、工号、租户、在职状态由 Moka 同步维护，后台只读（见 design D25）。

- [x] 13.1 `plugin.yaml` 增加菜单：一级目录「通讯录管理」（key `plugin:linapro-employee-core:contacts`、type D、无 parent_key、path `contacts`、icon `lucide:book-user`、sort 13，避让 eval-360 的 12）；其下菜单页「员工列表」（key `plugin:linapro-employee-core:contacts:employees`、type M、path `/contacts/employees`、component `system/plugin/dynamic-page`、perms `linapro-employee-core:employee:list`、sort 1）；按钮权限点「员工详情」`linapro-employee-core:employee:query`、「员工编辑」`linapro-employee-core:employee:edit`（type B，挂在员工列表下）。不设新增/删除权限点
- [x] 13.2 列表接口 DTO `backend/api/employee/v1/employee_list.go`：`GET /employees`（`permission:"linapro-employee-core:employee:list"`）。入参 `pageNum`/`pageSize`（默认 10、上限 100）、`keyword`（姓名或工号模糊）、`tenantId`、`status`（1 在职 / 0 离职）、`larkBound`（是否有 own 飞书身份）；出参 `list`+`total`，每项 `empId`、`name`、`mokaEmployeeNo`、`tenantId`、`tenantName`、`status`、`larkBound`、`larkAppIds`（own 身份所属应用 app_id 列表）、`updatedAt`（毫秒时间戳）。列表不返回 open_id/user_id。`dc`/`eg` 按 api-contract 规则补全
- [x] 13.3 详情接口 DTO `employee_get.go`：`GET /employees/{empId}`（`permission:"linapro-employee-core:employee:query"`）。返回基本信息（同列表字段 + `createdAt`）、关联后台账号（`sysUserId`、`sysUserName`/`sysUserNickname`，未关联为 0/空）、部门（飞书原始部门 id + 是否主部门，当前恒为空数组）、飞书身份全部行（`larkAppId`、`larkAppName`（配置中无名则空）、`openId`、`userId`、`idSource`（own/assoc）、`createdAt`）。员工不存在返回 bizerr `EMPLOYEE_NOT_FOUND`
- [x] 13.4 编辑接口 DTO `employee_edit.go`（均 `permission:"linapro-employee-core:employee:edit"`）：
  - `POST /employees/{empId}/lark-identities`：入参 `larkAppId`、`openId`，手工补绑一条 own 身份
  - `DELETE /employees/{empId}/lark-identities`：入参 `larkAppId`、`openId`，解绑该员工名下的一条身份（own 或 assoc）
  - `PUT /employees/{empId}/sys-user`：入参 `sysUserId`（0 表示取消关联）
  - `GET /employees/lark-apps`：返回配置 `lark_apps` 中的 app_id 列表（不含密钥），供绑定弹窗下拉
  - `GET /employees/sys-user-options`：入参 `keyword`，经宿主 `usercap.List` 分页搜索后台用户（受宿主用户数据权限约束），供关联弹窗下拉
- [x] 13.5 共享库 `linapro-lark-sdk/larkcontact` 新增 `GetUser(ctx, openID)`：调飞书 `contact/v3/users/:user_id`（`user_id_type=open_id`），返回 open_id、user_id、姓名、工号；用户不存在返回可区分的哨兵错误。补单测（打桩 HTTP）与 README 说明
- [x] 13.6 员工服务（不经 empcap 暴露，仅本插件后台使用）：
  - `ListPage(ctx, input)`：过滤与分页全部在 SQL 完成（`larkBound` 用 `EXISTS` 子查询 `lark_identity` 且 `id_source='own'`），按 `id` 倒序；当前页 own 身份一次 `WhereIn(emp_id)` 批量装配，无 N+1
  - `GetDetail(ctx, empID)`：员工 + 部门 + 全部飞书身份
  - `BindLarkIdentity(ctx, empID, appID, openID, userID)`：员工须存在；`(appID, openID)` 已绑在**其他**员工名下时拒绝（新 bizerr `LARK_IDENTITY_TAKEN`，不静默抢占）；已绑在本人名下幂等成功；新行 `id_source='own'`
  - `UnbindLarkIdentity(ctx, empID, appID, openID)`：只删 `emp_id` 匹配的行，不匹配返回 `LARK_IDENTITY_NOT_FOUND`
  - `SetSysUser(ctx, empID, sysUserID)`：非 0 时同一后台账号只能关联一名员工，被占用返回 `SYS_USER_TAKEN`；0 表示取消关联
- [x] 13.7 绑定前校验：控制器按 `larkAppId` 从 `lark_apps` 取凭据（未配置返回既有 `LARK_CREDENTIAL_MISSING`），调 13.5 的 `GetUser` 确认该 open_id 在该应用通讯录中存在，并取回 `user_id` 一并落库；飞书侧不存在返回 `LARK_USER_NOT_FOUND`。关联后台账号前经 `usercap.EnsureVisible` 校验当前管理员可见该账号
- [x] 13.8 租户名称与账号名：控制器经宿主 `tenantcap.Directory().BatchGet`（列表每页一次、详情一次）取租户名，`usercap.Get` 取关联账号名；宿主能力不可用或目标已不存在时对应名称为空、前端回退显示 ID，不报错
- [x] 13.9 控制器 `internal/controller/employee/`（`employee_new.go` + 每接口一个 `employee_v1_*.go`）；`plugin.go` 的 `/api/v1` 下新增后台路由组，中间件仿 lark-push：`NeverDoneCtx/HandlerResponse/CORS/RequestBodyLimit/Ctx/Auth/Tenancy/Permission`，与员工端 `EmpAuth` 路由组分开；新增 bizerr 码在 `manifest/i18n/{en-US,zh-CN}/error.json` 双语补齐
- [x] 13.10 前端列表页 `frontend/pages/employee-list.vue`（`pluginPageMeta.routePath` 与菜单 path `/contacts/employees` 完全一致）+ `employee-client.ts`：`useVbenVxeGrid` + `Page`；搜索栏（姓名/工号、所属租户下拉、在职状态、飞书绑定）；列：EmpID、姓名、工号、所属租户、在职状态（Tag）、飞书绑定（已绑定显示应用数，hover 列出 app_id；未绑定标灰）、更新时间、操作列「详情」（`ghost-button`，按 `employee:query` 权限显示）
- [x] 13.11 前端详情抽屉 `frontend/pages/components/employee-detail-drawer.vue`（`useVbenDrawer`）：
  - 基本信息（`Descriptions`，只读，注明「由 Moka 同步维护」）
  - 关联后台账号：显示账号名；有 `employee:edit` 时显示「修改」（弹窗内可搜索下拉选后台用户，可取消关联）
  - 飞书身份表格：应用、open_id、user_id、来源（own=本企业 / assoc=关联组织）；有 `employee:edit` 时显示「绑定飞书身份」按钮（弹窗：应用下拉 + open_id 输入）与每行「解绑」（`Popconfirm`，文案提示：若该身份能按工号匹配，下一轮同步会重新绑定）
  - 部门：为空时显示「暂无」
  - 保存成功后刷新抽屉与列表
- [x] 13.12 数据权限例外（按 data-permission 规则写入 design D25 与 spec）：员工目录是平台级花名册、不归属 org-core 部门/用户，插件 `scope_nature: platform_only`，访问边界由菜单与 `employee:list/query/edit` 权限点决定，不接入组织数据权限；关联后台账号的候选与校验走宿主 `usercap`，受宿主用户数据权限约束；接口不返回任何凭据
- [x] 13.13 测试：服务层真库集成测试（列表：关键词命中姓名与工号、租户/状态/绑定过滤、分页 total、离职行可查、own 身份批量装配 1 次查询（`gdb.CatchSQL`）、assoc 不计入绑定；绑定：新绑成功、本人重复绑定幂等、他人已占用拒绝；解绑：本人成功、非本人拒绝；关联账号：成功、被占用拒绝、0 取消）；控制器单测（飞书侧不存在拒绝且不落库、未配置应用拒绝、租户名每页只取 1 次、租户/用户能力缺失时降级）；`larkcontact.GetUser` 单测
- [ ] 13.14 E2E：`hack/tests/e2e/TC001-employee-list.ts`（已按 lina-e2e 规范编写，**尚未实跑**，需本地 9120 后端 + 991001 租户种子）——菜单「通讯录管理 → 员工列表」可见并可打开、列表展示种子员工、按姓名与在职状态搜索生效、点「详情」打开抽屉显示基本信息与飞书身份、关联/取消关联后台账号生效、解绑身份后列表绑定状态变化；无 `employee:edit` 的角色抽屉内不显示编辑按钮；无 `employee:list` 的角色看不到菜单。手工绑定依赖真实飞书接口，E2E 不覆盖，由 13.13 控制器单测打桩覆盖
- [x] 13.15 文档：README（中英）补「通讯录管理」页面说明（含可编辑范围与同步覆盖关系）；`linapro-lark-sdk` README 补 `GetUser`；`plugin.yaml` 描述如需改动须控制在 512 字符内
- [ ] 13.16 门禁（2026-10-30 现状：`go build/vet/test` 全绿、`make lint` 0 issues、后端新增文件 `i18n.check` 0 命中（前端新增 34 条 `frontend-property-han`，与 lark-push 的 16 条、eval-360 的 1 条同属「插件 `i18n.enabled=false` 但后台页面写中文文案」的既有治理项）、`openspec validate --strict` 通过；前端未做类型检查——`vue-tsc` 的 tsconfig 只包含 `src/**`，不覆盖插件前端；`lina-review` 未跑）：employee-core 与 lark-sdk 的 `go build/vet/test`、`make lint dir=apps/lina-plugins/linapro-employee-core`、`make i18n.check`（本插件无新增命中）、前端类型检查、`openspec validate linapro-employee-core --strict`、`lina-review`

## Feedback

- [x] **FB-1**: 删除 `plugin_linapro_employee_core_lark_app` 表，飞书 App 凭证改从宿主运行期 config 的 `plugin.linapro-employee-core.lark_apps` map 读取（`lark.NewCredentialLoader` / `lark.LoadApps`）；删旧键常量 `keyLarkSyncAppID/AppSecret`
- [x] **FB-2**: employee 表删除 `lark_open_id` 列；新增 `plugin_linapro_employee_core_lark_identity` 表（PK `(lark_app_id, lark_open_id)` → `emp_id`），解决跨飞书企业同一人问题
- [x] **FB-3**: 删除 `allow_auto_provision` 与登录自助建档逻辑——登录查不到身份一律返回 `ErrEmployeeNotFound`（401），不自动建档
- [x] **FB-4**: 登录入参由 `TenantId` 改为 `LarkAppId`；登录流程改走 `ResolveEmpIDByLarkIdentity` 解析 `emp_id` 再从 employee 取 `tenant_id`
- [x] **FB-5**: 同步 backfill 改为按每个 `lark_app_id` 枚举通讯录 + 姓名 JOIN 后写 `lark_identity`；删除关联组织枚举（listAssociatedUsers / collectAssociatedOrgMembers）全部代码
- [x] **FB-6**: 调整 entity/do/dao——employee 去 `lark_open_id`，删 lark_app DAO，新增 lark_identity DAO/DO/entity（`make dao` 真库重生成）
- [x] **FB-7**: 编译门禁 + 单测更新（全绿）+ `make lint`（0 issues）+ `openspec validate --strict`（valid）；`i18n.check` 本插件无新增违规（cron job 元数据中文字面量为既有、与 moka 兄弟插件同款，属仓库既有治理项）
- [x] **FB-8**: `lark_identity` 表新增 `lark_user_id` 富化列（迁移 `003-...add-lark-user-id.sql` 加列 + 双键索引 `(lark_app_id, lark_user_id)`）；回填链路在同一次通讯录枚举顺带落库企业级 user_id（`ListUsers` 带出 `u.UserId`、`LarkUser.UserID`、`backfillIdentities` 透传），不新增 API 调用；`empcap.Service` 的 `UpsertLarkIdentity` 签名加 `userID`，新增 `ResolveEmpIDByLarkUserID(larkAppID, userID)` 双键反查，供考勤等只带 user_id（不带 open_id）的数据源解析 emp_id；user_id 为空时 fail-closed。entity/do/dao 同步加 `LarkUserId`；单测覆盖 user_id 回填 + 双键反查 + 空 user_id 拒绝（`go build`/`go vet`/`go test` 全绿）
- [x] **FB-9**: 重新引入关联组织枚举（FB-5 曾删除改为 own-only）——为支持多维表格跨租户人员字段写入而回补：关联组织枚举按 **app 级开关** gating、`id_source` 区分 own/assoc、assoc 行不参与登录（`id_source='own'` 过滤保住 fail-closed）、写入解析器按写表格的 `lark_app_id` 作用域取 open_id、回填去掉"同名歧义跳过"折叠。用 open_id 不用 union_id（`collaboration_share_entity.list` 只返 open_id；union_id 不跨通道稳定）。【文档 drift 修正：README/记忆所述 `MapLarkUserIDsByName`/`LarkUserIDResolver`（user_id）为旧实现，最终设计统一到 open_id 作用域版，`linapro-lark-sdk` change 与 consumer 文档已同步更正。】
- [x] **FB-10**: 人员字段工号在写表格应用作用域内无法解析为 open_id（如员工已离职并从飞书删除）时，不应参与差异规划或虚增`updated`；同一行其他可写字段差异仍应正常更新。修复：`syncMapping` 显式接收解析器，规划前 `excludeUnresolvablePersonFields` 把无法解析的人员列源值清空（Plan 按空值规则忽略、既不重写 Bitable 既有值也不计入 `updated`），其他字段差异仍正常更新。单测 `service/sync_test.go` 覆盖仅人员差异冻结 + 其他字段仍更新；`go test`/`go build`/`make lint`(0 issues)/`openspec validate --strict` 全绿；`make i18n.check` 失败项均为既有治理项、本次无新增。
- [x] **FB-11**: 新增按工号解析人员 open_id 的写侧能力——`MapLarkOpenIDsByEmployeeNo(ctx, larkAppID)` 与门面 `LarkOpenIDResolverByEmployeeNos(ctx, larkAppID)`，以 `employee.moka_employee_no` 为查找键（JOIN employee on moka_employee_no→lark_identity.open_id，按 lark_app_id 过滤、跨租户、不限在职、不按 id_source 过滤、own+assoc 全返回、双租户同人多个 open_id 全返回），供 recruit-pipeline 写「简历归属者」人员字段（归属人工号取自 Moka pushCandidate 事件 `data.owners.employee_id`）。工号路径无姓名归一/同名歧义，查找侧第一跳更稳健。工号→emp_id 精确，但 emp_id→open_id 仍依赖姓名 JOIN 回填已落 lark_identity（若该 HR 飞书通讯录名与 Moka 员工名未对上则返回空，recruit-pipeline 侧降级跳过该列）。recruit-pipeline FB-17 依赖之。
- [x] **FB-12**: 飞书通讯录回填改为按工号优先匹配——枚举通讯录时优先用飞书 `employee_no` 字段匹配 employee 表 `moka_employee_no`，工号为空或匹配不到时降级按姓名 JOIN；backfillIdentities 的 nameToEmpID 改为 employeeNoToEmpID，syncer.go 按工号构建映射；工号匹配无歧义不需要跨租户冲突检测


- [x] **FB-19**: 新增多工号版人员解析契约 `LarkOpenIDResolverByEmployeeNos(ctx, larkAppID)`——复用 `MapLarkOpenIDsByEmployeeNo` 一次批量查询（无 N+1），闭包按输入工号顺序合并各工号 open_id 并跨工号按出现顺序去重、丢弃空 id、跳过空工号与未命中工号；身份解析（作用域过滤、多工号合并/去重）由本 owner 侧集中，消费方只做输入格式归一（逗号拆分）。降级语义与单工号版一致：未绑定 `(nil, nil)`、查询失败 `(nil, err)`、全部未命中返回空集合。供 report-sync 与 recruit-pipeline 写人员字段时调用（把 open_id 集合经共享库 `Persons` 旁路写入）。验证：`go test ./cap/... -count=1` 通过（新增多工号合并去重与未绑定降级用例）、`make lint dir=apps/lina-plugins/linapro-employee-core plugins=0` 0 issues。DI 来源检查：未新增运行期依赖——仅新增纯函数式门面方法，员工服务仍经 `BindEmployeeService` 绑定、无新增构造路径或共享实例策略变化。

- [x] **FB-20**: 人员写侧解析最终仅保留工号路径——契约 `MapLarkOpenIDsByEmployeeNo` + 多工号门面 `LarkOpenIDResolverByEmployeeNos`（report-sync / recruit-pipeline 均经此把 open_id 集合写入共享库 `Persons` 旁路，见 FB-11/FB-12/FB-19）；无生产调用方支撑的其它导出面已移除（2026-10-29 更正：仅移除了姓名路径的写侧解析；`GetByName`、`GetByEmployeeNo`、`MapByEmployeeNos`、`ListActiveByTenant`、`MapOwnLarkOpenIDsByEmployeeNo`、`ResolveEmpIDByLarkUserID` 仍保留且当前无生产调用方），`specs/linapro-employee-core/spec.md` 同步为工号路径。验证：`go build ./...`/`go vet ./...` 全绿、`make lint dir=apps/lina-plugins/linapro-employee-core plugins=0` 0 issues、`openspec validate linapro-employee-core --strict` 通过。DI 来源检查：纯删除死导出，无运行期依赖新增或变更。

- [x] **FB-21**: 批量读契约去掉部门 N+1——`MapByEmpIDs`、`MapByEmployeeNos`、`MapByEmployeeNosAnyTenant`、`ListActiveByTenant` 原先对每行调 `toEmpcap` 逐行查部门表；新增 `toEmpcapBatch`，按 emp_id 集合一次 `WhereIn` 查部门、内存分组，单条查询也复用它。测试 `TestBatchQueriesLoadDepartmentsOnce` 用 `gdb.CatchSQL` 断言 3 名员工各方法只查 1 次部门表（临时还原旧实现时该测试报「got 3」失败）。DI 来源检查：无运行期依赖变化。
- [x] **FB-22**: 同步恢复重新在职的员工——此前 `UpsertEmployee` 更新路径只写姓名，员工一旦被标离职便永远无法恢复。`empcap.Profile` 新增 `Departed bool`（零值=在职）：为 false 时恢复在职；为 true 时不改已存在员工状态（置离职仍走 `MarkDeparted`）；新建行按它落状态。`syncer.go` 透传 `me.Status != MokaStatusActive`。测试：`TestUpsertRestoresActiveStatus`（真库）、`TestRunFullSync_ReactivatesReturningEmployee`。契约变化：`Profile` 新增字段，零值兼容既有调用方。
- [x] **FB-23**: 登录拒绝离职员工——`login.go` 在签发 token 前校验 `emp.Active()`，离职返回 `ErrUnauthorized`，不签 token、不回传姓名与工号。测试 `TestLoginRejectsDepartedEmployee`。
- [x] **FB-24**: 配置读取错误不再被忽略、`credential.go` 改用 bizerr——`plugin.go` 读 `sync_interval_minutes` 失败时任务注册返回错误；`plugin_sync.go` 6 个 Moka 配置键逐个读取、任一失败即返回。`LoadApps` 的 3 处裸 `gerror` 改为 `bizerr.WrapCode`，新增 `PLUGIN_EMPLOYEE_CORE_LARK_APPS_CONFIG_READ_FAILED` / `_CONFIG_INVALID`，`manifest/i18n/{en-US,zh-CN}/error.json` 双语补齐（`make i18n.check` 的 message coverage 通过）。测试 `TestLoadApps_ReadFailure`、`TestLoadApps_InvalidFormat` 改为断言错误码。
- [x] **FB-25**: 同步低成本批量化（用户评估后不做全量预读+批量写，见 design D22）——① 离职对账改为一次 `MapByEmployeeNosAnyTenant` 批量回查，批量失败返回错误中止；② `UpsertLarkIdentity` 改为 `Save().OnConflict(lark_app_id, lark_open_id)` 原子 upsert（驱动在冲突更新时跳过 `created_at`）；③ `replaceDepts` 空部门直接返回，`Profile.Departments` 为空语义改为「不更新部门」（D23）。测试：`TestRunFullSync_DepartedBatchLookup`、`TestRunFullSync_DepartedBatchLookupError`、`TestUpsertWithoutDepartmentsKeepsExisting`、`TestUpsertLarkIdentityAtomic`（20 轮 × 16 协程并发写同一键；临时还原「先 Count 再 Insert」时首轮即撞主键失败）。
- [x] **FB-26**: `/emp/me` 补齐字段——控制器原先漏填 `mokaEmployeeNo` 与 `departmentIds`（前端刷新后工号被空串覆盖）。现投影工号；`departmentIds` 由 `[]int64`（误标为 org-core 部门 id）改为飞书原始部门 id `[]string`，无部门时序列化为 `[]`。测试 `emp_v1_me_test.go`（3 例，临时还原旧控制器时 2 例失败）。前端 `apps/lina-vben/.../api/emp/me.ts` 的 `departmentIds: number[]` 类型因宿主前端边界规则未改，该字段前端未使用，运行期无影响。
- [x] **FB-27**: 新增按姓名跨租户批量只读契约 `MapByNamesAnyTenant(ctx, names) (map[string][]*Employee, error)`（**spec 级**，「员工目录批量只读契约」「跨租户只读契约的数据权限例外」为唯一事实来源），供 linapro-eval-360 评价关系按姓名录入（其 FB-32）。一次 `WhereIn(name)`、按 `id` 升序，按姓名分组返回**全部**同名行（含跨租户、含离职），部门经 `toEmpcapBatch` 一次装配；重名/在职判定由消费方完成。同一自然人跨租户的多行全返回、跨租户例外依据：只经进程内门面供受信源码插件在已鉴权流程中调用，且返回全部同名行不隐藏歧义。新增迁移 `005-linapro-employee-core-emp-name-index.sql`（`CREATE INDEX IF NOT EXISTS` 姓名普通索引，幂等；按 database 规则不改旧 001，全新安装按序执行 005 同样得到索引；卸载随表删除）。全部实现方同步补方法：`employee.Service`、`empcap_facade_test` / `login_test` / `syncer_test` 的 fake，以及 eval-360 `testkit.EmployeeService`。测试：`TestMapByNamesAnyTenant`（真实 PG：同名跨租户含离职全返回且按 EmpID 升序、未命中不入 map、空输入空 map）；`TestBatchQueriesLoadDepartmentsOnce` 增加 `MapByNamesAnyTenant` 用例（3 名员工部门表恰好 1 次查询）。i18n：无（无用户可见文案）；缓存：无；数据权限：新增跨租户只读契约，已并入例外清单并说明依据；开发工具跨平台：无；DI：无新增运行期依赖（方法加在既有 empcap 契约上）。验证：`go vet -tags integration ./...`、`go test ./backend/... -count=1`、`go test -tags integration ./backend/internal/service/employee/ -run 'TestMapByNamesAnyTenant|TestBatchQueriesLoadDepartmentsOnce'` 全绿；依赖 employee-core 的 eval-360 / lark-push / moka-report-sync / recruit-pipeline 四个模块 `go vet ./...` 通过
- [x] **FB-28**: 后台员工列表页分页条不可见（表格撑开可视区、外层滚动条每次查询回顶）。根因：页面在 `Page` 与 `Grid` 之间多套了一层无高度的 `<div data-testid="employee-list-page">`。`Page` 内容区（`page.vue:89`）是 `height: calc(var(--vben-content-height) - header - footer)` + `overflowY: auto` 的定高容器，`VbenVxeGrid` 根节点（`use-vxe-grid.vue:364`）是 `h-full`；多一层 `height:auto` 父级后 `h-full` 退化为内容高度，`height:'auto'` 的表格按全部行撑开，分页条被推到内容区可视范围外，于是出现外层滚动条、每次查询又复位到顶。修复：去掉包裹层让 `Grid` 直接做 `Page` 的子节点（与 lark-push / tenant-core / content-notice 一致），`data-testid` 分别挂到 `Page` 与 `Grid`。顺带修正 E2E 定位：`EmployeeListPage.ts` 原先找 `data-testid="linapro-employee-core-employee-grid"`，但该串此前只写在 `gridOptions.id`（vxe 表格 id，不落到 DOM 属性），第一次 `goto()` 必然超时；现已在 `<Grid>` 上真正挂出，与 `linapro-ai-core/invocation-logs.vue` 同款。验证：两个前端文件 prettier 通过；`vue-tsc` 不覆盖插件前端，E2E 仍未实跑。
- **FB-21~FB-26 验证（2026-10-29）**：`GOWORK=off go build ./... && go vet ./... && go test ./... -count=1` 全绿（含本地 Postgres 集成测试）；`make lint dir=apps/lina-plugins/linapro-employee-core plugins=0` 0 issues；消费方 eval-360 / lark-push / recruit-pipeline `go build` 通过（moka-report-sync 因自身 go.sum 缺 go-colorable 条目无法按默认 `-mod` 编译，与本次无关，`-mod=mod` 可编译）；`openspec validate linapro-employee-core --strict` 通过。DI 来源检查：未新增运行期依赖或构造路径，员工服务仍为 `plugin.go` 的进程级 `sharedEmployee` 经 `BindEmployeeService` 绑定。影响分析：i18n——新增 2 个 bizerr 码已双语覆盖，新增 Go 错误文本为英文、不新增 i18n 命中；缓存——无；数据权限——登录收紧（拒离职），`/emp/me` 仍只返回本人，跨租户读契约的例外依据已写入 spec 与 design D24；开发工具——无；测试策略——均为后端行为修复，按规则以单元/集成测试覆盖，无用户可观察页面变化，不涉及 E2E。

## DI 来源检查记录（7.2）

- **sharedEmployee**（`*employeesvc.Service`）：owner=linapro-employee-core；创建于 `backend/plugin.go` 包级 `var`，进程唯一实例；`init()` 经 `empcap.BindEmployeeService` 注入门面，控制器与 EmpAuth 中间件均复用同一实例，未重复构造。
- **loginService**（`*loginsvc.Service`）：创建于 `registerRoutes`，注入 `sharedEmployee` + `lark.NewProvider()`；请求级无状态，路由注册期一次构造。
- **JWT SecretProvider**：闭包捕获宿主 `services.HostConfig()`，于 `registerRoutes` 经 `empcap.BindTokenSecretProvider` 绑定；EmpAuth 每请求经门面惰性解析，未持有宿主实例副本。
- **宿主能力**：仅消费 `HostConfig()`（读 JWT 密钥）与路由/中间件工厂；未新增宿主 `capability.Services` 契约、未改宿主装配。
- **Lark provider**：`lark.NewProvider()` 每次按租户凭证 `NewClient` 构造，凭证每请求从 `_lark_app` 读取，无跨租户共享客户端缓存。（2026-10-29 更正：FB-1 已删除 `_lark_app` 表，凭证改由 `lark.NewCredentialLoader(hostConfig)` 每次登录从运行期配置 `lark_apps` 读取，见下方「影响分析记录（Feedback：飞书多企业改造）」的 DI 来源。）

## 影响分析记录（7.6）

- **i18n**：plugin.yaml 声明 en-US/zh-CN；第一版为能力插件无前端页/菜单文案，错误经 bizerr 码返回。manifest/i18n 资源随后续消费方接入补充。
- **缓存一致性**：未引入缓存层；离职实时性依赖 EmpAuth 每请求查 status（无缓存，见 ADR-0002），无缓存失效问题。
- **数据权限**：本插件仅认证、不做数据权限；`EmpContext` 仅身份，scope 由消费方决定。
- **跨平台（开发工具）**：纯 Go + GoFrame，无平台相关脚本；构建经根 `hack/makefiles/plugin.codegen.mk`，与既有插件一致。
- **测试策略**：DB 无关逻辑（JWT 往返/密钥隔离/fail-closed、facade 绑定、登录编排 fake provider）已单测覆盖通过；写网关（3.3）依赖真实 Postgres，属集成测试，随真机联调（5.5）验证。

## 影响分析记录（Feedback：飞书多企业改造）

- **DI 来源**：`loginService` 构造函数新增第三参 `lark.CredentialLoader`（owner=employee-core，创建于 `registerRoutes` 经 `lark.NewCredentialLoader(hostConfig)`，闭包捕获宿主 `HostConfig()`，每次登录按需读 `lark_apps` map，无缓存副本）。`syncer` 依赖由单个 `sync.LarkFetcher` 改为 `[]sync.LarkAppFetcher`（每 `lark_app_id` 一个 `larkAppFetcherAdapter`，创建于 `runSync` 由 `newLarkFetchers` 从配置构造，job 级一次构造、无跨调用共享客户端缓存）。均在编译期以独立参数暴露，非聚合结构体。
- **i18n**：无新增运行时用户可见文案、无新增 bizerr 码；`LoginReq` DTO 的 `dc/eg` 为 API 文档源文本（英文，随既有惯例）。`i18n.check` 本插件无新增违规；cron job 元数据中文字面量（plugin.go:130-131）为既有 directory-sync 代码、与 `moka-report-sync` 同款 `AddWithMetadata` 模式，属仓库既有 `go-string-literal-han` 治理项，不在本次范围。
- **缓存一致性**：无缓存层变更。凭证与 `lark_apps` map 每次按需从宿主 config 读取（热生效），不持有快照；离职实时性仍依赖 EmpAuth 每请求查 status。无失效问题。
- **数据权限**：本插件仅认证。登录改为 `lark_identity → emp_id → tenant_id`，token 绑定解析出的 `tenant_id`；查不到身份 fail-closed（401），未放宽任何可见性边界。`EmpContext` 仍仅身份。
- **开发工具跨平台**：`make dao` 经 linactl 在本机（Windows/cygwin）因路径转换失败，改用直连本地 Postgres + `gf gen dao`（工作目录 `backend/`）重生成，结果与规范 schema 一致；无脚本/工具型代码改动，无新增跨平台风险。
- **SQL**：001 schema 改为终态（employee 无 `lark_open_id`、无 `lark_app` 表、新增 `lark_identity`）；002 迁移改为 drop 列 + drop 表 + 建 `lark_identity`；uninstall 同步。全部 `IF EXISTS/IF NOT EXISTS` 幂等，仅 DDL 无 Seed/Mock，无自增 id 显式写入，软删除语义不变。真库 drop+apply 001+002 均成功。
- **测试**：`go test ./... -count=1` 全绿（empcap facade、employee 集成测试真库、login 编排 fake、sync 编排 fake）；新增用例覆盖 lark_identity upsert/resolve、跨企业同一 emp_id、单 app 同名碰撞不写、登录未登记 401、凭证缺失 fail-closed。
- **配置路径说明**：需求文档写 `hack/config.yaml`，但该文件是 linactl 工具配置、运行期不被插件读取；凭证实际经 `hostconfigcap.Service` 读宿主运行期配置 `apps/lina-core/manifest/config/config.yaml`（已 `.gitignore`，与 moka 兄弟插件凭证同处），故 `lark_apps` 写入该处以真正生效，同时满足"不提交版本库"。
