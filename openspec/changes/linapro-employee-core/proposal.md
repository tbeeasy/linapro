## Why

考勤员工端与调查问卷两个需求都依赖同一块地基——「Lark（飞书）内员工身份 + 认证」。这块能力目前埋在 `linapro-attend-poc` 的 `internal/` 里，外部插件无法 import，且只是 PoC demo（明文 header 中间件、无员工表、无真 JWT）。若不抽取，考勤与问卷将各自重写员工认证与员工表。本变更将其抽取为共享插件 `linapro-employee-core`，作为「考勤员工端 → 问卷」依赖链的总开关。

经充分设计评审（见 `CONTEXT.md`、ADR-0001、ADR-0002），本变更交付一个**完整可用**的员工登录+认证核心：员工经 Lark 真登录、拿到含部门的身份、获得受 `EmpAuth` 守护的会话。不留桩、不分阶段。

## What Changes

- 新建源码插件 `linapro-employee-core`，骨架照抄 `linapro-extlogin-core`。
- **员工身份表**：内部 `EmpID`（整数代理主键）为身份；员工为租户内身份，唯一键为存活行上的 `(tenant_id, moka_employee_no)`。业务数据引用 EmpID 而非 open_id（ADR-0001）。
- **飞书身份映射表 `lark_identity`**：`(lark_app_id, lark_open_id) → emp_id`，附 `lark_user_id`（企业级 user_id，供考勤反查）与 `id_source`（`own`/`assoc`）。同一人跨多个飞书企业、或同时经 own 与关联组织通道出现时各一行，均指向同一 emp_id。
- **部门归属表**：保留为预留能力，可经 empcap 读取，本变更不写入部门数据。
- **飞书凭证**：从本插件运行期配置 `plugin.linapro-employee-core.lark_apps`（对象数组：`app_id`、`secret_key`、`assoc`）读取，不落库。
- **飞书真登录**：`POST /emp/login` 收 `larkAppId` + code → 换 open_id → 按 own 身份映射解析 emp_id → 校验在职 → 签员工 JWT；查不到身份或已离职一律拒绝，不自动建档。`GET /emp/me` 返回当前员工身份。
- **员工 JWT**：`golang-jwt/jwt/v5` + 独立签名密钥、2h、无 refresh（飞书免登即重认证），见 ADR-0002。
- **`EmpAuth()`**：每请求验签 + 查 status 实时拦截离职，注入 `EmpContext{EmpID, TenantID}`（纯身份，数据权限归消费方）。
- **core 独占写入网关**：`UpsertEmployee`（同步权威覆盖，含在职恢复）、`MarkDeparted`、`UpsertLarkIdentity`（原子 upsert）。
- **员工目录全量同步**（定时 job）：以 Moka HCM 为权威源，按 `dept_tenant_map` 把顶层部门映射到租户后落库；枚举各飞书应用通讯录（own + 按应用开关的关联组织），按飞书 `employee_no` 与 Moka 工号精确匹配写身份映射；按 Moka 离职状态对账离职。
- **跨插件契约 `backend/cap/empcap`**（go.mod `replace` import，零改宿主 `capability.Services`）：
  - 认证：`EmpAuth()`、`EmpContext`。
  - 员工读：`GetByID`、`GetByEmployeeNo`、`GetByEmployeeNoAnyTenant`、`GetByName`、`ListActiveByTenant`，批量 `MapByEmpIDs`、`MapByEmployeeNos`、`MapByEmployeeNosAnyTenant`（部门一次批量装配，无 N+1）。
  - 写侧人员解析：`MapLarkOpenIDsByEmployeeNo` 与多工号门面 `LarkOpenIDResolverByEmployeeNos`（按写表格的应用作用域，供 report-sync / recruit-pipeline 写多维表格人员字段）。
  - 出站推送寻址：`MapOwnLarkOpenIDsByEmployeeNo`，以及 `MapOwnLarkUserIDsByEmployeeNo` 与门面 `LarkUserIDResolverByApp`（只认 own 身份，区分命中 / user_id 为空 / 碰撞，供 lark-push 投递）。
  - 考勤反查：`ResolveEmpIDByLarkUserID`。
- **后台「通讯录管理 → 员工列表」**：一级目录 + 分页列表 + 详情抽屉，展示同步落库的员工（姓名、工号、所属租户、在职状态、飞书身份、关联后台账号）。可编辑的只有同步不写的字段：手工绑定/解绑飞书身份、关联后台账号；不提供新增与删除（Moka 为权威源）。权限点 `linapro-employee-core:employee:list` / `:query` / `:edit`。共享库 `linapro-lark-sdk` 补 `larkcontact.GetUser` 供绑定前校验。

**明确不在本变更**：WS 组织架构事件（与考勤共用长连接）、部门数据来源、飞书部门↔org-core 部门树映射、主管子树解析、离职实时推送。

## Capabilities

### New Capabilities

- `linapro-employee-core`：员工身份与认证插件（一插件一 capability）。含：
  - 身份内核：员工身份模型（租户内、EmpID 代理主键、工号唯一键、status、预留部门归属）、飞书身份映射（own/assoc）、core 独占写入网关、`cap/empcap` 跨插件共享门面。
  - 飞书登录：运行期配置的多应用凭证、飞书真登录、`/emp/login`·`/emp/me` 接口。
  - 员工会话：员工 JWT 独立密钥签发/校验（2h、无 refresh）、`EmpAuth()` 每请求查 status 实时拦截、`EmpContext{EmpID,TenantID}` 注入。
  - 目录同步：Moka 驱动全量同步（cron job）、飞书通讯录按工号回填身份映射、部门→租户映射、离职对账与在职恢复。
  - 跨插件只读契约：员工批量读、写侧人员 open_id 解析、own-only 推送寻址、考勤 user_id 反查。
  - 后台管理：「通讯录管理 → 员工列表」展示员工花名册与飞书身份，详情抽屉内可绑定/解绑飞书身份、关联后台账号。

### Modified Capabilities

<!-- 无：走公共 cap 包 + replace import，不触碰宿主 capability.Services。 -->

## Impact

- **新增代码**：`apps/lina-plugins/linapro-employee-core/`（模块 `lina-plugin-linapro-employee-core`，独立 go.mod + `replace lina-core`）。
- **依赖**：`github.com/golang-jwt/jwt/v5 v5.3.1`、`github.com/larksuite/oapi-sdk-go/v3`；共享库 `linapro-lark-sdk`（通讯录遍历；本变更为其新增 `larkcontact.GetUser`）；共享库 `linapro-moka-hcm`（Moka 全量员工、报表数据；非插件，无 `plugin.yaml`）。复用宿主 hostconfig / sys_config / jobs / route 能力。
- **数据库**：新增 `plugin_linapro_employee_core_employee`、`_employee_dept`、`_lark_identity` 三张表（install + uninstall）。
- **配置**：`plugin.linapro-employee-core.lark_apps`、`emp_jwt_secret`、`moka.*`、`sync_interval_minutes`；sys_config 键 `plugin.linapro-employee-core.dept_tenant_map`。
- **外部依赖**：每个飞书应用需通讯录读权限与「获取用户雇佣信息」权限（取工号）；开启 `assoc` 的应用需关联组织权限；需一次真机免登联调。
- **宿主**：不修改 `apps/lina-core`。
- **消费方**：eval-360、lark-push、moka-report-sync、recruit-pipeline、attend-poc 经 `require + replace` 消费 `empcap`。
