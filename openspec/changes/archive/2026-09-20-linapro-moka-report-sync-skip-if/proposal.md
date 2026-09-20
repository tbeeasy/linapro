## Why

「Moka 报表 → 飞书多维表格」同步目前会把报表返回的全部行都写入目标表，运营无法表达「早于某个时间的数据不要」这类口径。典型场景是招聘月度报表：源报表会返回指定日期范围之后的所有月份，而运营只需要最近一段时间的数据，历史月份行写进去后还要人工清理。

现在只能在 Moka 报表侧加过滤条件。报表侧做不到、或过滤口径需要独立于报表配置时，这条需求就无解。本变更给映射增加一条声明式的行级过滤规则，让运营在插件配置里就能表达「跳过早于某时间的行」。

## What Changes

- `ReportMapping` 新增 `skipIf` 数组字段，每项是一条行级过滤规则：`{kind, source, format, value}`。
- `kind` 从封闭的命名注册表解析（与现有 `derivedColumns` 的 `kind` 同构），本次只实现 `before`（源列时间早于阈值则跳过该行）。后续新增比较方向只需注册一个纯函数。
- `format` 采用 GoFrame 的 `gtime` 方言（`Y`=年、`m`=月、`d`=日，例如 `"Y-m"`），配置侧无需书写 Go 参考时间布局 `2006-01`。
- `source` 列值与 `value` 阈值都用 `format` 解析为东八区时间戳后比较；**两侧解析失败时该行保留**（不跳过），并记 warn。宁可多同步一行，也不因格式变更静默丢数据。
- 新增纯函数 `syncer.ApplySkipRules(rows, rules) (kept []Row, dropped int)`。
- 管线顺序调整为 `Flatten → 列派生 → 行过滤 → Coalesce → Normalize → preparePersonFields → Plan`。过滤放在列派生之后，使规则可引用派生列；放在 `Coalesce` 之前，尽早丢弃死行。
- 转置形态（`shape: pivot`）本次不接入 `skipIf`；配置了则忽略并记 warn，沿用现有 `derivedColumns` / `personFieldSources` 在 pivot 下的处理先例。
- 缺省行为不变：未配置 `skipIf` 的映射同步结果与当前完全一致。

## Capabilities

### New Capabilities
<!-- 无新增能力 -->

### Modified Capabilities
- `linapro-moka-report-sync`: 新增「行过滤（skipIf）」需求；现有「配置分层」需求扩展 `skipIf` 映射字段；管线固定顺序从「Flatten → 列派生 → Coalesce → Normalize → preparePersonFields → Plan」调整为在列派生与 Coalesce 之间插入行过滤步骤。

## Impact

- 代码：`apps/lina-plugins/linapro-moka-report-sync/backend/internal/config/config.go`（`ReportMapping` 加 `skipIf` 字段与 `SkipRule` 结构）、`.../internal/syncer/`（新增行过滤注册表与 `before` 纯函数）、`.../internal/service/sync.go`（flat 路径在列派生后接入过滤；pivot 路径记 warn 忽略）。
- 配置文档：`apps/lina-plugins/linapro-moka-report-sync/CONFIGURATION.md` 增加 `skipIf` 说明与样例。
- 配置：`plugin.linapro-moka-report-sync.reportMappings`（sys_config JSON）可选新增 `skipIf` 项；未配置时行为不变。
- 不涉及：Moka 拉取、Lark 写入、`Plan` / `BatchCreate` / `BatchUpdate`、人员列解析、pivot 转置逻辑。
