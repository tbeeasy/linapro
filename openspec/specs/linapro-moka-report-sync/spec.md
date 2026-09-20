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
Moka 凭证（apiKey/apiCode/entCode/rsaPrivateKey/baseURL）与飞书凭证（appId/appSecret）SHALL 来自 `services.HostConfig` 静态配置；报表映射列表 SHALL 来自 `HostConfig.SysConfig()` 的 `reportMappings` 键（JSON 数组），支持运营态增删。映射配置 SHALL 使用 `uniqueFields` 表达主键，不再提供单列 `uniqueField` 字段。

#### Scenario: 映射配置 JSON 结构
每条映射含：`reportId`（int64）、`appToken`（string）、`tableId`（string）、`uniqueFields`（string 数组，缺省 `["工号"]`）、`keySeparator`（string，缺省见默认值）、`derivedColumns`（可选，列派生规则数组）、`skipIf`（可选，行过滤规则数组，每项含 `kind`/`source`/`format`/`value`）、`remark`（string，仅用于日志辨识）、`enable`（bool，必须显式 `true` 才同步）、`source`（`hcm` 默认或 `recruit`）。

#### Scenario: 缺省归一
- **WHEN** 某条映射未提供 `uniqueFields` 或提供空数组
- **THEN** 归一为 `["工号"]`；未提供 `keySeparator` 时归一为默认分隔符；未提供 `skipIf` 时不做行过滤

### Requirement: 列派生变换
系统 SHALL 在 `Plan` 之前、按固定顺序 `Flatten → 列派生 → 行过滤 → Coalesce → Normalize → preparePersonFields → Plan` 执行「列派生」，把配置的 `derivedColumns` 规则作用于拍平后的报表行。每条规则 SHALL 声明 `kind`（派生类型）、`sources`（源列名）、`targets`（目标列名）及类型相关参数；`kind` SHALL 从一个封闭的命名注册表解析（当前支持 `date`、`split`、`regex`），每个 `kind` 为纯函数。派生产出的目标列 SHALL 追加进列集合，从而参与后续「报表列 ∩ Bitable 字段」交集与键计算。源值解析或匹配失败时对应目标列 SHALL 留空跳过，不写脏值。目标列 SHALL 与其它列一样按 Bitable 字段类型归一（回读对称），避免误判差异反复重写。行过滤 SHALL 在列派生之后、`Coalesce` 之前执行，使过滤规则可引用派生列，且被过滤的行不进入后续合并、归一与规划步骤。

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

#### Scenario: 行过滤排在派生之后合并之前
- **WHEN** 某映射同时配置 `derivedColumns` 与 `skipIf`
- **THEN** 派生先执行、过滤随后执行，被丢弃的行不计入 `CoalesceRows` 的冲突上报，也不进入 `Normalize` 与 `Plan`

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

### Requirement: 转置（pivot）同步形态
系统 SHALL 支持在单条报表映射上声明 `shape: "pivot"` 形态；未声明或声明 `"flat"` 时行为与既有扁平 upsert 完全一致（缺省 `flat`，向后兼容）。pivot 形态下系统 SHALL 通过映射的 `pivotHeaderColumn` 指定「其行值转为目标列头」的**源列**，通过 `pivotIndexColumn` 指定「转置后承载指标名」的**输出索引列名**（须与目标表指标标签列同名）；二者解耦、常不同名。系统 SHALL 把「行值为 `pivotHeaderColumn` 取值、列为各指标」的报表转置为「行为各指标、列为各行值」的目标形态，指标名写入 `pivotIndexColumn` 列，并复用既有唯一键 upsert 写入 Bitable。

#### Scenario: 声明 pivot 形态并转置
- **WHEN** 某映射 `shape: "pivot"`、`pivotHeaderColumn: "公共日期"`、`pivotIndexColumn: "招聘漏斗图"`，源报表拉平后为两行 `{公共日期:2026-01, 简历收集数:50, 入职人数:8}`、`{公共日期:2026-02, 简历收集数:60, 入职人数:3}`
- **THEN** 系统转置为按指标分行 `{招聘漏斗图:简历收集数, 2026-01:50, 2026-02:60}`、`{招聘漏斗图:入职人数, 2026-01:8, 2026-02:3}`，并以 `招聘漏斗图`（指标名）为唯一键写入目标表

