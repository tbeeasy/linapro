# Tasks: linapro-moka-report-sync 复合键与列派生

## 1. 共享库 larkbitable：ListRecords 键函数化

- [x] 1.1 将 `larkbitable.ListRecords` 参数由 `uniqueField string` 改为 `keyOf func(Row) string`，把建键处改为 `key := keyOf(row)`（保留空键跳过语义）
- [x] 1.2 更新 `larkbitable` 相关单测：用 `keyOf` 闭包覆盖单列与多列键场景

## 2. syncer：KeySpec 与键抽象

- [x] 2.1 新增 `KeySpec{Fields []string; Sep string}` 与 `KeyOf(row Row) string`（按序取值、逐列 TrimSpace、Sep 拼接；任一列空返回 ""）
- [x] 2.2 `CoalesceRows` 分组键由 `row[uniqueField]` 改为 `spec.KeyOf(row)`（签名接收 `KeySpec`）
- [x] 2.3 `PlanInput.UniqueField string` 改为 `Key KeySpec`；`Plan` 中 `name := in.Key.KeyOf(row)`
- [x] 2.4 `diffFields` 由「跳过 uniqueField」改为「跳过键组成列集合 `Key.Fields`」
- [x] 2.5 补充 `KeyOf`、`CoalesceRows`、`Plan` 复合键单测（单列/多列/空键/键组成列跳过 diff）

## 3. syncer：列派生注册表

- [x] 3.1 定义 `Deriver func(sources []string, params map[string]any) map[string]string` 与命名注册表 `derivers`（date/split/regex）
- [x] 3.2 实现 `date`：复用 `ParseEpochMillisCST` 解析日期，按各 target layout 格式化年/月等；失败留空
- [x] 3.3 实现 `split`（按 `by` 分隔符）与 `regex`（按捕获组映射 targets）；失败/不匹配留空
- [x] 3.4 实现 `ApplyDerivedColumns(rows, cols, rules)`：作用于行、把目标列追加进 `cols`，返回更新后的列集合
- [x] 3.5 补充三种 kind 与 `ApplyDerivedColumns` 的纯函数单测（含各分隔符、`年月`、解析失败留空）

## 4. config：ReportMapping 配置结构

- [x] 4.1 `ReportMapping` 删除 `uniqueField`，新增 `uniqueFields []string`、`keySeparator string`、`derivedColumns []DerivedColumn`
- [x] 4.2 定义 `DerivedColumn` 结构（`kind`/`sources`/`targets`/参数）以匹配 JSON 配置
- [x] 4.3 `loadMappings` 归一：`uniqueFields` 空 → `["工号"]`；`keySeparator` 空 → `defaultKeySeparator`；新增 `defaultKeySeparator` 常量
- [x] 4.4 补充 `loadMappings` 归一单测（缺省、单列、多列、含 derivedColumns）

## 5. service/sync.go：管线编排

- [x] 5.1 在 `syncMapping` 中按固定顺序接入派生：`Flatten → ApplyDerivedColumns → CoalesceRows → normalizeColumns → preparePersonFields → Plan`
- [x] 5.2 构造 `spec := syncer.KeySpec{Fields: m.UniqueFields, Sep: m.KeySeparator}`，传入 `CoalesceRows`、`ListRecords(spec.KeyOf, ...)`、`Plan{Key: spec}`
- [x] 5.3 确保派生目标列与键组成列走 `normalizeColumns`（回读对称）
- [x] 5.4 更新 `sync_test.go` 覆盖复合键 + 派生的端到端规划场景

## 6. 验证

- [x] 6.1 `go build` / `go vet` 全绿；`go test ./...`（syncer、config、service、larkbitable）通过
- [x] 6.2 `openspec validate linapro-moka-report-sync-key-derive --strict` 通过

## Feedback

