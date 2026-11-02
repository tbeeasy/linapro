## ADDED Requirements

### Requirement: 员工身份为租户内主体

系统 SHALL 在 `linapro-employee-core` 内维护员工身份，作为区别于 `sys_user` 的独立认证主体，表名 MUST 为 `plugin_linapro_employee_core_employee`。员工 MUST 为**租户内身份**：同一自然人在两个租户下 SHALL 表现为两条独立记录，系统 MUST NOT 引入跨租户的全局人合并层。员工行的存在由 Moka 工号决定，唯一键 SHALL 为存活行上的 `(tenant_id, moka_employee_no)`（仅对非空工号生效）。员工表 MUST NOT 持有飞书 `open_id` 列，飞书身份位于独立映射表 `lark_identity`。员工 MUST NOT 写入宿主 `sys_user` 表。

#### Scenario: 同一自然人跨租户为两条记录

- **WHEN** 同一 Moka 工号的员工分别被同步进租户 A 与租户 B
- **THEN** 系统存在两条员工记录，各自 `tenant_id` 不同，互不合并

#### Scenario: 工号在租户内唯一定位员工

- **WHEN** 以相同 `(tenant_id, moka_employee_no)` 重复写入员工
- **THEN** 系统只保留一条存活记录，返回同一 EmpID

#### Scenario: 员工不进 sys_user

- **WHEN** 新增一名员工
- **THEN** 记录仅写入 `plugin_linapro_employee_core_employee`，`sys_user` 不产生任何行

### Requirement: 内部 EmpID 作为身份提供方无关的主键

系统 SHALL 以内部整数 `EmpID`（员工表自增主键）作为员工身份主键。飞书 `open_id` / `user_id` MUST 仅存于身份映射表 `plugin_linapro_employee_core_lark_identity`，用于登录与同步时解析出 EmpID。消费方业务数据 SHALL 引用 EmpID，MUST NOT 直接引用 `open_id`。切换或新增身份提供方时，EmpID 与引用它的业务数据 MUST 保持不变（只需新增对应的身份映射）。

#### Scenario: 业务数据引用 EmpID

- **WHEN** 考勤、问卷或 360 测评记录一名员工的数据
- **THEN** 该数据以 EmpID 为外键，不存储 `open_id`

#### Scenario: 提供方切换不影响业务数据

- **WHEN** 将来新增钉钉身份
- **THEN** 只需新增钉钉身份映射，EmpID 与所有引用它的业务数据不变

### Requirement: 部门归属作为预留的员工身份属性

系统 SHALL 在 `linapro-employee-core` 内保留员工部门归属表 `plugin_linapro_employee_core_employee_dept`（`emp_id`、`lark_department_id`、`is_primary`），并经 empcap 读模型 `Employee.Departments` 对消费方可读。部门归属 MUST NOT 放入消费方插件。本变更**不提供部门数据来源**：同步数据源（Moka）不下发部门，登录也不写部门，因此部门当前恒为空，属预留能力。

写入语义 SHALL 为：`Profile.Departments` 非空时整体替换该员工的部门行；为空时表示「本次不更新部门」，MUST NOT 清空既有部门行。

#### Scenario: 空部门不清空既有部门

- **WHEN** 某员工已有部门行，同步以空 `Departments` 调用 `UpsertEmployee`
- **THEN** 该员工的既有部门行保持不变

#### Scenario: 非空部门整体替换

- **WHEN** 以新的非空部门集合调用 `UpsertEmployee`
- **THEN** 该员工的部门行被替换为新集合（不与旧集合合并），主部门标志按入参落库

#### Scenario: 消费方从 core 读部门

- **WHEN** 消费方经 empcap 读取员工
- **THEN** 部门由 core 返回（当前为空集合），消费方不自建部门表

### Requirement: core 独占员工与身份映射的写入网关

系统 SHALL 使 `linapro-employee-core` 成为员工表与 `lark_identity` 表的唯一写入方，消费方 MUST NOT 直接写这两张表。写入口 SHALL 为：

- `UpsertEmployee(tenantID, profile)`：同步路径的权威档案覆盖，以 `(tenantID, profile.EmployeeNo)` 为键新建或更新，覆盖姓名；`profile.EmployeeNo` 为空 MUST 拒绝。在职状态：`profile.Departed=false` 时 MUST 把已存在员工恢复为在职；`profile.Departed=true` 时 MUST NOT 改动已存在员工的状态（置离职统一由 `MarkDeparted` 负责）；新建行按 `profile.Departed` 直接落在职或离职。
- `MarkDeparted(tenantID, empID)`：置离职。
- `UpsertLarkIdentity(larkAppID, openID, userID, idSource, empID)`：以主键 `(lark_app_id, lark_open_id)` 为冲突键做单条原子 upsert，冲突时更新 `emp_id`、`lark_user_id`、`id_source`，`created_at` 保持首次写入值；`idSource` 为空按 `own` 处理。

