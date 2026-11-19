## ADDED Requirements

### Requirement: 自动记录非管理后台接口请求

插件启用后，系统 SHALL 通过全局中间件，在请求处理完成后记录同时满足以下条件的请求：

- 路由归属某个插件（源码插件或动态插件）；
- 请求上下文中**没有后台登录用户名**；
- 请求由接口处理器处理，不是静态资源或 `OPTIONS` 预检；
- 归属插件不在配置项 `exclude_route_owners` 中（默认 `[linapro-lark-push]`；键缺失时 SHALL 使用该内置默认值，显式配置为 `[]` 时 SHALL 不排除任何插件）；
- 路径不在配置项 `exclude_paths` 中。

不满足任一条件的请求 MUST NOT 被记录。有后台登录身份的请求由操作日志负责，本插件 MUST NOT 重复记录。
以后新增的员工端接口 SHALL 无需改代码即被记录。

#### Scenario: 员工端请求被记录

- **WHEN** 员工携带员工令牌调用 360 评估员工端接口提交作答
- **THEN** 系统新增一条记录，`route_owner` 为 `linapro-eval-360`，含方法、路径、HTTP 状态、耗时、request_id

#### Scenario: 员工登录请求被记录

- **WHEN** 员工以飞书登录码调用 `POST /x/linapro-employee-core/api/v1/emp/login`
- **THEN** 系统新增一条记录，`route_owner` 为 `linapro-employee-core`，响应体中的 `token` 字段为 `[REDACTED]`

#### Scenario: 消息推送接口不记录

- **WHEN** 外部系统以签名调用 `POST /x/linapro-lark-push/open/v1/message/text`
- **THEN** 本插件不新增记录：该插件已自行留痕可对账的标识，且明确决定不保存消息正文

#### Scenario: 排除名单配置缺失

- **WHEN** 配置中没有 `exclude_route_owners` 这个键，外部系统调用 `linapro-lark-push` 的对外接口
- **THEN** 本插件不新增记录：缺失时使用内置默认值 `[linapro-lark-push]`，不会因漏配而开始保存消息正文

#### Scenario: 排除名单显式置空

- **WHEN** 管理员把 `exclude_route_owners` 显式配置为 `[]`
- **THEN** 所有满足其余条件的插件请求都被记录，含 `linapro-lark-push`

#### Scenario: 后台请求不记录

- **WHEN** 已登录的后台管理员调用任意插件的后台接口
- **THEN** 本插件不新增记录

#### Scenario: 静态资源与宿主路由不记录

- **WHEN** 浏览器加载插件前端静态资源，或请求宿主自有路由（如宿主登录）
- **THEN** 本插件不新增记录

### Requirement: 完整保存请求与响应

每条记录 SHALL 保存：时间、方法、路径、路由模式、查询串、客户端 IP、User-Agent、归属插件、调用方标识、租户 ID、HTTP 状态、耗时、request_id、请求头、请求体、响应体、错误信息。

- 请求体与响应体 SHALL 完整保存，不设大小上限。实际大小受各路由自身的请求体上限约束。
- 请求体 SHALL 在请求处理完成后记录。处理器未读取请求体时（例如鉴权在解析前就拒绝），系统 SHALL 事后读取并记录，以便排查「提交了但被拒」的问题；实际能记录到的大小受各路由自身的请求体上限约束。
- 请求体确实无法读取时（下游关闭了请求体，或路由请求体上限已触发），系统 MUST NOT 让业务请求失败，SHALL 写入占位说明而非空值。
- multipart 请求 SHALL 完整记录普通字段的值。文件字段 SHALL 只记录字段名、文件名、Content-Type 与大小，MUST NOT 保存文件内容。
- 二进制请求体或响应体 SHALL 只记录类型与字节数；流式或已接管连接的响应 SHALL 记为 `[STREAM]`。

#### Scenario: JSON 提交完整留存

- **WHEN** 员工提交一份 JSON 表单，处理器返回 JSON 结果
- **THEN** 记录的请求体与响应体分别等于实际收发内容（敏感字段除外）

#### Scenario: 文件上传只记元数据

- **WHEN** 调用方以 multipart 上传一个 5 MB 文件和 `recipients` 字段
- **THEN** 记录中含 `recipients` 字段的值与该文件的字段名、文件名、类型、大小，不含文件内容

#### Scenario: 二进制响应

- **WHEN** 接口返回 `application/octet-stream` 的文件
- **THEN** 响应体记录为类型与字节数，不保存文件内容

