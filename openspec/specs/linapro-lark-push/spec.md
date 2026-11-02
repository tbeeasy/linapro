# linapro-lark-push Specification

## Purpose
TBD - created by archiving change linapro-lark-push. Update Purpose after archive.
## Requirements
### Requirement: 按调用方分组的推送应用配置

系统 SHALL 从本插件私有配置键 `plugin.linapro-lark-push.push_groups` 读取推送应用分组（FB-2）。
`push_groups` 是以**分组名**为键的映射，分组名 SHALL 为调用方插件 ID（如 `linapro-eval-360`、
`linapro-attend-poc`）或对外 HTTP 签名凭据绑定的分组名；每个分组的值是推送应用数组，元素含
`app_id`、`secret_key`、`name`、`identity_app_id`。系统 MUST NOT 读取已废弃的
`plugin.linapro-lark-push.push_apps`，也不做旧键兼容。

`identity_app_id` 的语义为「该推送应用投递时使用的 `user_id` 取自哪个企业」，其取值 SHALL
对应 `linapro-employee-core` 配置中某个身份应用的 `app_id`。

系统 MUST NOT 读取 `plugin.linapro-employee-core.lark_apps`（登录/通讯录同步应用凭据）——
推送链路只需要企业级 `user_id`（按 `lark_app_id` 查 `lark_identity` 得到），不需要身份应用密钥。

配置校验 SHALL **按分组独立进行**，不变式为：组内 `app_id`、`secret_key`、`identity_app_id`
非空；组内 `app_id` 唯一；组内同一个 `identity_app_id` SHALL NOT 被两个条目引用（否则同一人
在同一企业会收到两条消息）。同一个 `app_id` SHALL 允许出现在多个分组中（由运维决定是否共用
机器人）。某分组非法 MUST NOT 影响其它分组的投递。

#### Scenario: 分组被正确解析

- **WHEN** `push_groups` 配置了 `linapro-eval-360`（2 个推送应用）与 `linapro-attend-poc`（1 个推送应用）
- **THEN** 系统按分组名分别返回 2 个与 1 个推送应用，各自带 `app_id`、`name` 与 `identity_app_id`

#### Scenario: 配置结构非法

- **WHEN** `push_groups` 的值不是映射，或某个分组的值不是对象数组，或数组元素不是对象
- **THEN** 系统返回错误且不返回部分解析结果，所有分组的推送能力不可用（结构无法解析时
  无法可靠划分分组）

#### Scenario: 组内同一身份应用被两个推送应用引用

- **WHEN** 同一分组内两个条目的 `identity_app_id` 相同
- **THEN** 校验返回该分组的问题项，该分组被判为非法

#### Scenario: 一个分组非法不影响其它分组

- **WHEN** `linapro-attend-poc` 分组含空 `secret_key` 条目，而 `linapro-eval-360` 分组合法
- **THEN** 以 `linapro-attend-poc` 发送的请求返回配置非法错误；以 `linapro-eval-360` 发送的请求照常投递

#### Scenario: 同一推送应用出现在多个分组

- **WHEN** 同一个 `app_id` 同时配置在两个分组中
- **THEN** 校验通过，两个分组各自使用该推送应用投递

#### Scenario: identity_app_id 悬空

- **WHEN** 某条目的 `identity_app_id` 在 employee-core 配置中不存在
- **THEN** 配置期无法识别（本插件读不到那份配置），但从 `status` 端点可见该应用
  `addressable_employees == 0`，实际发送时对所有工号返回「无身份」

#### Scenario: 分组未配置

- **WHEN** 调用方请求的分组在 `push_groups` 中不存在，或该分组没有凭据齐备的推送应用
- **THEN** 系统返回「该分组无可用推送应用」错误（错误参数带分组名），MUST NOT 回退到其它分组
  或全部推送应用；登录与通讯录同步不受影响

### Requirement: 飞书凭据配置归属

`linapro-employee-core` SHALL 继续从 `plugin.linapro-employee-core.lark_apps` 读取身份应用
凭据（登录换票与通讯录同步），本次变更 MUST NOT 迁移、废弃或改写这处读取。其它插件的
飞书消息投递（含 `linapro-eval-360` 的测评卡片）SHALL 经本插件门面完成、凭据只取
`push_groups` 中调用方所属分组；除 employee-core 自身外，任何插件 MUST NOT 读取 `lark_apps`。

#### Scenario: 推送插件新增不影响登录与同步

- **WHEN** 启用 `linapro-lark-push` 且填写其 `push_groups`
- **THEN** 飞书登录换票与通讯录同步行为不变，`lark_identity` 行数不变

#### Scenario: 推送插件未配置

- **WHEN** `linapro-lark-push.push_groups` 为空而 `lark_apps` 正常
- **THEN** 登录、同步照常；文本推送与 eval-360 卡片推送均不可用（eval-360 在发布前即拦截）

### Requirement: 工号到 user_id 的跨企业扇出

推送能力 SHALL 以调用方提供的工号为寻址锚点，对**请求分组内**的每个推送应用，按其
`identity_app_id` 查询该企业作用域下 `id_source='own'` 且 `lark_user_id` 非空的
「工号 → 企业级 user_id」映射，命中者各发送一条消息。其它分组的推送应用 MUST NOT 参与本次投递。