登录路径 MUST NOT 写入员工表，也 MUST NOT 自动建档。

#### Scenario: 同步路径覆盖姓名

- **WHEN** 同步以已存在工号、新的姓名调用 `UpsertEmployee`
- **THEN** 系统覆盖其姓名，返回原 EmpID，该 `(tenant_id, moka_employee_no)` 仍只有一条

#### Scenario: Moka 报在职时恢复在职

- **WHEN** 一名已被标记离职的员工在 Moka 中重新报在职，同步以 `Departed=false` 调用 `UpsertEmployee`
- **THEN** 该员工恢复为在职，EmpID 不变

#### Scenario: Moka 报离职时不改已存在员工状态

- **WHEN** 以 `Departed=true` 调用 `UpsertEmployee`
- **THEN** 已存在员工的状态不被改动；若是新建则直接落离职

#### Scenario: 工号为空拒绝写入

- **WHEN** 以空 `EmployeeNo` 调用 `UpsertEmployee`
- **THEN** 返回错误，不创建记录

#### Scenario: 身份映射并发写入不冲突

- **WHEN** 两次同步同时对同一 `(lark_app_id, lark_open_id)` 调用 `UpsertLarkIdentity`
- **THEN** 两次调用均成功，最终恰好一行，且 `created_at` 为首次写入时间

### Requirement: cap/empcap 跨插件共享门面

系统 SHALL 通过公共包 `backend/cap/empcap` 暴露员工能力（`EmpAuth()` 中间件、`EmpContext`、员工读写契约 `Service`、写侧/推送侧解析门面），供其他源码插件经 go.mod `require` + `replace` import 消费，MUST NOT 修改宿主 `capability.Services`。契约返回值 MUST 使用 empcap 自有的读模型（`Employee`、`Department`、`LarkUserIDIndex`），MUST NOT 泄漏 DAO/DO/Entity。门面 MUST 与插件 `init()` 顺序无关：owner 在启动期经 `BindEmployeeService` / `BindTokenSecretProvider` 绑定，消费方在请求时懒解析。

#### Scenario: 消费方经 replace import 使用能力

- **WHEN** 另一插件声明 `require lina-plugin-linapro-employee-core` + `replace => ../linapro-employee-core` 并 import `empcap`
- **THEN** 该插件可挂载 `empcap.EmpAuth()` 并查询员工，无需改动宿主

#### Scenario: init 顺序无关的绑定

- **WHEN** 消费方在 owner 调用 `BindEmployeeService` 之前构造了中间件或解析闭包
- **THEN** 首个真实请求时按当前绑定懒解析，不因 init 顺序失败

#### Scenario: owner 未绑定时按契约降级

- **WHEN** 员工服务尚未绑定（owner 插件未安装或未启用）
- **THEN** `EmpAuth` 返回服务不可用；各门面按其接口注释的降级语义返回，而非 panic

### Requirement: 员工目录批量只读契约

系统 SHALL 在 `empcap.Service` 提供以下只读查询，供消费方装配员工信息：`GetByID`、`GetByEmployeeNo`、`GetByEmployeeNoAnyTenant`、`GetByName`、`ListActiveByTenant`、`MapByEmpIDs`、`MapByEmployeeNos`、`MapByEmployeeNosAnyTenant`、`MapByNamesAnyTenant`。`MapByNamesAnyTenant` SHALL 以姓名集合跨租户一次查询，返回「姓名 → 同名全部员工（按 EmpID 升序，含跨租户、含离职）」映射，姓名按原值精确匹配，重名判定由消费方完成。批量方法 SHALL 以一次集合查询取员工行，并 MUST 以一次集合查询装配全部员工的部门（数据库访问次数不随输入规模增长，MUST NOT 逐行查部门）。批量方法对空输入返回空 map，未命中的键不入 map，MUST NOT 排除离职员工（在职判定由消费方按 `Status` 决定）。单条方法无匹配时返回 `ErrEmployeeNotFound`。

#### Scenario: 批量查询的部门装配不随行数增长

