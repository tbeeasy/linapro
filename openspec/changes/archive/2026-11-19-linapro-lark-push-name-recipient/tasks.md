## 1. 员工能力门面（linapro-employee-core）

- [x] 1.1 `backend/cap/empcap/empcap_facade.go` 新增只读门面函数
  `EmployeesByNamesAnyTenant(ctx, names []string) (map[string][]*Employee, error)`：
  `BoundEmployeeService()` 为 nil 时返回 `ErrServiceUnbound`，否则透传 `MapByNamesAnyTenant`；
  加方法与降级语义注释（中文）。不改 `Service` 接口。
- [x] 1.2 `backend/cap/empcap/empcap_facade_test.go` 补测试：已绑定时返回映射、未绑定时返回
  `ErrServiceUnbound`、批量查询错误原样上抛。

## 2. 门面契约（linapro-lark-push/backend/cap/larkpushcap）

- [x] 2.1 `Recipient` 新增 `Name` 字段；`RecipientKindName = "name"`；`Kind()` 增加姓名分支，
  并更新「三种写法互斥」注释为四种（姓名与 `chat_id`、工号、`user_id` 混用返回空串判参数错误）。
- [x] 2.2 `Delivery` 新增 `Name` 字段（按姓名寻址时回显）。
- [x] 2.3 新增 `DeliveryStatusNameNotFound = "name_not_found"`、`DeliveryStatusNameDuplicate = "name_duplicate"`，
  并在 `SendTextRequest` / `SendCardRequest` / `SendFileRequest` 的 `Recipients` 注释说明姓名寻址。

## 3. 姓名解析编排（linapro-lark-push/backend/internal/service/send）

- [x] 3.1 `send.go`：新增 `NamePath` 类型
  `func(ctx context.Context, names []string) (map[string][]*empcap.Employee, error)`；
  `serviceImpl` 增加 `namePath` 字段；`New` 增加必填参数并校验非 nil（缺依赖返回 error）。
- [x] 3.2 新建 `send_name.go`：`resolveNames(ctx, recipients) (resolved []larkpushcap.Recipient, failures []larkpushcap.Delivery, err error)`。
  - 收集去重后的姓名，一次批量查询（空集合不查库）；
  - 逐个姓名判定：仅在职、按「工号，否则 EmpID」去重计数；0 → `name_not_found`，
    ≥2 → `name_duplicate`，1 但工号为空 → `failed`（带原因），1 → 替换为工号收件人并保留 `Name`；
  - `ErrServiceUnbound` → 告警 `KindEmpcapUnbound` 并返回 `CodeEmpcapUnbound`（与工号寻址一致）；
  - 已显式给出的工号集合用于去重，避免姓名与工号指向同一人时发两条。
- [x] 3.3 `send_request.go`：`normalizeRecipients` 的去重键加入 `Name`；姓名与 `chat_id` /
  工号 / `user_id` 混用按参数错误拒绝（姓名不与工号「以工号为准」兜底）；`push_app_id` 只允许群聊的既有校验保持。
- [x] 3.4 `send_text.go` / `send_card.go` / `send_file.go`：在 `bindChatPushApps` 之后调用
  `resolveNames`，把解析失败项并入 `result.Deliveries`，再 `logRequest`。卡片干跑路径同样适用。
- [x] 3.5 `send_dispatch.go`：`deliverOne` 防止姓名收件人漏解析（`Kind()==name` 时记为 `failed`，
  属内部不变量违例）；`logRequest` 的失败行输出姓名。

## 4. API 与控制器（linapro-lark-push）

- [x] 4.1 `backend/api/push/v1/push_text.go`：`RecipientReq` 新增 `Name`（`dc`、`eg`），`FailedRes` 新增 `Name`；
  `SendTextReq.Recipients` 与 `g.Meta.dc` 补充姓名寻址说明；`lark_msg` 的 `dc` 增加两个新状态。
- [x] 4.2 `backend/internal/controller/push/push_result.go`：`toRecipients` 传递 `Name`；
  `toFailedRes` 按寻址方式回显（有 `Name` 时只给 `name`，不回显解析出的工号）。

## 5. 装配（linapro-lark-push）

- [x] 5.1 `backend/plugin.go`：`send.New(...)` 传入 `empcap.EmployeesByNamesAnyTenant`。
  记录 DI 来源：owner 为 `linapro-employee-core/backend/cap/empcap`，创建位置为该包级门面函数，
  传递路径 `plugin.go → send.New → serviceImpl.namePath`，与既有 `IndexPath` 同形态，无新增共享实例。

## 6. 测试

- [x] 6.1 `backend/internal/service/send/send_name_test.go`：
  - 姓名扇出到两个企业各一条；
  - 姓名不存在 → `name_not_found` 失败项，同批其它收件人照常投递；
  - 同名两名在职员工 → `name_duplicate`，不发任何消息；
  - 同名但在职 + 离职 → 按在职投递，不判重名；
  - 跨租户同工号两行 → 视为一人，只发一份；
  - 姓名与显式工号指向同一人 → 只发一条；
  - empcap 未绑定 → 返回错误 + 一次 `KindEmpcapUnbound` 告警；
  - 姓名与工号同时给出 → 参数错误；
  - 100 个姓名只发起一次批量查询（计数替身）。
- [x] 6.2 既有 `send_test.go` / `send_alert_test.go` / `send_integration_test.go` / `send_text_test.go`
  的 `New(...)` 调用补 `namePath` 参数（可用空的假实现）；`TestNew_RequiresRuntimeDependencies` 增加
  「缺姓名解析来源」用例。
- [x] 6.3 `backend/internal/controller/push/push_test.go`：`toFailedRes` 回显姓名、不回显工号；
  `toRecipients` 传递姓名。
- [x] 6.4 门禁：`cd apps/lina-plugins/linapro-lark-push && go test ./... -count=1`；
  `cd apps/lina-plugins/linapro-employee-core && go test ./backend/cap/empcap/... -count=1`；
  `make lint dir=apps/lina-plugins/linapro-lark-push` 与 `dir=apps/lina-plugins/linapro-employee-core`
  （或 `linactl lint.go` 等价入口）。

## 7. 文档

- [x] 7.1 `README.md` / `README.zh-CN.md` 同步维护：`recipients[]` 字段表加 `name`、
  失败项的 `name` 回显与两个新状态的含义、姓名匹配口径（Moka 员工姓名、精确匹配、仅在职、需启用
  employee-core），并写明「优先用工号」。
- [x] 7.2 `plugin.yaml` 的 `description` 补充「收件人可按 工号 / user_id / 姓名寻址」，
  保存后核对长度不超过 512 字符。
- [x] 7.3 `openspec validate linapro-lark-push-name-recipient --strict` 通过。