工号在分组覆盖的 N 个企业存在 own 身份时 SHALL 发送 N 条（双发为预期行为，不做企业选择、
不跨企业去重）。调用方 SHALL NOT 需要指定企业。

#### Scenario: 员工在两个企业均有身份

- **WHEN** 工号 E1001 在两家企业的 `lark_identity` 中各有 own 行且 `lark_user_id` 非空
- **THEN** 系统分别用两个推送应用的凭据各发一条文本，共 2 条，结果中带 2 条记录

#### Scenario: 员工仅在一个企业有身份

- **WHEN** 工号 E1001 只在其中一家企业有 own 行
- **THEN** 系统只发 1 条；另一企业不产生发送，也不计为失败

#### Scenario: 不同调用方使用不同机器人

- **WHEN** `linapro-eval-360` 与 `linapro-attend-poc` 分别以各自分组向同一工号发送消息
- **THEN** 两条消息分别由各自分组的推送应用凭据发出，接收方看到两个不同的机器人；任一请求
  都不会使用对方分组的推送应用

#### Scenario: 工号在系统中不存在

- **WHEN** 工号未匹配到任何员工记录
- **THEN** 该收件人状态为「未找到」，其余收件人照常发送

### Requirement: 身份应用与推送应用的凭据隔离

发送消息时系统 MUST 使用请求分组内 `push_groups` 条目的 `app_id`/`secret_key` 构造飞书客户端；
`identity_app_id` MUST 仅作为查询 `lark_identity` 的键使用，MUST NOT 用于构造客户端或发起
任何鉴权请求。本插件 MUST NOT 读取身份应用的 `secret_key`。

#### Scenario: 告警不走考勤机器人

- **WHEN** 系统发送一条文本消息
- **THEN** 实际调用飞书发送接口所用的凭据来自请求分组的 `push_groups` 条目，接收方看到的发送方
  机器人是推送应用而非身份（考勤/登录）应用

#### Scenario: 推送应用凭据缺失

- **WHEN** 某分组内条目的 `secret_key` 为空
- **THEN** 该分组被判为配置非法并报告问题项，以该分组发送的请求被拒绝；其它分组不受影响

### Requirement: 用户标识缺失的三态区分

用户标识解析 SHALL 区分三种结果并在结果中体现，不得笼统归为「失败」：

1. 命中：存在 own 行且 `lark_user_id` 非空。
2. own 行存在但 `lark_user_id` 为空——表明身份应用缺少「获取用户 user_id」权限，或该行
   早于授权、等待下次同步回填。
3. 无身份行：该员工在此企业无 own 身份。

情形 2 与 3 的收件人 SHALL 被跳过并计入结果，MUST NOT 中断同批其余收件人的发送。

三态 MUST 按收件人本人判定（FB-14）：只有本人在该企业有 own 行且 `lark_user_id` 为空时才判为
情形 2；本人在该企业没有 own 行时 SHALL 判为情形 3，与该企业其他员工的 `lark_user_id` 是否为空无关。

#### Scenario: 身份应用缺 user_id 权限

- **WHEN** 某企业所有 own 行的 `lark_user_id` 均为空
- **THEN** 在该企业有 own 行的收件人全部被跳过并标记为「无 user_id」，系统记录聚合告警一次，
  且不回退为使用身份应用凭据发送；在该企业没有 own 行的收件人标记为「无身份」

#### Scenario: 同企业其他员工缺 user_id 不影响本人判定

- **WHEN** 工号 E1001 只在企业 A 有 own 行，企业 B 有其他员工的 own 行 `lark_user_id` 为空
- **THEN** E1001 在企业 A 正常发送，在企业 B 标记为「无身份」而不是「无 user_id」；对外接口
  不把 E1001 列为失败项

#### Scenario: 权限刚补、行尚未回填

- **WHEN** 部分 own 行 `lark_user_id` 非空、部分为空
- **THEN** 非空者正常发送，空者跳过并标记，不产生错误中断

#### Scenario: 工号在同一企业命中多行

- **WHEN** 同一工号在该 `identity_app_id` 作用域下匹配到多条 own 行
- **THEN** 该收件人被标记为失败且不发送（不做静默取首条），并记录告警

### Requirement: 进程内推送门面

插件 SHALL 提供进程内 Go 能力门面，供其它插件直接调用发送文本消息。门面 SHALL 在拥有方
插件初始化时绑定实现；消费方每次调用 SHALL 懒取当前绑定，未绑定时 SHALL 返回明确的
「能力未就绪」错误，MUST NOT 静默成功或丢弃消息。

门面请求 SHALL 支持三种收件人写法：工号（由系统解析各企业 `user_id`）、已持有的
`user_id`，或群聊 `chat_id`（FB-6，见「群聊投递」）。门面 SHALL 提供文本（`SendText`）、交互卡片
（`SendCard`）与文件（`SendFile`，FB-7）三种投递。请求 SHALL 携带必填的**分组**（`Group`，取调用方插件 ID），系统只用该分组的推送应用
投递；请求 SHALL 携带调用方标识（业务来源）用于日志对账，并可选携带业务单号。业务来源只用于
日志，MUST NOT 参与选路。