- **WHEN** 消费方以 N 个 EmpID 调用 `MapByEmpIDs`（或以 N 个工号调用 `MapByEmployeeNos` / `MapByEmployeeNosAnyTenant`，或以 N 个姓名调用 `MapByNamesAnyTenant`，或调用 `ListActiveByTenant`）
- **THEN** 系统对部门表只执行 1 次查询，并按员工正确分组返回

#### Scenario: 未命中键不入 map

- **WHEN** 批量查询的输入中含不存在的 EmpID 或工号
- **THEN** 这些键不出现在结果 map 中，不返回错误

#### Scenario: 单条查询无匹配

- **WHEN** 以不存在的工号或姓名调用 `GetByEmployeeNo` / `GetByName`
- **THEN** 返回 `ErrEmployeeNotFound`

#### Scenario: 按姓名批量查询返回全部同名员工

- **WHEN** 消费方以含「张三」的姓名集合调用 `MapByNamesAnyTenant`，而「张三」在两个租户各有一名员工（其一已离职）
- **THEN** 结果中「张三」对应两名员工、按 EmpID 升序、离职员工也返回，由消费方按在职状态与工号判定是否重名

### Requirement: 跨租户只读契约的数据权限例外

`GetByEmployeeNoAnyTenant`、`MapByEmployeeNosAnyTenant`、`MapByNamesAnyTenant`、`MapByEmpIDs`、`GetByID` 以及按 `larkAppID` 作用域的解析契约（`MapLarkOpenIDsByEmployeeNo`、`MapOwnLarkOpenIDsByEmployeeNo`、`MapOwnLarkUserIDsByEmployeeNo`）SHALL 不按租户过滤。该例外的依据为：

- 权威边界：EmpID 是全局自增主键、Moka 工号全公司唯一，跨租户定位不会产生歧义；
- 调用方边界：这些契约只经进程内 empcap 门面供受信源码插件在后台任务或已鉴权的业务流程中调用，employee-core 自身不经 HTTP 暴露它们；
- 拒绝策略：面向员工或管理员的 HTTP 读接口 MUST 由消费方在自身接口内按其数据权限过滤后再返回，MUST NOT 把这些契约的结果原样透出给无权调用方。

employee-core 自身的员工端 HTTP 接口 MUST 只返回当前员工本人数据；后台员工列表接口按「后台员工列表」需求经权限点访问。

#### Scenario: 离职对账按工号跨租户定位

- **WHEN** 离职员工在 Moka 中部门为空、无法推导租户
- **THEN** 系统按工号跨租户定位其员工行，使用其已落库的 `tenant_id` 标记离职

#### Scenario: 员工端接口只返回本人

- **WHEN** 已认证员工请求 `/emp/me`
- **THEN** 系统只返回 EmpContext 中 EmpID 对应的本人数据

### Requirement: 后台员工列表

系统 SHALL 在后台提供一级目录「通讯录管理」及其下菜单页「员工列表」，分页展示同步落库的员工（含离职），字段包括 EmpID、姓名、工号、所属租户、在职状态、飞书绑定（own 身份所属应用）。列表接口 SHALL 要求权限点 `linapro-employee-core:employee:list`，过滤与分页 MUST 在数据库查询中完成，当前页飞书身份与租户名 MUST 各批量装配一次；列表 MUST NOT 返回飞书 open_id、user_id 原值。

系统 SHALL 提供员工详情抽屉（权限点 `linapro-employee-core:employee:query`），展示基本信息、关联后台账号、部门与该员工全部飞书身份（应用、open_id、user_id、来源 own/assoc）。

系统 SHALL 只允许编辑同步不写的字段（权限点 `linapro-employee-core:employee:edit`）：手工绑定/解绑飞书身份、设置或取消关联后台账号。姓名、工号、租户、在职状态 MUST 只读。系统 MUST NOT 提供新增或删除员工的操作。任何接口 MUST NOT 返回凭据。

上述接口不接入组织数据权限，例外依据：员工目录是平台级花名册，不归属 org-core 部门或用户，插件为 `platform_only`；访问边界由菜单与权限点决定，缺权限点的请求由宿主权限中间件拒绝；关联后台账号的候选与校验受宿主用户数据权限约束。

#### Scenario: 有权限的管理员查看员工列表

- **WHEN** 拥有 `linapro-employee-core:employee:list` 的管理员打开「通讯录管理 → 员工列表」
- **THEN** 页面分页展示员工，按 EmpID 倒序，离职员工也可见并标注离职

#### Scenario: 按条件过滤

- **WHEN** 管理员按姓名或工号关键词、所属租户、在职状态、飞书绑定状态搜索
- **THEN** 系统在数据库层过滤并返回匹配行与正确的总数

