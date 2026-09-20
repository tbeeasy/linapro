## Context

`linapro-recruit-pipeline`（`backend/lark/bitable.go`）与 `linapro-moka-report-sync`
（`backend/internal/lark/bitable.go`）各自维护了一份飞书 Bitable 封装。两份的 REST 调用骨架
（分页、批量切块 ≤1000、250ms 节流、envelope 判错）逐字重复；`rowToFields`（按字段类型编码）、
`cellToString`（单元格回读）也高度重叠。

差异集中在**值转换语义**：
- 日期：recruit 按 UTC 解析 ISO（`ParseEpochMillisUTC`）；report-sync 按东八区墙上时间 + Moka
  布局（`2006-01-02` 等，`ParseInLocation` + `cstZone`），两者都兼容秒/毫秒 epoch。
- 数字：recruit 用 `Sscanf %g`；report-sync 容忍 `%`（除 100）与千分位 `,`。
- 单元格兜底：recruit 用 `fmt.Sprintf`；report-sync 用 `syncer.Stringify`（`-` 归一为空）。
- 附件：recruit 有 `UploadMedia` + attachment 列；report-sync 无。
- 类型：recruit 用本地 `Row/CreateOp/UpdateOp/ExistingRecord`；report-sync 用 `syncer.*`
  （其 `CreateOp/UpdateOp` 带 planner 内部用的 `Name` 字段）。

`DatetimeFieldConvFail`（日期字段要毫秒时间戳）的修复只落在 recruit 一侧——divergence 已发生。

约束：`lina-core` 当前不依赖飞书 SDK；插件间已有 `replace => ../sibling` 的跨模块引用先例
（recruit → moka-recruit）；go.work 已含非插件模块（`hack/tools/linactl`）。

## Goals / Non-Goals

**Goals:**
- 消除两份 REST 调用骨架 + 值编解码的重复，使 `DatetimeFieldConvFail` 这类修复只需改一处。
- 共享库 API 刻意做小：REST `Client` + 中立 Row/Op 类型 + 一个含 3 个函数字段的 `Encoder`。
- 易变语义（时区/数字/单元格兜底）留在调用侧显式组合，通过并列具名解析原语选用。
- 纯重构：两插件对外行为零变化。

**Non-Goals:**
- 不统一两边的日期/数字解析规则（它们本就该不同）。
- 不把飞书 SDK 依赖引入 `lina-core`。
- 本次不实现 Bitable 以外的飞书能力（消息、审批等），仅预留模块结构。
- 不改动 report-sync 的 planner（`syncer.Plan`）逻辑，仅在落库边界做 op 类型桥接。

## Decisions

### 决策 1：新建独立 module `linapro-lark-sdk`，放 `apps/lina-plugins/linapro-lark-sdk/`
- **为什么**：`lina-core/pkg` 虽引用最省事，但会给框架内核背上 larksuite SDK 依赖，违反 core
  边界。独立库模块 + `replace` 引用符合既有先例，且依赖边界干净。
- **备选**：放 `lina-core/pkg/larkbitable` —— 否决，污染 core 依赖。
- **库不含 `plugin.yaml`**：已核实 `command_build.go` 按 glob `*/plugin.yaml` 发现插件、
  `plugingovernance_scan.go` 的 `discoverPluginRoots` 按 `plugin.yaml` 存在过滤，库模块会被
  安全跳过，不被误当插件构建/扫描主体。
- **module 名去掉 `lina-plugin-` 前缀**（实现时确定）：治理规则 `ownerPluginIDFromImport`
  除按 `plugin.yaml` 发现主体外，还有一条按 **module 名 `lina-plugin-` 前缀**识别插件 owner
  的兜底路径。若共享库沿用该前缀，`scanGoCrossPluginImports` 会把它当插件 owner，给每个消费方
  的 `larkbitable` import 报 `PluginPackageBoundary` finding（实测 7 个）。去掉前缀后该兜底
  不匹配，治理检查零新增 finding，无需改动 host 治理工具。

### 决策 2：包结构 `larkbitable`，值转换参数化为 `Encoder`
- 包 `larkbitable` 下：`client.go`（Client/Table/NewClient/REST 方法）、`types.go`
  （Row/CreateOp/UpdateOp/ExistingRecord）、`encode.go`（Encoder + rowToFields + cellToString +
  具名解析原语）。
- `Encoder struct { ParseDateMillis func(string)(int64,bool); ParseNumber func(string)(float64,bool); CellFallback func(any) string }`。
- **为什么用函数字段而非接口**：三个纯函数，函数字段最轻，调用侧组合直观，无需定义实现类型。
- `NewClient` 默认 Encoder = UTC + Plain + 通用兜底；`WithEncoder(Encoder)` 供 report-sync 注入。
- **为什么导出并列原语而非配置开关**：避免共享库变成"万能配置怪物"；`ParseEpochMillisUTC`/
  `ParseEpochMillisCST`/`ParseNumberPlain`/`ParseNumberLoose` 谁用谁挑，语义显式留在调用侧。
