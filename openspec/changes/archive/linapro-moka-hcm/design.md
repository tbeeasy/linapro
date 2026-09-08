# Design

## Context

Moka HCM OpenAPI 使用 Basic Auth + MD5withRSA 查询参数签名，适用于非隐私数据端点（如报表、员工花名册）。随着 HCM 接口持续增加（组织架构、员工档案、薪酬、员工列表等），需要一个专属模块承载并独立演进，避免与其他认证体系的依赖相互污染。员工目录同步（`linapro-employee-core`）需要从 Moka 拉取全量员工花名册，本设计在现有 SDK 上补充员工列表接口，不引入新的抽象层。

## Goals / Non-Goals

**Goals**
- 独立插件 `lina-plugin-linapro-moka-hcm`，将 HCMAuth、签名工具、HTTP Client、`GetReportData` 提取到 `backend/hcm/` 包。
- 通过配置服务读取凭证，对外暴露 `*hcm.Client` 供依赖插件使用。
- 包结构为后续 HCM 接口扩展预留清晰插槽。
- 在 `hcm.Client` 上新增 `ListEmployees(ctx, pageNum, pageSize)` 和 `ListAllEmployees(ctx)` 两个方法，供员工目录同步消费。
- 复用现有 `Auther` + `sign.go`，零重复认证逻辑。
- 返回类型只包含员工目录同步所需字段（工号、姓名、部门ID、在职状态），不把 Moka 返回的所有字段暴露出来。

**Non-Goals**
- 实现 OAuth2 / OpenPlatform 功能。
- 新建 cap/hcmcap 层——维持 SDK 库模式，消费方 replace import。
- 处理员工详情、薪资、附件等与同步无关的字段。

## Decisions

1. **包名用 `hcm` 而非 `moka`**：`moka` 是品牌名，`hcm` 明确表达这是 Moka 人事系统客户端，与未来可能的 OpenPlatform 客户端（`backend/open/`）形成自然对称。文件级可保留 `moka_client.go` 等命名保留溯源。

2. **`Auther` 接口在 `hcm` 包内定义，不共享**：接口只有一个方法，复制成本极低；共享接口会引入额外模块依赖，增加版本管理复杂度。

3. **签名工具独立存在于本模块**：`BuildQuery`、`Sign`、`nonce` 与 Moka HCM 协议强绑定，不是通用工具；提取为共享包只增加模块数量，维护收益为负。

4. **插件通过配置服务暴露客户端工厂**：`OnStart` 读取 `api_key`/`api_code`/`ent_code`/`private_key_pem`，构造 `*hcm.Client` 注册到插件能力；下游通过能力依赖获取。原因：与现有 LinaPro 插件凭证管理模式一致，配置热更新后客户端可重建。

5. **每类 HCM API 域一个文件**：当前有 `report.go`、`employee.go`。后续每个 API 域新建文件，方法挂载在 `*Client` 上；命名约定即文档，便于定位。

6. **只映射同步所需的最小字段集**：Moka `/v2/batch/data` 返回字段极多（含银行卡、证件照等敏感字段）。`HCMEmployee` 结构体只映射 `employee_no`（工号，JOIN 主键）、`realname`（姓名，飞书 JOIN 键）、`department_id`（部门 ID，→ 内部租户映射）、`employee_status`（在职状态）。其余字段用 `json:"-"` 忽略，不进内存。

7. **ListAllEmployees 自动翻页，pageSize 固定 200**：Moka 接口最大 pageSize=200。`ListAllEmployees` 内部循环直到 `total <= (pageNum-1)*pageSize + len(list)`，调用方不感知翻页细节。

8. **不传 uuidList（拉全量）**：`uuidList: []` 即全量拉取，与接口文档一致。不支持按 uuid 筛选——那是另一个使用场景，不在本能力范围内。

## Risks / Trade-offs

- 私钥 PEM 存于插件配置 → 配置服务负责加密存储，本插件不承担密钥保护额外责任。
- Moka 返回字段随版本变化：只映射最小字段集，未映射字段变动不影响反序列化。
- `employee_status` 是文本而非 id：映射时按字符串 `"在职"` 判断；`employee_status_id=1` 也可兜底（两个字段都存在于返回示例中）。用 id 更稳健，实现时两个字段都取、id 优先。

## Migration Plan

创建模块目录与 `go.mod` → 实现 `backend/hcm/` 包（`auther.go`、`sign.go`、`client.go`、`report.go`、`employee.go`）→ 实现插件入口（`plugin.yaml`、`plugin_embed.go`、`backend/plugin.go`）→ `go.work` 注册 → `go build ./...` 构建验证。回滚：模块独立存在，删除目录即可完全回滚。