#### Scenario: 分组缺失

- **WHEN** 请求未携带分组或分组为空白
- **THEN** 系统返回参数校验错误，不发起任何飞书请求，MUST NOT 回退为全部推送应用

#### Scenario: 能力未绑定

- **WHEN** 消费方在 `linapro-lark-push` 未启用时调用发送
- **THEN** 返回「能力未就绪」错误，不产生任何发送行为

#### Scenario: 其它插件发送文本

- **WHEN** 已启用的业务插件通过门面以工号请求发送一条文本
- **THEN** 系统完成解析与投递，返回逐收件人 × 逐推送应用的结果

#### Scenario: 收件人为空的请求

- **WHEN** 请求的收件人列表为空或文本为空
- **THEN** 系统返回参数校验错误，不发起任何飞书请求

### Requirement: 进程内交互卡片投递

门面 SHALL 提供进程内交互卡片投递（`SendCard`），寻址、扇出、凭据隔离与错误语义与文本投递
一致：以工号或 `user_id` 为收件人，按请求分组内的推送应用以企业级 `user_id` 投递，凭据只取该分组。
卡片内容 SHALL 由调用方提供的构造函数按「推送应用 × 收件人」生成（卡片模板须授权给发送应用、
跨企业不可复用），构造函数拿到推送应用的公开投影（`app_id`、`name`、`identity_app_id`，
MUST NOT 含密钥）；构造失败 SHALL 只把该条投递记为失败，不中断同批其余投递，且 MUST NOT
为不可寻址的收件人调用构造函数。门面 SHALL 同时提供 `ListPushApps(group)` 返回指定分组内参与
投递的推送应用公开投影，供调用方在发送前按应用预检（分组为空返回参数错误，该分组配置非法时返回
配置错误）。对外 HTTP 接口不提供卡片投递。

卡片投递 SHALL 支持**干跑**（`SendCardRequest.DryRun=true`）：走与正式投递相同的寻址、扇出与卡片
构造编排，但 MUST NOT 调用飞书；能投递的明细记为 `addressable`（不算已送达），寻址失败与构造失败照常
记各自状态，且不写投递日志。供「全部收件人可达才继续」的调用方在发出任何消息前先判定可达性。

#### Scenario: 干跑不调用飞书

- **WHEN** 调用方以 `DryRun=true` 请求投递卡片，收件人 E1 在企业 A 有身份、E2 无任何身份
- **THEN** 不发生任何飞书调用；E1 在 A 的明细为 `addressable`，E2 各明细为 `no_identity`，所有明细的
  `Succeeded()` 均为 false

#### Scenario: 按推送应用构造卡片

- **WHEN** 调用方以工号请求投递卡片，而该员工在两个企业均有身份
- **THEN** 构造函数分别以两个推送应用调用各一次，两张卡片分别经对应推送应用凭据以 `user_id` 投递

#### Scenario: 某企业卡片构造失败

- **WHEN** 构造函数对推送应用 B 返回错误
- **THEN** B 的那条投递记为失败且不发送，A 的投递照常完成

#### Scenario: 列出推送应用

- **WHEN** 调用方在发送前调用 `ListPushApps("linapro-eval-360")`
- **THEN** 只返回该分组内各推送应用的 `app_id`、`name` 与 `identity_app_id`，不含 `secret_key`；
  该分组配置非法（如含空占位条目）时返回配置错误

### Requirement: 对外 HTTP 推送接口与 HMAC 签名鉴权

插件 SHALL 提供对外 HTTP 接口 `POST /x/linapro-lark-push/open/v1/message/text`、
`POST /x/linapro-lark-push/open/v1/message/file`（FB-7）与 `GET /x/linapro-lark-push/open/v1/status`，
供独立外部系统调用。这些接口 MUST NOT 挂载宿主用户会话鉴权与权限点校验，SHALL 由插件自建
**HMAC-SHA256 签名**校验（FB-3）：调用方持有 `app_key` 与 `secret`，`secret` 只用于本地计算签名、
MUST NOT 在网络上传输。

签名凭据 SHALL 存放在本插件数据表 `plugin_linapro_lark_push_api_key`，由后台管理页维护（FB-5，
见「签名凭据后台管理」）；系统 MUST NOT 再读取配置键 `plugin.linapro-lark-push.api_keys`。每次请求
SHALL 按 `app_key` 直接查询数据表、不做缓存，只匹配**启用且未删除**的凭据；凭据的停用、删除与修改
SHALL 在下一次请求即生效。命中凭据绑定的分组即本次投递分组。

请求 SHALL 携带四个头部：`X-App-Key`、`X-Timestamp`（Unix 秒）、`X-Nonce`（16~64 字符的
随机串）、`X-Signature`（小写十六进制 HMAC-SHA256）。待签串的构造规则为：

```text
METHOD + "\n" + PATH + "\n" + CANONICAL_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA256(""))
```

