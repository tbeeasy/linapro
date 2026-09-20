## 1. 新建共享库模块

- [x] 1.1 创建 `apps/lina-plugins/linapro-lark-sdk/go.mod`（module 名 `linapro-lark-sdk`，go 1.25.0，依赖 `github.com/larksuite/oapi-sdk-go/v3` 与 `github.com/gogf/gf/v2`），**不创建 `plugin.yaml`**。注：module 名刻意去掉 `lina-plugin-` 前缀——治理规则 `ownerPluginIDFromImport` 按该前缀识别插件 owner，若沿用前缀会把共享库当插件、给消费方 import 报 `PluginPackageBoundary` finding。去前缀后治理检查零新增 finding。
- [x] 1.2 在根 `go.work` 的 `use (...)` 列表加入 `./apps/lina-plugins/linapro-lark-sdk`
- [x] 1.3 创建包 `larkbitable/types.go`：中立类型 `Row`、`CreateOp{Fields,Attachments}`、`UpdateOp{RecordID,Fields,Attachments}`、`ExistingRecord{RecordID,Fields}`

## 2. 共享库 REST 与编码实现

- [x] 2.1 `larkbitable/client.go`：迁入 `Client`、`Table`、`NewClient(appID,appSecret)`、`WithEncoder(Encoder)`，常量 `maxBatchSize=1000`/`listPageSize=500`/`throttle=250ms`
- [x] 2.2 迁入 REST 方法 `ListFields`/`ListRecords`/`ListRecordsByID`（分页、节流、envelope 判错）
- [x] 2.3 迁入 `BatchCreate`（返回 record_id，顺序与输入一致）/`BatchUpdate`（≤1000 切批、节流、失败带 code/msg）
- [x] 2.4 内置 `logFieldMismatch`：写入前比对表 schema，未知字段名给可诊断 debug 日志
- [x] 2.5 迁入 `UploadMedia` 与附件列编码（file_token 对象数组）
- [x] 2.6 `larkbitable/encode.go`：`Encoder{ParseDateMillis,ParseNumber,CellFallback}`；`rowToFields` 用 `larkbitable.TypeNumber`/`TypeDateTime` 常量分支，日期空值/解析失败**跳列**
- [x] 2.7 导出并列解析原语：`ParseEpochMillisUTC`、`ParseEpochMillisCST`（`ParseInLocation`+东八区+Moka 布局）、`ParseNumberPlain`、`ParseNumberLoose`（容忍 `%`/千分位）
- [x] 2.8 `NewClient` 默认 Encoder = UTC + Plain + 通用单元格兜底；`cellToString(v,fallback)`

## 3. 共享库单测与自验证

- [x] 3.1 `encode_test.go`：覆盖 UTC/CST 两套日期解析、Plain/Loose 两套数字解析、空日期跳列、附件列生成、单元格富文本扁平化
- [x] 3.2 `cd apps/lina-plugins/linapro-lark-sdk && go build ./... && go vet ./... && go test ./... -count=1` 全绿

## 4. 改造 linapro-recruit-pipeline

- [x] 4.1 `backend/go.mod` 加 `require linapro-lark-sdk v0.0.0` + `replace => ../linapro-lark-sdk`
- [x] 4.2 删除 `backend/lark/bitable.go` 与 `bitable_test.go`
- [x] 4.3 调用点改引用共享库（默认 Encoder，UTC+Plain）：`job/interview_sync.go`、`job/report_sync.go`、`job/ai_verdict.go`、`webhook/push_candidate.go`（`lark.Row/CreateOp/UpdateOp/Client/NewClient/Table/ExistingRecord`）
- [x] 4.4 `cd backend && go build ./... && go vet ./... && go test ./... -count=1` 全绿；确认面试时间列仍写毫秒时间戳（`DatetimeFieldConvFail` 场景不回退）

## 5. 改造 linapro-moka-report-sync

- [x] 5.1 `backend/go.mod` 加 require + replace
- [x] 5.2 删除 `backend/internal/lark/bitable.go`
- [x] 5.3 `backend/internal/service/sync.go`：用 `WithEncoder` 注入 `ParseEpochMillisCST`+`ParseNumberLoose`+`syncer.Stringify`
- [x] 5.4 落库边界做 op 桥接：`syncer.CreateOp/UpdateOp`（含 `Name`）→ 共享库 op（取 `Fields`）；共享库 `ExistingRecord` → `syncer.ExistingRecord`（浅拷贝）
- [x] 5.5 `cd backend && go build ./... && go vet ./... && go test ./... -count=1` 全绿；确认 CST 日期与 `%`/千分位数字、`-` 占位符归一化行为不变

## 6. 整体回归