#### Scenario: 飞书绑定只计 own 身份

- **WHEN** 某员工只有 `id_source='assoc'` 的身份映射
- **THEN** 该员工显示为未绑定飞书，且不出现在「已绑定」过滤结果中

#### Scenario: 租户名不可用时降级

- **WHEN** 宿主租户能力不可用或员工所属租户已不存在
- **THEN** 列表照常返回，该行租户名为空、页面显示租户 ID

#### Scenario: 无权限点被拒绝

- **WHEN** 不具备 `linapro-employee-core:employee:list` 的用户请求员工列表接口
- **THEN** 宿主权限中间件拒绝请求，且该用户菜单中不显示「员工列表」

#### Scenario: 查看员工详情

- **WHEN** 拥有 `employee:query` 的管理员在列表中点击某员工的「详情」
- **THEN** 抽屉展示该员工基本信息、关联后台账号、部门（为空显示暂无）与全部飞书身份（含 assoc 行及其来源标注）

#### Scenario: 手工绑定飞书身份

- **WHEN** 拥有 `employee:edit` 的管理员为某员工选择已配置的飞书应用并填入 open_id，且该 open_id 在该应用通讯录中存在、未属于其他员工
- **THEN** 系统写入一条 `id_source='own'` 的身份映射并回填 user_id，该员工随即可用此身份登录

#### Scenario: 绑定已属于他人的身份被拒绝

- **WHEN** 管理员绑定的 `(lark_app_id, open_id)` 已映射到另一名员工
- **THEN** 系统拒绝绑定并返回明确错误，原映射不变

#### Scenario: 飞书通讯录中不存在的 open_id 被拒绝

- **WHEN** 管理员填入的 open_id 在所选应用的通讯录中查不到
- **THEN** 系统拒绝绑定且不落库

#### Scenario: 解绑飞书身份

- **WHEN** 管理员解绑某员工名下的一条身份
- **THEN** 系统只删除 `emp_id` 匹配的该行；目标行不属于该员工时拒绝

#### Scenario: 关联后台账号

- **WHEN** 管理员为员工选择一个当前可见、且未关联其他员工的后台账号
- **THEN** 系统写入 `sys_user_id`；该账号已关联其他员工时拒绝；选择取消关联时置为 0

#### Scenario: 同步维护的字段不可编辑

- **WHEN** 管理员打开员工详情
- **THEN** 姓名、工号、租户、在职状态只读展示，页面不提供新增与删除员工的入口

### Requirement: 多飞书企业 App 凭证从运行期配置读取

系统 SHALL 以 `lark_app_id` 为维度读取飞书 App 凭证，来源为本插件运行期配置 `plugin.linapro-employee-core.lark_apps`，格式为对象数组，每个元素含 `app_id`、`secret_key` 与可选的 `assoc`（关联组织枚举开关，默认 `false`）。凭证 MUST NOT 落库，每次使用时重新读取配置（修改无需重启）。配置缺失时视为无应用；配置存在但结构非法 MUST 返回 `PLUGIN_EMPLOYEE_CORE_LARK_APPS_CONFIG_INVALID`，配置后端读取失败 MUST 返回 `PLUGIN_EMPLOYEE_CORE_LARK_APPS_CONFIG_READ_FAILED`，二者均为 bizerr，原始原因只作为 cause 保留。

#### Scenario: 按 lark_app_id 取到各自的 App Secret

- **WHEN** 配置中同时存在飞书企业 F（`cli_feishu_f`）与飞书企业 G（`cli_feishu_g`）的凭证
- **THEN** 以 `cli_feishu_f` 登录时使用 F 的 secret，以 `cli_feishu_g` 登录时使用 G 的 secret

#### Scenario: 凭证缺失 fail-closed

- **WHEN** 登录携带的 `lark_app_id` 在配置中不存在，或其 `secret_key` 为空
- **THEN** 登录返回凭据缺失错误，不回退到其他应用、不签发 token

#### Scenario: 配置结构非法明确报错

- **WHEN** `lark_apps` 被配置为字符串或单个对象而非对象数组
- **THEN** 系统返回 `PLUGIN_EMPLOYEE_CORE_LARK_APPS_CONFIG_INVALID`，不静默当作「未配置」

### Requirement: 基于 lark_identity 的登录换取身份

