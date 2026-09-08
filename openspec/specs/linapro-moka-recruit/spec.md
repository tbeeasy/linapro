# linapro-moka-recruit Specification

## Purpose
TBD - created by archiving change linapro-moka-recruit. Update Purpose after archive.
## Requirements
### Requirement: 模块结构
新模块 `lina-plugin-linapro-moka-recruit` SHALL 作为独立 Go 模块存在于 `apps/lina-plugins/linapro-moka-recruit/`，并在根 `go.work` 中注册。

#### Scenario: 工作区可见性
- **WHEN** 在工作区根目录执行 `go build ./apps/lina-plugins/linapro-moka-recruit/...`
- **THEN** 构建成功，无 module not found 错误

### Requirement: 鉴权自包含
模块 SHALL 在 `backend/moka/` 包内自包含实现 `Author` 接口、`BasicAuth` 和 `OAuth2Auth`，不依赖外部插件模块（`lina-plugin-linapro-moka-hcm` 或其他），不得跨模块 import 鉴权逻辑。招聘系统 OpenAPI 仅支持 Basic Auth 和 OAuth2 两种模式，模块不实现 HCM 报表侧的 MD5withRSA 请求签名。

#### Scenario: BasicAuth 可用
- **WHEN** 调用方以 `BasicCredential` 构造 `BasicAuth` 并传入招聘 `Client`
- **THEN** 每次请求携带 `Authorization: Basic base64(apiKey:)` header，不附加任何签名查询参数

#### Scenario: OAuth2Auth 可用
- **WHEN** 调用方以 `ClientID`/`ClientSecret` 构造 `OAuth2Auth` 并传入招聘 `Client`
- **THEN** 每次请求携带有效的 Bearer token，token 过期前 30 分钟自动刷新

#### Scenario: 鉴权模式可切换
- **WHEN** 业务从 Basic Auth 切换到 OAuth2Auth
- **THEN** 仅需更换构造 `Client` 时注入的 `Author`，所有业务接口方法代码不变

### Requirement: 招聘系统客户端
模块 SHALL 提供 `Client` 结构体，字段与构造函数签名与 `linapro-moka-hcm` 的 `Client` 对齐：`baseURL string`、`auth Auther`、内置 30s 超时的 `*http.Client`。`DefaultBaseURL` 为 `"https://api.mokahr.com"`。

#### Scenario: 默认 BaseURL
- **WHEN** 以空 `baseURL` 构造 `Client`
- **THEN** 实际请求发往 `https://api.mokahr.com`

#### Scenario: 自定义 BaseURL
- **WHEN** 以非空 `baseURL` 构造 `Client`
- **THEN** 实际请求发往指定的 baseURL

#### Scenario: 请求超时
- **WHEN** Moka 服务端无响应
- **THEN** 30 秒后客户端返回超时错误

### Requirement: PostJSON 基础调用
`Client` SHALL 提供 `PostJSON(ctx, path string, body any) ([]byte, error)` 方法：拼接 `baseURL + path`，序列化 `body` 为 JSON，调用 `auth.ApplyAuth` 注入鉴权，发送 HTTP POST，HTTP 2xx 时返回原始响应字节，非 2xx 时返回携带状态码的错误。

#### Scenario: 成功响应
- **WHEN** Moka 返回 HTTP 200
- **THEN** `PostJSON` 返回响应体字节，error 为 nil

#### Scenario: 非 2xx 响应
- **WHEN** Moka 返回 HTTP 4xx 或 5xx
- **THEN** `PostJSON` 返回 nil 字节和非 nil error，error 信息包含 HTTP 状态码

### Requirement: GetReportData
模块 SHALL 在 `backend/moka/report.go` 中实现 `(c *Client) GetReportData(ctx context.Context, reportID int64) (*ReportData, error)`，调用 `POST /api-platform/v1/getReportData`，入参 `{"reportId": <id>}`。响应 code 为 `200` 或 `1000000` 时解析并返回 `*ReportData`，其他 code 返回携带 `msg` 的 error。

`ReportData` 和 `ReportHeader` 类型在本模块内自包含声明，不跨模块引用 `linapro-moka-hcm` 的同名类型。

#### Scenario: 正常获取报表
- **WHEN** 传入有效 `reportId`，Moka 返回 code=200 的报表数据
- **THEN** 返回包含 `Headers`、`Rows`、`Size` 的 `*ReportData`，error 为 nil

#### Scenario: 兼容 code=1000000
- **WHEN** Moka 返回 code=1000000（Moka 文档差异兜底）
- **THEN** 同样解析并返回 `*ReportData`，不返回 error

#### Scenario: API 返回业务错误
- **WHEN** Moka 返回非成功 code（如 `400001`）
- **THEN** 返回 nil 和包含 Moka `msg` 字段内容的 error

