## Context

`linapro-lark-push` 的收件人目前锚定在**工号**（`RecipientKindEmployeeNo`）或调用方已持有的企业级
`user_id`（`RecipientKindUserID`），群聊用 `chat_id`。三种写法在 `larkpushcap.Recipient.Kind()` 里
互斥判定，`internal/service/send` 的 `dispatch` 按推送应用逐个扇出、按 `identity_app_id` 取
「工号 → user_id」索引逐人投递。

工号是稳定的，但**不一定在调用方手里**：告警系统、业务库、运维工单里存的是责任人姓名。当前这类调用方
只能自建「姓名 → 工号」对照表，或人工查人，这条链路把人员数据的权威性从 employee-core 又搬回了每个
调用方。

员工的权威姓名在 `employee.name`（Moka 同步写入），HR 的约定是**重名时在姓名后标记部门**加以区分，
即姓名在当前数据下可当作唯一定位符。`empcap.Service` 已提供按姓名集合跨租户批量查询的方法
`MapByNamesAnyTenant`，返回「姓名 → 同名全部员工行」，明确把重名与在职判定留给消费方。

## Goals / Non-Goals

**Goals:**

- 对外 HTTP 文本 / 文件接口与进程内门面都能按 Moka 员工姓名寻址个人收件人，与既有寻址方式在同一
  `recipients[]` 元素里三选一。
- 姓名解析只做一次批量查询，不随收件人数产生 N+1。
- 解析结果完全复用既有的企业扇出与三态判定，不新增第二条投递路径。
- 解析失败（找不到、重名）逐条记失败项，不阻断同批其余收件人。

**Non-Goals:**

- 不做姓名模糊匹配、拼音匹配、大小写或全半角归一——姓名按原值精确匹配。
- 不支持按飞书通讯录昵称 / 显示名寻址（那是飞书侧数据，不是 `employee.name`）。
- 不改 employee-core 的 `Service` 接口、库表或同步逻辑，也不改 `linapro-eval-360` 现有的姓名解析实现。
- 不新增「允许姓名寻址」的凭据开关：能拿到签名凭据的调用方本来就能按工号把全公司发一遍。

## Decisions

### D1：加在既有接口的 `recipients[]` 上，不开新路径

`name` 是**收件人的寻址方式**，不是一种新的消息。开 `/message/text-by-name` 会把「寻址 × 消息类型」
变成笛卡尔积（文件接口马上要第二份），并复制签名、分组绑定、凭据群聊合并、请求体上限、统一响应收尾与
错误码映射。请求体是 `DisallowUnknownFields` 严格解码的，新增可选字段对既有调用方零影响。

`RecipientReq` 因此变成 `employee_no` / `user_id` / `name` **三选一**。同时给出多个时按参数错误拒绝——
即使 `employee_no` 与 `user_id` 现在有「以工号为准」的兜底，也**不为姓名沿用**：姓名与工号指向不同的人时
静默取其一就是发错人，而调用方显然是搞混了字段。

### D2：姓名 → 工号的解析下沉到 empcap 门面，规则与 eval-360 的既有实现对齐

`linapro-eval-360` 已在 `internal/service/relation/relation_resolve.go` 固化了一套「按姓名解析员工」规则
（只看在职、同工号跨租户视为一人、去重后 0 人找不到 / ≥2 人重名）。该规则直接决定**发给谁**，两处各写
一遍迟早会漂移，且仓库规范要求新增能力前先检索复用。

做法：在 `empcap_facade.go` 新增只读门面函数

```go
func EmployeesByNamesAnyTenant(ctx context.Context, names []string) (map[string][]*empcap.Employee, error)
```

只做「取绑定服务 + 透传 `MapByNamesAnyTenant`」，未绑定时返回 `ErrServiceUnbound`（与
`LarkUserIDResolverByApp` 一致，静默返回空会让「所有人都找不到」掩盖装配缺陷）。**判定规则留在消费方**：
eval-360 的现有规则服务于「录入评价关系」，推送侧的选择（失败项状态、是否告警）不同，硬合会造成一个
函数背两种语义。本次不搬 eval-360 的实现，只把「回退到同一份数据与同一批量契约」这件事固定下来。