系统 SHALL 提供 `POST /emp/login`：接收 `larkAppId` 与飞书免登 `code`，按 `larkAppId` 取凭据，经 `internal/lark` provider 换取 `open_id`，再按 `(lark_app_id, lark_open_id)` 查 `lark_identity` 取 `emp_id`，据此查员工取 `tenant_id`，最终签发绑定该 `tenant_id` 的员工 JWT。解析身份时 SHALL **仅匹配 `id_source='own'` 的行**。查不到身份 MUST 拒绝，MUST NOT 自动建档。员工已离职 MUST 拒绝（`ErrUnauthorized`），不签发 token、不回传身份快照。

#### Scenario: 已登记在职员工登录返回绑定租户的 token

- **WHEN** 一名已在 `lark_identity` 登记（`id_source='own'`）的在职员工携带有效 `larkAppId` + `code` 请求 `/emp/login`
- **THEN** 系统返回绑定其 tenant_id 的员工 JWT，以及 EmpID、tenant_id、open_id、姓名、工号快照

#### Scenario: 双租户同人用自身 own open_id 登录

- **WHEN** 一名同时存在于两个飞书租户的员工，用其 own 租户 app 的 own open_id 请求 `/emp/login`
- **THEN** 系统命中 `id_source='own'` 的那一行解析到 emp_id 并签发 token；其 assoc 行不参与登录

#### Scenario: assoc 行不参与登录

- **WHEN** 换得的 `(lark_app_id, open_id)` 仅以 `id_source='assoc'` 登记
- **THEN** 系统拒绝登录，不签发 token

#### Scenario: 未登记身份一律拒绝

- **WHEN** 换得的 `(lark_app_id, open_id)` 在 `lark_identity` 中无 `id_source='own'` 记录
- **THEN** 系统返回 `ErrEmployeeNotFound`，不创建员工、不签发 token

#### Scenario: 离职员工登录被拒

- **WHEN** 身份已登记但对应员工已离职
- **THEN** 系统返回 `ErrUnauthorized`，不签发 token、不回传姓名与工号

#### Scenario: 无效 code 明确失败

- **WHEN** 请求 `/emp/login` 携带无效或过期 code
- **THEN** 系统返回明确认证失败，不签发 token

### Requirement: 当前员工信息查询

系统 SHALL 提供 `GET /emp/me`：在 `EmpAuth` 守护下按 EmpContext 的 EmpID 返回当前员工的 `empId`、`tenantId`、`name`、`mokaEmployeeNo`、`status` 与 `departmentIds`。`departmentIds` SHALL 为飞书原始部门 id 字符串数组（非 org-core 部门 id），无部门时 MUST 序列化为空数组而非 `null`。缺少 EmpContext 时 MUST 返回 `ErrUnauthorized`。

#### Scenario: 返回当前员工含工号

- **WHEN** 已认证员工请求 `/emp/me`
- **THEN** 系统返回其 EmpID、租户、姓名、Moka 工号、在职状态

#### Scenario: 无部门返回空数组

- **WHEN** 该员工没有部门归属（当前部门为预留能力）
- **THEN** `departmentIds` 为 `[]`

### Requirement: 员工 JWT 独立签发与校验，短时无 refresh

系统 SHALL 为员工端签发独立 JWT，使用 `golang-jwt/jwt/v5` 的 HS256 与**独立签名密钥**（键 `plugin.linapro-employee-core.emp_jwt_secret`），MUST NOT 复用宿主 `jwt.secret`。有效期 SHALL 为 2 小时。系统 MUST NOT 提供 refresh token——员工端凭飞书免登静默重认证换取新 token。员工 JWT 载荷 MUST 含 EmpID、TenantID、过期时间。

#### Scenario: 员工 token 与管理员 token 相互隔离

- **WHEN** 员工密钥签发的 JWT 交给宿主管理员校验，或反之
- **THEN** 因签名密钥不同，两者相互不被接受

#### Scenario: 签发—校验往返一致

- **WHEN** 以员工身份签发 JWT 后再以员工校验逻辑解析
- **THEN** 解出的 EmpID/TenantID 与签发时一致，且 2 小时后过期

#### Scenario: 密钥缺失 fail-closed

- **WHEN** 员工 JWT 密钥未配置
- **THEN** 签发与校验均失败，不使用空密钥

### Requirement: EmpAuth 每请求校验并实时拦截离职

系统 SHALL 提供 `EmpAuth()` 中间件（`ghttp.HandlerFunc`）：每请求先验签，再按 EmpID 查员工 `status`，非在职 MUST 立即拒绝（实时离职拦截），通过后将 `EmpContext{EmpID, TenantID}` 注入 ctx。员工路由组 MUST 挂载 `EmpAuth()`，MUST NOT 经宿主 `Auth()`/`Permission()`。`EmpContext` MUST 仅含身份，MUST NOT 含数据权限判定。

