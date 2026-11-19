## Context

- **宿主操作日志的边界**：
  - `linapro-monitor-operlog` 在 `/*` 上绑定全局中间件 `Audit`。请求处理完后，它从 bizctx 读取后台用户名，取不到就直接返回（`middleware_audit.go:74`）。
  - 因此员工端请求不会留痕：员工用员工 JWT 或飞书免登身份访问，没有后台用户名。
  - 该插件是上游 LinaPro 的官方插件，修改它会增加以后合并上游的冲突。
- **现有的非管理后台路由**（均为源码插件）：

  | 路由前缀 | 所属插件 | 鉴权方式 | 本期是否记录 |
  |---|---|---|---|
  | `/x/linapro-eval-360/api/v1/eval/emp/*` | linapro-eval-360（360 员工端） | `empcap.EmpAuth()`，经 `WithEmpContext` 注入员工上下文 | **记录** |
  | `/x/linapro-employee-core/api/v1/emp/*` | linapro-employee-core（员工登录与身份） | `/emp/login` 公开；`/emp/me` 挂 `empcap.EmpAuth()` | **记录** |
  | `/x/linapro-attend-poc/emp/api/v1/*` | linapro-attend-poc | 自有 `empauth.EmpAuth`，把员工写进 bizctx 的 `UserID` 槽位，**不带用户名** | 不特殊处理：默认不启用、将来会删除；若被启用则照常记录，`caller_*` 为空 |
  | `/x/linapro-lark-push/open/v1/*` | linapro-lark-push（对外推送） | 插件自建 HMAC 签名中间件 | 不记录（见 D2） |

- **可复用的宿主接缝**：
  - `pluginhost.SourcePluginIDFromRequest(r)`：取源码插件路由的归属插件。
  - `services.Route().GetMetadata(ctx)`：动态插件路由的归属与公开路径。
  - `registrar.GlobalMiddlewares().Bind`：绑定全局中间件。
  - `plugin.Jobs()`：注册插件定时任务，统一出现在后台「定时任务」管理里。本插件用**一个**任务补齐分区（见 D9），**不用**于清理。
  - `hostconfigcap`：读取插件配置。
- **用户已确认**：
  - 2026-10-28：新建独立插件；自动记录非后台请求，包括 GET；请求体和响应体不限大小，文件只记元数据；需要后台查询页。
  - 2026-11-03：**不记录 `linapro-lark-push`**（它已自行留痕调用方、业务单号、飞书错误码与请求 ID，且明确决定不记消息正文；再由日志插件保存正文等于推翻该决定）。**记录只增不删**：360 评估与考勤的记录都不允许删除，取消保留期与清理任务（见 D9）。

## Goals / Non-Goals

**Goals**

- 以后新增员工端接口时零接入，就能留下完整的请求和响应。
- 能按「谁、什么时候、调了哪个接口、提交了什么、得到了什么」排查问题。
- 记录只增不删，永久保存；不设保留期、不做清理。
- 记录日志不影响业务请求：写入失败不让请求失败，也不显著增加延迟。

**Non-Goals**

- 后台管理请求：由 operlog 负责，本插件不重复记录。
- `linapro-lark-push` 的对外接口：该插件已自行留痕可对账的标识，且明确决定不记消息正文；见 D2。
- 存档上传文件的内容。
- 实时告警、导出、删除、冷归档：本期不做，见风险部分。
- 宿主自有路由，例如宿主登录：登录由 loginlog 负责。

## Decisions

### D1 新建插件 `linapro-monitor-apilog`，不扩展 operlog

- 插件 ID 遵循 `<author>-<domain>-<capability>`，与 `linapro-monitor-operlog`、`linapro-monitor-loginlog` 同属 monitor 域。
- 插件属性：
  - 源码插件；
  - `distribution: managed`，需要在插件管理中显式安装；
  - `scope_nature: platform_only`；
  - **不启用 i18n**（`plugin.yaml` 中 `i18n.enabled: false`，2026-11-04 用户确认），见 D11。
- 脱敏、响应捕获的写法参考 operlog，在本插件内独立实现，不 import operlog 的 internal 包。
- **备选**：在 operlog 加表、加页面。复用度更高，但每次同步上游都会冲突，因此放弃。

### D2 记录范围的判定

中间件绑定在 `/*`，先调用 `r.Middleware.Next()`，返回后按以下条件依次判定，**全部满足才记录**：

1. **归属插件**：路由归属某个插件。源码插件取 `SourcePluginIDFromRequest`，动态插件取路由元数据的 `PluginID`。宿主自有路由不记录。
2. **没有后台登录身份**：`bizctx.Current(ctx).Username` 为空，即 operlog 会跳过的那部分请求。
3. **是接口请求**：存在服务处理器，且不是静态文件服务。插件前端资源、`OPTIONS` 预检不记录。
4. **归属插件不在排除名单**：`exclude_route_owners`，默认 `[linapro-lark-push]`，见下。
5. **路径不在排除名单**：不匹配配置项 `exclude_paths`，默认为空，用于排除单条高频接口（例如健康检查）。

**为什么按插件排除，而不是按路径前缀排除**：

- 排除的是「整个插件的请求不值得记」这个判断，不是某几条路由。按 `route_owner` 表达，插件改路由、加接口、换前缀都不会漏。
- 路径前缀会在插件重构时静默失效——失效的后果是又开始记录，而不是停止记录。两种失效里有毒的是不报错的那种。
- 默认只排除一个插件：
  - `linapro-lark-push`：它已自行留痕调用方、业务单号、推送应用、工号、状态与飞书 `code`/`req_id`（`send_dispatch.go:196`），且注释写明「不记正文（消息体可能含敏感信息）」。日志插件再存一遍正文，等于推翻该插件已有的隐私决定。真正没覆盖的只有请求体校验失败（400）时的入参，那属于 lark-push 自己该补的一行日志。
- **不排除 `linapro-attend-poc`**（2026-11-04 用户确认）：它只是考勤的最小验证代码，默认不启用（`autoEnable` 里是注释行），后续会删除。把它写进排除名单只会在它删除后留下一个指向不存在插件的 ID；它若被临时启用，记下来也无害。