- [x] 6.1 根目录 `go build ./...`（经 go.work）确认跨模块 replace 生效、无循环依赖
- [x] 6.2 `make plugins.check`（若可用）确认 `linapro-lark-sdk` 未被治理扫描误当插件
- [x] 6.3 确认 `lina-core/go.mod` 未新增 larksuite 依赖（依赖边界保持）

## 7. 新增 BatchGetByIDs 精准批量读取

- [x] 7.1 `larkbitable/client.go` 新增 `BatchGetByIDs(ctx, t Table, recordIDs []string) (map[string]Row, []string, error)`：空列表短路返回；按 ≤100 个 record_id 切批调用 `client.Bitable.V1.AppTableRecord.BatchGet`（`NewBatchGetAppTableRecordReqBodyBuilder().RecordIds(...)`），批次间 `throttle` 节流；命中行经 `cellToString` 扁平化后以 record_id 为键汇总，`resp.Data.AbsentRecordIds` 累加返回；`resp.Success()` 为假时返回含 code/msg 的错误。新增常量 `maxBatchGetSize=100`
- [x] 7.2 `client_test.go`（或等价）覆盖：250 个 ID 切 3 批（100+100+50）、部分 ID 落入 absent、空列表不发请求
- [x] 7.3 `cd apps/lina-plugins/linapro-lark-sdk && go build ./... && go vet ./... && go test ./... -count=1` 全绿

## 8. 新增 larkcontact 通讯录枚举子包

- [x] 8.1 新建包 `larkcontact/client.go`：中立类型 `User{OpenID,UserID,Name,Source}`（`Source` 标识 own/assoc）；`Client`（app 级凭证）+ `NewClient(appID,appSecret)` + `AppID()`。**【drift 修正：Doc（`User{OpenID,UserID,Name}`）与现状一致；新增 `Source` 字段是本次扩大——需改该字段与所有构造点】**
- [x] 8.2 `ListAllUsers(ctx)`：全量枚举本租户通讯录并按 open_id 去重。飞书 `contact.user.list` 只返回指定部门直属成员且不递归，故先递归枚举全部部门（`Department.Children` + `FetchChild(true)`，含根部门 "0"），仅保留 `member_count>0` 的部门，再逐部门 `User.FindByDepartment` 分页拉取，跨部门按 open_id 去重。**【现状：仅 own 通道，已在位。本次改：`User` 增加 `Source="own"` 落值；新增关联组织枚举方法（见 8.2b）】**
- [x] 8.2b 新增关联组织枚举方法：调 `directory.collaboration_tenant.list` 列关联租户，逐租户递归 `directory.collaboration_share_entity.list`（`TargetTenantKey` 定位目标租户）拉共享成员，返回 `Source="assoc"`、仅 open_id（无 user_id）；按 **app 级配置开关** gating（默认关）；失败 soft-fail（warning 不阻断 own）。**【现状：不存在——FB-5 曾删除，本次重新引入；代码未实现，需落地】**
- [x] 8.3 排障 debug 日志：部门 ID 全集、每部门去重后新增人数、`FindByDepartment` 原始条数与因 open_id/name 为空跳过的条数（提示字段级 scope 缺失）
- [x] 8.4 `client_test.go`（fakeHTTP 注入）覆盖：`member_count=0` 部门被过滤、跨部门 open_id 去重、open_id/name 为空成员被跳过、关联组织枚举返回 assoc 身份、assoc 枚举失败 soft-fail 不阻断 own
- [ ] 8.5 改造 `linapro-employee-core`：`backend/go.mod` 加 require+replace；`plugin_sync.go` 的 `larkAppFetcherAdapter` 改为共享库 `larkcontact.Client` 的薄壳（`larkcontact.User` → `sync.LarkUser` 类型映射，透传 `Source`），删除本地部门遍历实现
- [ ] 8.6 `cd apps/lina-plugins/linapro-lark-sdk && go build/vet/test`、`cd apps/lina-plugins/linapro-employee-core/backend && go build/vet/test` 全绿

## 11. recruit-pipeline 人员列解析上收（Persons 旁路）

