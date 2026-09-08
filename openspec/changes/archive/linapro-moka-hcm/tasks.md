# Tasks

## Summary

- [x] 交付 `linapro-moka-hcm` 插件：模块脚手架（`go.mod`、`go.work` 条目、`plugin.yaml` id `linapro-moka-hcm` type source、`plugin_embed.go`）+ `backend/hcm/` 核心包（`auther.go` HCMAuth/HCMCredential/Auther、`sign.go` Sign/BuildQuery/nonce/BasicAuthHeader、`client.go` Client/NewClient/PostJSON、`report.go` GetReportData、`employee.go` HCMEmployee/ListEmployees/ListAllEmployees）+ 插件入口（`OnStart` 读取四项配置、解析 PKCS#1/PKCS#8 RSA 私钥、注册 `*hcm.Client` 能力，缺配置或解析失败返回 error）。
- [x] 员工列表能力：`employee.go` 新增 `HCMEmployee{EmployeeNo, Realname, DepartmentID, Status}`，`ListEmployees(ctx, pageNum, pageSize)` 封装 `POST /api-platform/hcm/oapi/v2/batch/data` 复用 `Auther.Sign` + `Client.PostJSON`；`ListAllEmployees(ctx)` 按 pageSize=200 循环翻页直至拉完全量；`Status` 由 `employee_status_id`（优先）或 `employee_status` 文本映射得出；单测覆盖单页/多页翻页/状态映射优先级。
- [x] 验证：`go build ./...` 零编译错误；`go test ./...` 单测通过；`go work sync` 依赖一致；`backend/hcm/sign_test.go` 验证 `BuildQuery` 含必要签名字段；确认 `linapro-moka-report-sync` 现有消费（只用 `GetReportData`）不受影响。
- [x] 治理：私钥仅经配置服务加密存储，插件不承担额外密钥保护；无 i18n / 数据库 / 缓存 / 数据权限影响；纯 Go 跨平台。
