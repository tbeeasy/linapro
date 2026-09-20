## Why

`linapro-recruit-pipeline` 与 `linapro-moka-report-sync` 各自维护了一份几乎相同的飞书
（Lark）SDK 二次封装：Bitable 的 `ListFields`/`ListRecords`/`BatchCreate`/`BatchUpdate`
REST 调用骨架逐字重复，字段值转换（按飞书字段类型把字符串转成数字/毫秒时间戳）逻辑也高度重叠。
两份拷贝已经开始各自演化：日期字段要求毫秒时间戳的 `DatetimeFieldConvFail` 修复只落在了
recruit-pipeline 一侧，report-sync 那份是独立实现——divergence 已经发生，继续放任会导致
下次修 bug 再次漏改，且每新增一个飞书插件都要再抄一遍。

## What Changes

- 新建独立 Go module `linapro-lark-sdk`（module 名去掉 `lina-plugin-` 前缀以免被治理规则误当插件 owner），
  承载飞书 SDK 的二次封装：REST 调用骨架 + 字段值编解码，作为库供插件复用（不含 `plugin.yaml`，
  不是可加载插件）。落地 Bitable 读写子包 `larkbitable` 与通讯录枚举子包 `larkcontact`，模块结构
  预留后续其它飞书能力（如消息、审批）的扩展空间。
- 通讯录子包 `larkcontact` 承载全量枚举一个飞书企业本租户通讯录成员的通用机制：因飞书
  `contact.user.list` 只返回指定部门直属成员且不递归，须先递归枚举部门（`Department.Children` +
  `fetch_child`，仅取 `member_count>0` 的部门）再逐部门 `FindByDepartment` 拉取、按 open_id 去重。
  这套"非显而易见"的遍历知识下沉到共享库，避免每个用通讯录的插件重复踩坑。`linapro-employee-core`
  的员工目录同步改为依赖该子包（原本地部门遍历实现删除），业务侧姓名 JOIN、租户映射不变。
- 共享库提供中立的 `Client`、`Table`、`Row`/`CreateOp`/`UpdateOp`/`ExistingRecord` 类型，
  以及 `ListFields`/`ListRecords`/`ListRecordsByID`/`BatchCreate`/`BatchUpdate`/`UploadMedia`。
- 值转换通过可注入的 `Encoder`（`ParseDateMillis`/`ParseNumber`/`CellFallback` 三个函数字段）
  吸收两边语义差异；并列导出具名解析原语 `ParseEpochMillisUTC`/`ParseEpochMillisCST`/
  `ParseNumberPlain`/`ParseNumberLoose`，谁用谁挑，避免共享库变成万能配置怪物。
- 日期字段编码统一：空值或无法解析时**跳过该列**，避免 `DatetimeFieldConvFail`；字段类型判断
  使用 SDK 常量 `larkbitable.TypeNumber`/`larkbitable.TypeDateTime`，不用魔术数字。
- `linapro-recruit-pipeline` 与 `linapro-moka-report-sync` 删除各自的 `lark` 封装，改为
  依赖共享库（go.mod require + replace），各自注入对应 Encoder；report-sync 保留其
  `syncer.CreateOp/UpdateOp`（带 `Name`）与共享库 op 之间的薄桥接。
- 前述迁移部分为纯重构：两插件对外可观测行为不变（同步结果、日期/数字写入语义、限流、幂等均保持一致）。
- 【本次增补，非重构】共享库 `larkbitable` 新增对飞书人员字段类型（`larkbitablesdk.TypeUser`=11）的写入支持：
  `CreateOp`/`UpdateOp` 增加 `Persons map[string][]string` 旁路（列名 → 已解析的 open_id 集合），`rowToFields`
  把该旁路渲染为飞书人员字段要求的对象数组 `[]Person{{Id}}`；集合为空时**跳过该列**（与日期/数字「无法解析即
  跳列」一致，避免整批写入失败）；`Row` 中人员列的裸文本一律忽略并记 error（人员字段不接受纯文本）。共享库
  **不做任何身份解析**，只做协议序列化。字段类型判断直接使用 `larkbitablesdk.TypeUser`，**不新增
  `larkbitable.TypeUser` 导出**（现有 `TypeText/TypeNumber/TypeDateTime` 导出在消费方并无引用，不再扩大此类导出）。
  写侧 `user_id_type=open_id`，与旁路传入的 id 语义一致——调用方须保证传入的是写表格那个应用作用域的 open_id
  （open_id 按开发者应用作用域签发，不可跨应用混用；b-own 通道拿到的 open_id 属 b 应用作用域，对 a 租户表格无效）。