**配置缺失与显式空数组要区分**（2026-11-04 用户确认）：

| 配置状态 | 行为 |
|---|---|
| 键缺失（`hostconfigcap.Get` 返回的 `*gvar.Var` 为 nil） | 使用代码内置默认值 `[linapro-lark-push]` |
| 显式写 `[]` | 照写执行，即全量记录——这是管理员有意的选择 |
| 显式列表 | 照写执行 |

- 理由：若把「缺失」也当空列表，漏抄一个键 lark-push 的正文就会静默开始落库，正好是上面说的「不报错的那种失效」。
- 三份配置文件仍**显式写出**默认值，让人一眼能看到；代码默认值只是兜底，不是主要表达方式。
- 配置每次请求读取（gcfg 在内存，成本可忽略），改配置无需重启，与 lark-push 读 `api_keys` 的做法一致。
- `exclude_paths`、`mask_fields` 不做此区分：默认就是空，缺失与 `[]` 效果相同，也不涉及隐私。

已知的副作用：不带令牌访问插件后台接口而收到 401 的请求也会被记录。这类请求量很小，作为安全线索保留。

### D3 请求体捕获

**不在 `Next()` 之前包装 Body。** 判定与读取全部发生在 `Next()` 返回之后，因此不需要为不记录的请求预装 tee——这与 D2「先 `Next()` 再判定」的顺序一致，也不给后台管理请求增加无谓的拷贝。做法与 operlog 相同（事后调用 `GetBodyString`）。

- **非 multipart、非二进制**：`Next()` 之后调用 `r.GetBodyString()`。
  - 命中 GoFrame 的 `bodyContent` 缓存时（`ghttp_request_param.go:153-157`）直接返回，**零成本且不会读 Body**。正常工作流的请求都走这条路：处理器调了 `r.Parse()` / `r.GetBody()`，或中间件把 Body 换成了可重复读取的 reader。
  - 当前仓库里没有处理器直接消费原始 Body 且不归还的实现。唯一的原始读取者是 lark-push 的 `bodylimit`，它读完后把 Body 换成从头开始的 reader（`bodylimit_read.go:55`），缓存仍能填上（该插件本期不记录，此条仅作核对参考）。
  - 缓存为空时会重新读 `r.Request.Body`。若处理器压根没读（例如鉴权在解析前就拒绝），此时 Body 是未消费的原始流，会被完整读出并记录——这是期望行为，对应 spec「处理器未读取时事后读取」。**这一点对本插件尤其重要**：员工令牌无效时 `empcap.EmpAuth` 在解析前就返回 401，此时正是最需要看到「他提交了什么」的时刻。
  - **必须包 `recover`，但只在窄范围触发**。`MakeBodyRepeatableRead` 读失败时是 `panic`（`ghttp_request_param.go:166`），实际能走到的只有两种情况：
    - **路由请求体上限已触发**：宿主的 `RequestBodyLimit` 把 Body 包成 `MaxBytesReader`（`middleware_request_body_limit.go:62`）后读取超限；标准库的 `MaxBytesReader` 会把错误 latch 住（`if l.err != nil { return 0, l.err }`），任何后续读取都复现同一个错误。典型触发是 chunked 传输（`ContentLength` 为 -1，绕过前置长度检查）的超大报文。
    - **下游关闭了 Body**：`io.ReadAll` 返回 `use of closed` 类错误。
  - `recover` 之后记 `[BODY 不可读]`，**记录照常写入**（路径、调用方、状态码等排查要素都还在），不要让一条日志把所有信息一起丢掉，更不要让日志插件把业务响应变成 500——这是 D7 的硬约束。
  - 读到空内容但 `ContentLength > 0` 时，记 `[BODY 未留存 content-length=N]` 而不是空串——说明下游读走了且没有归还，属于将来新增插件需要留意的情形。
  - 不设大小上限（用户确认），实际大小受宿主默认 8 MB 非 multipart 上限约束。
- **multipart**：`Next()` 之后读取已解析的 `r.Request.MultipartForm`（由 bodylimit 或 gf `parseForm` 填入，标准库保证只解析一次）。
  - 普通字段的值完整记录；文件只记字段名、文件名、Content-Type 和大小。
  - 处理器在解析前就已拒绝请求的，记 `[multipart 未解析] content-length=N`。
  - 不在中间件中提前解析，以免把 31 MB 的文件额外缓冲一遍。注意 multipart 请求的 `GetBodyString()` 恒为空（gf 的 `parseForm` 只对非 multipart 做 `MakeBodyRepeatableRead`），只能走 `MultipartForm`。
- **二进制**（`application/octet-stream`、`image/*` 等）：只计数、不缓冲，记 `[BINARY content-type N bytes]`。
- **查询串**：单独存一列，不和请求体混在一起。

### D4 响应捕获

- `Next()` 返回后读取 `r.Response.BufferString()`；为空时回退到动态路由元数据里的 `ResponseBody`，Content-Type 也从元数据兜底（与 operlog 的 `buildAuditResponseResult` 一致）。
- 二进制响应（导出文件、图片）按 Content-Type 判定后只记 `[BINARY content-type N bytes]`；已 hijack 或流式输出的响应记 `[STREAM]`。
- 记录 HTTP 状态码；有 `r.GetError()` 时记错误信息。状态码取 `r.Response.Status`，错误信息取 `r.GetError().Error()`。

### D5 脱敏，在落库前完成

- **请求头**只保存白名单之外的头，并对下列头整体替换为 `[REDACTED]`：`Authorization`、`Cookie`、`Set-Cookie`。
  - `X-Emp-Token`、`X-Signature` 也一并替换——它们当前分别属于考勤验证插件与消息推送插件（本期都不记录），留着是为了将来接入时不必回头补规则。
- **JSON 请求体与响应体**递归处理，键名不区分大小写。命中下列字段时把值替换为 `[REDACTED]`：`password`、`passwd`、`secret`、`secret_key`、`token`、`access_token`、`refresh_token`、`signature`、`authorization`。
  - 员工登录接口在响应里返回的 `token` 会被脱敏——这是本插件最主要的脱敏场景。
  - 可通过配置 `mask_fields` 追加字段。