#### Scenario: 源列名与输出索引列名解耦
- **WHEN** pivot 映射的 `pivotHeaderColumn`（如 `公共日期`）与 `pivotIndexColumn`（如 `招聘漏斗图`）不同名
- **THEN** 转置输出的首列名为 `pivotIndexColumn`，源列 `pivotHeaderColumn` 不出现在输出行；指标名写入 `pivotIndexColumn` 字段以与目标表标签列对齐

#### Scenario: 缺省形态保持扁平
- **WHEN** 某映射未声明 `shape`（或声明 `"flat"`）
- **THEN** 系统走既有「报表一行 = Bitable 一行」的扁平 upsert 路径，行为不变

#### Scenario: 全部非表头列转为指标
- **WHEN** pivot 映射的源报表除 `pivotHeaderColumn` 外含 8 个指标列
- **THEN** 系统为这 8 个指标各生成一行，指标顺序、目标列（各行值）顺序按源报表出现顺序稳定

### Requirement: 转置的唯一键 upsert
pivot 形态下系统 SHALL 以 `pivotIndexColumn`（承载指标名、与目标表标签列同名）为唯一键，把转置产出的指标行与目标 Bitable 记录对齐，复用既有「交集列完整性门闩」进行新增/重写/冻结判定与批量写入。

#### Scenario: 指标行新增
- **WHEN** 某指标名在目标表中不存在
- **THEN** 系统新增整行（写唯一键指标名列 + 各月份交集列）

#### Scenario: 指标行幂等冻结
- **WHEN** 同一份 pivot 报表连续两轮同步且期间无变化
- **THEN** 第二轮所有指标行落入冻结分支，无写入

### Requirement: 汇总列不写入不触碰
pivot 形态下系统 SHALL 只写入「唯一键指标名列 + 转置产出的各行值列（月份列）」；对目标表中存在但本轮报表未声明的列（如由 Bitable 公式自算的 `年度` 汇总列）SHALL 保持原样，不写入、不清空、不纳入完整性判断（复用既有「忽略表外列」语义）。

#### Scenario: 公式汇总列被忽略
- **WHEN** 目标表含 `年度` 公式列，pivot 报表未产出 `年度` 列
- **THEN** `年度` 列不参与完整性判断、不被写入或清空，其公式值由 Bitable 自行维护

### Requirement: 目标月份列由运营预建
pivot 形态下系统 SHALL 只填充目标表已存在的月份列的值，不创建列。目标表缺少某个月份列时，该列的值 SHALL 被写入侧忽略且不阻断本轮同步，并记录可诊断日志。

#### Scenario: 月份列缺失被忽略
- **WHEN** 源报表出现 `2026-07` 行值，但目标表未预建 `2026-07` 列
- **THEN** `2026-07` 的值被忽略、本轮其余月份列正常写入，系统记录一条 warn 便于运营补建列

### Requirement: pivot 形态的配置与降级
pivot 映射 SHALL 同时声明 `pivotHeaderColumn`（源列名）与 `pivotIndexColumn`（输出索引列名）；`pivotIndexColumn` SHALL NOT 回退到 `pivotHeaderColumn`。任一未声明、或源报表中不存在 `pivotHeaderColumn` 列时，系统 SHALL 记录 warn 并跳过该映射本轮同步，不影响其他映射。pivot 形态下 SHALL 不支持 `derivedColumns` 与 `personFieldSources`；若同时出现，系统 SHALL 忽略这两项并记录 warn。

#### Scenario: 缺少 pivotHeaderColumn 或 pivotIndexColumn 跳过
- **WHEN** 某映射 `shape: "pivot"` 但未声明 `pivotHeaderColumn` 或 `pivotIndexColumn`（或源报表无 `pivotHeaderColumn` 列）
- **THEN** 系统记录 warn 并跳过该映射本轮同步，其他映射照常执行

#### Scenario: pivot 下忽略不支持的选项
- **WHEN** pivot 映射同时声明了 `derivedColumns` 或 `personFieldSources`
- **THEN** 系统忽略这两项、记录 warn，转置与写入照常进行