- 字段类型判断用 `larkbitable.TypeNumber`/`larkbitable.TypeDateTime` SDK 常量；日期空值/解析
  失败**跳列**，避免 `DatetimeFieldConvFail`。

### 决策 3：中立 op 类型 + report-sync 侧桥接
- 共享库 op 只含 `Fields` + `Attachments`（create）/ `RecordID` + `Fields` + `Attachments`（update）。
- recruit 直接用共享库类型（或加 `type Row = larkbitable.Row` 别名减少改动）。
- report-sync 的 `syncer.CreateOp/UpdateOp` 带 `Name`（planner 内部键），在 `service/sync.go`
  落库前转成共享库 op（丢 `Name` 取 `Fields`）；`ListRecords` 返回共享库 `ExistingRecord`，
  在 sync.go 转回 `syncer.ExistingRecord`（字段同构，浅拷贝）。
- **为什么不把 `Name` 塞进共享库 op**：`Name` 是 report-sync planner 的内部概念，共享库不应知晓。

### 决策 4：`logFieldMismatch` 内置进共享库
- recruit 原有的字段名校验（写入前比对表 schema，命中 `FieldNameNotFound` 时给可诊断日志）对所有
  飞书插件都有用，内置到 `BatchCreate`/`BatchUpdate` 的 debug 日志中，report-sync 一并受益。

### 决策 5：通讯录枚举独立子包 `larkcontact`，返回中立 `User` 类型
- **为什么单独成包**：通讯录（contact）与多维表格（bitable）是两类互不依赖的飞书能力，各自 import
  不同 SDK service 包。拆成平级子包 `larkbitable` / `larkcontact`，消费方按需引入，不会因用通讯录
  而被动拖入 bitable 依赖。符合 proposal 预留的"模块结构容纳后续飞书能力"。
- **为什么下沉这段逻辑**：飞书 `contact.user.list` 只返回"指定部门的直属成员"且不递归子部门，不指定
  部门则默认查根部门（"0"）直属成员——绝大多数企业员工挂在子部门下，故直接 list 返回空。正确做法
  是递归枚举部门（`Department.Children` + `fetch_child=true`）再逐部门 `FindByDepartment`、按 open_id
  去重。这套"非显而易见"的遍历知识若留在插件里，下一个用通讯录的插件必然重复踩坑；下沉共享库一次写对。
- **`member_count>0` 过滤**：`Children` 返回的部门带 `member_count`，跳过为 0 的部门可省去大量对空
  部门的 `FindByDepartment` 调用。根部门 "0" 不在 Children 结果里、拿不到 count，故始终保留查一次。
- **返回中立 `User{OpenID,UserID,Name}` 而非 SDK 类型或调用方类型**：与 `larkbitable` 用中立
  `Row/Op` 同理——共享库不知晓调用方业务类型（如 employee-core 的 `sync.LarkUser`），由调用方在
  自己的适配器里做一次浅映射。employee-core 的 `larkAppFetcherAdapter` 因此退化为纯类型转换薄壳。
- **排障日志内置**：部门 ID 全集、每部门去重后新增人数、`FindByDepartment` 原始条数与因 open_id/name
  为空而跳过的条数（后者精确指向"应用缺字段级读取权限"这一高频配置问题），都内置为 debug 日志，
  所有消费方共享这套可观测性。

### 决策 6：人员字段解析——消费方解析 + SDK 只序列化
- **问题**：飞书人员字段（`TypeUser`=11）写入要求对象数组且每个元素至少含 `id`（open_id）；而数据源
  （Moka 报表工号、`interviewInfo[].interviewer.employeeId`）只有工号。
- **分层**：
  - `linapro-lark-sdk` 只做协议编解码：`CreateOp.Persons`/`UpdateOp.Persons`（列名 → 已解析 id 列表）
    接收 open_id 集合，`rowToFields` 渲染为 `[]*larkbitablesdk.Person{{Id}}`，空集合跳列；`Row` 中的
    `TypeUser` 列一律忽略并记 error（人员字段不接受纯文本）。SDK **不做任何身份解析**、不认识 DB、
    不 import `empcap`。
  - 身份解析集中在数据 owner `employee-core` 的公开契约：`MapLarkOpenIDsByEmployeeNo`（按工号 JOIN
    `employee`+`lark_identity`、按 `lark_app_id` 过滤、own+assoc 全返回）+ 门面 `LarkOpenIDResolverByEmployeeNos`
    （多工号 → 按出现顺序去重的 open_id 集合，复用一次批量查询、无 N+1）。
  - 消费方（report-sync / recruit-pipeline）在插件边界解析一次：取工号 → 调 empcap → 把 open_id 集合
    放进 `Persons` 旁路。唯一留在插件的转换是**输入格式归一**（如 recruit 的逗号拼接多工号拆分）。