### Requirement: 敏感信息脱敏

系统 MUST 在落库前完成脱敏：

- **请求头** `Authorization`、`Cookie`、`Set-Cookie`、`X-Signature`、`X-Emp-Token` 的值 SHALL 替换为 `[REDACTED]`。
- **JSON 请求体与响应体**、表单与 multipart 字段中，键名（不区分大小写）为 `password`、`passwd`、`secret`、`secret_key`、`token`、`access_token`、`refresh_token`、`signature`、`authorization` 的值 SHALL 替换为 `[REDACTED]`。上述规则在任意嵌套层级生效。
- 可通过配置 `mask_fields` 追加需要脱敏的字段名。
- 未脱敏的敏感值 MUST NOT 进入数据库或服务日志。

#### Scenario: 员工令牌头脱敏

- **WHEN** 员工携带员工 JWT 调用员工端接口
- **THEN** 记录的 `Authorization` 请求头为 `[REDACTED]`，其余请求头原样保留

#### Scenario: 响应中的令牌脱敏

- **WHEN** 员工登录接口在响应体中返回 `token`
- **THEN** 记录的响应体中该字段为 `[REDACTED]`，其余字段原样保留

### Requirement: 调用方标识约定

鉴权中间件在鉴权通过后，SHALL 通过请求上下文变量 `linapro.request.caller` 写入一个 JSON 字符串，形如 `{"kind":"emp","id":"5","name":"张三","no":"GZ001198"}`。

- 字段语义：
  - `kind`：`emp`（员工）或 `app_key`（外部系统）。
  - `id`：`emp` 时为 EmpID；`app_key` 时为 app_key。SHALL 是唯一的机器关联键。
  - `tenant`：租户 ID，整数；无租户语义时省略。
  - `name` / `no`：员工姓名与 Moka 工号，为写入时快照；拿不到时省略。`app_key` 时不写。
- 日志插件 SHALL 只读取该约定键，拆分为 `caller_kind`、`caller_id`、`caller_tenant`、`caller_name`、`caller_no` 五列。
- 未写入时各列为空，记录照常写入；任一字段缺失只影响对应列。
- 解析失败时各列留空并记一条带 request_id 的警告日志，MUST NOT 丢弃整条记录。
- 写入方与日志插件之间 MUST NOT 建立插件依赖或 Go 模块依赖。日志插件 MUST NOT 依赖 `linapro-employee-core`，MUST NOT 读取 `empcap.EmpContext`。
- 初始接入方：

  | 写入点 | 写入内容 |
  |---|---|
  | `empcap.EmpAuth()`（`linapro-employee-core` 与 `linapro-eval-360` 挂载同一个函数） | `{"kind":"emp","id":"<EmpID>","tenant":<租户>,"name":"<姓名>","no":"<工号>"}` |
  | `linapro-employee-core` 的登录控制器 `Login` | 同上 |

  `linapro-lark-push` 默认不被记录，因此不接入（见「自动记录非管理后台接口请求」）。`linapro-attend-poc` 是将被删除的最小验证代码，不接入；真实考勤插件经 `empcap.EmpAuth()` 鉴权，自动覆盖。

#### Scenario: 员工登录成功后可定位到人

- **WHEN** 员工以飞书登录码调用 `POST /x/linapro-employee-core/api/v1/emp/login` 并成功换票
- **THEN** 该记录的 `caller_kind` 为 `emp`，`caller_id`、`caller_tenant`、`caller_name`、`caller_no` 均有值，且管理员可按工号检索到它

#### Scenario: 员工登录失败时没有调用方

- **WHEN** 员工以无效的飞书登录码调用登录接口并被拒绝
- **THEN** 记录照常写入，`caller_*` 各列为空，可通过路径与 `larkAppId` 排查

#### Scenario: 按工号查到员工的请求

- **WHEN** 员工经 `empcap.EmpAuth()` 鉴权后调用 360 评估员工端接口
- **THEN** 记录的 `caller_kind` 为 `emp`、`caller_id` 为 EmpID、`caller_name` 为姓名、`caller_no` 为工号，且管理员可按工号直接检索到该记录

#### Scenario: 写入方给不出姓名

- **WHEN** 写入方只提供了 `{"kind":"emp","id":"5"}`
- **THEN** 记录照常写入，`caller_name` 与 `caller_no` 为空，页面回退显示 EmpID