- **表单与 multipart 字段**按同一规则处理。
- **非 JSON 文本**无法结构化脱敏，原样保存，见风险部分。
- **飞书预授权码 `code` 不脱敏**（2026-11-03 用户确认）：
  - 登录请求体形如 `{"larkAppId":"cli_x","code":"2g1..."}`。飞书预授权码一次性、有效期约 5 分钟，落库风险低。
  - 不能把它加进全局键名脱敏表：宿主统一响应结构（`middleware_response.go:29`）的字段就叫 `code`（整数业务错误码），加进去会把**每一条响应的错误码**变成 `[REDACTED]`，日志直接失去价值。
  - 若要收紧，正确做法是按路径限定——只对 `linapro-employee-core` 的 `/emp/login` 请求体脱 `code`，不动全局键名规则。本期不做。

### D6 调用方标识：上下文变量约定，不建立插件依赖

- **约定**：鉴权中间件通过后执行一次 `r.SetCtxVar("linapro.request.caller", <JSON 字符串>)`，形如：

  ```json
  {"kind":"emp","id":"5","tenant":1,"name":"张三","no":"GZ001198"}
  ```

  | 字段 | 说明 |
  |---|---|
  | `kind` | `emp`（员工）或 `app_key`（外部系统） |
  | `id` | `emp` 时为 EmpID；`app_key` 时为 app_key 本身。**这是唯一的机器关联键** |
  | `tenant` | 租户 ID（整数）；无租户语义时省略 |
  | `name` | 员工姓名；拿不到时省略。`app_key` 时不写 |
  | `no` | Moka 工号；拿不到时省略。`app_key` 时不写 |

- **为什么租户也从约定键传，而不是读 bizctx**：
  - `empcap.EmpAuth()` 只做 `r.SetCtx(WithEmpContext(...))`、**不写 bizctx**，读 bizctx 会让 employee-core 与 eval-360 的员工端请求恒为 0。
  - 而 `EmpContext` 里本来就有 `TenantID`，写入方零额外成本。谁鉴权成功谁就知道租户，这是最可靠的信息源。
  - 也不去读 `empcap.EmpContext`：那要 import 员工域的 cap 包，按插件规则就得声明 `dependencies.plugins`，与本节「零依赖」直接冲突。
  - 因此语义统一为：**调用方 JSON 带了 `tenant` 就记，没带就是 0**。不再出现「某插件鉴权没写 bizctx」这类隐性坑，取值是否可靠由写入方负责并可用单测锁定。

- **为什么是 JSON 字符串而不是四个独立上下文键**：
  - 四个键要三处各定义四个常量、各写四份单测锁值，漂移面是四倍；且写错 `name` 键不会报错，只会让那一列静默为空，事后无法区分「写入方没写」与「键拼错了」。单键要么整体解析成功、要么整体失败，失败可见。
  - 也不是直接 `SetCtxVar` 传 map / 结构体：那会让某个 Go 具体类型成为契约的一部分，写入方与读取方必须共享类型定义，等于变相引入依赖。
  - 性能不做考虑：员工端每日数千次请求，多一次约 100 字节的 marshal 不可测量。

- **为什么 `id` 用 EmpID 而不是工号**：`CONTEXT.md` 规定 EmpID 是与身份提供方无关的内部代理主键、业务数据一律引用 EmpID；工号是 Moka 的外部锚点，驱动同步去重键。用 EmpID 后接钉钉、换身份提供方都不影响历史记录关联。工号与姓名作为**写入时的快照**一并保存，只用于显示与按人搜索，不承担关联职责。

- **为什么姓名和工号要冗余存快照**：
  - 日志回答的是「当时谁调用了这个接口」。员工改名、换工号、离职、员工行被软删之后，现查员工表得到的是「这个 EmpID 现在叫什么」，不是「当时是谁」。这与 `linapro-monitor-operlog` 存的 `oper_name`（直接落字符串、不存 user_id）是同一套取舍。
  - 写入方本来就把员工对象握在手里，写快照零额外查询。

- **为什么日志插件不依赖 `linapro-employee-core`**：
  - `.agents/rules/plugin.md` 规定 import 其它插件的 `backend/cap/...` 就必须在 `plugin.yaml` 声明 `dependencies.plugins`，那是硬依赖。日志插件一旦依赖员工域，就装不到没有员工端的部署（例如只对外提供 `linapro-lark-push` 接口的环境），而可观测性组件应该是全仓最不挑环境的部分。
  - 反向同理：不用 `backend/cap/apilogcap`，否则 lark-push、考勤都会强依赖日志插件。用字符串约定则两边互不依赖；日志插件未安装时，这个变量没有任何读者。

- **初始接入**：

  | 写入点 | 写入内容 |
  |---|---|
  | `empcap.EmpAuth()`（employee-core 与 eval-360 两处挂载同一个函数） | `{"kind":"emp","id":"<EmpID>","tenant":<租户>,"name":"<姓名>","no":"<工号>"}` |
  | employee-core 的登录控制器 `Login`（`emp_v1_login.go`） | 同上；`LoginRes` 已含 `EmpId`/`TenantId`/`Name`/`MokaEmployeeNo`，零额外查询 |
  | `linapro-lark-push` 签名中间件 | 本期不接入（该插件不被记录，见 D2）；接入时写 `{"kind":"app_key","id":"<app_key>"}` |
  | `linapro-attend-poc` 员工认证 | 不接入：最小验证代码，后续删除；真实考勤插件经 `empcap.EmpAuth()` 鉴权，自动带上调用方 |

  - **为什么登录控制器要单独写一次**：`/emp/login` 挂在 `empcap.EmpAuth()` 之前（`plugin.go:131` 先 `Bind(loginController)`，`plugin.go:133` 才挂 `EmpAuth`），是公开接口。不写这一处，所有登录记录的 `caller_*` 全空——而「我登录不了」恰是最需要知道「谁」的场景。登录成功时 `LoginRes` 里已经有全部四个字段。
  - 登录**失败**时不写：码无效、员工未登记、已离职三种情况下确实不知道是谁，五列留空，靠 `larkAppId` 与请求体排查。
  - 调用方式：控制器里 `g.RequestFromCtx(ctx)` 取到请求后调共用的 `SetCaller(r, ...)` 辅助函数。`SetCtxVar` 是原地改 `*r.Request`（`ghttp_request_param_ctx.go:72-76`），外层中间件 `Next()` 返回后读得到；仓库里 `g.RequestFromCtx` 已有大量先例。
  - 写入点虽有两个，但键名与 JSON 结构只有一份（共用 builder），漂移面没有翻倍。
  - 未来的真实考勤插件会接入 `employee-core` 做员工鉴权，届时同样由 `empcap.EmpAuth()` 写入，日志插件不需要任何改动。
  - `app_key` 形态保留在约定里，是为将来可能出现的对外接口准备；当前没有写入方。

