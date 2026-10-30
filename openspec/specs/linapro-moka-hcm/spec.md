# linapro-moka-hcm Specification

## Purpose
TBD - created by archiving change linapro-moka-hcm. Update Purpose after archive.
## Requirements
### Requirement: HCM 认证（HCMAuth）

共享库 SHALL 提供`Author`接口与`HCMAuth`实现；`Author.ApplyAuth(ctx, req, apiCode, extra)`的`apiCode`按调用传入（每个 Moka 接口各有编码），`extra`为本次调用额外参与签名的查询参数（可为 nil）。`HCMAuth`对每个出站请求执行：

1. 设置`Authorization: Basic <base64(apiKey:)>`请求头（密码为空）
2. 生成随机 8 位 nonce（字母数字，大小写不敏感）
3. 将`entCode`、`apiCode`、`nonce`、`timestamp`（毫秒级 Unix 时间）以及`extra`中的非空键值进行 MD5withRSA 签名
4. 将上述参数与`sign`以 URL 查询参数形式追加到请求 URL，保留已有查询参数

签名工具 SHALL 以独立函数提供：`CanonicalString`（排除`sign`、键升序、`k=v&k=v`拼接）、`Sign`（MD5withRSA 后 base64）、`Verify`（公钥校验）、`BuildQuery`（签名并整体 URL 编码）、`ParsePrivateKey`（依次尝试 PKCS#1 与 PKCS#8）、`BasicAuthHeader`。

#### Scenario: 成功追加签名参数

- **WHEN** 调用`ApplyAuth`且请求 URL 无已有查询参数、`extra`为 nil
- **THEN** 请求 URL 的查询字符串包含`entCode`、`apiCode`、`nonce`、`timestamp`、`sign`共五个参数

#### Scenario: 合并已有查询参数

- **WHEN** 调用`ApplyAuth`且请求 URL 已有查询参数
- **THEN** 已有参数保留，签名参数追加在其后，不覆盖也不丢失原有参数

#### Scenario: extra 参数参与签名

- **WHEN** 调用`ApplyAuth`且`extra`含`{"userName": "ops@example.com"}`
- **THEN** `userName`与其余签名参数一同参与 MD5withRSA 计算，并以查询参数形式出现在请求 URL 上

#### Scenario: extra 中的空值键被跳过

- **WHEN** `extra`中某键或值为空字符串
- **THEN** 该键不参与签名，也不出现在请求 URL 上

#### Scenario: RSA 私钥为 nil 时返回错误

- **WHEN** 以`PrivateKey`为 nil 的`HCMCredential`构造`HCMAuth`，调用`ApplyAuth`
- **THEN** 返回非 nil 的 error，请求不被发出

#### Scenario: 私钥解析支持两种 PEM 编码

- **WHEN** 以 PKCS#1（`RSA PRIVATE KEY`）或 PKCS#8（`PRIVATE KEY`）编码的 RSA 私钥 PEM 调用`ParsePrivateKey`
- **THEN** 均返回对应的`*rsa.PrivateKey`，error 为 nil；非 PEM、无法解析或非 RSA 类型时返回 error

### Requirement: HTTP 客户端（Client）

共享库 SHALL 提供`Client`类型，封装 Moka OpenAPI 的 HTTP 传输层：

- 构造函数为`NewClient(baseURL string, cred HCMCredential) *Client`，baseURL 为空时使用`DefaultBaseURL`（`https://api.mokahr.com`），非空时去除尾部`/`
- `Client`内部持有完整`HCMCredential`与由它构造的`HCMAuth`，业务方法据此向`PostJSON`传入各自的`apiCode`
- 内置`*http.Client`超时为 30 秒
- `PostJSON(ctx, path string, apiCode string, body []byte, extra map[string]string)`发送`Content-Type: application/json`的 POST 请求，`body`为已序列化字节，返回原始响应字节；响应外层信封由调用方解码
- 每次请求前调用`Author.ApplyAuth`应用认证；认证失败时不发出 HTTP 请求
- HTTP 状态码非 2xx 时返回包含状态码和响应体前 512 字节的 error
- `Client`的并发使用 SHALL 是安全的

#### Scenario: 成功 POST 请求

- **WHEN** 调用`PostJSON`且服务端返回 HTTP 200 及 JSON 响应体
- **THEN** 返回响应体字节，error 为 nil

#### Scenario: HTTP 非 2xx 返回 error

- **WHEN** 服务端返回 HTTP 4xx 或 5xx
- **THEN** 返回包含状态码的 error，响应体字节为 nil

#### Scenario: 认证失败时不发出请求

- **WHEN** `Author.ApplyAuth`返回 error
- **THEN** `PostJSON`立即返回该 error，不向服务端发送 HTTP 请求

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

### Requirement: 员工列表接口（ListEmployees / ListAllEmployees）

`Client` SHALL 提供员工列表能力，封装 Moka`POST /api-platform/hcm/oapi/v2/batch/data`接口，供员工目录同步（`linapro-employee-core`）消费。