- **判据**：SDK 的形参语义与承载数据严格一致（`Persons` 收 id）；写入的 open_id 在插件边界完全可见
  可控（可 log、可校验）；全链路解析只一次（比对与写入共用同一组已解析 id）。
- **为什么不做 SDK 内建批量缓存**：给 `Client` 加跨 `rowToFields` 调用的可变状态（mutex + 缓存 + batch
  边界）会破坏「Encoder 是无状态纯函数字段」的简洁模型；批量加载留在消费侧经 empcap helper 复用即可。
- **为什么不做宿主级 capability**：把解析做成 `capability.Services` 的一员需改动 `lina-core` 稳定聚合
  接口 + 动态插件桥接 + 适配器，成本远超收益。
- **open_id 的选择**：`lark_identity` 主键路径即 open_id；写侧显式下发 `user_id_type=open_id`，与旁路
  传入的 id 语义一致。open_id 按应用作用域签发，故 empcap 解析一律按写表格的 `lark_app_id` 过滤。

### 决策 7：`ListRecordsByID` 与 `ListRecords` 共享人员列读回旁路
- 把 `ListRecords` 里解析 `TypeUser` 列的 `personCellToPersons` 循环提为两读取接口共享，`ListRecordsByID`
  返回携带 open_id 集合旁路的记录结构。这样共享库两个读取接口回读语义一致，消费方（recruit-pipeline 的
  字段级差异比对）拿按 record_id 读回的记录也能对人员列做 open_id 集合比对，而非姓名文本。
- **代价**：`ListRecordsByID` 返回类型变化（BREAKING，仅共享库内部消费方），影响 recruit-pipeline 的
  `report_sync.go`/`interview_sync.go` 两处调用点，均在依赖本库的变更内一并调整。
- **备选**：recruit 改用 `ListRecords`+`KeySpec`——否决（要把按 record_id 的索引与 `BatchUpdate` 全改一遍，改动更大）。

## Risks / Trade-offs

- [只有 2 个消费者，抽象可能过早] → API 刻意做小（Client + 类型 + 3 函数 Encoder），不统一 parser；
  即使第 3 个用例语义不同，也只需再加一个具名原语，不改共享库骨架。
- [report-sync op 桥接引入 glue 代码，抵消部分去重收益] → glue 仅在 sync.go 落库边界一处，且是
  浅拷贝，量小可控；换来 REST 骨架 + 编码逻辑的单点维护。
- [行为回归风险（时区/数字/占位符细节）] → 迁移各插件原有解析逻辑成具名原语时保持字节级等价；
  补齐 UTC/CST、Plain/Loose、空日期跳列、`-` 归零的单测锁定行为；两插件各自跑全量测试回归。
- [replace 路径在插件独立分发时可能断裂] → 与现有 recruit → moka-recruit 的 replace 完全同构，
  沿用仓库既定分发假设，不引入新问题。

## Migration Plan

1. 新建 `linapro-lark-sdk` 模块（go.mod + 包 `larkbitable`），迁入 REST 骨架 + 编码逻辑 + 具名
   原语 + 单测；加入 go.work。
2. 独立验证共享库：`go build/vet/test`。
3. 改造 recruit-pipeline：加 require+replace，删本地 `lark` 包，调用点改引用共享库（默认 Encoder），
   跑全量测试。
4. 改造 report-sync：加 require+replace，删本地 `lark` 包，sync.go 注入 CST/Loose/Stringify
   Encoder + op 桥接，跑全量测试。
5. 工作区整体 `go build ./...` 验证跨模块 replace 与无循环依赖；`make plugins.check` 确认库模块
   未被治理误伤。
- **回滚**：改造以插件为单位提交，任一插件回归即可单独回退其 go.mod 改动并恢复本地 `lark` 包，
  共享库保留不影响其它模块。

## Open Questions

- ~~共享库 module 名定为 `lina-plugin-linapro-lark-sdk`（与其它插件模块命名前缀一致，便于工作区
  识别）——如需与"非插件库"区分可另议前缀，但当前倾向复用前缀降低认知成本。~~
  **已解决（实现时）**：复用前缀会触发治理规则的 `lina-plugin-` 兜底把库当插件 owner（见决策 1），
  故采用本 Open Question 预留的"另议前缀"方案，module 名定为 `linapro-lark-sdk`（无 `lina-plugin-`
  前缀）。目录仍在 `apps/lina-plugins/linapro-lark-sdk/`，`replace` 路径不变。
