## Context

考勤与问卷共享「Lark（飞书）内员工身份 + 认证」这块地基，原先埋在 `linapro-attend-poc` 的 `internal/` 里且只是 demo。本变更抽取为完整可用的共享源码插件 `linapro-employee-core`，并在后续迭代中加入以 Moka 为权威源的员工目录同步、跨租户人员字段写入解析与出站推送寻址。

本插件属于**源码插件能力**（`plugin-owned`），公开契约位于 owner 插件 `backend/cap/empcap`，不属于宿主通用能力，也不涉及工作台适配层。

经设计评审（`CONTEXT.md`、ADR-0001、ADR-0002），确立边界原则：
- **认证/授权分离**：core 只答「你是谁」；「你能看什么」（数据权限）归各消费方。
- **身份提供方无关**：业务数据引用内部 EmpID；飞书 open_id / user_id 只存于身份映射表 `lark_identity`，将来切换提供方只需新增映射。
- **写入网关单点**：员工表与 `lark_identity` 由 core 独占写入。
- **Moka 为员工存在性权威**：员工行由 Moka 工号决定是否存在；飞书只提供身份映射。

约束：不改宿主 `capability.Services`；员工为租户内身份、无跨租户合并；`golang-jwt/jwt/v5 v5.3.1`；Lark SDK `larksuite/oapi-sdk-go/v3`；通讯录遍历复用共享库 `linapro-lark-sdk`。

## Goals / Non-Goals

**Goals:**
- 完整可用的员工登录+认证核心：飞书真登录 → 员工 JWT → EmpAuth 会话（每请求实时离职拦截）。
- `cap/empcap` 暴露能力，零改宿主。
- 员工表（EmpID、租户内、工号唯一键、status）+ 身份映射表 + core 独占写入网关。
- Moka 驱动的员工目录全量同步，飞书通讯录按工号回填身份映射。
- 写侧人员解析（多维表格人员字段）与出站推送寻址的只读契约。

**Non-Goals:**
- WS 组织架构事件（与考勤共用长连接）、离职实时推送。
- 部门数据来源：部门表与读模型保留，但本变更不写入部门（见 D9）。
- 飞书部门↔org-core 部门树映射、主管多部门子树解析。
- 数据权限/scope（归消费方）。
- 改造 attend-poc / 问卷为消费方。

## Decisions

### D1：共享走 `cap/empcap` + `replace` import，非 `capability.Services`
宿主 `capability.Services` 封闭。抄 `oidc-generic` import `extlogin-core/extidcap`：employee-core 暴露 `backend/cap/empcap`，消费方 `require + replace` import。**备选**：改宿主加 `Employee()`——否决。

### D2：`init()` 顺序无关的绑定
owner 在 `init()` 经 `BindEmployeeService` 绑定员工服务、在路由注册期经 `BindTokenSecretProvider` 绑定 JWT 密钥来源；消费方构造的中间件和门面在**请求时**通过 `BoundEmployeeService()` 懒解析，因此插件 `init()` 顺序无关。未绑定时按各门面注释的降级语义返回。（早期设计为 `extidcap` 式 pending 缓冲，实现时改为懒解析，更简单且满足同一目标。）

### D3：员工 JWT 独立密钥、2h、无 refresh（ADR-0002）
HS256、独立密钥（键 `plugin.linapro-employee-core.emp_jwt_secret`），不复用 `jwt.secret`。2h。无 refresh——飞书免登即静默重认证。Claims 自定义（EmpID/TenantID/exp）。

### D4：EmpAuth 每请求查 status，实时离职（ADR-0002）
每请求验签后按 EmpID 查 status，非在职即时拦截，取代 token 撤销名单。status=0 的来源：同步离职对账调用 `MarkDeparted`。

### D5：内部 EmpID 代理主键，业务数据引用它（ADR-0001）
员工表以整数 EmpID 为主键；飞书 open_id 不在员工表上，而在 `lark_identity` 映射表（见 D14、D15）。业务表引用 EmpID。切钉钉 = 新增钉钉身份映射，业务表不动。

### D6：员工=租户内身份，无全局 Person
唯一键为存活行上的 `(tenant_id, moka_employee_no)`（仅对非空工号生效），同一自然人跨租户两条记录。无跨租户合并需求，不引入全局 Person。

