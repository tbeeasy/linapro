# Tasks

## Summary

- [x] 交付 `linapro-moka-report-sync` 插件：骨架（`plugin.yaml`、`plugin_embed.go`、`backend/plugin.go`；`go.mod` 依赖 `lina-plugin-linapro-moka-hcm`；5 分钟可配定时 job，生命周期跟随 AfterEnable/BeforeDisable）+ 纯算法包 `internal/syncer`（`FlattenReport` headers→title/dataIndex 平铺、`Plan` uniqueField 主键对齐 + 交集列完整性门闩三分支，`plan_test.go` 覆盖新增/重写/冻结及忽略表外列）+ 飞书 `internal/feishu`（`ListFields` 权威 schema、`ListRecords` 主键索引、`BatchCreate`/`BatchUpdate` ≤1000 行/批节流）+ 编排 `internal/service`（`Runner.RunOnce`：加载配置→遍历 enable 映射→拉取报表→Plan→批量写入→汇报 created/updated/frozen/skipped，per-mapping 失败记 error 不中断其他）+ 配置分层 `internal/config`（凭证进 `services.HostConfig`，映射进 `HostConfig.SysConfig()` 键 `plugin.linapro-moka.reportMappings`）。
- [x] 验证：`GOWORK=off go build ./...`、`go test ./...`（syncer 单测全绿）、`go vet`、`gofmt` 均通过。落地前确认 `getReportData` 成功码 `200`（防御接受 `1000000`）与两张 Bitable 表 appToken/tableId/主键列。
- [x] 治理：飞书 secret 进配置文件不进 git；无 API / 数据库 schema / 缓存 / 数据权限 / i18n 影响。
- [ ] 集成冒烟（真实 Moka/飞书凭证 + 运行中宿主，1 租户 + 2 报表映射跑一轮，核对 Bitable 行数/字段填充符合算法）——代码已就绪，**待真实凭证与运行环境执行**。
