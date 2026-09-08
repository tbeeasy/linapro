# linapro-moka-hcm Specification

## Purpose
TBD - created by archiving change linapro-moka-hcm. Update Purpose after archive.
## Requirements
### Requirement: HCM 认证（HCMAuth）
插件 SHALL 提供 `HCMAuth` 类型，实现 `Auther` 接口，对每个出站请求执行：
1. 设置 `Authorization: Basic <base64(apiKey:)>` 请求头（密码为空）
2. 生成随机 8 位 nonce（字母数字，大小写不敏感）
3. 将 `entCode`、`apiCode`、`nonce`、`timestamp`（毫秒级 Unix 时间）进行 MD5withRSA 签名
4. 将 `entCode`、`apiCode`、`nonce`、`timestamp`、`sign` 以 URL 查询参数形式追加到请求 URL，不覆盖已有查询参数

#### Scenario: 成功追加签名参数
- **WHEN** 调用 `ApplyAuth` 且请求 URL 无已有查询参数
- **THEN** 请求 URL 的查询字符串包含 `entCode`、`apiCode`、`nonce`、`timestamp`、`sign` 共五个参数

#### Scenario: 合并已有查询参数
- **WHEN** 调用 `ApplyAuth` 且请求 URL 已有查询参数
- **THEN** 已有参数保留，签名参数追加在其后，不覆盖也不丢失原有参数

#### Scenario: RSA 私钥为 nil 时返回错误
- **WHEN** 构造 `HCMAuth` 时 `PrivateKey` 为 nil，调用 `ApplyAuth`
- **THEN** 返回非 nil 的 error，请求不被发出

---

### Requirement: HTTP 客户端（Client）
插件 SHALL 提供 `Client` 类型，封装 Moka OpenAPI 的 HTTP 传输层：
- 默认 base URL 为 `https://api.mokahr.com`，可通过构造参数覆盖
- 每次请求前调用注入的 `Auther.ApplyAuth` 应用认证
- `PostJSON(ctx, path, body)` 发送 `Content-Type: application/json` 的 POST 请求，返回原始响应字节
- HTTP 状态码非 2xx 时返回包含状态码和响应体前 512 字节的 error
- `Client` 的并发使用 SHALL 是安全的

#### Scenario: 成功 POST 请求
- **WHEN** 调用 `PostJSON` 且服务端返回 HTTP 200 及 JSON 响应体
- **THEN** 返回响应体字节，error 为 nil

#### Scenario: HTTP 非 2xx 返回 error
- **WHEN** 服务端返回 HTTP 4xx 或 5xx
- **THEN** 返回包含状态码的 error，响应体字节为 nil

#### Scenario: 认证失败时不发出请求
- **WHEN** `Auther.ApplyAuth` 返回 error
- **THEN** `PostJSON` 立即返回该 error，不向服务端发送 HTTP 请求

---

### Requirement: GetReportData 接口
`Client` SHALL 提供 `GetReportData(ctx, reportID int64) (*ReportData, error)` 方法：
- 向 `/api-platform/hcm/oapi/v1/report/getReportData` 发送 POST 请求
- 请求体为 `{"reportId": <reportID>}`
- 响应 `code` 为 200 或 1000000 时视为成功
- 成功时返回解析后的 `*ReportData`（含 `Headers`、`Rows`、`Size`）
- 响应 `data` 字段为 null 时返回空 `&ReportData{}`，不返回 error
- 非成功 code 时返回包含 reportId、code、msg 的 error

#### Scenario: 成功获取报表数据
- **WHEN** API 返回 `{"code":200,"data":{"headers":[...],"rows":[...],"size":N}}`
- **THEN** 返回包含对应 Headers、Rows、Size 的 `*ReportData`，error 为 nil

#### Scenario: API 返回非成功 code
- **WHEN** API 返回 `{"code":500,"msg":"internal error","data":null}`
- **THEN** 返回包含 code 和 msg 信息的 error，`*ReportData` 为 nil

#### Scenario: 响应 data 为 null
- **WHEN** API 返回 `{"code":200,"data":null}`
- **THEN** 返回 `&ReportData{}`，error 为 nil

#### Scenario: 兼容 legacy 成功码
- **WHEN** API 返回 `{"code":1000000,"data":{...}}`
- **THEN** 视为成功，返回解析后的 `*ReportData`

---

### Requirement: 插件注册与客户端工厂
插件 SHALL 在 LinaPro 插件生命周期中完成以下操作：
- 在 `OnStart` 钩子中从插件配置服务读取 `api_key`、`api_code`、`ent_code`、`private_key_pem` 四个必填配置项
- 解析 PEM 格式 RSA 私钥，构造 `*hcm.Client`
- 将 `*hcm.Client` 注册为插件能力，供依赖本插件的其他插件通过能力接口获取
- 任意必填配置项缺失或私钥解析失败时，`OnStart` SHALL 返回 error，插件不完成启动