#### Scenario: 有效 token 且在职则通行并注入身份

- **WHEN** 在职员工携带有效 JWT 访问 `/emp/*`
- **THEN** 验签通过、status 为在职，`EmpContext{EmpID,TenantID}` 注入，handler 可经 `EmpFromContext` 取到

#### Scenario: 离职员工下一请求即被拦截

- **WHEN** 某员工 `status` 被置为离职后，其仍持未过期 JWT 再次请求
- **THEN** EmpAuth 查 status 发现离职，立即返回未授权，不进业务 handler

#### Scenario: 缺失或无效 token 拒绝

- **WHEN** 请求未携带或携带无效 JWT
- **THEN** EmpAuth 返回未授权

### Requirement: Moka 驱动的员工目录全量同步

系统 SHALL 内嵌一个定时全量同步 job，以 Moka HCM 为员工存在性、工号、姓名、在职状态的权威源。job 拉取 Moka 全量员工，按入职日期再按工号排序，按 `dept_tenant_map`（sys_config 键 `plugin.linapro-employee-core.dept_tenant_map`，JSON `{"顶层部门名": tenant_id}`）解析租户后经 `UpsertEmployee` 落库，并把 Moka 在职状态作为 `Profile.Departed` 透传。租户键取 Moka 完整部门路径（如 `广州星嘉/公共部门/总经办/CEO`）第一个 `/` 之前的顶层部门名（`广州星嘉`），而非部门 ID。工号为空的员工 MUST 记 warning 并跳过；在职员工的顶层部门不在映射中 MUST 记 warning 并跳过，不静默归属；离职员工部门不在映射中属正常情况，跳过但不告警（由离职对账兜底）。`dept_tenant_map` 缺失或为空时 job MUST 报错中止，不静默空跑。Moka 凭据、同步周期等配置读取失败时 MUST 返回错误，MUST NOT 当作「未配置」继续。

#### Scenario: 部门映射到租户后落库

- **WHEN** Moka 返回一名员工，其部门路径的顶层段在 `dept_tenant_map` 中
- **THEN** 系统按映射的 `tenant_id` 调用 `UpsertEmployee`，`emp_id` 稳定

#### Scenario: 在职员工部门未映射跳过

- **WHEN** Moka 返回一名在职员工，其部门路径的顶层段不在 `dept_tenant_map` 中
- **THEN** 系统记 warning 并跳过，不落库、不静默归属

#### Scenario: 重新在职的员工被恢复

- **WHEN** 此前被标记离职的员工在 Moka 中重新报在职
- **THEN** 本轮同步把其恢复为在职

#### Scenario: 映射缺失中止

- **WHEN** `dept_tenant_map` 缺失或为空
- **THEN** job 报错并跳过本次同步，不静默空跑

### Requirement: 按 lark_app_id 枚举通讯录回填 lark_identity

系统 SHALL 遍历 `plugin.linapro-employee-core.lark_apps` 中每个配置了密钥的应用，枚举该飞书企业的成员，按**飞书通讯录的 `employee_no`（工号）字段精确匹配 employee 表的 `moka_employee_no`**，匹配上时经 `UpsertLarkIdentity` 写一行 `lark_identity`。工号为空或匹配不到的飞书用户 SHALL 跳过（仅 debug 记录），系统 MUST NOT 按姓名降级匹配。只有本轮 Moka 报在职的员工参与匹配。

枚举分两道：own 通道（按部门树递归 `contact.Department.Children` + `contact.User.FindByDepartment`，取本租户原生成员，`user_id_type=open_id`）与关联组织通道（`trust_party.collaboration_tenant.list` 列关联租户，逐租户递归 `trust_party.collaboration_tenant.visible_organization`，再按需 `collaboration_tenant_collaboration_user.get` 取工号）。关联组织枚举 SHALL 由应用元素上的 `assoc` 开关 gating（默认关）；assoc 枚举失败 SHALL soft-fail，不阻断 own 通道。own 通道失败时 SHALL 记 error 并跳过该应用，不阻断其他应用。

每条身份 SHALL 落一行 `lark_identity(lark_app_id, lark_open_id, lark_user_id, id_source, emp_id)`，own/assoc 分别写 `id_source`；assoc 行 `lark_user_id` 留空。同一自然人横跨多个飞书企业或同时为 own 与 assoc 时各写一行，均指向同一 `emp_id`。写侧多租户：多维表格人员字段只认写表格应用作用域的 open_id，`union_id` 不跨通道稳定，故不使用。