- [x] **FB-1**: 人员列每轮空转重写——diff 比较 Moka 侧工号与 Bitable 回读姓名，二者永不相等；改为按 open_id 集合比对（回读对称）
- [x] **FB-1（修订·身份解析归位）**: 人员列解析从「工号放进 Fields 交共享库解析」上收为「Plan 内解析一次并产出到 `op.Persons` 旁路」。要点：新增 `syncer/plan.go` 的人员列解析路径（`resolvePersonCols` 一行内解析一次人员列，供判等与写入共用）；`CreateOp`/`UpdateOp` 增加 `Persons map[string][]string`，人员列 SHALL NOT 进入 `Fields`（`project` 排除人员列，`diffFields` 产出 `(Fields, Persons)` 两路）；`service/sync.go` 的 encoder 只保留 `UserIDType=open_id`（不做任何身份解析），`toLarkCreates`/`toLarkUpdates` 映射 `Persons`；resolver 改用 empcap 复数版 `LarkOpenIDResolverByEmployeeNos`，本插件仅做逗号拆分（`syncer.SplitEmployeeNos`）。验证：`go test ./... -count=1` 全绿、`make lint dir=apps/lina-plugins/linapro-moka-report-sync plugins=0` 0 issues。DI 来源检查：未新增运行期依赖，resolver 仍为周期开始构造一次的闭包（owner=linapro-employee-core，经 empcap 门面绑定服务懒解析）。

- [x] **FB-2（lina-review 跟进）**: 处置身份解析归位 review 的两条警告。(1)【解析两次】`service/sync.go` 的 `preparePersonFields` 原在判空时预调一次 `resolver`（`len(resolver(...)) == 0`）再由 `Plan` 内 `resolvePersonCols` 二次解析；已去掉预解析——`preparePersonFields` 只把人员列搬运为工号来源列的值，能否解析到 open_id 全部交由 `Plan` 判断（`project` 已把人员列排除出 `Fields`、`resolvePersonCols` 跳过空集合，与预清空等价），全链路对同一工号只解析一次。随之删除 `service` 侧 `preparePersonFields` 的 `resolver` 参数与本地 `splitEmployeeNos` 包装；`syncer.SplitEmployeeNos` 因不再有跨包调用方，收敛为包内 `splitEmployeeNos`（最小导出面）。(2)【桥接无断言】`sync_test.go` 新增 `TestToLarkPersonsPassthrough`，断言 `toLarkCreates`/`toLarkUpdates` 把人员列 open_id 集合经 `Persons` 旁路原样透传、丢弃内部键 `Name`、保留 `RecordID`。验证：`go build ./...`/`go test ./... -count=1` 全绿、`make lint dir=apps/lina-plugins/linapro-moka-report-sync plugins=0` 0 issues。DI 来源检查：纯内部重构 + 测试补充，无运行期依赖变更。

- [x] **FB-3（lina-review 跟进·split 顺序保护）**: review 发现 `split` 派生的已知缺陷——`toDeriveRules` 用 `for k := range c.Targets` 遍历 Go map 生成目标列顺序（map 键序不稳定），而 `deriveSplit` 按位置把切分段填入目标列，导致多目标 split（如「一级/二级」）的值会随机对调、写错列。经确认 pivot 转置需求不经派生（`syncMappingPivot` 已忽略 `derivedColumns`），且当前列派生仅 `date`（年月拆列）有真实配置，`split`/`regex` 无现网使用。按「先标记已知限制 + 加保护」方案处置：`toDeriveRules` 对 `split` 且目标列 ≥ 2 时跳过该规则并记 warn（避免写错列），单目标 split 顺序平凡稳定正常放行；`date`/`regex` 按列名显式映射与顺序无关不受影响。签名改为 `toDeriveRules(ctx, label, cols)` 以承载告警上下文。测试：`sync_test.go` 新增 `TestToDeriveRules_SkipsMultiTargetSplit`（多目标 split 被跳过、同批 date 保留）与 `TestToDeriveRules_KeepsSingleTargetSplit`（单目标放行且 order 正确）。后续若确有多目标 split 需求，应为 `config.DerivedColumn` 增加显式 `order []string` 字段后再启用。验证：`go test ./backend/internal/... -count=1` 全绿、`make lint dir=apps/lina-plugins/linapro-moka-report-sync plugins=0` 0 issues。DI 来源检查：纯内部逻辑 + 测试补充，无运行期依赖变更。
