# linapro-moka-report-sync Specification (Delta)

## MODIFIED Requirements

### Requirement: 主键对齐
系统 SHALL 以 `uniqueFields`（列名列表，默认 `["工号"]`）配合 `keySeparator` 组成复合主键，通过 `KeySpec.KeyOf(row)` 将 Moka 报表行与目标 Bitable 表已有记录对齐。`KeyOf` SHALL 按 `uniqueFields` 声明顺序取各列值、逐列去首尾空白后用 `keySeparator` 拼接；任一组成列值为空时该行视为无键。复合主键 SHALL 仅用于匹配已有记录，不作为字段写入 Bitable（不需要物理合并列）。报表侧与 Bitable 侧 SHALL 使用同一个 `KeyOf` 计算键，保证两侧对齐。

#### Scenario: 单列键
- **WHEN** `uniqueFields` 为 `["工号"]`、某行 `工号=A001`
- **THEN** 该行匹配键为 `A001`

#### Scenario: 复合键拼接
- **WHEN** `uniqueFields` 为 `["工号","考勤月"]`、`keySeparator` 为 `-`、某行 `工号=A001`、`考勤月=2026-09`
- **THEN** 该行匹配键为 `A001-2026-09`，且报表侧与读取 Bitable 记录时用同一规则建键

#### Scenario: 建立主键索引
- **WHEN** 读取目标 Bitable 表全部记录
- **THEN** 系统以 `KeyOf(记录)` 为键建立 `{键: record}` 映射用于比对；`KeyOf` 返回空串的记录跳过

### Requirement: 交集列完整性门闩
对每个 Moka 报表行：`KeyOf(行)` 为空 SHALL 跳过（计入 SkippedNoName）；无同键记录 SHALL 新增整行；有同键记录且「Moka 报表列 ∩ Bitable 表字段」交集内存在空字段 SHALL 用 Moka 最新值覆盖更新整条；交集内无空字段 SHALL 跳过（冻结）。完整性判断 SHALL 仅针对交集列，不涉及 Bitable 表中报表未声明的其他列。字段级 diff SHALL 跳过键组成列（`uniqueFields` 内各列），因其在匹配成功的记录中天然相等。Bitable 字段列表 SHALL 通过字段 API 获取（权威 schema），不依赖现有记录值。

#### Scenario: 新增
- **WHEN** 报表行 `KeyOf` 值在 Bitable 中不存在
- **THEN** 新增整行（仅写交集列）

#### Scenario: 重写
- **WHEN** 报表行 `KeyOf` 值存在，且交集列中至少一个字段为空
- **THEN** 用 Moka 最新值覆盖更新整条记录（写交集列全部值）

#### Scenario: 冻结
- **WHEN** 报表行 `KeyOf` 值存在，且交集列全部非空
- **THEN** 跳过，不更新

#### Scenario: 忽略表外列
- **WHEN** Bitable 表存在报表未声明的手工列且为空
- **THEN** 该列不参与完整性判断，不触发重写

#### Scenario: 无键的行跳过
- **WHEN** 某报表行 `KeyOf` 返回空串（任一键组成列值为空）
- **THEN** 该行计入 SkippedNoName，不新增也不更新

### Requirement: 配置分层
Moka 凭证（apiKey/apiCode/entCode/rsaPrivateKey/baseURL）与飞书凭证（appId/appSecret）SHALL 来自 `services.HostConfig` 静态配置；报表映射列表 SHALL 来自 `HostConfig.SysConfig()` 的 `reportMappings` 键（JSON 数组），支持运营态增删。映射配置 SHALL 使用 `uniqueFields` 表达主键，不再提供单列 `uniqueField` 字段。

#### Scenario: 映射配置 JSON 结构
每条映射含：`reportId`（int64）、`appToken`（string）、`tableId`（string）、`uniqueFields`（string 数组，缺省 `["工号"]`）、`keySeparator`（string，缺省见默认值）、`derivedColumns`（可选，列派生规则数组）、`remark`（string，仅用于日志辨识）、`enable`（bool，必须显式 `true` 才同步）、`source`（`hcm` 默认或 `recruit`）。

#### Scenario: 缺省归一
- **WHEN** 某条映射未提供 `uniqueFields` 或提供空数组
- **THEN** 归一为 `["工号"]`；未提供 `keySeparator` 时归一为默认分隔符

## ADDED Requirements

