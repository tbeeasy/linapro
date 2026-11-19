## Why

「Moka 报表 → 飞书多维表格」同步写人员字段时，只认工号来源：`personFieldSources`把 Bitable 人员字段映射到 Moka 报表的**工号列**，再经 employee-core 解析为 open_id。但部分 Moka 报表（如面谈记录里的「面谈人 1」）只给姓名、不给工号。此时把姓名列配进`personFieldSources`会被当作工号解析，必然解析不到，人员列被静默留空，配置看起来生效、实际从未写入。

## What Changes

- `ReportMapping`新增`personFieldNameSources`（`Bitable 人员字段名 → Moka 报表姓名列名`），与工号来源并列。
- **BREAKING** 工号来源键`personFieldSources`改名为`personFieldEmpNoSources`，与`personFieldNameSources`成对，从键名就能看出来源类型。不保留旧键：仍写旧键的映射，其人员字段会被当作未声明来源而留空。各环境的`reportMappings`需在部署时同步改键。
- 姓名来源列的值先按姓名换成工号，再走既有「工号 → open_id」解析链路，`Plan`及写侧不变。
- 姓名匹配口径：原值去首尾空白后精确匹配；**只认在职员工**；同一自然人跨租户的多行按工号去重算一人。
- 去重后恰好一名在职员工：取其工号；没有在职员工：该单元格留空跳过并记 warn；**多名在职员工重名：该单元格留空跳过，并推送运维告警**（每轮同步汇总成一条）。
- 同一人员字段同时出现在两个来源里时，工号来源优先，并记 warn。
- 一个单元格只承载一个姓名，不做多姓名拆分。
- `shape: pivot`下`personFieldNameSources`与`personFieldEmpNoSources`一样忽略并记 warn。

## Capabilities

### New Capabilities
<!-- 无新增能力 -->

### Modified Capabilities
- `linapro-moka-report-sync`: 「人员列按 open_id 集合比对」需求扩展姓名来源；「配置分层」需求的映射 JSON 结构新增`personFieldNameSources`；「pivot 形态的配置与降级」需求把`personFieldNameSources`纳入忽略项；新增「人员字段按姓名来源解析」需求（匹配口径、重名告警）。

## Impact

- 代码：`apps/lina-plugins/linapro-moka-report-sync/backend/internal/config/config.go`（新字段、告警配置键）、`.../internal/service/`（姓名解析、`preparePersonFields`扩展、周期末重名告警）。
- 依赖：消费 employee-core 已发布的`empcap.EmployeesByNamesAnyTenant`、共享库`linapro-lark-sdk/larkalert`，均已在 module 依赖内，不新增 module。
- 配置：宿主配置新增可选键`plugin.linapro-moka-report-sync.alert`（引用`_anchors.ops_alert`）；未配置时只写日志、不推群。
- 文档：`CONFIGURATION.md`补人员字段两种来源的说明。
- 不涉及：Moka 拉取、`Plan`/写侧、工号来源既有行为、前端、数据库。