#### Scenario: 员工改名后历史记录不变

- **WHEN** 员工在记录写入后改名
- **THEN** 历史记录的 `caller_name` 保持写入时的姓名

#### Scenario: 日志插件未安装

- **WHEN** 日志插件未安装或已停用，业务插件照常写入调用方标识
- **THEN** 业务请求行为与响应不受任何影响

### Requirement: 记录失败不影响业务请求

写库 SHALL 异步执行。写库失败时，系统 SHALL 只输出一条包含 request_id 的错误日志，MUST NOT 改变业务响应的状态码或内容，也 MUST NOT 让业务请求失败。

#### Scenario: 数据库写入失败

- **WHEN** 记录写入时数据库暂时不可用
- **THEN** 业务请求照常返回原响应，服务日志中有一条带 request_id 的写入失败记录

### Requirement: 记录只增不删

记录一旦写入，系统 MUST NOT 提供任何删除路径。

- 系统 MUST NOT 提供删除记录的接口、页面入口或权限点。
- 插件 MUST NOT 注册清理过期记录的定时任务。
- 记录 MUST NOT 设置保留期：360 评估与考勤的记录同样永久保存。
- 插件卸载时 MUST NOT 删除记录表（卸载 SQL 不得包含 `DROP TABLE`）。
- 插件升级或重装时，安装 SQL SHALL 对每一列使用 `ADD COLUMN IF NOT EXISTS`，使新增列在既有表上收敛；改列、改索引、改约束 SHALL 显式写出对应的 `ALTER` 语句，不得只改 `CREATE TABLE` 定义。
- 系统 MUST NOT 以批量删除（含 `DROP PARTITION`、detached 分区、清理任务）为手段控制表体积；分区 SHALL 只用于查询剪枝。

#### Scenario: 记录不随时间消失

- **WHEN** 一条 360 评估提交记录写入超过 360 天
- **THEN** 该记录仍然存在，可在查询页检索到

#### Scenario: 卸载后数据仍在

- **WHEN** 管理员卸载 `linapro-monitor-apilog` 后重新安装
- **THEN** 卸载前的记录仍然存在，且新版本新增的列已通过 `ADD COLUMN IF NOT EXISTS` 补上

#### Scenario: 没有删除入口

- **WHEN** 管理员访问「系统监控 → 接口请求日志」
- **THEN** 页面与接口均不提供删除单条或清空全部的操作

### Requirement: 按月分区

记录表 SHALL 按 `request_at` 做月度范围分区。

- 分区键 `request_at` SHALL 为 `NOT NULL` 且是主键的一部分；主键为 `(id, request_at)`。
- `request_at` SHALL 为请求开始时间，由中间件显式写入；`created_at` SHALL 为写库时间，由框架自动写入，代码 MUST NOT 手动赋值，且 MUST NOT 用于分区、筛选或排序。
- `id` SHALL 由序列（`DEFAULT nextval(...)`）生成，MUST NOT 使用 identity 列——目标数据库 PostgreSQL 14 不支持分区表上的 identity 列。
- 索引 SHALL 建在父表上，使新分区自动继承。
- 系统 SHALL 保证「当前月 + 未来 6 个月」的分区始终存在，由每日执行的任务补齐；该任务 MUST NOT 删除或 detach 任何分区。
- 分区补齐任务失败时，系统 SHALL 经共享库 `linapro-lark-sdk/larkalert` 推送告警（`kind` 为 `apilog_partition_missing`，`detail` 含目标分区名与原因）。告警发送 MUST NOT 影响任务本身的结果判定。
- 告警配置 SHALL 取自本插件自己的配置键 `plugin.linapro-monitor-apilog.alert`，MUST NOT 读取其他插件的配置键。
- 插件 MUST NOT 为发送告警而依赖 `linapro-lark-push`。
- 插件 MUST NOT 创建 DEFAULT 分区：DEFAULT 分区一旦写入数据，后续为同一范围创建正式分区会失败，修复需移出数据（即删除），与「只增不删」冲突。
- 详情查询 SHALL 携带 `request_at`；缺少时 SHALL 返回参数错误，MUST NOT 退化为全分区扫描。

#### Scenario: 写入落在当月分区

- **WHEN** 一条记录写入
- **THEN** 该行落在 `request_at` 所属月份的分区中

#### Scenario: 记录时间是请求开始时间

