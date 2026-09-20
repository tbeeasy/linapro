## Why

Moka 招聘漏斗图报表的形态是「月份为行、指标为列」，而运营在飞书多维表格里需要的是「指标为行、月份为列」的透视形态（每个指标一行，各月份分列，年度汇总由 Bitable 公式字段自算）。现有 `linapro-moka-report-sync` 只支持「报表一行 = Bitable 一行」的扁平 upsert，无法表达这种行列转置，导致该报表无法直接同步。

## What Changes

- 给 `ReportMapping` 新增 `shape` 字段（枚举 `flat` / `pivot`，缺省 `flat`）、`pivotHeaderColumn` 与 `pivotIndexColumn` 字段，声明一条映射走「转置」形态。
- 新增转置变换步骤：在 `FlattenReport` 之后、`Plan` 之前，把「月份为行、指标为列」的拉平结果转为「指标为行、月份为列」——`pivotHeaderColumn`（**源报表**列，如日期列 `公共日期`，其行值为 `2026-01`/`2026-02`/…）的各取值成为目标列头，其余列（全部指标）成为目标行；转置后承载指标名的输出索引列名由 `pivotIndexColumn`（须与目标表指标标签列同名，如 `招聘漏斗图`）指定。`pivotHeaderColumn`（源列名）与 `pivotIndexColumn`（输出索引列名）解耦，二者常不同名。
- 转置产出的行复用现有下游 `Plan`（`uniqueFields=[pivotIndexColumn]` 指标名幂等 upsert）/ `BatchCreate` / `BatchUpdate`，下游逻辑不改。
- 「年度」等汇总列由飞书多维表格公式字段自算，插件不写入、不触碰：转置产出的列集合不含这些列，`Plan` 对「表里存在但本轮未提供」的列保持原样，不清空、不冻结判定。
- 月份列（`2026-01`/`2026-02`/…）由运营在 Bitable 表中预建，插件只填值；列不存在时由写入侧忽略。
- 默认 `shape: flat` 保持现有扁平 upsert 行为完全不变，向后兼容。数据源沿用现有 `hcm` / `recruit` 选择逻辑。

## Capabilities

### New Capabilities
<!-- 无新增能力 -->

### Modified Capabilities
- `linapro-moka-report-sync`: 新增「转置（pivot）同步形态」需求；现有扁平 upsert 作为缺省形态，行为不变。

## Impact

- 代码：`apps/lina-plugins/linapro-moka-report-sync/backend/internal/config/config.go`（`ReportMapping` 加 `shape`/`pivotHeaderColumn`/`pivotIndexColumn` 字段与缺省归一）、`.../internal/syncer/`（新增转置变换，如 `pivot.go`，`Pivot` 解耦 headerColumn/indexColumn）、`.../internal/service/sync.go`（按 `shape` 分派：`flat` 走现有路径，`pivot` 在 Flatten 后插入转置再交给现有 Plan）。
- 配置：`plugin.linapro-moka-report-sync.reportMappings`（sys_config JSON）新增 pivot 类映射项；运营需预建目标 Bitable 表的月份列。
- 下游 `Plan` / `BatchCreate` / `BatchUpdate` / Lark 客户端 / 编码器：不改动。
- 数据源认证（HCM / Recruit）：不改动。