其中 `PATH` 为请求路径（如 `/x/linapro-lark-push/open/v1/message/text`）；`CANONICAL_QUERY`
为查询参数的规范化形式（按参数名、再按值排序后以 `&` 连接 `urlencode(name)=urlencode(value)`，
无参数时为空串）。所有对外接口的请求体 MUST NOT 参与签名（FB-8 文件接口、FB-9 文本接口）：末行固定为
空串的 SHA-256（`e3b0c442…b855`，保留该行以维持待签串结构），签名中间件 MUST NOT 读取请求体。请求体
（消息内容、文件、收件人）因此不受签名保护，生产部署 MUST 走 HTTPS。签名比对 MUST 使用常量时间比较。

时间戳 MUST 落在服务器当前时间 **±300 秒**内。同一 `app_key` 的同一 `nonce` 在有效窗口内
MUST 只能成功使用一次（防重放）：去重状态 SHALL 通过宿主提供给插件的共享缓存能力
（`cachecap`）存储，`cluster.enabled=true` 时 MUST 为跨实例可见的共享存储，MUST NOT 退化为
仅本节点内存；去重条目 TTL SHALL 不小于时间戳窗口的两倍。

系统 MUST 先校验签名、后登记 `nonce`，使未通过认证的请求不产生任何状态变更（不能被用来
消耗他人正在传输中的 `nonce`）。校验通过后系统 SHALL 以该 `app_key` 绑定的分组投递；
请求体 MUST NOT 提供分组选择。请求体大小上限由签名之后的按路由上限中间件校验（FB-12，未通过鉴权的请求不读请求体）：文本接口 256 KB，文件接口 31 MB
（30 MB 文件 + 1 MB multipart 封装），超限返回 413；签名中间件不读请求体，处理器 MUST 能读到完整请求体。

所有对外接口的响应体 MUST 使用宿主统一响应结构 `{code, message, data, errorCode, messageKey, messageParams}`
（FB-12，与后台管理接口一致）：`code` 为 0 表示成功，非 0 时 `errorCode` 为稳定的机器可读错误码，调用方
SHALL 以 `code` 判断成败、以 `errorCode` 判断具体原因，`message` 仅供展示。响应体 SHALL 由宿主统一响应
中间件包装，签名中间件与处理器 MUST NOT 自行写 JSON。

HTTP 状态码 SHALL 只区分三类，其余一律 **200**、由 `code` / `errorCode` 区分（FB-12）：请求体超限 → **413**
（`LINAPRO_LARK_PUSH_BODY_TOO_LARGE`）；凭据表、去重存储、推送能力、员工能力或宿主配置不可用 → **503**
（fail-closed）；服务端推送配置问题（分组无可用推送应用、配置非法）及其它内部错误 → **500**。缺签名头、`app_key`
未知或已停用、时间戳超出窗口、签名不匹配、`nonce` 重复、参数错误均返回 HTTP 200 与各自不同的 `errorCode`。
所有响应体 MUST 是可直接解析的 JSON，不得混入 HTTP 状态文本。日志 MUST NOT 记录 `secret` 与签名原文。

投递结果放在 `data` 中，SHALL 只返回结论与失败项（FB-11）：全部成功时 `code` 为 0、`data` 为
`{"all_succeeded": true}`；存在失败时返回 HTTP 200、`code` 非 0、`errorCode` 为
`LINAPRO_LARK_PUSH_SEND_PARTIAL_FAILED`（FB-12，原为 HTTP 502），`data.failed` 逐项给出失败收件人（按请求的寻址
方式给 `employee_no` / `user_id` / `chat_id` 之一）与 `lark_code`、`lark_msg`、`lark_req_id`，以便调用方只重试
失败的收件人；部分失败 MUST NOT 以 `code` 为 0 返回，避免调用方只判 `code` 时把失败当成功。非飞书侧原因的失败项
`lark_code` 为 0、`lark_msg` 为失败状态（`no_identity` / `user_id_missing` / `collision` / `failed`；工号写错或
不存在不单列状态，归入 `no_identity`，FB-15）。推送应用、`message_id`、错误详情等逐条明细
MUST NOT 出现在响应中，SHALL 记入服务端日志。某人只在部分企业无身份（`no_identity`）是按企业扇出的正常结果，
MUST NOT 计为失败；只有其在所有企业都无身份时才作为一个失败项返回。

#### Scenario: 凭据存储不可用

- **WHEN** 查询签名凭据表失败（如数据库不可达）
- **THEN** 接口返回 HTTP 503 与 `LINAPRO_LARK_PUSH_CREDENTIAL_STORE_UNAVAILABLE`，不处理也不发送任何消息

#### Scenario: 凭据停用即时生效

- **WHEN** 管理员在后台停用某条凭据后，调用方继续以该 `app_key` 发起签名正确的请求
- **THEN** 下一次请求即被拒（HTTP 200，`errorCode` 为 `LINAPRO_LARK_PUSH_SIGNATURE_UNKNOWN_APP_KEY`），不发送任何消息

#### Scenario: 缺少签名头部