- **WHEN** 一个请求在 10 月 31 日 23:59:59.8 开始处理，异步写库在 11 月 1 日 00:00:00.2 才执行
- **THEN** 记录的 `request_at` 为 10 月 31 日 23:59:59.8，该行落在 10 月分区，按 10 月时间范围可检索到

#### Scenario: 补齐未来分区

- **WHEN** 分区补齐任务执行，且未来第 6 个月的分区尚不存在
- **THEN** 该分区被创建；已存在的分区不受影响，也没有任何分区被删除

#### Scenario: 补齐失败时报警

- **WHEN** 分区补齐任务执行失败
- **THEN** 系统写一条 ERROR 日志，并经 `larkalert` 向告警群推送一条 `apilog_partition_missing` 告警

#### Scenario: 分区齐全时不加锁

- **WHEN** 分区补齐任务执行，且「当前月 + 未来 6 个月」的分区均已存在
- **THEN** 任务不执行任何 DDL，不在记录表上申请锁

#### Scenario: 拿不到锁时放弃而不阻塞写入

- **WHEN** 分区补齐任务需要建分区，但记录表正被长查询占用，等锁超过 `lock_timeout`
- **THEN** 任务放弃本次建表并记为失败、触发告警；期间新的日志写入不因该任务排队

#### Scenario: 未配置告警通道

- **WHEN** `plugin.linapro-monitor-apilog.alert` 的 `app_id` / `secret_key` / `chat_id` 任一为空，分区补齐任务失败
- **THEN** 任务结果照常记录，告警被静默丢弃，不 panic、不改变任务成败判定

#### Scenario: 重复失败只报一次

- **WHEN** 分区补齐任务在防抖窗口内连续失败多次
- **THEN** 告警群只收到一条 `apilog_partition_missing` 告警

#### Scenario: 详情查询带时间

- **WHEN** 管理员在列表中打开一条记录的详情
- **THEN** 前端携带该行的 `request_at` 调用详情接口，查询只扫描对应分区

#### Scenario: 详情查询缺少时间

- **WHEN** 调用方只提供 `id` 而不提供 `requestAt`
- **THEN** 接口返回参数错误，不执行查询

#### Scenario: 记录不随时间消失

- **WHEN** 一条 360 评估提交记录写入超过 360 天
- **THEN** 该记录仍然存在，可在查询页检索到

#### Scenario: 卸载后数据仍在

- **WHEN** 管理员卸载 `linapro-monitor-apilog` 后重新安装
- **THEN** 卸载前的记录仍然存在，且表结构已收敛到新版本（新增列可见）

#### Scenario: 没有删除入口

- **WHEN** 管理员访问「系统监控 → 接口请求日志」
- **THEN** 页面与接口均不提供删除单条或清空全部的操作

### Requirement: 后台查询页

系统 SHALL 提供后台菜单「系统监控 → 接口请求日志」：

- **列表**：
  - 需要权限 `monitor:apilog:list`。
  - SHALL 支持按时间范围、归属插件、路径前缀、调用方（工号 / 姓名 / EmpID）、HTTP 状态、request_id 筛选。
  - 时间范围必填，默认最近 7 天，按时间倒序分页。
  - 列表响应 MUST NOT 包含请求头、请求体、响应体。
- **详情**：
  - 需要权限 `monitor:apilog:query`。
  - SHALL 展示完整的请求头、请求体、响应体，JSON 内容格式化展示。
- **数据权限**：记录为平台级审计数据，调用方不是后台用户。因此不接入部门数据范围，只以上述权限点控制访问。
- **记录内容不做业务级裁剪**：360 评估的作答正文（含文本评语）SHALL 与其他接口一样全文记录、永久保存，其可见性 SHALL 只由 `monitor:apilog:query` 控制，不额外校验调用方的业务权限。这是已确认的取舍（见 design D12）。

#### Scenario: 无详情权限看不到请求体

- **WHEN** 只有 list 权限的管理员调用详情接口
- **THEN** 系统拒绝访问，列表中也不含任何请求体或响应体内容

#### Scenario: 按工号排查

- **WHEN** 管理员按工号 `GZ001198` 和最近 7 天筛选
- **THEN** 列表显示该员工在此期间的请求，点开可看到其提交内容与系统返回

#### Scenario: 评估作答正文可被详情权限读取

- **WHEN** 管理员持 `monitor:apilog:query`、但不持评估插件的任何业务权限，打开一条 360 评估提交记录
- **THEN** 详情中能看到该次提交的完整作答内容
