## Context

`linapro-moka-report-sync` 是「Moka 报表 → 飞书多维表格」的通用同步引擎，现有流水线为：`GetReportData` → `FlattenReport`（多级表头拉平为「列标题 → 值」的行）→ 可选 `ApplyDerivedColumns` → `CoalesceRows` → `NormalizeColumns` → `Plan`（按 `uniqueFields` 唯一键做 create/update 差分）→ `BatchCreate`/`BatchUpdate`。整套假设「报表一行 = Bitable 一行」。

Moka 招聘漏斗图报表的形态是「月份为行、指标为列」：日期列 `公共日期` 的行值为 `2026-01`/`2026-02`/…，其余列为 `简历收集数`/`简历通过数`/…/`入职人数` 等指标，单元格为计数。目标 Bitable 表则要求「指标为行、月份为列」：指标标签列 `招聘漏斗图` 的值为指标名，其余列为各月份（外加一个由 Bitable 公式自算的 `年度` 列）。注意源报表的日期列名（`公共日期`）与目标表的指标标签列名（`招聘漏斗图`）不同名，需分别声明。现有扁平 upsert 无法表达这种行列转置。

约束（已与用户确认）：目标表月份列由运营预建、插件只填值；`年度` 等汇总列插件不写入不触碰；除 `pivotHeaderColumn` 外的源列全部转为指标行。

## Goals / Non-Goals

**Goals:**
- 在同一插件、同一定时任务内，支持声明式的「转置（pivot）」同步形态，与现有扁平形态共存。
- 转置产出复用现有 `Plan`/`BatchCreate`/`BatchUpdate`，下游零改动；转置逻辑内聚在 syncer 层一个新步骤。
- 默认形态 `flat` 行为与当前完全一致，向后兼容。

**Non-Goals:**
- 不计算 `年度` 等汇总列（由 Bitable 公式字段负责）。
- 不自动创建目标 Bitable 的月份列（运营预建）。
- 不改变数据源认证与 HCM/Recruit 选择逻辑。
- 不引入多级表头在 pivot 下的特殊处理（漏斗报表为单级表头）。

## Decisions

### 决策 1：以 `shape` 字段在映射级别切换形态，而非新建插件/新任务
`ReportMapping` 增加 `shape`（`flat` 缺省 / `pivot`）。同一 cron 任务遍历映射时按 `shape` 分派。
- 备选：在 `linapro-recruit-pipeline` 新起独立定时任务。否决——该插件是候选人 `applicationId` 生命周期编排器，漏斗是月度聚合报表，无 applicationId、无候选人生命周期，且会重复实现同步/upsert/Lark 基座。
- 备选：新建独立插件。否决——与现有报表同步引擎职责完全重叠，徒增维护面。

### 决策 2：转置作为 `FlattenReport` 之后的独立步骤，复用下游 `Plan`
新增 `syncer.Pivot(cols, rows, headerColumn, indexColumn) -> (cols, rows)`：
- 输入为 Flatten 产出的「月份行」：每行含 `headerColumn`（值=月份）+ 各指标列。
- 输出「指标行」：对每个非 `headerColumn` 的源列生成一行，该行 `indexColumn` 字段=指标名，各月份字段=源表对应 `(月份, 指标)` 单元格值。
- 目标列集合 = `{indexColumn} ∪ {各月份值}`；指标顺序、月份顺序按源表出现顺序稳定。
- 之后设 `spec = KeySpec{Fields:[indexColumn], Sep}`，直接进入现有 `Plan`。
- 理由：`Plan` 的「唯一键 upsert + 交集列完整性门闩 + 忽略表外列」正好满足需求——唯一键=指标名，月份列为交集列参与完整性判断，`年度` 属「表里有、报表未声明」的表外列，天然被忽略、不清空不冻结。

### 决策 2.1：`headerColumn`（源列名）与 `indexColumn`（输出索引列名）解耦
`pivotHeaderColumn` 决定「读源报表哪一列的行值当目标列头」（如日期列 `公共日期`，值 `2026-01`…）；`pivotIndexColumn` 决定「转置后承载指标名的输出列叫什么、去和目标表哪一列对齐」（如 `招聘漏斗图`）。二者常不同名——源报表的日期列名与目标 Bitable 的指标标签列名并无关联。
- 早期把两者揉进单一 `pivotHeaderColumn`，隐含假设「源列名 == 目标索引列名」，在真实数据（源 `公共日期` / 目标 `招聘漏斗图`）下导致指标名列写不进目标表、`招聘漏斗图` 恒空。故拆为两个必填字段。
- `pivotIndexColumn` 不回退到 `pivotHeaderColumn`：二者语义不同，回退会在配置遗漏时静默写错列，显式必填更安全（缺失则记 warn 跳过）。

### 决策 3：`年度` 等汇总列的「不触碰」由现有 `Plan` 语义保证，无需新增逻辑
现有「交集列完整性门闩」明确：完整性判断仅针对「报表列 ∩ Bitable 字段」交集，表外列不参与、不写入。pivot 产出的列集合不含 `年度`，故 `Plan` 既不会写它也不会因它触发重写。实现时通过单测固化此行为。

### 决策 4：月份列缺失时依赖写入侧忽略，不报错
运营预建月份列；若某月份列在 Bitable 不存在，写入侧（现有 `Plan` 按 `TableFields` 过滤 + Lark 写入）忽略该列，不阻断本轮。记录一条 debug/warn 便于排查即可。

## Risks / Trade-offs

- [源表列名与目标月份列名不一致（如 `5月` vs `5月份`）导致写不进] → 约定源表 `headerColumn` 行值即为目标月份列名，文档明确；不一致时该月份列被写入侧忽略并告警，不静默成功。
- [`headerColumn` 配错或源表无该列] → 转置无法进行，本轮该映射记 warn 跳过，不影响其他映射（与现有「单映射失败不阻断」一致）。
- [同一指标在源表出现多行（多月）本就预期，但若 `headerColumn` 值重复（同月两行）] → 后出现的月份值覆盖先出现的，记 warn（复用 Coalesce 式冲突上报思路）。
- [pivot 与 `derivedColumns`/`personFieldSources` 组合语义未定义] → 本变更 pivot 形态下不支持这两项，配置同时出现时忽略并告警，避免语义歧义（Non-Goal）。