- SHALL 在`hcm/employee.go`中定义`HCMEmployee`，只映射同步所需字段：`EmployeeNo`（工号，员工目录稳定外部主键）、`Realname`（姓名，仅作展示）、`Department`/`DepartmentID`（部门名与部门 ID）、`EmployeeType`/`EmployeeTypeID`（员工类型）、`EmployeeStatus`/`EmployeeStatusID`（在职状态原文与状态 ID）、`Status`（归一化在职标志）、`OnBoardingDate`/`EndProbationDate`/`LeaveDate`（日期，格式`YYYY-MM-DD`）
- SHALL 在`*Client`上实现`ListEmployees(ctx context.Context, pageNum, pageSize int) (list []HCMEmployee, total int, err error)`：`pageSize`上限 200，返回 Moka 全量`total`；请求体为`{"pageSize": N, "pageNum": M}`
- SHALL 以签名查询参数`userName`传递操作人邮箱，取自`HCMCredential.OperatorEmail`；为空时不追加该参数
- SHALL 在`*Client`上实现`ListAllEmployees(ctx context.Context) ([]HCMEmployee, error)`：内部以`pageSize=200`循环翻页，累计数量达到`total`或某页为空时停止，调用方不感知分页
- SHALL 在`Status`映射时优先取`employee_status_id`（1=在职）；该字段为 0（缺失）时取`employee_status`文本（`"在职"`→1，其他→0）
- SHALL 只解码上述字段，Moka 返回的薪资、证件、银行卡等其余字段被丢弃，不进内存
- SHALL 在响应`code`非 200 时返回包含页码、code、msg 的 error；`data`为 null 时返回 nil 切片与`total=0`，不返回 error
- SHALL 维持 SDK 库模式，不新增 cap 层，消费方通过 go.mod`replace`直接 import

#### Scenario: 单页返回正确映射员工

- **WHEN** 调用`ListEmployees(ctx, 1, 200)`且 Moka 返回一页员工数据，含`employee_no`、`realname`、`department_id`、`employee_status_id=1`
- **THEN** 返回的`[]HCMEmployee`中每条记录正确映射各字段，`Status=1`，`total`为 Moka 返回的全量总数，error 为 nil

#### Scenario: 多页翻页直至拉完全量

- **WHEN** Moka 全量员工大于单页（如 total=450），调用`ListAllEmployees(ctx)`
- **THEN** 内部以 pageSize=200 循环翻页，返回全量员工切片，调用方不感知分页，error 为 nil

#### Scenario: employee_status_id 优先于文本字段

- **WHEN** 同一员工返回中同时存在`employee_status_id=1`与`employee_status="离职"`
- **THEN** `Status`取`employee_status_id`得出`1`，文本字段被忽略

#### Scenario: 无 id 时回退文本映射

- **WHEN** 返回中无`employee_status_id`，仅`employee_status="在职"`
- **THEN** `Status`由文本映射得出`1`

#### Scenario: 操作人邮箱作为签名参数

- **WHEN** `HCMCredential.OperatorEmail`非空，调用`ListEmployees`
- **THEN** 请求 URL 的查询参数含`userName=<OperatorEmail>`，并与其他签名参数一同参与签名

#### Scenario: 不引入 cap 层维持 SDK 库模式

- **WHEN** 消费方（如`linapro-employee-core`）需要员工列表数据
- **THEN** 通过 go.mod`replace`直接 import`hcm.Client`，不经过任何新增 cap/中间抽象层

### Requirement: 包结构扩展约定

`hcm/`包 SHALL 遵循以下文件组织约定，以支持后续 HCM 接口的有序扩展：

- `author.go`：`Author`接口、`HCMCredential`、`HCMAuth`、`BuildQuery`
- `sign.go`：`CanonicalString`、`Sign`、`Verify`、`ParsePrivateKey`、`BasicAuthHeader`
- `client.go`：`Client`、`NewClient`、`PostJSON`
- `report.go`：`GetReportData`及相关响应类型、`APICodeKeyReportData`
- `employee.go`：`HCMEmployee`、`ListEmployees`、`ListAllEmployees`、`APICodeKeyBatchData`
- 后续每类 HCM API 域新增独立文件（如`org.go`、`salary.go`），方法挂载在`*Client`上，`apiCode`键以常量形式定义并被消费方填入`HCMCredential.APICodes`

#### Scenario: 新增 API 文件不破坏现有功能

- **WHEN** 在`hcm/`下新增文件并在`*Client`上添加方法
- **THEN** `go build ./...`通过，现有`GetReportData`/`ListEmployees`行为不变

### Requirement: 共享库模块边界

系统 SHALL 提供独立 Go module `linapro-moka-hcm`（位于`apps/lina-plugins/linapro-moka-hcm/`），承载 Moka HCM OpenAPI 客户端，供插件通过 go.mod`require`+`replace`复用。该模块 SHALL NOT 含`plugin.yaml`，不作为可加载插件参与构建发现与治理扫描。该模块的 module 名 SHALL NOT 以`lina-plugin-`前缀命名，避免治理规则按 module 名前缀把共享库误识别为插件 owner。该模块 SHALL NOT 注册任何宿主资源（路由、后台任务、能力、数据表），其唯一对`lina-core`的依赖为`pkg/logger`。

#### Scenario: 库模块不被当作插件

- **WHEN** 执行插件构建发现（glob`apps/lina-plugins/*/plugin.yaml`）或治理扫描（按`plugin.yaml`是否存在过滤）
- **THEN** `linapro-moka-hcm`因无`plugin.yaml`被跳过，不产生插件构建产物，也不触发插件治理检查

#### Scenario: 库模块不触发跨插件 import 边界检查

- **WHEN** 消费方插件 import 共享库（`linapro-moka-hcm/hcm`），且治理规则按 module 名`lina-plugin-`前缀兜底识别插件 owner
- **THEN** 因共享库 module 名无`lina-plugin-`前缀，消费方的 import 不产生`PluginPackageBoundary`finding

#### Scenario: 消费方自行读取配置

- **WHEN** 消费方需要构造`Client`
- **THEN** 由消费方从自己的运行期配置读取`api_key`、`ent_code`、`private_key_pem`、`operator_email`及各接口的`apiCode`，本库不读配置、不持有配置来源、不落库保存凭据