- **防止约定漂移**：写入方用本地常量写这个键，并附注释指向本规范；单测断言常量值等于 `linapro.request.caller`，并断言序列化结果能反序列化回等价结构。

- **拆分存储**：日志插件把 JSON 拆成 `caller_kind`、`caller_id`、`caller_tenant`、`caller_name`、`caller_no` 五列（见 D8）。
  - 没有写入时各列为空，仍可按 IP 和路径排查。
  - 任一字段缺失只影响对应列，其余列照常写入。
  - 解析失败时各列留空并记一条带 request_id 的 `WARNING`，**不丢弃整条记录**。

### D7 异步写入，失败不影响请求

- 判定与组装在请求协程内完成，组装的是纯内存数据。
- **请求开始时间单独存在 `request_at` 列，`created_at` 交给框架**（2026-11-04 用户确认，取代此前「`request_at` 即请求开始时间」的做法）：
  - 中间件在 `Next()` 之前取一次 `startTime := time.Now()`，`cost_ms` 与 `request_at` 共用它，`request_at + cost_ms` 即请求结束时间。
  - INSERT 时**显式赋值** `request_at`，不依赖列 DEFAULT。DEFAULT 只是兜底；若依赖它，异步排队的延迟会让时间筛选变成「写入时间」语义，跨月边界的请求还会落进下一个月的分区。
  - `created_at` 是写库时间，遵守 `backend-go.md`「禁止手动设置 `request_at`」，由 GoFrame 在 INSERT 时自动写入，不参与分区、筛选与排序。做法与 operlog 的 `oper_time`、loginlog 的 `login_time` 一致：事件时间用独立业务列显式写入，`created_at` 不承载业务语义。
  - 将来若改成批量缓冲，这条语义不受影响。
  - 生成 dao 后核对 `do` 层：`RequestAt` 必须被写入，不能因零值/`OmitEmpty` 被跳过。
- 写库通过 `grpool` 异步执行，使用 `r.GetNeverDoneCtx()`，与 operlog 一致。
- 写库失败只记一条 `ERROR` 日志（含 request_id），绝不改变已经发出的响应。
- 每个请求只执行一次 `INSERT`，不做批量缓冲：现阶段量级不需要，也避免进程退出时丢缓冲。

### D8 表结构 `plugin_linapro_monitor_apilog`

**按 `request_at` 做月度范围分区**（见 D9）。分区带来两条硬约束，直接决定了下面的列定义。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `BIGINT NOT NULL DEFAULT nextval('..._record_id_seq')` | 主键之一。**不能用 `GENERATED ALWAYS AS IDENTITY`**：PG 14 不支持分区表上的 identity 列（PG 17 才有）。代价是失去「禁止显式写入 id」的保护，对本表可接受 |
| `request_at` | `TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP` | **分区键**，必须是主键的一部分。语义是**请求开始时间**，由中间件显式写入，见 D7 |
| `request_id` | `VARCHAR(64)` | `gctx.CtxId`，与业务日志关联 |
| `route_owner` | `VARCHAR(100)` | 归属插件 ID，用于按插件筛选与排除名单匹配 |
| `method` | `VARCHAR(10)` | |
| `path` | `VARCHAR(500)` | 实际请求路径 |
| `route_path` | `VARCHAR(255)` | 路由模式，例如 `/x/.../task/{id}`，便于按接口聚合筛选；取不到的来源见下方说明 |
| `query` | `TEXT` | 原始查询串，敏感参数脱敏 |
| `client_ip` | `VARCHAR(64)` | |
| `user_agent` | `VARCHAR(500)` | |
| `caller_kind` / `caller_id` | `VARCHAR(32)` / `VARCHAR(128)` | 见 D6：`emp`/`app_key` 与 EmpID/app_key，`caller_id` 是唯一的机器关联键 |
| `caller_tenant` | `INT` | 见 D6：取自调用方约定；无租户语义时为 0 |
| `caller_name` / `caller_no` | `VARCHAR(64)` / `VARCHAR(64)` | 见 D6：写入时的姓名与工号快照，只用于显示与按人搜索；拿不到时为空 |
| `status_code` | `INT` | HTTP 状态码 |
| `cost_ms` | `INT` | 耗时，单位毫秒 |
| `req_headers` | `TEXT` | JSON，已脱敏 |
| `req_body` / `resp_body` | `TEXT` | 完整内容，已脱敏；PostgreSQL TOAST 会自动压缩 |
| `error_msg` | `TEXT` | |
| `created_at` | `TIMESTAMPTZ` | 写库时间，框架自动写入；不参与分区与筛选，见 D7 |

- **主键 `(id, request_at)`**，不是 `(id)`：分区表的唯一约束必须包含分区键，这是 PostgreSQL 的强制要求。`id` 仍由序列保证全局唯一，所以 `(id, request_at)` 在语义上并不比 `(id)` 弱——它只是把分区键并进索引。
- **`request_at` 必须 `NOT NULL`**：分区键为 NULL 无法路由到任何分区。默认值 `CURRENT_TIMESTAMP` 已保证有值，但 DDL 里要显式写 `NOT NULL`。
- `route_path` 的来源分两种情况：
  - **源码插件**：取处理器注册时声明的路由模式（`handler.Handler.Router.Uri`），能把 `/task/{id}` 这类路径参数还原成模板。
  - **动态插件**：路由元数据只暴露 `PublicPath`，它就是本次请求的真实路径，**不是模板**。此时 `route_path` 与 `path` 相同，不做推断。以后补齐模板再改这里。
