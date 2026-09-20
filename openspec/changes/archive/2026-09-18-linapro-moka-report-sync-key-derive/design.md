## Context

`linapro-moka-report-sync` 的同步管线本质上是「一串 Plan 之前的纯变换」：

```
Fetch → FlattenReport → CoalesceRows → ListFields → normalizeColumns
      → ListRecords → preparePersonFields → Plan → BatchCreate/Update
```

其中 `syncer` 包（`FlattenReport`/`CoalesceRows`/`NormalizeColumns`/`Plan`）为纯函数、可单测；`Plan` 只认单列 `UniqueField` + `cols` + `rows` + `tableFields`，按「报表列 ∩ Bitable 字段」做字段级 diff。

新需求有两类：唯一键是多列组合、以及某列需变换后拆成多列（如年月）。当前架构无法表达，且不希望通过「在 Bitable 加冗余合并列」或「每个需求塞一个专用函数」的方式打补丁。

约束：
- `Plan` 保持「笨且纯」，不承载键/变换语义。
- 复合键必须在代码层解决，**不依赖 Bitable 物理合并列**。
- 存在既有的「回读对称」陷阱（`NormalizeColumns` 即为此而生）：报表侧写入值必须等于下一轮从 Bitable 回读并 stringify 后的值，否则 `diffFields` 永远判不等而每轮重写。

## Goals / Non-Goals

**Goals:**
- 用 `KeySpec{Fields, Sep}` + `KeyOf(row)` 抽象贯穿 `CoalesceRows`、`Plan`、共享库 `ListRecords`，天然支持 N 列复合键，键仅用于匹配、不写入物理列。
- 引入封闭的、命名 `kind` 的「列派生」注册表（`date`/`split`/`regex`），每个 `kind` 为纯函数；`date` 复用现有日期解析。
- 固定变换顺序，保证键计算发生在派生之后、去重之前。
- 删除单列 `uniqueField`，配置统一为 `uniqueFields`。

**Non-Goals:**
- 不做通用表达式 DSL / 用户自定义脚本；派生是封闭注册表，新增一种即加一个纯函数。
- 不对旧 `uniqueField` 配置做代码级兼容（现网配置 JSON 手工迁移，不在本变更代码范围）。
- 不改动 `Plan` 的完整性门闩语义（新增/重写/冻结规则不变）。

## Decisions

### 决策 1：键抽象用 `KeySpec.KeyOf(row) string`，而非物理合并列

- **做法**：`syncer` 定义
  ```go
  type KeySpec struct { Fields []string; Sep string }
  func (s KeySpec) KeyOf(row Row) string  // 按 Fields 顺序取值、各自 TrimSpace 后用 Sep 拼接；任一列空 → 返回 ""（该行无键，跳过）
  ```
  替换所有 `row[UniqueField]`。`PlanInput.UniqueField string` → `Key KeySpec`；`diffFields` 的「跳过 uniqueField」改为「跳过键组成列集合 `Key.Fields`」。
- **共享库**：`ListRecords` 已把整条记录解码进 `row` 后才建键（client.go:145），故参数由 `uniqueField string` 改为 `keyOf func(Row) string`，改动仅一行 `key := keyOf(row)`。插件侧传 `spec.KeyOf`，报表侧与 Bitable 侧用同一函数算键，天然对齐。
- **为何不用物理合并列**：加列会污染 Bitable 结构、每种键形态都要加一列；且合并列本身还要维护回读对称。键作为「纯匹配概念、不落地为列」更干净，且 N 列扩展零代码改动。
- **关键性质**：复合键不是写入列——真正写入的仍是交集里的普通列（如工号、考勤月各自成列）；创建/更新记录的字段来自交集，键只回答「这条 (A,B) 是否已存在」。

### 决策 2：列派生做成封闭注册表，`date` 用时间函数而非字符串切

- **做法**：
  ```go
  type Deriver func(sources []string, params map[string]any) map[string]string
  var derivers = map[string]string{ "date": ..., "split": ..., "regex": ... } // kind → 纯函数
  ```
  配置：`{"kind","sources","targets","params...}`。`date` 复用 `ParseEpochMillisCST` 把 `2026-09` / `2026/09` / `2026年09月` 统一解析为 `time`，再按各 target 的 layout（如 `年→2006`、`月→01`）格式化；`split` 按 `by` 分隔符；`regex` 按捕获组映射 targets。
- **为何封闭注册表而非 DSL**：两类以上需求已出现，专用配置字段会不断累积；但放开成表达式引擎则不可控、难测、有安全面。封闭注册表在「可扩展」与「可控可测」间取平衡——每种特殊处理是一个小纯函数 + 一行注册。
- **为何 `date` 用时间函数**：年月来源分隔符各异（`-`/`/`/`年月`），字符串切既脆又要逐一适配；解析成 `time` 再格式化对输入形态鲁棒，并复用插件已有解析器。
- **边界**：源值解析/匹配失败 → 目标列留空跳过，不写脏值。

### 决策 3：固定变换顺序

`Flatten → 列派生 → Coalesce(按 KeyOf 去重) → Normalize → preparePersonFields → Plan`。派生必须在算键与去重之前（键可能由派生列组成）；Normalize 在 Plan 前保证回读对称。

### 决策 4：配置结构

`ReportMapping` 删除 `uniqueField`，新增 `uniqueFields []string`、`keySeparator string`、`derivedColumns []DerivedColumn`。`loadMappings` 归一：`uniqueFields` 为空 → `["工号"]`；`keySeparator` 为空 → 默认分隔符。

## Risks / Trade-offs

- **回读对称破坏导致反复重写/重复建记** → 派生产出列与键组成列必须按 Bitable 字段类型走 `NormalizeColumns`；键组成列优先选文本类稳定列（工号/编码），日期类作键组件时须先归一、两侧用归一后形态。
- **删除 `uniqueField` 是 BREAKING，现网旧配置反序列化后 `uniqueFields` 为空** → 上线前手工把 sys_config 的 `reportMappings` JSON 改为 `uniquefields`（配置迁移，非代码兼容；按用户要求不列入代码任务）。
- **共享库 `ListRecords` 签名变更** → 经确认当前仅 report-sync 一个调用方（demo-source 的 `ListRecords` 为无关的另一服务方法），影响自包含；共享库单测需同步更新。
- **派生列名与报表列名冲突** → 约定派生 targets 为「新增列」，若与既有报表列同名以派生结果为准，并在文档明确顺序覆盖语义。

## Migration Plan

1. 共享库 `larkbitable.ListRecords` 改签名 + 单测。
2. `syncer` 加 `KeySpec`/`KeyOf`、派生注册表；改 `CoalesceRows`/`Plan`/`diffFields`。
3. 插件 `config` 改 `ReportMapping` + `loadMappings`；`sync.go` 接派生步骤、构造 `KeySpec` 传三处。
4. 上线前手工迁移 sys_config `reportMappings`（`uniqueField` → `uniqueFields`），并为需要的映射补 `derivedColumns`。
- 回滚：本变更无数据库 schema 变更，纯代码 + 配置；回滚即还原代码并把配置 JSON 改回旧结构。

## Open Questions

- 暂无（`date`/`split`/`regex` 三种 kind 满足当前已知需求；后续新 kind 按注册表增量添加，无需再走设计）。