- 【消费侧】`linapro-employee-core` 的 `empcap.Service` 新增只读方法 `MapLarkOpenIDsByEmployeeNo(ctx, larkAppID string)
  (map[string][]string, error)`：JOIN `employee`（`moka_employee_no`）+ `lark_identity`，**按写表格的 `lark_app_id`
  作用域过滤**、跨租户、不限在职、不按 `id_source` 过滤，一次查询返回「工号 → 该应用作用域下该人全部 open_id」映射
  （同一自然人同时为 own 与 assoc、或跨多个飞书企业时各有 open_id，全部返回）。此方法供同步任务在周期开始时
  构建一次内存映射，避免逐人查库的 N+1。**为何必须按 app 过滤**：open_id 按（开发者应用）作用域签发，同一工号
  在不同应用下有不同 open_id，全表返回会混入其它应用作用域的 id、写入即错。
- 【消费侧】`empcap` 门面另提供共享 helper `LarkOpenIDResolverByEmployeeNos(ctx, larkAppID string)
  (func(employeeNos []string) []string, error)`：内部调一次 `MapLarkOpenIDsByEmployeeNo` 并返回按内存查找的多工号
  解析闭包（多工号合并、按 open_id 去重）。员工服务未绑定时返回 `(nil, nil)`、查询失败返回 `(nil, err)`，消费方据此
  降级（人员列跳过、不阻断同步）。多个插件复用同一 helper，「批量加载」逻辑只此一份，消费方各自仅一行调用。
- 【关联组织枚举】`larkcontact` 的 `ListAllUsers` 仅枚举 own 租户通讯录；新增关联组织枚举方法：调
  `directory.collaboration_tenant.list` 列关联租户，逐租户递归 `directory.collaboration_share_entity.list`
  （`TargetTenantKey` 定位目标租户）拉共享成员，返回 `Source="assoc"` 的用户（仅 open_id，无 user_id）。
  与 own 通道共用中立 `User` 类型（新增 `Source` 字段标识 own/assoc）。assoc 枚举失败 soft-fail
  （warning 不阻断 own）。
- 【消费侧】`linapro-recruit-pipeline` 的 `RunInterviewSync` 与 `linapro-moka-report-sync` 的 `RunOnce`
  在每个同步周期开始时调用一次 `empcap.LarkOpenIDResolverByEmployeeNos`，在插件边界把工号解析为 open_id 集合后
  经 `CreateOp.Persons`/`UpdateOp.Persons` 旁路交共享库序列化；面试官列/报表人员列（人员字段）因此得以正确写入。
  两插件均新增 employee-core 的 require+replace 依赖。
- 【读侧人员列旁路】`larkbitable` 的 `ListRecords` 与 `ListRecordsByID` 回读时，除文本投影外 SHALL 对
  `TypeUser` 列解析出结构化 open_id 集合旁路（复用同一 `personCellToPersons` 逻辑，两读取接口回读语义一致），
  供消费方对人员列做 open_id 集合比对而非姓名文本比对。**BREAKING（仅共享库内部消费方）**：`ListRecordsByID`
  返回类型由 `map[string]Row` 变为携带人员旁路的记录映射，`linapro-recruit-pipeline` 的 `report_sync.go`
  与 `interview_sync.go` 两处调用点随之调整（本 change 内一并完成）。

## Capabilities

### New Capabilities
- `linapro-lark-sdk`: 飞书 SDK 二次封装共享库的行为契约——Bitable 读写 REST 调用（分页、
  批量切块 ≤1000、限流）、字段值编解码（日期→毫秒时间戳且空值跳列、数字类型转换、**人员列经 `Persons`
  旁路接收已解析的 open_id 集合、仅序列化为对象数组，空集合跳列**、单元格回读归一化、**人员列回读结构化旁路
  （`ListRecords`/`ListRecordsByID` 对 `TypeUser` 列解析出 open_id 集合，供调用方按集合比对而非姓名文本）**）、以及通过可注入 Encoder 承载
  调用方差异化语义的扩展点（日期/数字/单元格兜底三个可替换函数）；另含通讯录全量枚举
  （own 租户：部门递归 + `member_count>0` 过滤 + 逐部门成员拉取 + open_id 去重 + 字段缺失排障日志；
  关联组织：`CollaborationTenant.List` + `CollaborationShareEntity.List` 拉共享成员，`Source` 标识
  own/assoc，仅 open_id）。

### Modified Capabilities
<!-- 无。本次为纯重构：report-sync 的「批量写入与限流」等 requirement 描述的可观测行为不变，
     仅实现下沉到共享库，属实现细节，不构成 spec 级 requirement 变更。 -->

## Impact

- **新增模块**：`apps/lina-plugins/linapro-lark-sdk/`（module 名 `linapro-lark-sdk`），
  依赖 `github.com/larksuite/oapi-sdk-go/v3` 与 `github.com/gogf/gf/v2`；加入 `go.work`。
