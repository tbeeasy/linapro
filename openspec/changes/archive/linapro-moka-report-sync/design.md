# Design

## Context

Moka 报表中心通过 `POST https://api.mokahr.com/api-platform/hcm/oapi/v1/report/getReportData` 提供报表读取（3 次/秒/企业、30 次/分钟/企业）。响应为 `headers + rows` 结构，`headers[].dataIndex` 为 `c_$` 列 key，`rows[].c_$` 为单元格值。本需求每 5 分钟拉取一次，写入飞书 Bitable。

仓库现状：`lina-plugin-linapro-moka-hcm` 已提供 `GetReportData`；飞书已有 Lark SDK（`larksuite/oapi-sdk-go/v3`，按租户构建 client）；定时 + 无请求 ctx 的多租户遍历模式已有先例。本插件依赖 `lina-plugin-linapro-moka-hcm` 读取报表，写入飞书 Bitable。

## Decisions

### 1. 插件边界

新建插件 `linapro-moka-report-sync`，`go.mod` 依赖 `lina-plugin-linapro-moka-hcm`，实现定时同步（`internal/syncer` 纯算法、`internal/feishu` Bitable 读写、`internal/service` 编排、`internal/config` 配置）。需求 1/2/3 的简历流水线由 `lina-plugin-linapro-moka-recruit` 承载，不在本变更实现。

### 2. 写入算法：uniqueField 主键（默认 `工号`）+ 交集列完整性门闩

每 5 分钟、每报表映射：

```
moka_rows = GetReportData(reportId)               # code==200 才继续
existing  = 列出目标 Bitable 表全部记录 → {uniqueField值: record}  # 工号唯一
table_fields = Bitable 字段列表 API → 字段名集合       # 权威 schema，不依赖记录值
交集列    = Moka 报表 headers 的列 ∩ Bitable 表字段

for row in moka_rows:
    key = row[uniqueField]
    if key not in existing:         新增整行                          # 建
    else:
        rec = existing[key]
        if 交集列 中存在空字段:      用 Moka 最新值覆盖更新整条 rec     # 重写
        else:                       跳过                                # 冻结
```

- **完整性只算交集列**，不碰 Bitable 表中报表未声明的其他列（避免手工备注列触发无谓重写）。
- Bitable 字段列表来自字段 API（权威 schema），避免「某列在所有记录里都为空」时被漏判交集。
- 行级门闩副作用良性：Moka 侧某列暂时未算出时保持「未完成」，每轮续刷直至填满才冻结；幂等、可断点续跑、无需本地数据库表。
- 更新为「覆盖整条」而非逐字段 patch：门闩保证重写只发生在存在空字段时，整条覆盖与目标一致且更简单。

### 3. Bitable 写入与限流

- `moka_rows` 分成「待新增」「待重写」两拨，各按 batch_create / batch_update、批次 ≤1000 行提交；批次间小睡节流，在 50 次/秒限制内保留余量。
- 飞书 Bitable 寻址：`app_token`（多维表格文档）+ `table_id`（文档内表）。`appId/appSecret` 一套共用换写权限；因两张目标表在不同文档，`appToken` 留在每条映射内。

### 4. 配置分层

| 配置 | 落点 | 理由 |
|---|---|---|
| Moka：apiKey / apiCode / entCode / rsaPrivateKey / baseURL | `services.HostConfig` 配置文件 | 敏感凭证，不硬编码、不进 git |
| 飞书：appId / appSecret | `services.HostConfig` 配置文件 | 敏感凭证，一套共用 |
| 报表映射 `[{reportId, appToken, tableId, uniqueField, remark, enable}]` | 租户 `HostConfig.SysConfig()` 键 `plugin.linapro-moka-hcm.reportMappings`（JSON 数组） | 运维可增删 |
| 同步间隔 `intervalMinutes` | `services.HostConfig` 配置文件 | 可配，默认 5 分钟 |

`apiKey`（Basic 用户名）与 `apiCode`（query 参数）按两个独立配置项存，允许值相等。`uniqueField` 默认 `工号`，`enable` 必须显式 `true` 才同步（省略即停用）。

## Boundaries

- 只建 `linapro-moka-report-sync` 一个插件；不修改宿主、既有插件、数据库 schema 或前端。
- 新增飞书 Bitable 表为外部资源，不纳入本仓库。

## Validation

- 单元测试：交集列门闩三分支（新增/重写/冻结）+ 忽略表外列（`backend/internal/syncer/plan_test.go`）。
- 构建验证：`GOWORK=off go build ./...`、`go test ./...`、`go vet`、`gofmt` 均通过。
- 集成冒烟（待真实凭证与运行中宿主执行）：1 租户 + 2 报表映射跑一轮定时同步，核对 Bitable 行数/字段填充符合算法；确认 HTTP 请求头含 `Authorization` 且与 `curl -u 'apiKey:'` 一致。

## Rule Impact Record

- 插件开发：有影响，已读取 `.agents/rules/plugin.md` 与现有插件结构作为惯例参照。
- 配置治理：有影响，凭证进 `HostConfig`、映射进租户 settings，不硬编码。
- API、数据库 schema、缓存、数据权限、前端运行时、i18n：无影响。

## 宿主接入说明（本变更范围外的集成步骤）

- 宿主通过生成的 `lina-plugins` 聚合包（`//go:build official_plugins`）blank-import 各插件 backend；将 `linapro-moka-report-sync` 纳入聚合与启用配置属于构建/部署工序，不在本代码变更内手改。
- 运行期 HostConfig 静态键：`plugin.linapro-moka-hcm.moka.{apiKey,apiCode,entCode,rsaPrivateKey,baseURL}`、`plugin.linapro-moka-hcm.feishu.{appId,appSecret}`、`plugin.linapro-moka-hcm.{tenantId,intervalMinutes}`。
- 报表映射（sys_config 键 `plugin.linapro-moka-hcm.reportMappings`）JSON 数组示例：`[{"reportId":123,"appToken":"xxx","tableId":"tblYYY","uniqueField":"工号","remark":"员工性别民族分布表","enable":true}]`；`uniqueField` 默认 `工号`，`enable` 必须显式 `true` 才同步。
