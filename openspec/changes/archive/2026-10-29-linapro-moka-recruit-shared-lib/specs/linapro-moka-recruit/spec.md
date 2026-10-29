## ADDED Requirements

### Requirement: 共享库形态
`linapro-moka-recruit` SHALL 以非插件共享库形态交付：模块根目录不得存在 `plugin.yaml`、`plugin_embed.go`、`backend/`、`frontend/`、`manifest/`，不向宿主注册源码插件，不建表、不注册任务。使用方 SHALL 通过 `go.mod` 的 `require linapro-moka-recruit v0.0.0` 与 `replace linapro-moka-recruit => ../linapro-moka-recruit` 引入，并 import `linapro-moka-recruit/moka`。模块根目录 SHALL 同时提供 `README.md` 与 `README.zh-CN.md`，说明共享库定位、认证方式、API 路径前缀、用法与使用方。

#### Scenario: 引入方不被判为跨插件越界
- **WHEN** 使用方插件生产代码 import `linapro-moka-recruit/moka` 后执行 `make plugins.check`
- **THEN** 不出现指向该包的 `plugin-cross-plugin-private-import` finding

#### Scenario: 不进入插件聚合构建
- **WHEN** linactl 为 plugin-full 构建生成 `temp/official-plugins/plugins.go`
- **THEN** 其中不包含 `linapro-moka-recruit` 的 import

## MODIFIED Requirements

### Requirement: 模块结构
模块 `linapro-moka-recruit` SHALL 作为独立 Go 模块存在于 `apps/lina-plugins/linapro-moka-recruit/`，并在根 `go.work` 中注册。模块名 SHALL NOT 带 `lina-plugin-` 前缀，因为插件治理按该前缀兜底识别插件 owner。客户端代码 SHALL 位于模块根下的 `moka/` 包。

#### Scenario: 工作区可见性
- **WHEN** 在工作区根目录执行 `go build ./apps/lina-plugins/linapro-moka-recruit/...`
- **THEN** 构建成功，无 module not found 错误

#### Scenario: 脱离工作区独立构建
- **WHEN** 在模块目录执行 `GOWORK=off go build ./...`
- **THEN** 构建成功

### Requirement: 鉴权自包含
模块 SHALL 在 `moka/` 包内自包含实现 `Author` 接口、`BasicAuth` 和 `OAuth2Auth`，不依赖其他插件或共享库模块（`linapro-moka-hcm` 或其他），不得跨模块 import 鉴权逻辑。招聘系统 OpenAPI 仅支持 Basic Auth 和 OAuth2 两种模式，模块不实现 HCM 报表侧的 MD5withRSA 请求签名。

#### Scenario: BasicAuth 可用
- **WHEN** 调用方以 `BasicCredential` 构造 `BasicAuth` 并传入招聘 `Client`
- **THEN** 每次请求携带 `Authorization: Basic base64(apiKey:)` header，不附加任何签名查询参数

#### Scenario: OAuth2Auth 可用
- **WHEN** 调用方以 `ClientID`/`ClientSecret` 构造 `OAuth2Auth` 并传入招聘 `Client`
- **THEN** 每次请求携带有效的 Bearer token，token 剩余有效期不足 30 分钟时自动刷新

#### Scenario: 鉴权模式可切换
- **WHEN** 业务从 Basic Auth 切换到 OAuth2Auth
- **THEN** 仅需更换构造 `Client` 时注入的 `Author`，所有业务接口方法代码不变

### Requirement: 招聘系统客户端
模块 SHALL 提供由 `NewClient(baseURL string, auth Author) *Client` 构造的 `Client` 结构体，字段为 `baseURL string`、`auth Author`、内置 60s 单请求超时的 `*http.Client`；构造时去除 `baseURL` 末尾的 `/`。`DefaultBaseURL` 为 `"https://api.mokahr.com"`。

#### Scenario: 默认 BaseURL
- **WHEN** 以空 `baseURL` 构造 `Client`
- **THEN** 实际请求发往 `https://api.mokahr.com`

#### Scenario: 自定义 BaseURL
- **WHEN** 以非空 `baseURL` 构造 `Client`
- **THEN** 实际请求发往指定的 baseURL

#### Scenario: 请求超时
- **WHEN** Moka 服务端无响应
- **THEN** 单次请求 60 秒后客户端返回超时错误

### Requirement: PostJSON 基础调用
`Client` SHALL 提供 `PostJSON(ctx context.Context, path string, body []byte) ([]byte, error)` 方法：拼接 `baseURL + path`，以调用方已序列化的 `body` 作为请求体并设置 `Content-Type: application/json`，调用 `auth.ApplyAuth` 注入鉴权后发送 HTTP POST。鉴权失败时 SHALL 直接返回该错误且不发出请求；HTTP 2xx 时返回原始响应字节，非 2xx 时返回携带状态码的错误。

#### Scenario: 成功响应
- **WHEN** Moka 返回 HTTP 200
- **THEN** `PostJSON` 返回响应体字节，error 为 nil

#### Scenario: 非 2xx 响应
- **WHEN** Moka 返回 HTTP 4xx 或 5xx
- **THEN** `PostJSON` 返回 nil 字节和非 nil error，error 信息包含 HTTP 状态码

### Requirement: GetReportData
模块 SHALL 在 `moka/report.go` 中实现 `(c *Client) GetReportData(ctx context.Context, reportID int64) (*ReportData, error)`，调用 `POST /api-platform/v1/getReportData`，入参 `{"reportId": <id>}`。响应 code 为 `200` 或 `1000000` 时解析并返回 `*ReportData`，其他 code 返回携带 `msg` 的 error。

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