### Requirement: 列派生变换
系统 SHALL 在 `Plan` 之前、按固定顺序 `Flatten → 列派生 → Coalesce → Normalize → preparePersonFields → Plan` 执行「列派生」，把配置的 `derivedColumns` 规则作用于拍平后的报表行。每条规则 SHALL 声明 `kind`（派生类型）、`sources`（源列名）、`targets`（目标列名）及类型相关参数；`kind` SHALL 从一个封闭的命名注册表解析（当前支持 `date`、`split`、`regex`），每个 `kind` 为纯函数。派生产出的目标列 SHALL 追加进列集合，从而参与后续「报表列 ∩ Bitable 字段」交集与键计算。源值解析或匹配失败时对应目标列 SHALL 留空跳过，不写脏值。目标列 SHALL 与其它列一样按 Bitable 字段类型归一（回读对称），避免误判差异反复重写。

#### Scenario: date 派生年月
- **WHEN** 规则 `{kind:date, sources:[入职年月], targets:{年:"2006", 月:"01"}}`、某行 `入职年月=2026-09`（或 `2026/09`、`2026年09月`）
- **THEN** 该行新增列 `年=2026`、`月=09`，源分隔符差异不影响结果

#### Scenario: split 按分隔符拆分
- **WHEN** 规则 `{kind:split, sources:[部门路径], targets:[一级,二级], by:"/"}`、某行 `部门路径=研发/后端`
- **THEN** 该行新增列 `一级=研发`、`二级=后端`

#### Scenario: regex 捕获组
- **WHEN** 规则 `{kind:regex, sources:[编号], targets:[年,月], pattern:"(\\d{4})(\\d{2})"}`、某行 `编号=202609`
- **THEN** 该行新增列 `年=2026`、`月=09`

#### Scenario: 派生列参与复合键
- **WHEN** `derivedColumns` 先派生出 `年`、`月`，且 `uniqueFields` 含 `年`、`月`
- **THEN** 键计算发生在派生之后，`KeyOf` 能取到派生列值参与拼接

#### Scenario: 解析失败留空
- **WHEN** 某行源值无法被规则解析或匹配（如 `date` 源非日期）
- **THEN** 对应目标列留空，不写入脏值，该行其它列不受影响

### Requirement: 人员列按 open_id 集合比对
系统在字段级 diff 中对「人员类型列」（Bitable 字段类型为人员/成员）SHALL 按 open_id 集合比对，而非按文本比对。Moka 侧人员列值为工号（多个工号以逗号拼接），规划阶段 SHALL 将其解析为期望写入的 open_id 集合；Bitable 回读侧人员单元格提供结构化 open_id 集合。两侧集合 SHALL 去重、顺序无关地比较：等价 SHALL 冻结（不更新），不等价 SHALL 纳入更新并以**已解析的 open_id 集合**写入写入操作的 `Persons` 旁路（列名 → open_id 集合），人员列 SHALL NOT 进入普通文本字段集合。人员列比对 SHALL NOT 依赖姓名文本——姓名是不稳定展示名（同名、改名、双租户同人多身份都会漂移），按姓名比对会把同一人误判为变更而每轮空转重写。工号无法解析出 open_id、或人员列未声明工号来源时该列留空跳过，不参与比对与写入。

身份解析 SHALL 在全链路只发生一次：规划阶段解析出的 open_id 集合既用于与回读集合判等，也直接作为待写入值交共享库序列化，写侧 SHALL NOT 再按工号二次解析。工号→open_id 的解析（含多工号合并与去重）SHALL 由 employee-core 的人员 id 解析契约提供，本插件只做逗号拆分这一层输入格式归一。

#### Scenario: 集合等价冻结
- **WHEN** 某人员列 Moka 工号解析出的 open_id 集合与 Bitable 回读该列的 open_id 集合等价
- **THEN** 该列不纳入 diff；若该行其它交集列亦无差异则冻结，不再每轮重写

#### Scenario: 集合不等重写
- **WHEN** 某人员列 Moka 工号解析出的 open_id 集合与回读集合不等价（换人、离职复入 open_id 漂移等）
- **THEN** 该列纳入更新，且更新操作携带的是**已解析的 open_id 集合**（经 `Persons` 旁路），而非 Moka 工号原值

#### Scenario: 顺序与重复不影响判等
- **WHEN** 两侧 open_id 集合成员相同但顺序不同，或存在重复 id（双租户同人多身份）
- **THEN** 去重、顺序无关比较后判为等价，不触发更新

#### Scenario: 多工号人员单元格
- **WHEN** 某人员列值为逗号拼接的多个工号
- **THEN** 系统按逗号拆分为工号列表后交 employee-core 解析，合并结果按出现顺序去重为一组 open_id 写入同一人员单元格

#### Scenario: 工号不可解析跳过
- **WHEN** 某人员列工号为空、未声明工号来源列、或解析器解析不到 open_id
- **THEN** 该列留空跳过，不纳入 diff，不因人员列触发更新
