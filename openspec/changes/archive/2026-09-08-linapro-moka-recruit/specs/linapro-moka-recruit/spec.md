## ADDED Requirements

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

## ADDED Requirements（第二批：招聘业务接口）

### Requirement: PutQuery 扩展
`Client` SHALL 提供 `PutQuery(ctx context.Context, path string, params url.Values) error` 方法：拼接 `baseURL + path`，将 `params` 编码后附加到 URL query string，调用 `auth.ApplyAuth` 注入鉴权，发送 HTTP PUT（空 body），HTTP 2xx 时返回 nil，非 2xx 时返回携带状态码的错误。

#### Scenario: PUT 成功
- **WHEN** 目标路径返回 HTTP 200
- **THEN** `PutQuery` 返回 nil error

#### Scenario: PUT 非 2xx
- **WHEN** 目标路径返回 HTTP 4xx 或 5xx
- **THEN** `PutQuery` 返回包含状态码的非 nil error

### Requirement: GetJSON 扩展
`Client` SHALL 提供 `GetJSON(ctx context.Context, path string) ([]byte, error)` 方法：发送 HTTP GET，鉴权注入，HTTP 2xx 时返回响应字节，非 2xx 时返回错误。

### Requirement: GetResumeContent
模块 SHALL 在 `backend/moka/resume.go` 中实现 `(c *Client) GetResumeContent(ctx context.Context, applicationID int64) (*ResumeContent, error)`，调用 `POST /api-platform/application/resumeContent/get`，入参 `{"applicationId": <id>}`；响应 code=200 时返回 `*ResumeContent`（含 `ResumeKey string` 和 `ResumeContent string`），其他 code 返回携带 `msg` 的 error。

#### Scenario: 正常获取简历文本
- **WHEN** 传入有效 `applicationId`，Moka 返回 code=200
- **THEN** 返回 `*ResumeContent`，`ResumeContent` 字段包含解析好的纯文本简历，error 为 nil

#### Scenario: API 返回业务错误
- **WHEN** Moka 返回非成功 code
- **THEN** 返回 nil 和包含 `msg` 的 error

### Requirement: EhrApplications
模块 SHALL 在 `backend/moka/application.go` 中实现 `(c *Client) EhrApplications(ctx context.Context, query EhrApplicationsQuery) ([]EhrApplication, error)`，调用 `POST /api-platform/v2/data/ehrApplications`，入参由 `query` 组合（`stageIds` 必填，`archived`、`updateAtStartTime`、`updateAtEndTime` 可选）；响应 code=200 时返回应用列表，其他 code 返回错误。

类型声明：`ApplicationStage`（ID int64、Name string、Type int）、`ApplicationBasicInfo`（ApplicationID int64、CandidateID int64、Name string、Stage ApplicationStage、Archived bool、ArchiveReasons）、`EhrApplication`（BasicInfo ApplicationBasicInfo、InterviewInfo）。

#### Scenario: 按 stageIds 过滤
- **WHEN** 传入 `EhrApplicationsQuery{StageIDs: [...]}`，Moka 返回 code=200
- **THEN** 返回该阶段的候选人列表，每条记录 `BasicInfo.ApplicationID` 非零

#### Scenario: 空结果
- **WHEN** 指定阶段无候选人
- **THEN** 返回空切片，error 为 nil

#### Scenario: 归档与更新时间范围过滤
- **WHEN** `query.Archived` 非 nil 或 `UpdateAtStartTime`/`UpdateAtEndTime` 非空
- **THEN** 对应 `archived`、`updateAtStartTime`、`updateAtEndTime` 字段透传至请求体，过滤由 Moka 服务端完成

### Requirement: MoveApplicationStage
模块 SHALL 在 `backend/moka/application.go` 中实现 `(c *Client) MoveApplicationStage(ctx context.Context, applicationID int64, stageID int64) error`，调用 `PUT /api-platform/v1/applications/move_application_stage?applicationId=<id>&stageId=<id>` via `PutQuery`；响应 code=0 时返回 nil，其他 code 返回错误。

#### Scenario: 成功推进阶段
- **WHEN** 传入有效 applicationId 和 stageId，Moka 返回 code=0
- **THEN** 返回 nil error

#### Scenario: 推进失败
- **WHEN** Moka 返回非零 code
- **THEN** 返回包含 msg 的非 nil error

### Requirement: GetStagesList
模块 SHALL 在 `backend/moka/stage.go` 中实现 `(c *Client) GetStagesList(ctx context.Context) ([]Stage, error)`，调用 `GET /api-platform/v2/stage/getStagesList` via `GetJSON`；响应 code=200 时返回阶段列表，其他 code 返回错误。

类型 `Stage` 包含：`ID int64`、`Name string`、`Type int`。

#### Scenario: 获取阶段列表
- **WHEN** 调用 GetStagesList
- **THEN** 返回包含初筛（type=100）和面试（type=201）等阶段的列表，error 为 nil

### Requirement: GetInterviewInformation
模块 SHALL 在 `backend/moka/application.go` 中实现 `(c *Client) GetInterviewInformation(ctx context.Context, applicationIDs []int64, email string) ([]InterviewInformation, error)`，调用 `POST /api-platform/v1/interview/interview-information`，入参 `{"applicationIds":[...], "email":<email>}`；`email` 为组织管理员邮箱。响应 code=0 时返回面试信息列表，其他 code 返回错误；`applicationIDs` 为空时直接返回空切片不发请求。

类型声明：`InterviewInformationEntity`（ID int64、Round int、RoundName string、StartTime int64、IntervieweeVideoURL string）、`InterviewInformation`（ApplicationID int64、Entities []InterviewInformationEntity）。`InterviewType`（视频面试/现场面试/电话面试）与 `InterviewStatus`（已取消/未结束/已结束）为容错解析 Moka 值的命名类型。

#### Scenario: 正常获取面试信息
- **WHEN** 传入有效 applicationIds 与 email，Moka 返回 code=0
- **THEN** 返回带 entities 的面试信息列表，`IntervieweeVideoURL` 为视频面试链接，error 为 nil

#### Scenario: 空 applicationIds
- **WHEN** `applicationIDs` 为空
- **THEN** 不发送 HTTP 请求，返回空切片，error 为 nil
