## ADDED Requirements

### Requirement: 按员工姓名寻址个人收件人

推送 SHALL 支持以 Moka 员工姓名（`employee.name`）作为个人收件人的寻址方式，与工号（`employee_no`）、
企业级 `user_id` 三选一，对进程内门面（`SendText` / `SendCard` / `SendFile`）与对外 HTTP 文本、文件接口
一致生效。同一收件人元素给出多于一种寻址方式时 SHALL 以 `LINAPRO_LARK_PUSH_INVALID_PARAM` 拒绝（HTTP 200），
MUST NOT 静默取其一——姓名与工号指向不同的人时会发错人。

姓名 SHALL 去掉首尾空白后与员工姓名**原值精确匹配**，不做大小写、全半角或拼音归一，也 MUST NOT 使用
飞书通讯录昵称。解析 SHALL 跨全部租户进行，只认**在职**（`status` 为在职）员工；同一自然人在多个租户
各有一行（工号相同）时 SHALL 视为同一人、只发一份。

姓名解析 SHALL 对整批收件人做**一次**批量查询并在内存判定，MUST NOT 逐收件人查库。解析发生在跨企业
扇出之前：解析成功后以该员工的工号替换原收件人，其后的企业扇出、`user_id` 缺失判定与工号碰撞判定
SHALL 完全沿用既有的工号寻址路径。

解析失败 SHALL 只把该收件人记为失败项，不阻断同批其余收件人，失败状态为：

| 情形 | `lark_msg` |
|---|---|
| 无任何在职员工使用该姓名（含员工改名后旧姓名、Moka 未同步到该人） | `name_not_found` |
| 去重后有两名及以上在职员工使用该姓名 | `name_duplicate` |
| 匹配到一名在职员工但其工号为空，无法寻址 | `failed` |

上述失败项的 `lark_code` SHALL 为 0。系统 MUST NOT 在同名多人时选取其中一人投递；该分支是数据异常的
防御性兜底（业务约定 HR 在重名时于姓名后标记部门，正常数据不会命中）。

姓名解析依赖员工能力（`empcap`），未绑定时请求 SHALL 以 `LINAPRO_LARK_PUSH_EMPCAP_UNBOUND`（HTTP 503）
失败关闭，MUST NOT 降级为静默跳过或按其它方式猜测收件人。

失败项 SHALL 按**调用方的寻址方式**回显：按姓名寻址时给 `name`，MUST NOT 回显解析出的工号。同一请求中
既有显式工号、又有解析到同一人的姓名时，该人 SHALL 只投递一次。

#### Scenario: 按姓名投递并自动扇出

- **WHEN** 调用方以 `{"name": "张三"}` 请求发送文本，张三在两个企业均有在职身份且 `lark_user_id` 非空
- **THEN** 系统以两个推送应用各投递一条，结果 `all_succeeded` 为 true，接收方按企业收到各自机器人的消息

#### Scenario: 姓名不存在

- **WHEN** 请求的姓名在员工目录中没有任何在职员工
- **THEN** 接口返回 `LINAPRO_LARK_PUSH_SEND_PARTIAL_FAILED`，`data.failed` 中该项带 `name`、`lark_code` 为 0、
  `lark_msg` 为 `name_not_found`，同批其它收件人照常投递

#### Scenario: 同名多人被拒绝投递

- **WHEN** 去重后有两名在职员工使用同一姓名
- **THEN** 该收件人记为 `name_duplicate` 失败项且不发送任何消息，MUST NOT 只发给其中一人

#### Scenario: 离职员工不参与匹配

- **WHEN** 某姓名同时对应一名在职员工与一名离职员工
- **THEN** 按在职的那名员工投递，不判为重名

#### Scenario: 同时给出姓名与工号

- **WHEN** 同一收件人元素同时给出 `name` 与 `employee_no`
- **THEN** 接口以 `LINAPRO_LARK_PUSH_INVALID_PARAM` 拒绝（HTTP 200），不发送任何消息