- 流水日志，**不做软删除**，也没有 `updated_at`。
- 索引建在**父表**上，PG 会自动为每个已存在和将来新建的分区生成同名索引（PG 11 起的行为），不需要为每个分区单独建。
  - `(request_at)`：默认列表按时间倒序；
  - `(route_owner, request_at)`：按插件筛选；
  - `(caller_id, request_at)`：按 EmpID 或 app_key 查；
  - `(caller_no, request_at)`：按工号查。管理员的入口是工号而不是 EmpID，没有这条索引，按人排查就得先查员工表换 ID；
  - `(caller_name, request_at)`：按姓名查。管理员手上通常只有姓名，工号要先查员工表，因此姓名必须是**独立可用的检索入口**，不是「只做显示」；
  - `(request_id)`：与业务日志互查。
- 路径筛选用前缀 `LIKE 'xxx%'`，且必须同时带时间范围（默认最近 7 天），避免全表扫描。
- **详情查询必须带 `request_at`**（见 D10）：分区表上 `WHERE id = ?` 会退化成扫描全部分区。全局唯一的 `id` 保证结果正确，但代价随分区数线性增长。

### D9 只增不删：记录一旦写入不可删除

**用户确认（2026-11-03）：360 评估与考勤的记录都不允许删除。** 因此取消「按插件保留期 + 每日清理任务」，改为全量永久保存。

- **不注册任何清理定时任务**，不读取保留期配置。配置项 `retention` 从设计中移除。
- **不提供删除接口、页面入口，service 层不暴露 Delete 方法。** 不是把入口藏起来，是根本不写这段代码。
- **卸载不删表**：`manifest/sql/uninstall/` 不写 `DROP TABLE`（见下）。
- **做按月范围分区，但只做「创建」不做「删除」**：分区是查询剪枝与体积控制的手段，与「能不能删」是两件独立的事。设计上必须同守一条纪律：**只用分区剪枝，绝不用 `DROP PARTITION` 或 detached 做批量删除**——那是删除动作，不是分区本身。

#### 分区怎么建、怎么维护

- **粒度：按月**（`PARTITION BY RANGE (request_at)`），分区名 `plugin_linapro_monitor_apilog_p{YYYYMM}`。
  - 日志量按员工端每日数千次、平均 2 KB 估，单月约十几 MB 到百 MB。按月既能有效剪枝，也不会让分区数量失控（每年 12 个）。
  - 按年太粗（一次查询要扫整年），按天太细（十年 3650 个分区，规划与剪枝开销反而增加）。
- **预先创建，不建 DEFAULT 分区**：
  - 建表时一次创建「当前月 + 未来 6 个月」，之后由一个每日任务确保「未来 6 个月」始终存在。`CREATE TABLE IF NOT EXISTS ... PARTITION OF ... FOR VALUES ...` 本身幂等，重复执行无副作用。
  - **不建 DEFAULT 分区**，这是本设计的一个刻意选择。DEFAULT 分区看起来能兜住「忘了建分区」的写入，实际是个陷阱：一旦某段范围的行落进了 DEFAULT，之后再为这段范围建正式分区，`PARTITION OF ... FOR VALUES` 会因为数据重叠直接失败；要修复就必须把这些行**移出去**——而移出去只有 `DELETE` + 重新 `INSERT` 一条路，直接违反「只增不删」。
  - 没有 DEFAULT 时，漏建分区的后果是**写入报 `no partition of relation found for row`**。配合 D7，这会变成一条带 request_id 的 `ERROR` 日志，而业务请求不受影响；补建分区后立即恢复。**「丢一条日志 + 可见的报错」比「数据落进一个将来无法转正的分区」要好。**
- **这个每日任务只创建、不删除**，与 D9 的「不注册任何清理定时任务」不矛盾——禁止的是删除路径，不是所有定时任务。任务在集群里只在主节点执行（`JobsRegistrar.IsPrimaryNode()`），避免多节点同时 DDL。
- **补齐任务不得堵住日志写入**（2026-11-04 用户确认）：
  - PG 14 的 `CREATE TABLE ... PARTITION OF` 要在**父表上拿 ACCESS EXCLUSIVE 锁**。若此时有长查询（管理员跑大范围筛选）占着父表，DDL 排队，而**排在 DDL 后面的所有 INSERT 也一起等**——PG 锁队列先来先得。`IF NOT EXISTS` 不能免锁。
  - **先查再建**：任务先查 `pg_inherits` / `pg_class`，算出「当前月 + 未来 6 个月」里缺哪几个分区，只对缺的发 DDL。正常情况一个月才拿一次锁，其余日子不碰父表。
  - **DDL 前 `SET LOCAL lock_timeout = '5s'`**（与 DDL 在同一事务内）：拿不到锁就放弃，本次任务记失败并经 `larkalert` 告警，次日自动重试。分区提前 6 个月建，偶发失败不会真的缺分区；**宁可本次建不成，也不能堵住写入**。
  - 安装 SQL 里的初始分区不受此约束：安装时表是新建的，没有并发查询。
- **分区管理的边界**：允许「创建新分区」，禁止「detach / drop 已有分区」。将来要改分区粒度只能通过新建表 + 迁移完成，不能靠拆分区绕着走。

#### 分区带来的两个已知代价

1. **详情查询必须带 `request_at`。** 分区表上 `WHERE id = ?` 会依次扫描所有分区（`id` 全局唯一只保证结果正确，不保证快）。因此详情接口设计为 `GET /records/{id}?requestAt=...`，列表已返回 `request_at`，前端无需额外请求（见 D10）。
2. **主键从 `(id)` 变成 `(id, request_at)`**，且 `id` 不能用 identity 列（PG 14 限制，见 D8）。两处都是 PG 14 分区表的强制约束，不是可优化项。

#### 分区补齐失败要报警——用共享库直发，不依赖 lark-push 插件

漏建分区的后果不是「少几条日志」，而是**当月所有日志静默写不进去**（写入报 `no partition of relation found for row`）。这类故障没人会主动去翻定时任务执行记录，必须主动推送。