### D7：core 独占写入网关；登录只读不写
core 拥有员工表、`lark_identity` 表及写 API。写入口仅三个：`UpsertEmployee`（同步权威覆盖）、`MarkDeparted`、`UpsertLarkIdentity`（同步回填）。登录只读：查不到身份即拒，**不自动建档、不覆盖资料**。（早期设计的登录 get-or-create `ResolveEmployee` / `allowCreate` 已在 FB-3 删除，见 D11。）

### D8：飞书真登录
`/emp/login` 编排：按 `larkAppId` 取凭据 → 换 open_id → 按 `(lark_app_id, open_id, id_source='own')` 查 `lark_identity` 得 emp_id → 查员工得 tenant_id → 在职校验（D21）→ 签 JWT。飞书 OAuth 位于 `internal/lark`，藏在 provider 接口 `ExchangeCode` 后（为将来钉钉留换点）。

### D9：部门作为预留的员工身份属性
部门归属表 `plugin_linapro_employee_core_employee_dept`（emp_id、lark_department_id、is_primary）与读模型 `Employee.Departments` 保留，core 拥有、对消费方可读，MUST NOT 放入消费方插件。**当前没有数据来源**：Moka 不下发部门，登录也不写部门，部门恒为空。写入语义见 D23；将来接入部门来源时直接以非空部门集合调用 `UpsertEmployee`。（登录时 provider 仍会尝试取部门，但结果未被使用，属后续清理项。）

### D10：命名用 lark
代码标识符（包 `internal/lark`、列 `lark_open_id`/`lark_department_id`、类型 `Lark*`）与配置键统一 `lark`；中文叙述可称「飞书」。

### D11：每租户自助建档开关（已废弃）
原设计在 `lark_app` 表加 `allow_auto_provision` 控制登录自助建档。FB-1 删除 `lark_app` 表、FB-3 删除自助建档逻辑：员工只能由 Moka 同步产生，登录查不到身份一律拒绝。

## Risks / Trade-offs

- **真登录需飞书凭证 + 真机联调** → 编排逻辑以 provider 接口隔离并用 fake 单测；真机联调作为独立验收步骤（任务 5.5）。
- **每请求查 status 增加查库** → 主键查询，换实时离职。压力大再引极短 TTL 缓存。
- **实时离职依赖同步及时置 0** → 离职生效延迟上限为一个同步周期（默认 1 小时）。
- **同步逐条写入** → 按 1000 多人规模评估，一轮约 1 万次数据库往返、数秒级完成，可接受；只把离职回查改为批量、身份映射改为原子 upsert（D22）。员工规模到上万或同步频率提高到分钟级时再考虑全量预读 + 批量写。
- **跨租户只读契约** → 见 D24 的数据权限例外。

## Migration Plan

纯新增插件，三张表：`plugin_linapro_employee_core_employee`、`_employee_dept`、`_lark_identity`。`001` 为最终 schema；`003`（加 `lark_user_id`）、`004`（加 `id_source`）为早期已安装实例的增量迁移，均可重复执行。部署随宿主编译；回滚移除插件目录，uninstall SQL 提供 DROP。

## 员工目录同步

### D12：Moka 驱动花名册，飞书只补身份映射
Moka HCM 是员工身份权威源（工号是稳定外部主键）。同步方向：先拉 Moka 全量花名册 → 按入职日期、工号排序 → `UpsertEmployee` → 再枚举各飞书应用通讯录（own + 可选关联组织）→ 按工号匹配 → 写 `lark_identity` → 离职对账。**备选**：飞书驱动——否决（多租户、同人多 open_id、无法作为权威源）。

### D13：JOIN 键为工号（取代早期的姓名 JOIN）
飞书通讯录的 `employee_no` 扩展字段（需「获取用户雇佣信息」权限）与 Moka 工号一致，按工号精确匹配 `moka_employee_no`；工号为空或匹配不到的飞书用户直接跳过，**不按姓名降级**（FB-12 起改为工号优先，FB-20 最终只保留工号路径）。早期「姓名全局唯一 + trim/全半角归一 JOIN」方案已废弃：姓名会变、存在同名风险，工号无歧义。

