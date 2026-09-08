## Why

需要把 Moka 报表中心的数据定时同步到飞书多维表格（Bitable）。通过 `lina-plugin-linapro-moka-hcm` 提供的 `GetReportData` 接口每 5 分钟拉取一次报表数据，按幂等策略写入飞书 Bitable，供组织在飞书侧消费人事报表。

## What Changes

- 新建报表同步插件 `linapro-moka-report-sync`（`apps/lina-plugins/linapro-moka-report-sync`），`go.mod` 依赖 `lina-plugin-linapro-moka-hcm`，注册 5 分钟可配定时 job（生命周期跟随 AfterEnable/BeforeDisable）。
- 按报表映射列表定时拉取 Moka 报表并写入 Bitable，写入采用「uniqueField 主键（默认 `工号`）+ 交集列完整性门闩」策略：无记录→新增，有记录且交集列存在空字段→覆盖重写，全非空→冻结不动。
- 批量写入（≤1000 行/次），在飞书 50 次/秒限制内节流。
- 配置分层：Moka 与飞书凭证进 `services.HostConfig` 静态配置；报表映射列表进租户 `HostConfig.SysConfig()` 配置行。

## Impact

- 新增 `apps/lina-plugins/linapro-moka-report-sync/**`；不修改 `apps/lina-core`、`apps/lina-vben`、HTTP API、数据库 schema 或既有插件。
- 目标飞书 Bitable 表为外部资源，不纳入本仓库；本插件只负责写入逻辑。
- 数据写入外部飞书多维表格是用户明确需求；飞书 secret 写入配置文件，不进 git 提交。

## Open Questions（落地前已确认）

- `getReportData` 成功码为 `200`（防御性同时接受 `1000000`）。
- 两张目标 Bitable 表的 appToken/tableId 及「主键列」字段名（`uniqueField`）。