**方案演进（记录取舍，避免以后有人重新发明）**：

1. ~~在 `larkpushcap.Sender` 上开放 `NotifyAlert`~~——会让 apilog 在 `plugin.yaml` 硬依赖 lark-push，没有 lark-push 的部署就装不上日志插件。否决。
2. ~~apilog 跨插件读 `plugin.linapro-lark-push.alert`~~——跨命名空间读别人的配置键，所有权不清。否决。
3. **共享库 `larkalert` + YAML 锚点共享凭据**——采纳。逻辑一份、凭据一份、插件之间零依赖。

**最终方案**：

- **逻辑落在共享库** `linapro-lark-sdk/larkalert`，与 `larkim` 同级。
  - 现有 `linapro-lark-sdk` 已是共享库（`module linapro-lark-sdk`，无 `plugin.yaml`），六个模块已依赖它，`go.work` 已包含。
  - 库内职责：「读配置 → 判空静默 → 防抖 → 拼正文 → `larkim` 发送 → 失败只记日志」。**防抖只有这一份实现**，将来考勤插件接入不必重写。
- **直接用宿主的 capability 与 logger，不做窄接口适配**：

  ```go
  package larkalert

  type Env struct {
      Config hostconfigcap.Service // 读消费方自己的配置键
      Cache  cachecap.Service      // 防抖计数（Incr 后判是否 == 1）
  }

  type Event struct {
      ConfigKey string // 消费方自己的配置键，库内不写死任何插件
      Kind      string // 稳定取值，同时作为防抖键与正文「类型」行
      Detail    string
  }

  // Notify 无返回值：发送失败在内部记 ERROR，绝不回传、绝不递归告警。
  func Notify(ctx context.Context, env Env, ev Event)
  ```

  **为什么不做窄接口**（原先我一度设计过 `ConfigReader` + `ThrottleFunc`，已撤销）：

  - 源码插件与 `lina-core` 编译进同一个宿主二进制，不存在「SDK 独立发布」的场景，为少引一个包而加一层接口没有任何收益，反而多一处需要维护的抽象。
  - 日志必须走 `lina-core/pkg/logger`——`.agents/rules/backend-go.md:85-86` 明确要求，且禁止直接用 `g.Log()`。告警的失败路径（配置读取失败、发送失败）正是需要打日志的地方。
  - 该库的注释与 README 里写着「MUST NOT 引入 `lina-core`」，但**这条约束没有依据，且早已被同一模块的四个文件违反**——`larkbitable/encode.go`、`larkbitable/write.go`、`larkcontact/client.go`、`larkhttp/ratelimit.go` 全都 import 了 `lina-core/pkg/logger`。它的原始意图（见 `openspec/changes/archive/2026-09-20-extract-shared-lark-sdk/design.md:32,39`）其实是**方向**：「不把飞书 SDK 依赖引入 `lina-core`」，即在描述**计数**时被改写错了。另外两个共享库 `linapro-moka-hcm`、`linapro-moka-recruit` 也都 import `lina-core`（同样只有 `pkg/logger`）。共享库引 `lina-core` 是这个仓库的既定做法，不是例外。

  **但本期不去改那段文案与 `go.mod`**。`larkalert` 按既有事实写（引 `lina-core/pkg/logger`），文案修正留给 `linapro-lark-sdk` 自己的变更——它与本次功能无关，改了会把评审范围扩到一个不相干库的约束重写，谁有异议都会卡住 apilog。同样地，该库 `go.mod` 缺 `require lina-core v0.0.0`（其余共享库都有），导致 `GOWORK=off go build ./...` 报 `package lina-core/pkg/logger is not in std`；但构建全部经 `go.work`（`plugins_env.go:37`），`go mod tidy -diff` 无差异，CI 也没有裸模块编译门禁，属于潜伏问题，一并留给该库。


- **配置用 YAML 锚点共享，不共享键**。`_anchors` 段已存在且注释写明「共享凭据：只在这里登记一次，下面各插件段用 YAML 别名（`*xxx`）引用」，已有 `<<: [*moka, *lark_bitable]` 的先例。

  ```yaml
  _anchors:
    # 运维告警群（分区缺失、定时任务失败等）。各插件按需引用，读的仍是自己的键。
    ops_alert: &ops_alert
      app_id: ""      # 告警专用飞书应用，不参与业务推送
      secret_key: ""
      chat_id: ""     # 应用须已被拉进该群且开了机器人能力
      interval: "30m"

  plugin:
    linapro-lark-push:
      alert: *ops_alert              # 现有行为不变，仍读 plugin.linapro-lark-push.alert
    linapro-monitor-apilog:
      alert: *ops_alert              # 读自己的键 plugin.linapro-monitor-apilog.alert
  ```

  - **锚点只解决「写一遍」，不解决「读哪个键」**——解析后别名展开成字面值，每个插件照旧读自己命名空间下的键。所有权清晰，没有跨命名空间访问。
  - 新增插件接入 = 加两行 YAML，不用改代码去读别人的键。

- **apilog 侧**：`plugin.yaml` **不声明任何依赖**，保持「日志插件可独立安装」。`go.mod` 只加 `linapro-lark-sdk`（与 eval-360、lark-push 等六个模块同型：`replace linapro-lark-sdk => ../linapro-lark-sdk` + `require linapro-lark-sdk v0.0.0`）。

- **报警内容**：`Kind` 用 `apilog_partition_missing`，`Detail` 带目标分区名与失败原因。防抖键 `Kind`（+ 配置键），默认 30 分钟。

- **lark-push 侧一行不改**：它继续用 `backend/internal/service/alert` 那套私有实现与 `plugin.linapro-lark-push.alert` 键。两套实现并存是**有意的**——`alert` 包刻意独立于业务推送通道（`alert.go:1-13`：最需要告警的时刻恰恰是 `push_groups` 损坏的时刻），那是一份带装配约束的内部实现；`larkalert` 是给其他插件用的通用能力。将来可考虑让前者复用后者，本期不动，避免把已经跑通的告警通道一起改坏。