#### Scenario: 姓名与用户标识混用同一请求

- **WHEN** 请求中一项显式给 `employee_no` 为 E1001，另一项给姓名「张三」且张三的工号正是 E1001
- **THEN** 该人只收到一条消息，不重复投递

#### Scenario: 姓名解析不产生逐人查库

- **WHEN** 一次请求按姓名给出 100 个收件人
- **THEN** 系统只发起一次员工批量查询，不随收件人数增加查询次数

#### Scenario: 员工能力未绑定

- **WHEN** `linapro-employee-core` 未启用，调用方按姓名推送
- **THEN** 接口返回 HTTP 503 与 `LINAPRO_LARK_PUSH_EMPCAP_UNBOUND`，不发送任何消息

## MODIFIED Requirements

### Requirement: 进程内推送门面

插件 SHALL 提供进程内 Go 能力门面，供其它插件直接调用发送文本消息。门面 SHALL 在拥有方
插件初始化时绑定实现；消费方每次调用 SHALL 懒取当前绑定，未绑定时 SHALL 返回明确的
「能力未就绪」错误，MUST NOT 静默成功或丢弃消息。

门面请求 SHALL 支持四种收件人写法：工号（由系统解析各企业 `user_id`）、已持有的
`user_id`、Moka 员工姓名（由系统先解析为工号再扇出，见「按员工姓名寻址个人收件人」），或群聊
`chat_id`（FB-6，见「群聊投递」）。门面 SHALL 提供文本（`SendText`）、交互卡片
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

#### Scenario: 其它插件按姓名发送文本

- **WHEN** 已启用的业务插件通过门面以员工姓名请求发送一条文本
- **THEN** 系统先解析为工号再按企业扇出，返回逐收件人 × 逐推送应用的结果

#### Scenario: 收件人为空的请求

- **WHEN** 请求的收件人列表为空或文本为空
- **THEN** 系统返回参数校验错误，不发起任何飞书请求

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
方式给 `employee_no` / `user_id` / `name` / `chat_id` 之一）与 `lark_code`、`lark_msg`、`lark_req_id`，以便调用方只重试
失败的收件人；部分失败 MUST NOT 以 `code` 为 0 返回，避免调用方只判 `code` 时把失败当成功。非飞书侧原因的失败项
`lark_code` 为 0、`lark_msg` 为失败状态（`no_identity` / `user_id_missing` / `collision` / `name_not_found` /
`name_duplicate` / `failed`；工号写错或
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

#### Scenario: 按姓名推送

- **WHEN** 调用方在 `recipients` 中只给 `{"name": "张三"}` 并调用 `message/text`
- **THEN** 系统把姓名解析为工号后按企业扇出投递，响应只含 `all_succeeded` 或失败项

#### Scenario: 姓名寻址的失败项回显姓名

- **WHEN** 请求中一名按姓名寻址的收件人不存在，另一名按工号寻址的收件人送达
- **THEN** `data.failed` 中该项只带 `name`（不带解析出的工号）、`lark_code` 为 0、`lark_msg` 为 `name_not_found`

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

### Requirement: 群聊投递

推送 SHALL 支持以群聊为收件人（FB-6）：收件人给出 `chat_id`，并可给出 `push_app_id` 指明由请求分组内
哪个推送应用发送。对外 HTTP 接口的群聊收件人 MUST 只来自签名凭据的后台配置（FB-10），调用方 MUST NOT
在请求中指定群聊；进程内门面调用方（同进程插件代码）可直接给出群聊收件人。群聊收件人 MUST NOT 按工号扇出，每个群聊只经**一个**推送应用投递一次：

- 分组内只有一个可用推送应用时，`push_app_id` 可省略，默认用该应用；
- 分组内有多个推送应用时，`push_app_id` 必填；
- `push_app_id` MUST 属于请求分组，否则视为参数错误。

上述参数错误 SHALL 在发起任何飞书请求前整体拒绝。群聊收件人 MUST NOT 同时携带工号、`user_id` 或姓名。
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