### D3：解析在 `send` 层做，位置在分组校验之后、扇出之前

三个投递入口（`SendText` / `SendCard` / `SendFile`）共用同一条编排，姓名解析必须对三者一致生效，
因此放在 service 层而不是控制器：

```text
normalizeGroup → normalizeRecipients → requirePushApps → bindChatPushApps
  → resolveNames（新增）→ dispatch → 合并解析失败项 → logRequest
```

放在 `requirePushApps` 之后，是为了让「分组没配好」这类配置错误先于一次员工库查询暴露，且不给明显
不会成功的请求白查一次库。

`Service` 新增必填运行期依赖 `NamePath`
（`func(ctx, names []string) (map[string][]*empcap.Employee, error)`），与既有 `IndexPath` 同一形态：
由 `plugin.go` 注入 `empcap.EmployeesByNamesAnyTenant`，测试注入内存实现。必填而非可选，缺失即装配缺陷，
在 `New` 返回错误。

### D4：判定规则

对一批去重后的姓名一次查询，逐个姓名：

| 情况 | 结果 |
|---|---|
| 无该姓名 | 失败项，`lark_msg = name_not_found` |
| 仅在职（`Status == 1`）行，去重后 1 人且有工号 | 用其工号替换该收件人，走既有扇出 |
| 去重后 1 人但工号为空格 | 失败项，`lark_msg = failed`（此人无工号无法寻址，属数据缺陷，正文说明原因） |
| 去重后 ≥2 人 | 失败项，`lark_msg = name_duplicate`（MUST NOT 取其一） |

**只看在职**：离职员工不接收业务消息；用户已确认 HR 会在重名时于姓名后标记部门，故 `name_duplicate`
是防御性兜底而非常规路径。**去重键**：工号非空用工号，否则用 `EmpID`——同一自然人在多个租户各有一行时
工号相同，必须算一人，否则双租户企业会全部误判重名。

### D5：解析失败不阻断整批，逐条回显原始姓名

失败项以零明细的形式并入 `SendResult.Deliveries`（`Status` 为 `name_not_found` / `name_duplicate`，
`PushAppID` 为空），与「某人在所有企业都无身份」同一处理层级：`AllSucceeded()` 为 false，
对外接口返回 `LINAPRO_LARK_PUSH_SEND_PARTIAL_FAILED` 并在 `data.failed` 列出该姓名。

`Delivery` / `FailedRes` 新增 `Name` 字段；按姓名寻址的失败项**只回显 `name`**，不回显解析出的工号——
调用方没有工号这个概念，回显它只会让人以为可以拿它重试。

### D6：姓名与工号混用同一请求时去重

解析发生在客户端去重之后，可能出现「显式工号 E1001」与「姓名 A（解析为 E1001）」同批存在。解析阶段
把后者丢弃，保证同一人只发一次；请求级 `normalizeRecipients` 的去重键相应加入 `Name`，
使两个相同姓名也只查一次、只发一次。

## Risks / Trade-offs

- **姓名不是稳定键**：员工改名后旧姓名立刻解析不到（`name_not_found`），已发出的历史请求无法追溯。
  这是把权威数据让给 HR 目录的必然代价；工号寻址仍是推荐写法，README 明确「优先用工号」。
- **重名依赖业务约定**：`name_duplicate` 分支的保护是「不取其一」，若 HR 标记部门的约定被破坏，
  表现为该条推送失败而非发错人——失败可见、发错不可见，选择失败。
- **依赖 empcap**：姓名寻址与工号寻址共用员工能力，`linapro-employee-core` 未启用时按
  `LINAPRO_LARK_PUSH_EMPCAP_UNBOUND`（HTTP 503）失败关闭，不降级为「按名字猜」。
- **线上数据核对**：上线前建议对生产 `employee` 表按姓名 + 在职跑一次重名统计，确认约定成立；
  统计出重名的姓名不会被误发，只是会持续失败，能从失败状态直接定位。

## Migration Plan

无数据迁移。字段为可选，无配置变更；回滚只需回退代码，已发出消息不受影响。

## Open Questions

无。
