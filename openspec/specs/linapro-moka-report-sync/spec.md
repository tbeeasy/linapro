# linapro-moka-report-sync Specification

## Purpose
TBD - created by archiving change linapro-moka-report-sync. Update Purpose after archive.
## Requirements
### Requirement: 定时拉取报表
系统 SHALL 每 5 分钟（可配置，`intervalMinutes`）遍历「报表映射列表」，对每条 `enable: true` 的映射调用 `GetReportData(reportId)` 拉取报表数据。循环维度是报表映射，不是租户；认证一套复用。

#### Scenario: 遍历映射
- **WHEN** 定时器触发且映射列表含 2 条（不同 reportId + appToken + tableId，均 enable: true）
- **THEN** 系统对 2 条映射各拉取一次并各自写入对应 Bitable 表，复用同一套 Moka Client

#### Scenario: 禁用的映射跳过
- **WHEN** 某条映射 `enable: false`（或省略 enable 字段）
- **THEN** 该映射本轮被跳过，不拉取也不写入

### Requirement: 成功判定
系统 SHALL 仅在响应 `code == 200` 时处理 `data.headers` 与 `data.rows`；非 200 时记录 `msg` 并跳过本轮该报表，不写 Bitable。

#### Scenario: 非成功码跳过
- **WHEN** `GetReportData` 返回 error（底层 code != 200）
- **THEN** 系统记录错误日志并跳过该报表本轮同步，不产生任何 Bitable 写入

### Requirement: 表头到字段映射
系统 SHALL 用 `data.headers[].title` 作为 Bitable 字段名、`data.headers[].dataIndex`（`c_$`）从 `rows` 取值，平铺为 `map[string]string`（`FlattenReport`）。本需求不含多级表头。

#### Scenario: 平铺表头映射
- **WHEN** headers 为 `[{dataIndex:c_1,title:性别},{dataIndex:c_2,title:民族}]`、某 row 为 `{c_1:男性,c_2:汉族}`
- **THEN** 该行映射为字段 `性别=男性`、`民族=汉族`

### Requirement: 主键对齐
系统 SHALL 以 `uniqueField`（默认 `工号`）为主键，将 Moka 报表行与目标 Bitable 表已有记录对齐。主键值在数据源中唯一。

#### Scenario: 建立主键索引
- **WHEN** 读取目标 Bitable 表全部记录
- **THEN** 系统建立 `{uniqueField值: record}` 映射用于比对

### Requirement: 交集列完整性门闩
对每个 Moka 报表行：无同名记录 SHALL 新增整行；有同名记录且「Moka 报表列 ∩ Bitable 表字段」交集内存在空字段 SHALL 用 Moka 最新值覆盖更新整条；交集内无空字段 SHALL 跳过（冻结）。完整性判断 SHALL 仅针对交集列，不涉及 Bitable 表中报表未声明的其他列。Bitable 字段列表 SHALL 通过字段 API 获取（权威 schema），不依赖现有记录值。

#### Scenario: 新增
- **WHEN** 报表行 uniqueField 值在 Bitable 中不存在
- **THEN** 新增整行（仅写交集列）

#### Scenario: 重写
- **WHEN** 报表行 uniqueField 值存在，且交集列中至少一个字段为空
- **THEN** 用 Moka 最新值覆盖更新整条记录（写交集列全部值）

#### Scenario: 冻结
- **WHEN** 报表行 uniqueField 值存在，且交集列全部非空
- **THEN** 跳过，不更新

#### Scenario: 忽略表外列
- **WHEN** Bitable 表存在报表未声明的手工列且为空
- **THEN** 该列不参与完整性判断，不触发重写

#### Scenario: 无 uniqueField 值的行跳过
- **WHEN** 某报表行的 uniqueField 列值为空字符串
- **THEN** 该行计入 SkippedNoName，不新增也不更新

### Requirement: 批量写入与限流
写入 SHALL 使用飞书 batch_create / batch_update，批次 ≤1000 行/次；在 50 次/秒限制内节流。写 token（appId/appSecret）一套共用；每条映射用自身 `appToken + tableId` 定位目标表。

#### Scenario: 分拨批量提交
- **WHEN** 一轮同步产生待新增与待重写两拨记录
- **THEN** 各按 ≤1000 行分批调用 batch_create / batch_update，批次间节流不超限

### Requirement: 无状态幂等
同步 SHALL 不依赖本地数据库表存储进度；Bitable 自身为「哪些行已完成」的真相源。重复运行同一轮 SHALL 幂等（相同输入不产生额外变更）。

#### Scenario: 重复运行幂等
- **WHEN** 同一份报表数据连续两轮同步且期间无变化
- **THEN** 第二轮所有行落入冻结分支，无写入

### Requirement: 配置分层
Moka 凭证（apiKey/apiCode/entCode/rsaPrivateKey/baseURL）与飞书凭证（appId/appSecret）SHALL 来自 `services.HostConfig` 静态配置，键前缀 `plugin.linapro-moka-hcm.`；报表映射列表 SHALL 来自 `HostConfig.SysConfig()` 键 `plugin.linapro-moka-hcm.reportMappings`（JSON 数组），支持运营态增删。

#### Scenario: 映射配置 JSON 结构
每条映射含：`reportId`（int64）、`appToken`（string）、`tableId`（string）、`uniqueField`（string，默认 `工号`）、`remark`（string，仅用于日志辨识）、`enable`（bool，必须显式 `true` 才同步）。