### D14：schema——唯一键为工号，open_id 移出员工表
员工表唯一键为存活行上的 `(tenant_id, moka_employee_no)`；员工表**不再持有** `lark_open_id` 列（FB-2），飞书身份改存 `lark_identity`（主键 `(lark_app_id, lark_open_id)` → `emp_id`）。原因：员工行由 Moka 工号决定是否存在；同一人跨多个飞书企业有多个 open_id，一列装不下。

### D15：飞书双租户/同人多 open_id——一行一 open_id
同一员工在多个飞书企业、或同时经 own 与关联组织通道被枚举到时，各写一行 `lark_identity`，均指向同一 `emp_id`（最多：应用数 × own/assoc）。**备选**：只取 own——否决（写关联组织人员字段时缺 id）；全局 Person 表——否决（无此需求）。

### D16：Moka 部门 → 内部租户映射从 sys_config 读取
`sys_config` 键 `plugin.linapro-employee-core.dept_tenant_map`，值为 JSON `{"顶层部门名": tenant_id}`。键是 Moka 完整部门路径（如 `广州星嘉/公共部门/总经办/CEO`）第一个 `/` 之前的顶层部门名，而非部门 ID。每轮同步开始时读一次。在职员工顶层部门不在映射中记 warning 并跳过；离职员工部门常为空，跳过但不告警（由离职对账按工号兜底）。Moka 全量接口经共享库 `linapro-moka-hcm` 的 `ListAllEmployees` 消费（该库不是插件：无 `plugin.yaml`、不注册宿主，module 名不带 `lina-plugin-` 前缀）。

### D17：`lark_identity.id_source` 与登录失败关闭
`id_source`（`own`/`assoc`，默认 `own`）：own=本租户原生身份，assoc=关联组织视角身份（仅为写多维表格人员字段采集）。登录 `ResolveEmpIDByLarkIdentity` 与考勤反查 `ResolveEmpIDByLarkUserID` 一律加 `id_source='own'` 过滤，保证引入 assoc 行后登录仍失败关闭。**为何加列**：不加则 assoc 行会泄漏进登录，他租户员工可凭关联视角 open_id 登录本应用。

### D18：写入解析器按应用作用域过滤
`MapLarkOpenIDsByEmployeeNo(ctx, larkAppID)` 按 `lark_app_id` 过滤，返回「工号 → 该应用作用域下全部 open_id」（own+assoc）；门面 `LarkOpenIDResolverByEmployeeNos` 复用一次批量查询提供多工号合并去重闭包。**为何必须按应用过滤**：open_id 按应用作用域签发，混入其它应用的 id 写入即错。

### D19：assoc 枚举应用级开关；用 open_id 不用 union_id
关联组织枚举（`trust_party.collaboration_tenant.list` → 逐租户递归 `trust_party.collaboration_tenant.visible_organization`）由 `lark_apps` 元素上的 `assoc` 开关 gating（默认关）；失败 soft-fail，不阻断 own。写侧识别符固定为 open_id——实测关联通道只返 open_id，且 `union_id` 不跨通道稳定。

### D20：回填直接逐用户写入，无「同名歧义」折叠
回填直接遍历每个飞书用户，按工号得到 emp_id 后对每个 open_id 各 upsert 一行。早期「同 app 内同名对应多个 open_id 即判歧义跳过」的折叠已删除：改为工号匹配后不存在同名歧义，own 与 assoc 同名通常就是同一人。

### D21：登录拒绝离职员工；同步恢复重新在职的员工
登录在签发 token 前校验在职，离职员工返回 `ErrUnauthorized` 且不回传身份快照，与 EmpAuth 口径一致。`UpsertEmployee` 新增 `Profile.Departed`（零值=在职）：Moka 报在职时把已离职员工恢复为在职（重新入职、误标纠正）；报离职时不改已存在员工状态，置离职仍统一走 `MarkDeparted`，以保留离职计数与单一入口。**备选**：在 `UpsertEmployee` 里直接写离职——否决（会让离职对账与 upsert 两处改同一状态）。