- **WHEN** 请求缺少 `X-App-Key`、`X-Timestamp`、`X-Nonce` 或 `X-Signature` 中任一项
- **THEN** 接口返回 HTTP 200 与 `LINAPRO_LARK_PUSH_SIGNATURE_MISSING`，且不进入签名比对与 nonce 登记

#### Scenario: app_key 未知

- **WHEN** 请求的 `X-App-Key` 不对应任何启用且未删除的凭据
- **THEN** 接口返回 HTTP 200 与 `LINAPRO_LARK_PUSH_SIGNATURE_UNKNOWN_APP_KEY`

#### Scenario: 签名校验通过

- **WHEN** 调用方以正确的 `app_key`/`secret` 对一条合法请求计算签名，且时间戳在 ±300 秒内、
  `nonce` 首次使用
- **THEN** 接口返回 HTTP 200、`code` 为 0、`data` 为 `{"all_succeeded": true}`，投递分组取自该 `app_key` 绑定的分组

#### Scenario: 请求体不参与签名

- **WHEN** 调用方按固定末行（空串摘要）计算签名，并提交任意请求体
- **THEN** 鉴权通过，处理器按实际请求体投递；若调用方仍按请求体摘要计算末行，接口以
  `LINAPRO_LARK_PUSH_SIGNATURE_MISMATCH` 拒绝（HTTP 200），不发送任何消息

#### Scenario: 文本接口请求体超限

- **WHEN** 调用方以超过 256 KB 的请求体调用 `message/text`
- **THEN** 系统返回 HTTP 413 与 `LINAPRO_LARK_PUSH_BODY_TOO_LARGE`，响应体为统一结构，不发送任何消息

#### Scenario: 时间戳过期

- **WHEN** `X-Timestamp` 与服务器当前时间相差超过 300 秒
- **THEN** 接口返回 HTTP 200 与 `LINAPRO_LARK_PUSH_SIGNATURE_TIMESTAMP_INVALID`

#### Scenario: nonce 重放

- **WHEN** 同一 `app_key` 用同一 `nonce` 重复提交一条原本合法的请求
- **THEN** 首次通过，后续返回 HTTP 200 与 `LINAPRO_LARK_PUSH_SIGNATURE_NONCE_REPLAYED`，不重复发送消息

#### Scenario: 签名失败不消耗 nonce

- **WHEN** 携带正确 `nonce` 但签名错误的请求先到达，随后合法请求携带同一 `nonce`
- **THEN** 前者的失败不登记 `nonce`，后者仍能正常通过

#### Scenario: 集群模式下的 nonce 去重

- **WHEN** `cluster.enabled=true` 部署多个实例，同一请求被重放到另一实例
- **THEN** 该实例共享同一去重存储，仍返回 `LINAPRO_LARK_PUSH_SIGNATURE_NONCE_REPLAYED`，不会重复发送消息

#### Scenario: 按 app_key 绑定的分组投递

- **WHEN** `app_key` A 绑定分组 `ops-alert`，调用方以 A 签名发送文本
- **THEN** 消息只经 `ops-alert` 分组的推送应用发出，不会使用 `linapro-eval-360` 等其它分组的机器人

#### Scenario: 绑定的分组未配置

- **WHEN** 凭据绑定的分组事后从 `push_groups` 中删除
- **THEN** 接口返回 HTTP 500 与 `LINAPRO_LARK_PUSH_NO_PUSH_APP`，不发送任何消息

#### Scenario: 请求体试图指定分组

- **WHEN** 请求体包含 `group` 字段
- **THEN** 接口按未知字段以 `LINAPRO_LARK_PUSH_INVALID_PARAM` 拒绝请求（HTTP 200），不发送任何消息

#### Scenario: 部分收件人失败

- **WHEN** 请求中一名收件人发送成功、另一名因飞书侧拒绝而失败
- **THEN** 接口返回 HTTP 200、`code` 非 0、`errorCode` 为 `LINAPRO_LARK_PUSH_SEND_PARTIAL_FAILED`，`data.failed`
  只含失败的那名收件人及其 `lark_code` / `lark_msg` / `lark_req_id`，不含成功的收件人与推送应用信息，调用方可据此
  只重试失败者

#### Scenario: 响应体统一结构

- **WHEN** 外部系统调用任一对外接口，无论成功、参数错误、签名错误还是部分投递失败
- **THEN** 响应体为宿主统一结构 `{code, message, data, errorCode, ...}`；除请求体超限（413）与服务端问题（5xx）外
  HTTP 状态码均为 200，调用方以 `code` / `errorCode` 区分结果

#### Scenario: 推送能力未就绪

- **WHEN** 推送实现未绑定（插件装配失败）时调用 `message/text` 或 `status`
- **THEN** 接口返回 HTTP 503 与 `LINAPRO_LARK_PUSH_SENDER_UNBOUND`，响应体为统一结构

#### Scenario: 只在部分企业无身份不算失败

- **WHEN** 某工号在企业 A 送达、在企业 B 没有身份
- **THEN** 接口返回 `code` 为 0、`data` 为 `{"all_succeeded": true}`；若该工号在所有企业都没有身份，则返回
  `LINAPRO_LARK_PUSH_SEND_PARTIAL_FAILED`，`data.failed` 中该工号一项，`lark_code` 为 0、`lark_msg` 为 `no_identity`

