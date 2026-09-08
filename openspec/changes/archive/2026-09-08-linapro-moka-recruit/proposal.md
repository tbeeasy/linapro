## Why

现有 `linapro-moka-hcm` 插件（`lina-plugin-linapro-moka-hcm`）已覆盖 Moka HCM 模块的 API（路径前缀 `/api-platform/hcm/`）。招聘系统 API 使用不同的路径前缀（`/api-platform/v1/`、`/api-platform/v2/`、`/api-platform/v3/`），且业务需求（简历分析、面试状态回写、报表同步）将在独立插件中实现，需要一个专属的招聘系统客户端库作为依赖基础。

## What Changes

- 新建 Go 模块 `lina-plugin-linapro-moka-recruit`，位于 `apps/lina-plugins/linapro-moka-recruit/`
- 在 recruit 模块内自包含实现招聘系统支持的 `BasicAuth` 和 `OAuth2Auth` 鉴权（不复制 HCM 报表侧的 MD5withRSA 签名）
- 提供面向招聘系统的 `Client`，`DefaultBaseURL` 与 HCM 客户端相同（`https://api.mokahr.com`），但接口路径前缀为 `/api-platform/v{1,2,3}/...`
- 初始仅实现 `GetReportData`（`POST /api-platform/v1/getReportData`），后续招聘接口（简历获取、阶段推进、面试查询等）陆续扩充
- 将新模块加入根 `go.work`

## Capabilities

### New Capabilities

- `linapro-moka-recruit`：Moka 招聘系统 API 客户端，包含双鉴权（BasicAuth / OAuth2Auth）、`Client.PostJSON` 基础调用层，以及第一个业务接口 `GetReportData`

### Modified Capabilities

（无）

## Impact

- **新文件**：`apps/lina-plugins/linapro-moka-recruit/`（完整插件目录，含 `go.mod`、`backend/moka/`、`plugin.yaml`）
- **`go.work`**：新增 `apps/lina-plugins/linapro-moka-recruit` 条目
- **依赖方**：后续 `linapro-moka-recruit-sync`（或同名业务插件）将 `require` 此模块
- **无破坏性变更**：现有 `lina-plugin-linapro-moka-hcm` 和 `linapro-moka-report-sync` 不受影响
