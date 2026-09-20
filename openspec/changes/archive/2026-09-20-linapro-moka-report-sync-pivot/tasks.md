## 1. 配置扩展

- [x] 1.1 在 `internal/config/config.go` 的 `ReportMapping` 增加 `Shape string`（json `shape`，枚举 `flat`/`pivot`）、`PivotHeaderColumn string`（json `pivotHeaderColumn`，源列名）与 `PivotIndexColumn string`（json `pivotIndexColumn`，输出索引列名，必填、不回退到 headerColumn）字段
- [x] 1.2 在 `applyMappingDefaults` 中把空 `Shape` 归一为 `flat`；`PivotIndexColumn` 不做缺省回退；补充 `config_test.go` 覆盖缺省归一与 pivot 字段（header/index 解耦）解析

## 2. 转置变换

- [x] 2.1 在 `internal/syncer/` 新增 `pivot.go`：实现 `Pivot(cols []string, rows []Row, headerColumn, indexColumn string)`，将「行值为 headerColumn 取值、列为各指标」转为「行为各指标、列为各 headerColumn 取值」，指标名写入 indexColumn 列（源列名与输出索引列名解耦）
- [x] 2.2 Pivot 保证指标顺序、目标列（各 headerColumn 取值）顺序按源报表出现顺序稳定；`headerColumn` 值重复（同月多行）时后值覆盖前值并返回冲突信息供上层告警
- [x] 2.3 新增 `pivot_test.go`：覆盖基本转置、header/index 解耦、全部非表头列转指标、值重复覆盖、源无 headerColumn 列、indexColumn 为空（均返回 nil）等场景

## 3. service 分派

- [x] 3.1 在 `internal/service/sync.go` 的 `syncMapping` 中按 `m.Shape` 分派：`flat` 走现有路径不变；`pivot` 在 `FlattenReport` 之后调用 `syncer.Pivot(cols, rows, pivotHeaderColumn, pivotIndexColumn)`，再以 `KeySpec{Fields:[pivotIndexColumn], Sep:m.KeySeparator}` 进入现有 `Plan`/`BatchCreate`/`BatchUpdate`
- [x] 3.2 pivot 分支：`PivotHeaderColumn` 或 `PivotIndexColumn` 为空、或源报表无 headerColumn 列时记 warn 并跳过该映射本轮同步，不影响其他映射
- [x] 3.3 pivot 分支：显式忽略 `DerivedColumns` 与 `PersonFieldSources`，若非空记 warn
- [x] 3.4 pivot 分支：`headerColumn` 值重复冲突按现有 Coalesce 冲突上报风格记 warn

## 4. 汇总列与月份列行为验证

- [x] 4.1 在 `service/sync_test.go` 增加用例：pivot 产出列不含 `年度` 时，`Plan` 不写入/不清空/不冻结该表外列（固化「汇总列不触碰」语义）
- [x] 4.2 增加用例：源出现目标表未预建的月份列值时该列被忽略、其余月份列正常写入，并记录可诊断日志

## 5. 幂等与回归

- [x] 5.1 增加用例：同一份 pivot 报表连续两轮同步无变化时第二轮全部指标行落入冻结分支、无写入
- [x] 5.2 运行 `go test ./...`（linapro-moka-report-sync 模块）确认 flat 既有用例全绿、pivot 新增用例通过

## 6. 配置样例与文档

- [x] 6.1 在插件配置样例/说明中补充一条 pivot 映射示例（`shape`/`pivotHeaderColumn`/`pivotIndexColumn`/`uniqueFields`/预建月份列的运营前置，含 header/index 解耦说明），中文注释