- [ ] 11.1 `backend/go.mod`：增加 `require lina-plugin-linapro-employee-core v0.0.0` + `replace lina-plugin-linapro-employee-core => ../linapro-employee-core`
- [x] 11.2 `backend/job/interview_sync.go`：`RunInterviewSync` 开头调用 `empcap.LarkOpenIDResolverByEmployeeNos(ctx, cfg.LarkAppID)` 取得多工号解析闭包；面试官列**不进 Row**，改为在插件侧用该闭包把该轮次全部面试官工号（逗号拼接后拆分）解析为去重 open_id 集合，经 `CreateOp.Persons`/`UpdateOp.Persons` 旁路写入，`Encoder` 只设 `UserIDType=lark.UserIDTypeOpenID`。服务未绑定或查询失败时解析器为 nil（人员列跳过，不阻断同步）。**（身份解析归位后修订：不再向 SDK 注入解析器；`multiEmployeeNoResolver` 已删除，合并去重上收 empcap）**
- [ ] 11.3 `cd apps/lina-plugins/linapro-recruit-pipeline/backend && go build ./... && go vet ./... && go test ./... -count=1` 全绿
- [ ] 11.4 逐模块 `go build ./...`（recruit-pipeline / employee-core / lark-sdk）确认跨模块 replace 生效、无循环依赖（recruit-pipeline → employee-core → lark-sdk 单向）

## 12. moka-report-sync 人员列解析上收（Persons 旁路）

- [ ] 12.1 `backend/go.mod`：增加 `require lina-plugin-linapro-employee-core v0.0.0` + `replace lina-plugin-linapro-employee-core => ../linapro-employee-core`
- [x] 12.2 `backend/internal/service/sync.go`：`RunOnce` 调用 `empcap.LarkOpenIDResolverByEmployeeNos(ctx, cfg.LarkAppID)`（失败记 warning 并降级），`Encoder` 只设 `UserIDType=lark.UserIDTypeOpenID`（**不注入人员解析器**）；人员列由 `syncer.Plan` 解析一次后经 `op.Persons` 旁路产出，`toLarkCreates`/`toLarkUpdates` 映射该旁路。日期/数字/单元格兜底语义不变。**（身份解析归位后修订）**
- [ ] 12.3 `cd apps/lina-plugins/linapro-moka-report-sync/backend && go build ./... && go vet ./... && go test ./... -count=1` 全绿
- [ ] 12.4 逐模块回归确认 report-sync → employee-core → lark-sdk 单向、无循环依赖

## 13. 人员字段编码归位（身份解析上收消费方）

- [x] 13.1 `larkbitable/types.go`：`CreateOp`/`UpdateOp` 各增加 `Persons map[string][]string`（列名 → 已解析的飞书用户 id 列表），镜像既有 `Attachments` 旁路；注释说明 id 由调用方在自身边界解析（如经 empcap 把工号解析为 open_id），共享库只序列化、`UserIDType` 须与 id 语义一致
- [x] 13.2 `larkbitable/encode.go`：`Encoder` 只保留 `UserIDType`（声明旁路 id 的语义），**不做任何身份解析**；`rowToFields` 签名增加 `persons` 参数，`TypeUser` 分支忽略 `Row` 中裸值并记 error 日志（人员字段不接受纯文本），经 `persons` 渲染循环（去空去重 → `[]*Person{Id}` → `out[col]`，空集合跳列）序列化，镜像 attachments 循环
- [x] 13.3 `larkbitable/client.go`：`BatchCreate`/`BatchUpdate` 两处 `rowToFields(...)` 补传 `op.Persons`；`user_id_type()` 下发逻辑不变。顺带删除同文件内无引用的 `truncateJSON`（staticcheck U1000）
- [x] 13.4 `larkbitable/encode_test.go` / `client_test.go`：`TestRowToFieldsUser` 覆盖「经 `persons` 旁路传 open_id + Row 裸值被忽略」；新增 `TestBatchCreate_WritesPersonCell`（多 open_id → `[{id}]` 对象数组、普通文本原样写入）；`fakeHTTP` 记录写入请求的 `user_id_type` 查询参数，断言 `user_id_type=open_id` 下发（探索发现的缺口）
- [x] 13.5 验证：`cd apps/lina-plugins/linapro-lark-sdk && go test ./... -count=1` 全绿；`make lint dir=apps/lina-plugins/linapro-lark-sdk plugins=0` 0 issues

## 14. 读侧人员列旁路（ListRecords/ListRecordsByID）

- [x] 14.1 `larkbitable/client.go`：`ListRecordsByID` 补人员列结构化旁路——把 `ListRecords` 中解析 `TypeUser` 列的 `personCellToPersons` 循环提为两读取接口共享，返回携带人员旁路（`PersonIDs`/`Persons`）的记录结构，使按 uniqueField 与按 record_id 读取回读语义一致
- [x] 14.2 `client_test.go`：验证含 `TypeUser` 列的表回读 open_id 集合；无人员列时旁路为空、文本投影不变
- [x] 14.3 消费方 `linapro-recruit-pipeline` 两处调用点适配 `ListRecordsByID` 新返回类型：`job/report_sync.go`、`job/interview_sync.go`（保留按 record_id 索引与 `BatchUpdate` 用 record_id 的路径不变）