#### Scenario: 按工号匹配写身份映射

- **WHEN** 某 `lark_app_id` 通讯录中一名用户的 `employee_no` 匹配到本轮在职员工的 `moka_employee_no`
- **THEN** 系统 upsert 一行 `lark_identity`；own 通道写 `id_source='own'` 且 `lark_user_id` 取该用户的企业级 user_id（无权限时为空），assoc 通道写 `id_source='assoc'` 且 `lark_user_id` 为空

#### Scenario: 工号为空或匹配不到时跳过

- **WHEN** 某飞书用户的 `employee_no` 为空，或不对应任何本轮在职员工
- **THEN** 系统跳过该用户，不按姓名降级匹配

#### Scenario: 双租户同人各写一行

- **WHEN** 同一自然人在 own 通道与关联组织通道各被枚举到，且工号匹配到同一 employee
- **THEN** 系统为两个 open_id 各写一条 `lark_identity`，均指向同一 `emp_id`

#### Scenario: 关联组织枚举由 app 级开关控制

- **WHEN** 某应用的 `assoc` 开关关闭
- **THEN** 系统仅枚举 own 通道，不调关联组织接口

#### Scenario: 关联组织枚举失败不阻断 own

- **WHEN** 某应用开启 `assoc` 但关联组织接口失败（缺 scope、限频等）
- **THEN** 系统跳过该应用的 assoc 通道，own 通道回填照常

#### Scenario: 按 user_id 反查 emp_id

- **WHEN** 考勤等只携带 `(lark_app_id, user_id)` 的数据源调用 `ResolveEmpIDByLarkUserID`
- **THEN** 系统仅匹配 `id_source='own'` 的行并返回 `emp_id`；未命中或 user_id 为空时返回 `ErrEmployeeNotFound`

#### Scenario: 在职员工无飞书身份记 warning

- **WHEN** 一名本轮在职员工在所有配置的飞书企业均未匹配到用户
- **THEN** 系统记 warning，该员工无新的 `lark_identity`，不阻断同步

### Requirement: 按工号解析人员 open_id 的写入能力

系统 SHALL 在 empcap 提供写侧解析契约 `MapLarkOpenIDsByEmployeeNo(ctx, larkAppID)`：一次查询 JOIN `employee.moka_employee_no → lark_identity.lark_open_id`，按 `lark_app_id` 过滤，跨租户、不限在职、不按 `id_source` 过滤（own + assoc 都取），返回「工号 → 该应用作用域下该人全部 open_id」映射（去重、跳过空工号与空 open_id）。消费方把解析出的 open_id 集合经 `larkbitable` 的 `Persons` 旁路写入，写侧以 `user_id_type=open_id` 识别人员字段。

#### Scenario: 按工号解析 open_id

- **WHEN** 消费方以 `larkAppID=a_app` 调用，某工号对应员工在 a_app 下有 own 与 assoc open_id 各一
- **THEN** 返回该工号到两个 open_id 的映射，不混入其它应用作用域的 id

#### Scenario: 工号无身份映射时不入 map

- **WHEN** 某工号在 employee 表存在，但在 a_app 下没有 `lark_identity` 行
- **THEN** 结果中没有该工号（消费方据此跳过该人员列，不阻断其余字段写入）

### Requirement: 多工号解析人员 open_id 的写入能力

系统 SHALL 在 empcap 提供门面 `LarkOpenIDResolverByEmployeeNos(ctx, larkAppID) (func(employeeNos []string) []string, error)`：构造时调用一次 `MapLarkOpenIDsByEmployeeNo`，返回的闭包按内存查找（无 N+1）。合并规则 SHALL 为：按输入工号顺序逐个取 open_id，跨工号按出现顺序去重、丢弃空 id、跳过空工号与未命中工号。身份解析 SHALL 由本 owner 集中完成，消费方只做输入格式归一（如逗号拆分）。降级语义：员工服务未绑定返回 `(nil, nil)`，批量查询失败返回 `(nil, err)`；全部未命中返回空集合。

#### Scenario: 多工号合并去重

- **WHEN** 消费方传入工号列表，其中两个工号分别解析出 `[o1]` 与 `[o1, o2]`
- **THEN** 返回按出现顺序去重后的 `[o1, o2]`

#### Scenario: 空工号与未命中工号跳过

- **WHEN** 传入的工号列表含空串或不存在的工号
- **THEN** 这些工号被跳过，不影响其余工号的解析结果

