## ADDED Requirements

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

## MODIFIED Requirements

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