- **`linapro-recruit-pipeline`**：删除 `backend/lark/bitable.go`+`bitable_test.go`；
  `backend/go.mod` 加 require+replace；调用点 `job/interview_sync.go`、`job/report_sync.go`、
  `job/ai_verdict.go`、`webhook/push_candidate.go` 改引用共享库类型。
- **`linapro-moka-report-sync`**：删除 `backend/internal/lark/bitable.go`；`backend/go.mod`
  加 require+replace；`backend/internal/service/sync.go` 注入 CST/Loose/Stringify Encoder
  并做 op 类型桥接。
- **`linapro-lark-sdk` 新增子包**：`larkcontact/`（`client.go` + `client_test.go`），承载通讯录
  全量枚举；依赖 `github.com/larksuite/oapi-sdk-go/v3/service/contact/v3`。
- **`linapro-employee-core`**：`backend/go.mod` 加 require+replace；`plugin_sync.go` 的
  `larkAppFetcherAdapter` 由自带部门遍历实现（约 150 行）改为共享库 `larkcontact.Client` 薄壳
  （仅 `larkcontact.User` → `sync.LarkUser` 类型映射）；不再直接 import `service/contact/v3`。
- **构建/治理**：库模块无 `plugin.yaml`，已核实 build glob（`*/plugin.yaml`）与治理扫描
  （`discoverPluginRoots` 按 `plugin.yaml` 存在与否过滤）均会跳过，不会被误当插件。
- **依赖边界**：飞书 SDK 依赖不进入 `lina-core`，仅在插件层的共享库中引入。
- **【增补】`linapro-lark-sdk`**：`larkbitable/types.go` 的 `CreateOp`/`UpdateOp` 增加 `Persons` 旁路字段；
  `larkbitable/encode.go` 的 `rowToFields` 增加 `case larkbitablesdk.TypeUser` 分支（忽略裸文本并记 error +
  渲染 `Persons` 旁路）；`encode.go` 需 import `larkbitablesdk`（`client.go` 已 import，包内已有该依赖）；
  `encode_test.go` 补人员字段编码用例。SDK 仍不依赖 `lina-core`/`empcap`，不做任何身份解析。
- **【增补】`linapro-employee-core`**：`backend/cap/empcap/empcap.go` 的 `Service` 接口新增
  `MapLarkOpenIDsByEmployeeNo`；`backend/internal/service/employee/employee.go` 实现（JOIN `employee.moka_employee_no`
  与 `lark_identity`、按 `lark_app_id` 过滤、跨租户去重收集 open_id）；`empcap_facade_test.go` 的 `fakeService` 补该方法。
- **【增补】`linapro-employee-core`（helper）**：`backend/cap/empcap/empcap_facade.go` 新增
  `LarkOpenIDResolverByEmployeeNos(ctx, larkAppID)`，封装「调一次 `MapLarkOpenIDsByEmployeeNo` + 返回多工号内存
  查找闭包」，供所有写飞书人员字段的插件复用，避免各自重复搭建。
- **【增补】`linapro-recruit-pipeline`**：`backend/go.mod` 增加 `require lina-plugin-linapro-employee-core`
  + `replace => ../linapro-employee-core`；`job/interview_sync.go` 的 `RunInterviewSync` 周期开始时调用
  `empcap.LarkOpenIDResolverByEmployeeNos(ctx, cfg.LarkAppID)`，在插件边界把该轮面试官工号解析为 open_id 集合，
  经 `CreateOp.Persons`/`UpdateOp.Persons` 旁路写入面试官列（`FieldKeyInterviewer`），`Encoder` 只设
  `UserIDType=open_id`。
- **【增补】`linapro-moka-report-sync`**：`backend/go.mod` 增加 `require lina-plugin-linapro-employee-core`
  + `replace => ../linapro-employee-core`；`backend/internal/service/sync.go` 的 `RunOnce` 调用
  `empcap.LarkOpenIDResolverByEmployeeNos(ctx, cfg.LarkAppID)`，在 `syncer.Plan` 内把工号解析为 open_id 集合后
  经 `op.Persons` 旁路产出，`Encoder` 只设 `UserIDType=open_id`；其余日期/数字/兜底语义不变。
- **【增补·读侧旁路】`linapro-lark-sdk`**：`larkbitable/client.go` 的 `ListRecords`/`ListRecordsByID`
  回读 `TypeUser` 列时解析 open_id 集合旁路（复用 `personCellToPersons`），`ListRecordsByID` 返回类型随之变更；
  `client_test.go` 补人员列回读用例（含无人员列时旁路为空）。**`linapro-recruit-pipeline`**：`job/report_sync.go`、
  `job/interview_sync.go` 两处 `ListRecordsByID` 调用点适配新返回类型（本 change 内完成，保留按 record_id 索引不变）。