### D22：同步的低成本批量化
不做全量预读 + 内存比对 + 批量写（1000 多人规模下收益仅数秒，却要引入快照过期、批次失败定位、契约扩展等复杂度）。只做三处：离职对账一次批量回查（`MapByEmployeeNosAnyTenant`）；`UpsertLarkIdentity` 改为 `Save().OnConflict(lark_app_id, lark_open_id)` 单条原子 upsert（消除「先查后插」并发撞主键，`created_at` 由驱动保留）；空部门不做 DELETE（D23）。

### D23：`Profile.Departments` 为空表示「不更新部门」
非空时整体替换；为空时不改动既有部门行。原因：同步每轮都以空部门调用，旧语义「空=清空」会让每人每轮多一次无意义的 DELETE，并会抹掉将来其他来源写入的部门。代价：将来若需清空某人部门，需另提供明确的方法。

### D24：批量只读契约与跨租户数据权限例外
`empcap.Service` 的批量读（`MapByEmpIDs`、`MapByEmployeeNos`、`MapByEmployeeNosAnyTenant`、`ListActiveByTenant`）一次集合查询取员工行，再一次 `WhereIn` 装配全部部门，数据库访问次数不随输入规模增长。跨租户的读契约（`*AnyTenant`、`MapByEmpIDs`、按应用作用域的解析契约）不按租户过滤，例外依据：EmpID 全局唯一、Moka 工号全公司唯一；这些契约只经进程内门面供受信插件在后台任务或已鉴权流程中使用，employee-core 不经 HTTP 暴露；面向用户的 HTTP 接口由消费方按其数据权限过滤后返回。employee-core 自身的员工端 HTTP 接口只返回当前员工本人；后台员工列表接口的例外见 D25。

### D25：后台「通讯录管理 → 员工列表」：列表、详情、仅编辑同步不写的字段
新增一级目录「通讯录管理」与菜单页「员工列表」，供后台管理员查看 Moka 同步落库的员工花名册及其飞书绑定情况（排查「为什么某人登录不了 / 收不到推送」），并通过详情抽屉做少量人工修正。

- **不提供新增与删除**：员工行由 Moka 驱动同步写入（D12），手工新增的人没有 Moka 工号锚点、删除的人下一轮又会被同步回来。
- **只编辑同步不写的字段**：同步每轮覆盖姓名、按 Moka 恢复或标记离职，租户与工号是 upsert 的定位键，这些在后台只读。可编辑的只有两类：
  - **飞书身份绑定/解绑**：用于同步按工号匹配不上的人（飞书工号为空或与 Moka 不一致）。手工绑定写 `id_source='own'`，绑定前用该应用凭据调飞书通讯录确认 open_id 存在并取回 user_id；`(app_id, open_id)` 已属于其他员工时拒绝，不静默抢占。同步回填对同一键做 upsert，若之后能按工号匹配到其他员工会改写归属——以工号匹配为准，符合 D13。解绑只删本人名下的行；若该身份能按工号匹配，下一轮同步会重新绑定（页面提示）。
  - **关联后台账号 `sys_user_id`**：同步从不写此列。一个后台账号最多关联一名员工；候选与校验走宿主 `usercap`，受宿主用户数据权限约束。
- 列表的过滤与分页全部在 SQL 完成，当前页 own 身份与租户名各一次批量装配。列表的飞书绑定只统计 `id_source='own'`（与登录口径一致，D17），只返回 app_id；open_id/user_id 只在需要 `employee:query` 权限的详情中返回。

**数据权限例外**：员工目录是平台级花名册，不归属 org-core 的部门或用户，插件为 `scope_nature: platform_only`，因此不接入组织数据权限，访问边界由菜单与按钮权限点 `linapro-employee-core:employee:list` / `:query` / `:edit` 决定（与 lark-push 凭据管理同类）。拒绝策略：缺权限点的请求由宿主 `Permission()` 中间件拒绝；关联后台账号额外经 `usercap.EnsureVisible` 校验；接口不返回任何凭据。这同时修订 D24 中「employee-core 自身 HTTP 接口只返回当前员工本人」的表述：员工端接口仍只返回本人，后台接口按权限点返回全量花名册。

## Open Questions

- 主动同步功能落地时，飞书 WS 长连接需与考勤打卡事件共用一条，届时定。
- 部门数据来源（Moka 下发、飞书通讯录或其他）待后续需求确定（D9）。
- 首次安装后是否需要立即触发一次同步（任务 9.7 未实现部分）。