### Requirement: 部署与数据缺陷的告警通道

插件 SHALL 提供一个与业务推送完全独立的告警通道，把部署缺陷与数据缺陷推送到配置的飞书群
（FB-17）。告警凭据 SHALL 取自独立配置块 `plugin.linapro-lark-push.alert`（`app_id`、`secret_key`、
`chat_id`、`interval`），MUST NOT 复用 `push_groups` 中的任何推送应用——`push_groups` 配置非法正是
需要告警的场景之一，复用会让告警与故障同时失效。

告警 SHALL 覆盖以下事件，且 MUST NOT 覆盖业务常态：

| 事件种类 | 触发条件 |
|---|---|
| `config_invalid` | 请求分组的推送应用配置结构非法 |
| `no_push_app` | 请求分组没有任何凭据齐备的推送应用 |
| `empcap_unbound` | 工号寻址依赖的员工能力未绑定 |
| `blank_user_id` | 某企业整表 `lark_user_id` 为空（通常缺「获取 user_id」权限） |
| `collision` | 单次请求出现工号对应多个飞书账号 |
| `credential_store_unavailable` | 签名凭据存储不可用 |
| `nonce_store_unavailable` | nonce 去重存储不可用 |
| `assembly_failed` | 推送服务构造失败（装配层漏传依赖） |

以下情形 MUST NOT 告警：调用方侧签名错误（缺签名头、时间戳超窗、签名不匹配、nonce 重放、
`app_key` 未知）、单个收件人的 `user_id` 缺失、单人在某企业无身份、飞书侧单条投递失败。
这些是业务常态或调用方问题，会被扫描器与正常业务反复触发。

同一「事件种类 + 推送分组 + 推送应用」SHALL 在 `interval` 窗口内最多告警一次，防抖状态 SHALL 存于
宿主共享缓存（`cluster.enabled=false` 为进程内、`true` 为跨实例共享），MUST NOT 使用进程内 map。
缓存不可用时 SHALL 退化为每次都发（fail-open）：宁可重复告警也不能漏发。

告警发送失败 SHALL 只记录 ERROR 日志，MUST NOT 递归触发新的告警。`alert` 段缺失或不完整时
SHALL 静默不告警且不影响推送能力，启动时记录一次提示。

#### Scenario: 分组配置损坏

- **WHEN** `push_groups.<group>` 下两个推送应用引用同一个 `identity_app_id`
- **THEN** 请求以 `CodeConfigInvalid` 失败关闭，并向告警群推送一条 `config_invalid`，带分组名

#### Scenario: 业务常态不告警

- **WHEN** 一批收件人中有人的工号不存在，或某人在其中一家企业没有身份
- **THEN** 这些收件人在结果中标记为失败或无身份，MUST NOT 触发任何告警

#### Scenario: 签名错误不告警

- **WHEN** 外部请求因缺少签名头、时间戳超窗或签名不匹配被拒
- **THEN** 请求按各自错误码拒绝，MUST NOT 触发告警

#### Scenario: 告警通道未配置

- **WHEN** `plugin.linapro-lark-push.alert` 未配置或缺少任一必填项
- **THEN** 推送能力照常工作，缺陷只写日志，启动时记录一次「告警通道未配置」提示

#### Scenario: 告警通道的覆盖边界

- **WHEN** 插件未启用、进程已退出，或宿主配置能力本身不可用
- **THEN** 本通道无法自我报告；部署侧 SHALL 配置外部探针轮询 `GET /open/v1/status`，
  以 503 判断推送能力不可用

### Requirement: 外部调用的请求日志

因宿主审计中间件对无宿主身份的调用方不落记录，插件 SHALL 为对外接口的每次调用记录一条
结构化日志，至少包含请求标识、签名凭据的 `app_key`（不含 `secret`）、推送分组、推送应用标识、工号、投递状态、
飞书错误码与飞书请求 ID。失败场景 SHALL 记录错误详情。

#### Scenario: 发送失败留下可追溯记录

- **WHEN** 某收件人发送被飞书拒绝
- **THEN** 日志中包含该次请求的请求标识、推送应用、工号、飞书错误码与飞书请求 ID

#### Scenario: 日志不含密钥

- **WHEN** 检查任一次外部调用的日志
- **THEN** 日志中不出现 `secret` 与签名原文

### Requirement: 签名凭据后台管理

对外 HTTP 接口的签名凭据 SHALL 由后台管理页维护（FB-5），菜单位于宿主「系统设置」目录下，接口挂载
宿主会话鉴权与权限点校验。管理能力 SHALL 包含：分页列表（按名称或 `app_key` 关键字、分组、状态
过滤）、新增、编辑、启停、删除与查看 `secret`。

每条凭据含名称、`app_key`、`secret`、绑定分组、群聊 `chat_id`、群聊推送应用、状态与备注：

- `app_key` SHALL 为 1~64 个字符，仅允许字母、数字、`_`、`-`、`.`，在**未删除**的凭据中唯一；删除后
  同名 `app_key` 可以重新创建。