#### Scenario: 配置完整时插件正常启动
- **WHEN** 四个必填配置项均存在且 PEM 私钥格式正确
- **THEN** 插件启动成功，`*hcm.Client` 注册到能力系统

#### Scenario: 配置缺失时插件启动失败
- **WHEN** 任意必填配置项为空或不存在
- **THEN** `OnStart` 返回 error，插件不进入运行状态

#### Scenario: 私钥格式错误时插件启动失败
- **WHEN** `private_key_pem` 非合法 PKCS#1 或 PKCS#8 RSA 私钥 PEM
- **THEN** `OnStart` 返回包含解析错误信息的 error

---

### Requirement: 员工列表接口（ListEmployees / ListAllEmployees）

`Client` SHALL 提供员工列表能力，封装 Moka `POST /api-platform/hcm/oapi/v2/batch/data` 接口，供员工目录同步（`linapro-employee-core`）消费。

- SHALL 在 `backend/hcm/employee.go` 中定义 `HCMEmployee` 结构体，只映射同步所需最小字段：`EmployeeNo`（工号，员工目录稳定外部主键）、`Realname`（姓名，飞书通讯录 JOIN 键）、`DepartmentID`（Moka 部门 ID，映射内部租户）、`Status`（1=在职，0=离职/其他）。
- SHALL 在 `*Client` 上实现 `ListEmployees(ctx context.Context, pageNum, pageSize int) (list []HCMEmployee, total int, err error)`：`pageSize` 上限 200，返回 Moka 全量 `total`，认证复用 `Auther.Sign`。
- SHALL 在 `*Client` 上实现 `ListAllEmployees(ctx context.Context) ([]HCMEmployee, error)`：内部以 `pageSize=200` 循环翻页直至 `(pageNum-1)*200 + len(page) >= total`，调用方不感知分页。
- SHALL 在 `Status` 映射时优先取 `employee_status_id`（1=在职）；无则取 `employee_status` 文本（`"在职"` → 1，其他 → 0）。
- SHALL 以 `json:"-"` 忽略 Moka 返回的薪资、证件、银行卡等非同步字段，不进内存。
- SHALL 维持 SDK 库模式，不新增 cap 层，消费方通过 `go.mod replace` 直接 import。

#### Scenario: 单页返回正确映射员工
- **WHEN** 调用 `ListEmployees(ctx, 1, 200)` 且 Moka 返回一页员工数据，含 `employee_no`、`realname`、`department_id`、`employee_status_id=1`
- **THEN** 返回的 `[]HCMEmployee` 中每条记录正确映射四字段，`Status=1`，`total` 为 Moka 返回的全量总数，error 为 nil

#### Scenario: 多页翻页直至拉完全量
- **WHEN** Moka 全量员工大于单页（如 total=450），调用 `ListAllEmployees(ctx)`
- **THEN** 内部以 pageSize=200 循环翻页，返回全量员工切片，调用方不感知分页，error 为 nil

#### Scenario: employee_status_id 优先于文本字段
- **WHEN** 同一员工返回中同时存在 `employee_status_id=1` 与 `employee_status="离职"`
- **THEN** `Status` 取 `employee_status_id` 得出 `1`，文本字段被忽略

#### Scenario: 无 id 时回退文本映射
- **WHEN** 返回中无 `employee_status_id`，仅 `employee_status="在职"`
- **THEN** `Status` 由文本映射得出 `1`

#### Scenario: 认证复用 Auther 不重复签名逻辑
- **WHEN** 调用 `ListEmployees`
- **THEN** 复用现有 `Auther.Sign` + `Client.PostJSON` 完成认证与请求，不重复实现签名逻辑

#### Scenario: 不引入 cap 层维持 SDK 库模式
- **WHEN** 消费方（如 `linapro-employee-core`）需要员工列表数据
- **THEN** 通过 `go.mod replace` 直接 import `hcm.Client`，不经过任何新增 cap/中间抽象层

---

### Requirement: 包结构扩展约定
`backend/hcm/` 包 SHALL 遵循以下文件组织约定，以支持后续 HCM 接口的有序扩展：
- `auther.go`：`Auther` 接口、`HCMCredential`、`HCMAuth` 类型
- `client.go`：`Client` 类型及 `PostJSON`/`GetJSON` 方法
- `sign.go`：`Sign`、`BuildQuery`、`nonce` 等签名工具函数
- `report.go`：`GetReportData` 及相关响应类型
- `employee.go`：`HCMEmployee` 及 `ListEmployees`/`ListAllEmployees`
- 后续每类 HCM API 域新增独立文件（如 `org.go`、`salary.go`），方法挂载在 `*Client` 上

#### Scenario: 新增 API 文件不破坏现有功能
- **WHEN** 在 `backend/hcm/` 下新增文件并在 `*Client` 上添加方法
- **THEN** `go build ./...` 通过，现有 `GetReportData`/`ListEmployees` 行为不变

