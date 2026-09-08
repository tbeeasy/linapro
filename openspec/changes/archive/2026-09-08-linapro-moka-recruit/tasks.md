## 1. 模块脚手架

- [x] 1.1 在 `apps/lina-plugins/linapro-moka-recruit/` 创建目录结构：`backend/moka/`、`manifest/i18n/en-US/`、`manifest/i18n/zh-CN/`
- [x] 1.2 编写 `go.mod`，模块名 `lina-plugin-linapro-moka-recruit`，Go 版本与 `linapro-moka-hcm` 一致
- [x] 1.3 在根 `go.work` 中追加 `apps/lina-plugins/linapro-moka-recruit` 条目，并添加对应 `replace` 指令（若工作区已有统一 replace 规则则跳过）
- [x] 1.4 创建 `plugin.yaml`（参照 `linapro-moka-hcm/plugin.yaml`，改 id/name 为 `linapro-moka-recruit`）
- [x] 1.5 创建 `plugin_embed.go`（同 `linapro-moka-hcm`，embed 空前端占位）
- [x] 1.6 创建 `backend/plugin.go`（空插件入口，注册模块）
- [x] 1.7 创建 `manifest/i18n/en-US/plugin.json` 和 `zh-CN/plugin.json`（空对象 `{}`）

## 2. 客户端核心

- [x] 2.1 创建 `backend/moka/client.go`：定义 `DefaultBaseURL`、`Client` 结构体（`baseURL`、`auth moka.Auther`、`httpClient *http.Client` 30s 超时）、`NewClient(baseURL string, auth moka.Auther) *Client`，以及 `PostJSON(ctx, path string, body any) ([]byte, error)`
- [x] 2.2 验证 `NewClient("")` 时 `baseURL` 回退到 `DefaultBaseURL`
- [x] 2.3 在工作区根执行 `go build ./apps/lina-plugins/linapro-moka-recruit/...` 确认无 module not found 错误

## 3. GetReportData 接口

- [x] 3.1 创建 `backend/moka/report.go`：在本模块内自包含声明 `ReportHeader`、`ReportData` 类型（与 `linapro-moka-hcm` 结构一致但独立声明）
- [x] 3.2 实现 `GetReportData(ctx context.Context, client *Client, reportId int64) (*ReportData, error)`，调用 `POST /api-platform/v1/getReportData`，处理 code=200 和 code=1000000 两种成功码，其他 code 返回携带 `msg` 的 error

## 4. 构建验证

- [x] 4.1 在工作区根执行 `go vet ./apps/lina-plugins/linapro-moka-recruit/...`，无报错
- [x] 4.2 执行 `openspec validate --strict linapro-moka-recruit`，通过

## 5. PutQuery 扩展

- [x] 5.1 在 `backend/moka/client.go` 添加 `PutQuery(ctx context.Context, path string, params url.Values) error` 方法：拼接 `baseURL + path`，将 `params` 附加到 URL query string，调用 `auth.ApplyAuth` 注入鉴权，发送 HTTP PUT（空 body），HTTP 2xx 时返回 nil，非 2xx 时返回携带状态码的错误

## 6. GetResumeContent 接口

- [x] 6.1 创建 `backend/moka/resume.go`，声明 `ResumeContent` 类型：`ResumeKey string`、`ResumeContent string`
- [x] 6.2 实现 `(c *Client) GetResumeContent(ctx context.Context, applicationID int64) (*ResumeContent, error)`，调用 `POST /api-platform/application/resumeContent/get`，入参 `{"applicationId": <id>}`；响应 code=200 时返回 `*ResumeContent`，其他 code 返回携带 `msg` 的 error

## 7. EhrApplications 接口

- [x] 7.1 创建 `backend/moka/application.go`，声明所需类型：`ApplicationStage`（id int64、name string、type int）、`ApplicationBasicInfo`（applicationId int64、candidateId int64、name string、stage ApplicationStage）、`EhrApplication`（basicInfo ApplicationBasicInfo）
- [x] 7.2 实现 `(c *Client) EhrApplications(ctx context.Context, stageIDs []int64) ([]EhrApplication, error)`，调用 `POST /api-platform/v2/data/ehrApplications`，入参 `{"stageIds": [...]}` ；响应 code=200 时返回应用列表，其他 code 返回错误

## 8. MoveApplicationStage 接口

- [x] 8.1 在 `backend/moka/application.go` 实现 `(c *Client) MoveApplicationStage(ctx context.Context, applicationID int64, stageID int64) error`，调用 `PUT /api-platform/v1/applications/move_application_stage?applicationId=<id>&stageId=<id>` via `PutQuery`；响应 code=0 时返回 nil，其他 code 返回错误

## 9. GetStagesList 接口

- [x] 9.1 创建 `backend/moka/stage.go`，声明 `Stage` 类型：id int64、name string、type int
- [x] 9.2 实现 `(c *Client) GetStagesList(ctx context.Context) ([]Stage, error)`，调用 `GET /api-platform/v2/stage/getStagesList`；响应 code=200 时返回列表，其他 code 返回错误；需在 client 上补 `GetJSON(ctx, path) ([]byte, error)` 辅助方法（与 PostJSON 对称）

## 10. 构建验证（补全后）

- [x] 10.1 在工作区根执行 `go vet ./apps/lina-plugins/linapro-moka-recruit/...`，无报错
- [x] 10.2 执行 `go build ./apps/lina-plugins/linapro-moka-recruit/...`，通过

## 11. 集成验证

- [x] 11.1 集成验证：真实 Moka 凭证 + 运行中宿主，端到端跑通简历分析与环节推进流水线，核对各 Moka 接口调用与状态回写符合预期。**待执行**：需真实凭证与运行环境。