- `secret` SHALL 为 16~128 个可见 ASCII 字符。新增时 MUST 填写（FB-13）：管理页打开新增表单时在浏览器本地
  预填随机值、可修改或重新生成，留空不允许提交；服务端同样校验，留空返回参数错误且不落库，服务端不再生成
  `secret`。编辑时留空表示保持原值。
- 分组 SHALL 取自 `push_groups` 中已配置的分组名，保存时校验分组存在；管理页的分组下拉 SHALL 从同一
  配置读取。
- 群聊 `chat_id` SHALL 可选（FB-10），格式为 `oc_` 开头、仅含字母与数字；群聊推送应用 SHALL 仅在配置了
  `chat_id` 时可填：分组只有一个推送应用时可留空，有多个时必填，且 MUST 属于绑定分组；保存时校验，不合法
  返回参数错误且不落库。管理页的推送应用下拉 SHALL 取自同一 `push_groups` 配置（不含密钥）。
- 状态 SHALL 使用宿主字典 `sys_normal_disable`（`1` 正常、`0` 停用）。
- 删除 SHALL 为软删除。

列表与详情接口 MUST NOT 返回 `secret`；查看 `secret` SHALL 走独立接口与独立权限点，管理员可以反复查看。
本插件为 `platform_only` 平台配置，凭据不归属组织或个人，数据边界由菜单与按钮权限点控制，不接入
组织数据权限过滤。

#### Scenario: 新增凭据使用表单中的 secret

- **WHEN** 管理员打开新增表单，保留预填的 `secret` 或改为自己填写的合法值后提交
- **THEN** 系统按提交的 `secret` 原样保存，新增结果与「查看 secret」读到的都是该值

#### Scenario: 新增凭据未填写 secret

- **WHEN** 管理员清空 `secret` 后提交新增表单，或绕过管理页直接以空 `secret` 调用新增接口
- **THEN** 管理页阻止提交；接口返回参数错误，不落库

#### Scenario: 配置群聊

- **WHEN** 管理员为凭据填写 `oc_` 开头的 `chat_id`，并在多应用分组中选择分组内的推送应用
- **THEN** 保存成功，列表显示该 `chat_id`，以该凭据签名的后续推送即发往该群

#### Scenario: 群聊配置非法

- **WHEN** `chat_id` 不以 `oc_` 开头，或多应用分组未选推送应用，或所选推送应用不属于绑定分组
- **THEN** 系统拒绝保存并返回参数错误

#### Scenario: app_key 重复

- **WHEN** 新增或编辑后的 `app_key` 与另一条未删除凭据相同
- **THEN** 系统拒绝保存并返回「app_key 已存在」错误

#### Scenario: 分组未配置

- **WHEN** 管理员选择的分组不在 `push_groups` 中
- **THEN** 系统拒绝保存并返回「分组不存在」错误

#### Scenario: 列表不泄露 secret

- **WHEN** 管理员查看凭据列表或详情
- **THEN** 响应中不包含 `secret` 字段

#### Scenario: 查看 secret 需要独立权限

- **WHEN** 持有列表权限、但没有「查看密钥」权限的用户请求查看 `secret`
- **THEN** 系统拒绝请求，不返回 `secret`

#### Scenario: 删除后重建同名 app_key

- **WHEN** 管理员删除一条凭据后，以相同 `app_key` 新增凭据
- **THEN** 新增成功；以旧 `secret` 签名的请求以 `LINAPRO_LARK_PUSH_SIGNATURE_MISMATCH` 被拒

### Requirement: 群聊投递

推送 SHALL 支持以群聊为收件人（FB-6）：收件人给出 `chat_id`，并可给出 `push_app_id` 指明由请求分组内
哪个推送应用发送。对外 HTTP 接口的群聊收件人 MUST 只来自签名凭据的后台配置（FB-10），调用方 MUST NOT
在请求中指定群聊；进程内门面调用方（同进程插件代码）可直接给出群聊收件人。群聊收件人 MUST NOT 按工号扇出，每个群聊只经**一个**推送应用投递一次：

- 分组内只有一个可用推送应用时，`push_app_id` 可省略，默认用该应用；
- 分组内有多个推送应用时，`push_app_id` 必填；
- `push_app_id` MUST 属于请求分组，否则视为参数错误。

上述参数错误 SHALL 在发起任何飞书请求前整体拒绝。群聊收件人 MUST NOT 同时携带工号或 `user_id`。
机器人不在群内等飞书侧拒绝 SHALL 只把该条明细记为 `failed`。个人收件人与群聊收件人 SHALL 可以在同一
请求中混合，但至少要有一个。明细 SHALL 带 `chat_id`。

文本、交互卡片与文件三种投递均 SHALL 支持群聊。对外 HTTP 文本与文件接口 SHALL 在凭据配置了 `chat_id`
时，把该群（连同凭据配置的推送应用）追加到 `recipients` 之后投递，此时 `recipients` 可省略；凭据未配置群聊
且 `recipients` 为空时 SHALL 以 `LINAPRO_LARK_PUSH_INVALID_PARAM` 拒绝（HTTP 200）。请求体带 `chats` 字段 SHALL 以未知字段按同一参数错误拒绝。卡片构造函数对群聊
收件人调用时，收件人参数 SHALL 带 `chat_id`。