#### Scenario: 员工服务未绑定时降级

- **WHEN** 员工服务尚未绑定
- **THEN** 返回 `(nil, nil)`，消费方跳过人员列，不阻断本轮同步

### Requirement: own-only 推送寻址能力

系统 SHALL 在 empcap 提供面向**出站消息推送**的只读寻址契约，MUST 只认 `id_source='own'` 的身份（assoc 为他企业视角，无法经本应用投递），MUST 按 `lark_app_id` 作用域过滤，MUST NOT 暴露应用密钥：

- `MapOwnLarkOpenIDsByEmployeeNo(ctx, larkAppID)`：返回「工号 → own open_id」；同一工号多条 own 行时取首条。
- `MapOwnLarkUserIDsByEmployeeNo(ctx, larkAppID)` 与门面 `LarkUserIDResolverByApp(ctx, larkAppID)`：返回 `LarkUserIDIndex`，`ByEmployeeNo` 为「工号 → own 行的企业级 user_id」。它 SHALL 区分三态：命中；own 行存在但 user_id 为空（计入 `BlankRows`）；无 own 行（不计数）。同一工号匹配到多个不同 user_id 时 MUST NOT 静默取首条，该工号移出 `ByEmployeeNo` 并计入 `Collisions` / `CollidedEmployeeNos`。门面在员工服务未绑定时 MUST 返回 `ErrServiceUnbound`，不返回空索引。

#### Scenario: 仅返回 own 身份

- **WHEN** 某工号对应员工在某应用下同时有 own 与 assoc 各一条 `lark_identity`
- **THEN** 寻址契约只返回 own 的标识，assoc 行被排除

#### Scenario: user_id 为空计入 BlankRows

- **WHEN** 某工号的 own 行存在但 `lark_user_id` 为空（身份应用缺 user_id 权限或尚未回填）
- **THEN** 该工号不入 `ByEmployeeNo`，`BlankRows` 计数加一

#### Scenario: 同一工号多个 user_id 不静默取首条

- **WHEN** 同一工号匹配到两条 user_id 不同的 own 行
- **THEN** 该工号不入 `ByEmployeeNo`，计入 `Collisions` 与 `CollidedEmployeeNos`

#### Scenario: 门面未绑定时报错

- **WHEN** 员工服务尚未绑定时调用 `LarkUserIDResolverByApp`
- **THEN** 返回 `ErrServiceUnbound`

### Requirement: 离职对账

系统 SHALL 在每次全量同步中对账离职，一切以 Moka 为准：只把 Moka 显式报告为离职（状态非在职）且有工号的员工标记为离职；Moka 未返回的员工 MUST NOT 被处理。离职员工 SHALL 按工号一次批量跨租户回查（`MapByEmployeeNosAnyTenant`），MUST NOT 逐条查询；本地不存在或已是离职态的员工跳过，其余逐个调用 `MarkDeparted`（使用其已落库的 `tenant_id`）。批量回查失败时本轮对账 MUST 以错误中止，不降级为逐条查询、不误标任何人。

#### Scenario: Moka 报离职

- **WHEN** Moka 全量中多名员工状态为离职
- **THEN** 系统只执行一次批量回查，并对其中仍在职的员工调用 `MarkDeparted`

#### Scenario: Moka 未返回的员工不处理

- **WHEN** 员工表中一名在职员工不在本次 Moka 全量中
- **THEN** 系统不改变其状态

#### Scenario: 批量回查失败中止

- **WHEN** 离职员工的批量回查失败
- **THEN** 本轮对账返回错误，不标记任何人离职

### Requirement: 同步触发机制

系统 SHALL 通过宿主 Jobs 注册机制注册定时同步 job（任务名 `linapro-employee-core-sync`），每小时在配置项 `plugin.linapro-employee-core.sync_interval_minutes` 指定的分钟执行（缺省为第 0 分钟）。单次同步 SHALL 解绑宿主默认任务超时、使用本插件自控的 30 分钟超时。同步是最终一致，不保证实时；登录时 `(lark_app_id, open_id)` 不在 `lark_identity` 中直接拒登，不触发补偿同步。

#### Scenario: 定时触发全量同步

- **WHEN** cron 到达配置的执行时刻
- **THEN** 系统执行一次全量同步（Moka 拉取 → Upsert → 各应用回填 lark_identity → 离职对账）

#### Scenario: 同步周期配置读取失败

- **WHEN** 注册同步任务时读取 `sync_interval_minutes` 失败
- **THEN** 任务注册返回错误，而不是按缺省值静默注册
