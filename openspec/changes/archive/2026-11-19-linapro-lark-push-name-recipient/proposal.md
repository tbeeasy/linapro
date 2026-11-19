## Why

外部系统接入推送时，手上常常只有**人名**而不是工号：告警系统从业务库里读到的是「责任人姓名」，
HR 侧导出的名单是姓名，运维在黑名单里写的也是姓名。当前 `recipients` 只接受 `employee_no` 与
`user_id`，调用方被迫自己维护一份「姓名 → 工号」对照表，或者退回手工查人后再调接口。

Moka 员工姓名（`employee.name`）由 HR 在员工目录里维护，且已约定**不会重名**（重名时 HR 会在姓名后
标记部门加以区分），因此它可以作为稳定的寻址锚点使用。把姓名解析放进推送插件，调用方只需传名字。

## What Changes

- **在同一接口上加收件人写法，不新增接口**：`POST /x/linapro-lark-push/open/v1/message/text` 与
  `message/file` 的 `recipients[]` 元素新增 `name` 字段，与 `employee_no`、`user_id` 三选一。
  门面 `larkpushcap.Recipient` 同步新增 `Name` 字段，进程内调用方同样可用。
  - 接口开新路径会把「寻址方式 × 消息类型」做成笛卡尔积，签名鉴权、分组绑定、凭据群聊合并、
    请求体上限、统一响应收尾、错误码全部要复制一遍；请求体是严格解码的，新增可选字段对既有调用方零影响。
- **姓名按 Moka 员工姓名精确匹配**：去首尾空白后与 `employee.name` 原值比对（不做大小写或全半角归一）。
  解析跨全部租户、只看**在职**员工；同一自然人在多个租户各有一行（工号相同）视为同一人。
- **解析只做一次批量查询**：整批姓名经 `empcap.MapByNamesAnyTenant` 一次查出，内存判定，不逐条查库。
- **重名按数据异常处理、该条记失败**：去重后仍匹配到 ≥2 名在职员工时，该收件人返回
  `LINAPRO_LARK_PUSH_SEND_PARTIAL_FAILED` 下的失败项（`lark_msg` 为 `name_duplicate`），MUST NOT
  静默取其一——发错人比发不出去严重。业务上已约定不重名，此分支是防御性兜底，不是常规路径。
- **姓名解析出来后走既有扇出**：解析结果替换为工号，之后的企业扇出、碰撞判定、`user_id` 缺失判定、
  群聊绑定全部复用现有链路，行为不变。
- **失败项回显调用方的寻址方式**：姓名寻址的失败项给 `name`，不回显解析出的工号。
- **新增失败状态** `name_not_found`、`name_duplicate`，与既有 `no_identity` / `user_id_missing` /
  `collision` / `failed` 并列，`lark_code` 均为 0。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `linapro-lark-push`：进程内门面的收件人写法由三种扩为四种（新增姓名）；对外 HTTP 接口的
  `recipients[]` 元素新增 `name`，投递结果失败项按寻址方式回显 `name`，并新增两个失败状态。

## Impact

- **代码**：`backend/cap/larkpushcap`（`Recipient.Name`、`RecipientKindName`、`Delivery.Name`、两个状态常量）、
  `backend/internal/service/send`（`send_name.go` 解析编排、`NamePath` 依赖）、
  `backend/api/push/v1/push_text.go`（两个 DTO 字段）、`backend/internal/controller/push/push_result.go`
  （收件人投影与失败项回显）、`backend/plugin.go`（注入姓名解析来源）。
- **运行期依赖**：`send.New` 新增必填参数 `NamePath`，由 `plugin.go` 传入
  `linapro-employee-core/backend/cap/empcap` 新增的门面函数；owner 是 employee-core（员工表的唯一写入方），
  创建位置是该门面的包级函数，传递路径 `plugin.go → send.New → serviceImpl.namePath`，
  与既有 `IndexPath`（`empcap.LarkUserIDResolverByApp`）同一形态，无新增共享实例。
- **employee-core**：`backend/cap/empcap/empcap_facade.go` 新增一个只读门面函数
  `EmployeesByNamesAnyTenant`，包装既有的 `Service.MapByNamesAnyTenant`，不改接口、不改库表。
- **配置与数据库**：无变更。无新增配置键、无新增表或列、无迁移。
- **i18n**：本插件 `i18n.enabled: false`，新增文案与错误状态均为中文源码文本，无语言资源变更。
- **前端**：无页面变化；后台「飞书推送凭据」页不涉及收件人写法。
- **兼容性**：纯增量。既有调用方不传 `name` 时行为完全不变；请求体严格解码下新增字段不破坏旧请求。