#### Scenario: 单应用分组省略 push_app_id

- **WHEN** 分组只有一个推送应用，请求群聊收件人只给 `chat_id`
- **THEN** 消息经该推送应用以 `receive_id_type=chat_id` 发送，明细一条

#### Scenario: 多应用分组缺少 push_app_id

- **WHEN** 分组有两个推送应用，请求群聊收件人未给 `push_app_id`
- **THEN** 系统返回参数错误，不发送任何消息（含同请求中的个人收件人）

#### Scenario: push_app_id 不属于分组

- **WHEN** 群聊收件人的 `push_app_id` 不在请求分组内
- **THEN** 系统返回参数错误，不发送任何消息

#### Scenario: 个人与群聊混发

- **WHEN** 请求同时包含一个工号与一个群聊
- **THEN** 工号按企业扇出投递，群聊只经指定推送应用投递一次，明细分别列出

#### Scenario: 对外接口按凭据配置的群聊投递

- **WHEN** 凭据配置了 `chat_id`，调用方以该凭据签名调用文本接口且只传 `text`
- **THEN** 系统只向该群投递一次，明细带该 `chat_id`

#### Scenario: 调用方不能指定群聊

- **WHEN** 调用方在文本接口请求体或文件接口表单中携带 `chats`
- **THEN** 系统以 `LINAPRO_LARK_PUSH_INVALID_PARAM` 拒绝（HTTP 200），不发送任何消息

#### Scenario: 机器人不在群内

- **WHEN** 推送应用的机器人未被拉入目标群
- **THEN** 该群聊明细为 `failed` 并带飞书错误码，同请求的其它明细照常投递

### Requirement: 文件与图片推送

推送 SHALL 支持发送文件（FB-7）。对外 HTTP 接口 `POST /x/linapro-lark-push/open/v1/message/file` SHALL
接收 `multipart/form-data`：`file`（必填）、`recipients`（JSON 数组字符串，元素同文本接口；凭据配置了群聊时
可省略）、`biz_ref`（可选）；出现其它表单字段（含 `chats`）SHALL 以 `LINAPRO_LARK_PUSH_INVALID_PARAM` 拒绝（HTTP 200）。群聊取自签名凭据配置（见「群聊投递」）。请求体不参与签名（同文本接口，
见上文签名鉴权要求），调用方无需为签名读取整个文件；请求体超过 31 MB SHALL 返回 413。门面 SHALL 提供 `SendFile`（文件名 + 文件内容）。

消息形态由文件内容决定：

- 内容识别为 JPEG、PNG、GIF、WEBP、BMP 或 ICO 且不超过 10 MB 时，SHALL 上传为图片并以 `image` 消息发送；
- 其余文件（含超过 10 MB 的图片）SHALL 上传为文件并以 `file` 消息发送，飞书 `file_type` 按扩展名取
  `opus`、`mp4`、`pdf`、`doc`、`xls`、`ppt`，其余为 `stream`；
- 文件为空或超过 30 MB SHALL 返回参数错误。

飞书 `file_key` / `image_key` 只能由上传它的应用使用，因此系统 SHALL 对每个推送应用**最多上传一次**，
且只在该应用至少有一条可投递明细时才上传；某应用上传失败 SHALL 只把该应用下的明细记为 `failed`。
文件内容 MUST NOT 落盘或持久化，处理完即丢弃。响应结构与文本接口一致。

#### Scenario: 图片以图片消息发送

- **WHEN** 调用方上传一张 2 MB 的 PNG
- **THEN** 系统按推送应用上传图片并发送 `image` 消息，接收方在会话中直接看到图片

#### Scenario: PDF 以文件消息发送

- **WHEN** 调用方上传 `report.pdf`
- **THEN** 系统以 `file_type=pdf` 上传并发送 `file` 消息

#### Scenario: 两个企业各上传一次

- **WHEN** 收件人在两个企业都有身份，另有一个群聊指定企业 A 的推送应用
- **THEN** 每个推送应用各上传一次，三条明细复用各自应用的上传结果

#### Scenario: 无可寻址收件人时不上传

- **WHEN** 所有收件人在某推送应用对应企业都没有身份
- **THEN** 该推送应用不发生上传调用

#### Scenario: 文件超限

- **WHEN** 上传文件超过 30 MB
- **THEN** 接口拒绝请求，不发送任何消息

#### Scenario: 某应用上传失败

- **WHEN** 推送应用 B 上传文件失败而 A 成功
- **THEN** B 下的明细为 `failed`，A 下的明细照常投递

#### Scenario: 文件接口签名不含请求体

- **WHEN** 调用方按固定末行计算签名后，以 multipart 请求体调用 `message/file`
- **THEN** 鉴权通过并按表单投递

#### Scenario: 文件接口请求体超限

- **WHEN** 调用方以超过 31 MB 的请求体调用 `message/file`
- **THEN** 系统返回 HTTP 413 与 `LINAPRO_LARK_PUSH_BODY_TOO_LARGE`，响应体为统一结构，不触发任何上传或投递

