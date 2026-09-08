## Why

Moka HCM OpenAPI（Basic Auth + MD5withRSA 查询参数签名）与 OpenPlatform OAuth2 是两套完全独立的认证体系，服务于不同的 API 域，适用于非隐私数据端点（如报表中心、员工花名册）。将 HCM 客户端作为独立插件承载，可以让 HCM 接口集中演进，为后续持续新增的人事系统接口（组织架构、员工档案、薪酬、员工列表等）提供清晰归属，避免不同认证体系的依赖相互污染。

员工目录同步（`linapro-employee-core`）需要从 Moka 拉取全量员工花名册（工号、姓名、部门、在职状态）来驱动同步，而 HCM SDK 此前仅有报表拉取能力，缺少员工列表接口；员工列表能力是员工目录同步 job 的前置依赖。

## What Changes

- 新增插件 `lina-plugin-linapro-moka-hcm`（模块路径 `github.com/lina-app/lina-plugin-linapro-moka-hcm`，位于 `apps/lina-plugins/linapro-moka-hcm/`，`plugin.yaml` id `linapro-moka-hcm`、type `source`），并在根 `go.work` 注册模块入口。
- `backend/hcm/` 核心包承载 HCM 客户端能力：
  - `auther.go`：`Auther` 接口、`HCMCredential`、`HCMAuth` 与 `NewHCMAuth`（Basic Auth + MD5withRSA 签名）。
  - `sign.go`：`Sign`、`BuildQuery`、`nonce`、`BasicAuthHeader` 签名工具（HCM 专用）。
  - `client.go`：`Client`、`NewClient` HTTP 传输层，保持 `Auther` 注入模式。
  - `report.go`：`GetReportData`（路径 `/api-platform/hcm/oapi/v1/report/getReportData`）。
  - `employee.go`：`HCMEmployee` 类型与 `ListEmployees`/`ListAllEmployees`（路径 `POST /api-platform/hcm/oapi/v2/batch/data`），供员工目录同步消费。
- 插件在 `OnStart` 钩子读取配置（`api_key`、`api_code`、`ent_code`、`private_key_pem`），构造 `*hcm.Client` 并注册为插件能力，供下游插件通过能力依赖获取，而非直接构造。
- 包结构为后续每类 HCM API 域预留独立文件扩展点（`org.go`、`salary.go` 等）。
- 员工列表只映射同步所需最小字段（工号、姓名、部门 ID、在职状态），其余敏感字段（薪资、证件、银行卡）以 `json:"-"` 忽略，不进内存；认证复用现有 `Auther` + `sign.go`，零重复签名逻辑；不新增 cap 层，维持 SDK 库模式，消费方通过 `go.mod replace` 直接 import。
- 不包含 OAuth2 或 OpenPlatform 相关任何功能。

## Capabilities

### New Capabilities

- `linapro-moka-hcm`：Moka HCM OpenAPI 客户端插件，提供 HCMAuth 认证、HTTP 客户端、`GetReportData` 接口调用与插件级客户端工厂；并封装 Moka `POST /api-platform/hcm/oapi/v2/batch/data` 的员工列表能力，提供 `ListEmployees`（分页）与 `ListAllEmployees`（自动翻页拉全量）。

## Impact

- 新增 `apps/lina-plugins/linapro-moka-hcm/` 全新代码，`go.work` 新增模块条目。
- 下游需要 HCM 接口的插件（如报表同步、员工目录同步）通过能力依赖获取 `*hcm.Client`；员工目录同步通过 `ListAllEmployees` 拉取全量花名册。
- 不破坏现有消费方：`linapro-moka-report-sync` 只用 `GetReportData`，新增员工列表方法不影响它。
- 不修改 `apps/lina-core`、`apps/lina-vben`、HTTP API、数据库或前端；插件独立存在，删除目录即可完全回滚。
