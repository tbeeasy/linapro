## 1. 配置扩展

- [x] 1.1 在 `internal/config/config.go` 的 `ReportMapping` 增加 `SkipIf []SkipRule`（json `skipIf`），并新增 `SkipRule{Kind, Source, Format, Value string}` 结构体，字段注释用中文说明各字段语义
- [x] 1.2 在 `internal/config/config_test.go` 增加用例：`skipIf` 的 JSON 反序列化（含多条规则）、未提供时为空切片、字段名拼写正确（对照 `format` 而非 `formate`）

## 2. 行过滤纯函数

- [x] 2.1 在 `internal/syncer/` 新增 `skip.go`：定义 `Skipper func(row Row, rule SkipRule) (skip bool, ok bool)` 与封闭注册表 `skippers`（本次只注册 `"before"`），并实现 `ApplySkipRules(rows []Row, rules []SkipRule) (kept []Row, dropped int)`
- [x] 2.2 在 `skip.go` 实现 `before` 纯函数：源列值与阈值都按 `rule.Format` 解析，解析失败/源值为空返回 `ok=false`（调用方保留该行）
- [x] 2.3 在 `skip.go` 实现 `parseByFormat(value, format string) (int64, bool)`：经 GoFrame `gtime.StrToTimeFormat` 按方言解析（`Y`=年、`m`=月、`d`=日），再把年月日分量按东八区零点重新锚定为毫秒时间戳，不直接使用 `gtime` 的内部 `time.Local`
- [x] 2.4 `ApplySkipRules` 对每条规则逐行判定：任一规则 `skip=true` 即丢弃该行；全部规则 `ok=false` 时保留该行并向上返回需要告警的信息（规则标识与保留行数），供调用方记日志
- [x] 2.5 `skip.go` 增加中文文件用途注释，说明该文件职责、`kind` 注册表的扩展方式与「失败即保留」的语义约束
- [x] 2.6 新增 `skip_test.go` 覆盖：早于阈值跳过、等于/晚于阈值保留、源值解析失败保留、阈值为空保留、阈值格式非法时全部保留、多条规则取并集、`format` 方言（`Y-m`）生效、派生列作为 `source`、跨时区锚定一致（同一输入在非东八区 `time.Local` 下产出相同判定）
- [x] 2.7 运行 `go test ./internal/syncer -count=1` 确认既有 `derive_test.go` / `plan_test.go` / `pivot_test.go` 全绿且新增用例通过

## 3. service 管线接入

- [x] 3.1 在 `internal/service/sync.go` 的 `syncMappingFlat` 中，于 `ApplyDerivedColumns` 之后、`CoalesceRows` 之前调用 `syncer.ApplySkipRules`，把 `m.SkipIf` 转换为 `syncer.SkipRule`
- [x] 3.2 增加 `toSkipRules` 转换函数（config → syncer 类型桥接，与现有 `toDeriveRules` 同构），并对每条规则记一条 debug 日志标明 `kind`/`source`/`format`/`value`
- [x] 3.3 行过滤产生丢弃行时记 info（丢弃行数），出现「无法判定」时记 warn（规则标识 + 保留行数 + 原因），使规则未生效可从日志定位
- [x] 3.4 `MappingResult` 增加 `Filtered int` 字段，并在同步完成日志中输出「过滤=%d」，与现有 `新增/更新/冻结/跳过` 并列
- [x] 3.5 在 `syncMappingPivot` 中：`m.SkipIf` 非空时忽略并记 warn（说明 pivot 形态不支持行过滤），沿用现有 `derivedColumns` / `personFieldSources` 的处理先例
- [x] 3.6 在 `internal/service/sync_test.go` 增加用例：flat 路径配置 `skipIf` 后早于阈值的行不产生 `Creates`/`Updates`；pivot 路径配置 `skipIf` 时不影响同步结果

## 4. 验证

- [x] 4.1 运行 `go test ./... -count=1`（linapro-moka-report-sync module）确认全部包通过
- [x] 4.2 运行定向 lint：`make lint dir=apps/lina-plugins/linapro-moka-report-sync plugins=1`（或 `linactl lint.go`），确认无新增告警
- [x] 4.3 运行 `openspec validate linapro-moka-report-sync-skip-if --strict` 确认通过
- [x] 4.4 记录 DI 来源检查结论：本变更未新增运行期依赖、服务构造函数、启动装配或宿主服务适配器（无影响判断）。仅新增：config 结构体字段 `SkipIf`、syncer 纯函数包 `skip.go`（依赖已在 module 内的 GoFrame `gtime`）、service 管线内一处调用与桥接函数 `toSkipRules`。无新的构造函数/启动装配/宿主适配器，DI 无影响。

## 5. 文档与配置样例

- [x] 5.1 在 `apps/lina-plugins/linapro-moka-report-sync/CONFIGURATION.md` 增加 `skipIf` 说明：字段表、`before` 语义、`format` 用 `Y-m` 方言的写法、解析失败保留行的行为、pivot 不支持的说明
- [x] 5.2 在配置样例中补充一条含 `skipIf` 的完整映射示例（与 `derivedColumns` 组合，展示规则引用派生列的用法）
- [x] 5.3 确认新增/修改的文档与源码注释均为中文
