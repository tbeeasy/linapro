## ADDED Requirements

### Requirement: 转置（pivot）同步形态
系统 SHALL 支持在单条报表映射上声明 `shape: "pivot"` 形态；未声明或声明 `"flat"` 时行为与既有扁平 upsert 完全一致（缺省 `flat`，向后兼容）。pivot 形态下系统 SHALL 通过映射的 `pivotHeaderColumn` 指定「其行值转为目标列头」的**源列**，通过 `pivotIndexColumn` 指定「转置后承载指标名」的**输出索引列名**（须与目标表指标标签列同名）；二者解耦、常不同名。系统 SHALL 把「行值为 `pivotHeaderColumn` 取值、列为各指标」的报表转置为「行为各指标、列为各行值」的目标形态，指标名写入 `pivotIndexColumn` 列，并复用既有唯一键 upsert 写入 Bitable。

#### Scenario: 声明 pivot 形态并转置
- **WHEN** 某映射 `shape: "pivot"`、`pivotHeaderColumn: "公共日期"`、`pivotIndexColumn: "招聘漏斗图"`，源报表拉平后为两行 `{公共日期:2026-01, 简历收集数:50, 入职人数:8}`、`{公共日期:2026-02, 简历收集数:60, 入职人数:3}`
- **THEN** 系统转置为按指标分行 `{招聘漏斗图:简历收集数, 2026-01:50, 2026-02:60}`、`{招聘漏斗图:入职人数, 2026-01:8, 2026-02:3}`，并以 `招聘漏斗图`（指标名）为唯一键写入目标表

#### Scenario: 源列名与输出索引列名解耦
- **WHEN** pivot 映射的 `pivotHeaderColumn`（如 `公共日期`）与 `pivotIndexColumn`（如 `招聘漏斗图`）不同名
- **THEN** 转置输出的首列名为 `pivotIndexColumn`，源列 `pivotHeaderColumn` 不出现在输出行；指标名写入 `pivotIndexColumn` 字段以与目标表标签列对齐

#### Scenario: 缺省形态保持扁平
- **WHEN** 某映射未声明 `shape`（或声明 `"flat"`）
- **THEN** 系统走既有「报表一行 = Bitable 一行」的扁平 upsert 路径，行为不变

#### Scenario: 全部非表头列转为指标
- **WHEN** pivot 映射的源报表除 `pivotHeaderColumn` 外含 8 个指标列
- **THEN** 系统为这 8 个指标各生成一行，指标顺序、目标列（各行值）顺序按源报表出现顺序稳定

### Requirement: 转置的唯一键 upsert
pivot 形态下系统 SHALL 以 `pivotIndexColumn`（承载指标名、与目标表标签列同名）为唯一键，把转置产出的指标行与目标 Bitable 记录对齐，复用既有「交集列完整性门闩」进行新增/重写/冻结判定与批量写入。

#### Scenario: 指标行新增
- **WHEN** 某指标名在目标表中不存在
- **THEN** 系统新增整行（写唯一键指标名列 + 各月份交集列）

#### Scenario: 指标行幂等冻结
- **WHEN** 同一份 pivot 报表连续两轮同步且期间无变化
- **THEN** 第二轮所有指标行落入冻结分支，无写入

### Requirement: 汇总列不写入不触碰
pivot 形态下系统 SHALL 只写入「唯一键指标名列 + 转置产出的各行值列（月份列）」；对目标表中存在但本轮报表未声明的列（如由 Bitable 公式自算的 `年度` 汇总列）SHALL 保持原样，不写入、不清空、不纳入完整性判断（复用既有「忽略表外列」语义）。

#### Scenario: 公式汇总列被忽略
- **WHEN** 目标表含 `年度` 公式列，pivot 报表未产出 `年度` 列
- **THEN** `年度` 列不参与完整性判断、不被写入或清空，其公式值由 Bitable 自行维护

### Requirement: 目标月份列由运营预建
pivot 形态下系统 SHALL 只填充目标表已存在的月份列的值，不创建列。目标表缺少某个月份列时，该列的值 SHALL 被写入侧忽略且不阻断本轮同步，并记录可诊断日志。

#### Scenario: 月份列缺失被忽略
- **WHEN** 源报表出现 `2026-07` 行值，但目标表未预建 `2026-07` 列
- **THEN** `2026-07` 的值被忽略、本轮其余月份列正常写入，系统记录一条 warn 便于运营补建列

### Requirement: pivot 形态的配置与降级
pivot 映射 SHALL 同时声明 `pivotHeaderColumn`（源列名）与 `pivotIndexColumn`（输出索引列名）；`pivotIndexColumn` SHALL NOT 回退到 `pivotHeaderColumn`。任一未声明、或源报表中不存在 `pivotHeaderColumn` 列时，系统 SHALL 记录 warn 并跳过该映射本轮同步，不影响其他映射。pivot 形态下 SHALL 不支持 `derivedColumns` 与 `personFieldSources`；若同时出现，系统 SHALL 忽略这两项并记录 warn。

#### Scenario: 缺少 pivotHeaderColumn 或 pivotIndexColumn 跳过
- **WHEN** 某映射 `shape: "pivot"` 但未声明 `pivotHeaderColumn` 或 `pivotIndexColumn`（或源报表无 `pivotHeaderColumn` 列）
- **THEN** 系统记录 warn 并跳过该映射本轮同步，其他映射照常执行

#### Scenario: pivot 下忽略不支持的选项
- **WHEN** pivot 映射同时声明了 `derivedColumns` 或 `personFieldSources`
- **THEN** 系统忽略这两项、记录 warn，转置与写入照常进行