- **顺带约束**：建表 SQL 与补齐任务必须共用同一个「按月份生成分区 DDL」的函数（见 tasks 4b.3），否则会出现「建表时创建的分区范围」与「任务滚动创建的范围」算法不一致，表现为某个月永远缺分区。

#### 能做到什么程度——必须诚实说明

应用是用 **`postgres` 超级用户**连库的（三份配置的 `link:` 均为 `pgsql:postgres:postgres@...`）。因此：

| 手段 | 是否可行 | 原因 |
|---|---|---|
| `REVOKE DELETE` 给应用账号 | **不可行** | 超级用户绕过一切权限检查；且仓库里没有任何 `GRANT`/`REVOKE` 先例 |
| 表级 `BEFORE DELETE` 触发器 | 部分有效 | 能防「手滑写错 WHERE」，防不了 `DISABLE TRIGGER`、`DROP TABLE`；且 `TRUNCATE` 不触发行级触发器，须另加 `BEFORE TRUNCATE` 语句级触发器 |
| 备份 | **唯一兜底** | 只有它能挡住「误删整库」「磁盘损坏」 |

**结论**：在超级用户连接的前提下，「不可删」只能靠**让删除路径不存在**（代码层 + 不写 DROP），而不是靠数据库权限。这挡得住插件自己的代码和审查，挡不住有人直接连库执行 SQL。

- **本期不引入触发器**：仓库无 `CREATE TRIGGER` 先例，且它对超级用户形同建议，收益与「多一套需要维护的 DDL」不成比例。
- **真正的保底是备份**：运维必须为这张表配置定期 `pg_dump`，见 Migration Plan。

#### 卸载不删表之后，重装怎么收敛