### Requirement: 行过滤（skipIf）
系统 SHALL 支持在映射级别声明「行过滤」规则，把不满足条件的报表行在进入规划前丢弃。每条规则 SHALL 声明 `kind`（比较类型）、`source`（源列名）、`format`（源列与阈值的解析格式）与 `value`（阈值字面量）。`kind` SHALL 从一个封闭的命名注册表解析（当前支持 `before`），每个 `kind` 为纯函数；新增比较方向只需注册一个纯函数，管线主体不变。阈值 SHALL 为固定字面量，不支持相对当前时间的动态偏移。

规则 SHALL 只作用于声明该规则的映射，不影响其它映射。未配置 `skipIf` 的映射同步结果 SHALL 与未引入该能力时完全一致。

#### Scenario: 早于阈值的行被跳过
- **WHEN** 规则 `{kind:before, source:申请时间, format:"Y-m", value:"2026-01"}`、某行 `申请时间=2025-12`
- **THEN** 该行被丢弃，不进入 `Coalesce`/`Normalize`/`Plan`，不计入新增、重写、冻结或无键跳过

#### Scenario: 不早于阈值的行保留
- **WHEN** 同一规则下某行 `申请时间=2026-01` 或 `2026-03`
- **THEN** 该行保留并正常参与后续同步

#### Scenario: 未配置规则时行为不变
- **WHEN** 某条映射未提供 `skipIf`（或提供空数组）
- **THEN** 该映射不做任何行过滤，同步结果与未引入该能力时一致

#### Scenario: 规则可引用派生列
- **WHEN** `derivedColumns` 先派生出 `招聘月份`（`format` 与规则一致），且规则 `source` 指向该派生列
- **THEN** 过滤发生在列派生之后，规则能取到派生列值参与判定

#### Scenario: 多条规则
- **WHEN** 某映射声明多条 `skipIf` 规则
- **THEN** 任一条规则判定为跳过时该行即被丢弃

### Requirement: 行过滤的解析与失败语义
系统 SHALL 把规则 `source` 列的单元格值与 `value` 阈值都按 `format` 解析为时间戳后比较，不采用字符串比较。`format` SHALL 使用 GoFrame `gtime` 方言（`Y`=年、`m`=月、`d`=日），配置侧不出现 Go 参考时间布局。解析出的时间 SHALL 按东八区锚定，保证同一份配置在不同部署时区下产出相同的时间戳。

源列值为空、或源列值与阈值中任一解析失败时，该规则 SHALL 判定为「无法判定」，对应行 SHALL 保留并进入后续同步，同时记 warn。

#### Scenario: 解析为时间戳后比较
- **WHEN** 规则 `{kind:before, source:申请时间, format:"Y-m", value:"2026-01"}`、某行 `申请时间=2025-12`
- **THEN** 两侧按 `Y-m` 解析为时间戳后比较，判定该行早于阈值

#### Scenario: 阈值格式非法
- **WHEN** `value` 无法按 `format` 解析
- **THEN** 该规则对每一行都判定为「无法判定」，不丢弃任何行，并记 warn 标明规则与原因

#### Scenario: 源值解析失败保留该行
- **WHEN** 某行 `source` 列值无法按 `format` 解析
- **THEN** 该行 SHALL 保留（不跳过）进入后续同步，并记 warn

#### Scenario: 源值或阈值为空
- **WHEN** 某行 `source` 列值为空，或 `value` 为空
- **THEN** 该行 SHALL 保留（不跳过），并记 warn

#### Scenario: 跨时区锚定一致
- **WHEN** 同一份规则与同一份输入在进程本地时区不同的两个环境中执行
- **THEN** 两侧比较结果一致，被丢弃的行集合相同

### Requirement: 转置形态不支持行过滤
转置形态（`shape: pivot`）SHALL NOT 应用 `skipIf` 规则。配置了 `skipIf` 的 pivot 映射 SHALL 忽略该配置并记 warn，本轮同步照常执行，不因该配置失败。

#### Scenario: pivot 映射配置 skipIf
- **WHEN** 某映射 `shape=pivot` 且提供了非空 `skipIf`
- **THEN** 该映射忽略 `skipIf`，记 warn 说明 pivot 形态不支持行过滤，同步照常进行