卸载保留表后重装时，`CREATE TABLE IF NOT EXISTS` 会跳过建表。这本身不是问题——**只要安装 SQL 把每一列都带上 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`**，新增的列就会被补上。

这是仓库 `database.md` 已经要求的幂等写法，不需要额外发明机制。要守的纪律只有两条：

- 安装 SQL 里每一列都必须有对应的 `ADD COLUMN IF NOT EXISTS`，不能只写在 `CREATE TABLE` 里。**加列**这件事靠它完全覆盖。
- 改列（改类型、改 NOT NULL / 默认值）、加索引、加约束需要显式写 `ALTER` 语句（索引用 `CREATE INDEX IF NOT EXISTS`）。这些操作在首次安装时不写也行，因为建表语句已经带上了；但**只要发生过一次「卸载后重装」，就必须补上对应的 `ALTER`**，否则旧表停在上一个版本的结构。

换句话说：唯一的风险不是「加列」，而是「升级时只改了 `CREATE TABLE` 的列定义却没写对应 `ALTER`」。这是所有幂等迁移的通用约束，不是本插件特有的。

### D10 后台查询页与权限

- **菜单**：「系统监控 → 接口请求日志」。
- **菜单与权限点**：在 `plugin.yaml` 的 `menus:` 段声明，由宿主在安装时同步进 `sys_menu`，卸载时按 `plugin:<plugin-id>:%` 前缀自动清理。**不在 SQL 里 INSERT 菜单**，与 `linapro-monitor-operlog`、`linapro-monitor-loginlog` 一致。
  - 菜单：`key: plugin:linapro-monitor-apilog:apilog`，`parent_key: monitor`，`path: /monitor/apilog`，`component: system/plugin/dynamic-page`，`type: M`。
  - 权限点（`type: B`，挂在上面这个菜单下）：
    - `monitor:apilog:list`：列表，**不含请求体和响应体**；
    - `monitor:apilog:query`：详情，含完整的请求头、请求体和响应体。
  - 权限码沿用本仓「域:能力:动作」的命名，与 `monitor:operlog:list`、`monitor:loginlog:query` 同构。
- **列表筛选**：
  - 时间范围，必填，默认最近 7 天；
  - 归属插件，下拉；只列出现过的 `route_owner`；
  - 路径前缀、调用方（工号 / 姓名 / EmpID）、HTTP 状态（成功 2xx / 失败非 2xx / 指定码）、request_id。
  - 调用方的三个字段**互相之间是 AND**，与筛选栏其他条件一致：不填的字段不进 WHERE，填几个就收紧几个。它们是**同一行**的三个列，描述同一个人，多填一个理应缩小结果集，而不是放大。
  - 只填其中一个时它是唯一的人肉条件，各走自己的 `(x, request_at)` 索引；填多个时规划器挑选择性最高的那条，其余列在同一条记录上过滤。**不拼 `OR`**——OR 会让每个分支都得贡献索引，且未建索引的分支会退化成全分区扫描。
- **详情抽屉**：分区展示请求与响应；JSON 格式化展示。
  - **详情查询必须带 `request_at`**：`GET /records/{id}?requestAt=<Unix 毫秒>`。因为表按 `request_at` 分区，只给 `id` 会扫描全部分区。列表响应本来就带 `request_at`，前端点开详情时直接回传即可，不需要额外查询。
  - 缺少 `requestAt` 时接口**报参数错误**而不是退化成全分区扫描——让调用方显式面对这个契约，比让它悄悄变慢好。
- **数据权限例外**：调用方是员工或外部系统，不是后台用户，记录也不属于任何部门；记录是平台级审计数据。因此不接入部门数据范围，只以权限点控制访问，在实现与审查中记录这一例外。
- 本插件是 `platform_only`，列表不按租户过滤。

### D11 i18n

- 插件**不启用 i18n**（`i18n.enabled: false`），与 `linapro-employee-core`、`linapro-lark-push`、`linapro-eval-360` 同口径：
  - 菜单名、页面标题、表格列、筛选项、详情字段等用户可见文案**直接写中文**，前端不调用 `$t`；
  - API 的 `g.Meta` `dc` 与字段 `dc`/`eg` 用**中文**源文本（`api-contract.md`：插件未启用 i18n 时统一中文），不维护 `apidoc/` 翻译；
  - 日志、启动期 `gerror` 用中文；
  - `manifest/i18n/{zh-CN,en-US}/` 只保留 `plugin.json`（插件名与描述）和 `error.json`（业务错误码文案），不提供 `menu.json` 与 `apidoc/`。
- 记录内容本身原样保存，不翻译。

### D12 360 评估作答正文全量记录

360 评估员工端 `POST /submit` 的请求体含逐被评估人、逐题的答案（`SubmitReq.Items[].Answers[].TextValue`）。这些内容**全文落库、永久保存**（见 D9），阅读门槛只有 `monitor:apilog:query`。

- **这是明确接受的取舍**（2026-11-03 用户决定）：持有 `monitor:apilog:query` 的都是平台管理员，本就信得过。
- **放弃的方案**：成功时只记结构摘要、失败时记全文。它能把「成功的评语」挡在日志表外，但要多一套按接口的摘要生成规则；收益不足以抵消复杂度。
- **已知影响**：该权限构成一条绕过评估业务权限的读取路径——有日志详情权限的人，不需要评估插件的报表/详情权限，就能看到评语原文。
- **实现与审查要求**：
  - 不要把它当缺陷，也不要据此擅自收窄记录范围或加脱敏——那会让「提交了但系统没收到」这类排查失去依据。
  - 若将来要收紧，正确做法是增加业务权限校验或改为摘要记录，并同步改本节与 spec，而不是在中间件里悄悄截断。

## Risks / Trade-offs

- **存储持续增长且没有出口**：请求体和响应体完整保存，且记录只增不删（D9）。按员工端每日数千次请求、平均 2 KB 估算，一年约数 GB，PostgreSQL 可承受；但接上真实考勤后会更陡。这是「不允许删除」这条硬约束的必然代价，不是可以事后调整的余量。
  - 部署后每月观察表大小，并在**上线前**就和运维确认扩容节奏与备份策略。
  - 减少写入：`exclude_route_owners` / `exclude_paths` 排除高频接口。
  - 改善查询：**已做按月分区**（见 D9），靠分区剪枝控制扫描量。分区只用于剪枝，**不得用 `DROP PARTITION` / detached 批量删除**，那才是与「只增不删」冲突的动作。
  - 冷归档：把旧分区迁到低速存储属于架构变更，本期不做；但若做，**必须是复制而非移动**，原表数据不得减少。
- **请求延迟**：中间件不在 `Next()` 之前包装 Body，判定不通过时零开销。被记录的请求多一次 `GetBodyString()`（命中 `bodyContent` 缓存时是零成本，未命中时是一份内存拷贝）和一次 `BufferString()`，写库异步执行。
- **内存占用**：除 `bodyContent` 缓存外不额外持有请求体副本；文件只记元数据，不缓冲。
- **请求体可能未留存**：`GetBodyString()` 依赖 GoFrame 的 `bodyContent` 缓存或可重复读取的 Body。若有处理器读完原始 Body 且不归还，记录里会是 `[BODY 未留存 content-length=N]`。新增插件若直接消费 `r.Request.Body`，其请求体将无法留存，需在 review 中检查。日志插件不为此预装 tee：那会让所有请求（含后台管理与静态资源）白拷贝一次，代价大于收益。
- **隐私**：
  - 员工提交的业务数据会进入日志表，因此详情使用独立权限点，敏感字段落库前脱敏。
  - **360 评估的作答正文全量落库、永久保存，且只由 `monitor:apilog:query` 控制访问**（2026-11-03 用户确认，见 D12）。这意味着该权限不经过评估插件的任何业务权限，就能读到评语原文，且**没有过期这条兜底**。这是明确接受的取舍，不是疏漏：理由见 D12，实现与审查时不要再当缺陷处理，也不要因此擅自收窄记录范围。
  - 非 JSON 的文本体无法结构化脱敏。目前这类接口都使用 JSON，新增文本接口时需评估。
  - 「已排除 `linapro-lark-push`」本身就是一条隐私约束：它明确不记消息正文，本插件也不得以「统一日志」为名把正文存进来。
- **约定漂移**：调用方标识依赖字符串键。各写入方用单测锁定键值与 JSON 结构；写错只会导致对应列为空，不影响记录本身。
- **与 operlog 的边界**：两者按「有没有后台用户名」二分。**但这不是严格互补**——operlog 只记 POST/PUT/DELETE 与带 `operLog` 标签的 GET（`middleware_audit.go:365`）。管理员用 GET 访问一个没打标签的插件接口时，operlog 跳过（方法不符），本插件也跳过（有用户名），这类请求两份日志都没有。本期接受这个空洞：它属于「管理员读取」，不是员工提交，排查诉求弱。将来若需要，把本插件对后台 GET 的排除改成可配置开关。

## Migration Plan

1. 部署新版本后，在插件管理中安装并启用 `linapro-monitor-apilog`。未安装时没有任何影响。
2. 在配置中确认 `exclude_route_owners` 为 `[linapro-lark-push]`。这是默认值，配置模板里显式写出，便于以后有人问「为什么没有推送日志」时能一眼看到；漏配时代码也会回落到同一默认值。
3. 安装 SQL 建表（收敛式 DDL，见 D9），菜单和权限随插件安装生效；给需要排查问题的角色分配 list / query 权限。
4. **上线前必须完成**（D9 的硬约束要求）：
   - 为 `plugin_linapro_monitor_apilog` 配置定期 `pg_dump` 备份，并验证一次恢复。这是「记录不可删」唯一的兜底——数据库层面挡不住超级用户的误操作。
   - 与运维确认表增长预期与扩容节奏。
5. **回滚**：停用（disable）即停止记录，数据保留；卸载（uninstall）也**不删表**，记录仍在。二者都不丢数据。
   - 若要真正删除这张表，只能人工执行 `DROP TABLE`，且应先自行备份。这不是插件能做的操作，这是本设计的意图。

## Open Questions

1. 是否需要导出？本期不做。

已关闭（2026-11-04）：

- **`/emp/me` 是否需要排除**：不需要。它唯一的调用点是员工端外壳 `layouts/emp.vue` 的 `loadProfile()`，仅在「有 token 但内存里没有 profile」时调用一次——即刷新页面或从飞书卡片新开窗口时，用于回填侧栏姓名；登录后的页内跳转不调用。频率与页面打开次数相当，不是轮询。
- **租户管理员是否可看本租户员工的请求记录**：不需要。记录只对平台管理员开放（`platform_only`，见 D10）。
