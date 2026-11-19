## ADDED Requirements

### Requirement: 人员字段按姓名来源解析
系统 SHALL 支持在映射上声明`personFieldNameSources`（`Bitable 人员字段名 → Moka 报表姓名列名`），把只提供姓名的报表列写入 Bitable 人员字段。姓名来源列的值 SHALL 先解析为工号，再进入既有「工号 → open_id」解析链路；`Plan`、集合判等与写侧 SHALL 保持不变，全链路 open_id 解析仍只发生一次。

姓名匹配 SHALL 只去首尾空白后按原值精确匹配，且只认在职员工；同一自然人跨租户的多行 SHALL 按「工号非空用工号、否则用 EmpID」去重视为一人。去重后恰好一名在职员工且有工号时 SHALL 取其工号；否则该单元格 SHALL 留空跳过，不纳入 diff、不写入，并记录 warn。一个单元格 SHALL 只按一个姓名处理，不做多姓名拆分。

每个映射每轮 SHALL 只发起一次按姓名的批量查询，查询次数与报表行数无关。员工能力未绑定或批量查询失败时，姓名来源列 SHALL 本轮跳过并记 warn，不阻断该映射其余列与其他映射的同步。

同一人员字段同时出现在`personFieldEmpNoSources`与`personFieldNameSources`时，系统 SHALL 以工号来源为准，并记录 warn。

#### Scenario: 姓名唯一匹配在职员工
- **WHEN** 某映射声明`personFieldNameSources: {"面谈人 1": "面谈人 1"}`，某行`面谈人 1=张三`，员工目录中恰好一名在职员工叫张三、工号`A001`
- **THEN** 该人员字段按工号`A001`解析出 open_id 集合参与判等与写入

#### Scenario: 同一自然人跨租户多行
- **WHEN** 姓名命中两行在职员工，二者工号相同
- **THEN** 视为同一人，按该工号解析，不判为重名

#### Scenario: 只匹配到离职员工
- **WHEN** 姓名只命中离职员工，或员工目录中不存在该姓名
- **THEN** 该单元格留空跳过，不触发更新，并记录 warn

#### Scenario: 来源冲突时工号优先
- **WHEN** 同一人员字段同时出现在`personFieldEmpNoSources`与`personFieldNameSources`
- **THEN** 系统按工号来源解析该字段，忽略姓名来源，并记录 warn

### Requirement: 人员姓名重名告警
姓名来源列中，同一姓名去重后命中多名在职员工时，系统 SHALL 不猜测其一：该单元格 SHALL 留空跳过，并在本轮同步结束时向运维告警通道推送告警。告警 SHALL 经共享库`larkalert`发送，配置键为`plugin.linapro-moka-report-sync.alert`；未配置时 SHALL 只记日志、不推送。一轮同步内所有映射的重名姓名 SHALL 汇总为一条告警，按映射分组列出姓名，避免同类告警被防抖窗口吞掉。告警发送失败 SHALL 只记日志，不影响同步结果。

#### Scenario: 重名跳过并告警
- **WHEN** 某行姓名来源列为`李四`，员工目录中有两名不同工号的在职员工叫李四
- **THEN** 该单元格留空跳过，本轮同步结束时推送一条告警，正文包含该映射标识与姓名`李四`

#### Scenario: 多个映射的重名汇总为一条
- **WHEN** 同一轮中两个映射各有重名姓名
- **THEN** 系统只推送一条告警，正文按映射分组列出两组姓名

#### Scenario: 告警通道未配置
- **WHEN** 未配置`plugin.linapro-moka-report-sync.alert`
- **THEN** 重名仍被跳过并记 warn，不推送告警，同步照常完成

## MODIFIED Requirements

### Requirement: 配置分层
Moka 凭证（apiKey/apiCode/entCode/rsaPrivateKey/baseURL）与飞书凭证（appId/appSecret）SHALL 来自`services.HostConfig`静态配置；报表映射列表 SHALL 来自`HostConfig.SysConfig()`的`reportMappings`键（JSON 数组），支持运营态增删。映射配置 SHALL 使用`uniqueFields`表达主键，不再提供单列`uniqueField`字段。

#### Scenario: 映射配置 JSON 结构
每条映射含：`reportId`（int64）、`appToken`（string）、`tableId`（string）、`uniqueFields`（string 数组，缺省`["工号"]`）、`keySeparator`（string，缺省见默认值）、`derivedColumns`（可选，列派生规则数组）、`skipIf`（可选，行过滤规则数组，每项含`kind`/`source`/`format`/`value`）、`personFieldEmpNoSources`（可选，`Bitable 人员字段名 → Moka 工号列名`）、`personFieldNameSources`（可选，`Bitable 人员字段名 → Moka 姓名列名`）、`remark`（string，仅用于日志辨识）、`enable`（bool，必须显式`true`才同步）、`source`（`hcm`默认或`recruit`）。

#### Scenario: 缺省归一
- **WHEN** 某条映射未提供`uniqueFields`或提供空数组
- **THEN** 归一为`["工号"]`；未提供`keySeparator`时归一为默认分隔符；未提供`skipIf`时不做行过滤

### Requirement: 人员列按 open_id 集合比对
系统在字段级 diff 中对「人员类型列」（Bitable 字段类型为人员/成员）SHALL 按 open_id 集合比对，而非按文本比对。Moka 侧人员列值为工号（多个工号以逗号拼接），或由姓名来源解析得到的工号（见「人员字段按姓名来源解析」）；规划阶段 SHALL 将其解析为期望写入的 open_id 集合；Bitable 回读侧人员单元格提供结构化 open_id 集合。两侧集合 SHALL 去重、顺序无关地比较：等价 SHALL 冻结（不更新），不等价 SHALL 纳入更新并以**已解析的 open_id 集合**写入写入操作的`Persons`旁路（列名 → open_id 集合），人员列 SHALL NOT 进入普通文本字段集合。人员列比对 SHALL NOT 依赖姓名文本——姓名是不稳定展示名（同名、改名、双租户同人多身份都会漂移），按姓名比对会把同一人误判为变更而每轮空转重写。工号无法解析出 open_id、或人员列既未声明工号来源也未声明姓名来源时该列留空跳过，不参与比对与写入。

身份解析 SHALL 在全链路只发生一次：规划阶段解析出的 open_id 集合既用于与回读集合判等，也直接作为待写入值交共享库序列化，写侧 SHALL NOT 再按工号二次解析。工号→open_id 的解析（含多工号合并与去重）SHALL 由 employee-core 的人员 id 解析契约提供，本插件只做逗号拆分这一层输入格式归一。

#### Scenario: 集合等价冻结
- **WHEN** 某人员列 Moka 工号解析出的 open_id 集合与 Bitable 回读该列的 open_id 集合等价
- **THEN** 该列不纳入 diff；若该行其它交集列亦无差异则冻结，不再每轮重写

#### Scenario: 集合不等重写
- **WHEN** 某人员列 Moka 工号解析出的 open_id 集合与回读集合不等价（换人、离职复入 open_id 漂移等）
- **THEN** 该列纳入更新，且更新操作携带的是**已解析的 open_id 集合**（经`Persons`旁路），而非 Moka 工号原值

#### Scenario: 顺序与重复不影响判等
- **WHEN** 两侧 open_id 集合成员相同但顺序不同，或存在重复 id（双租户同人多身份）
- **THEN** 去重、顺序无关比较后判为等价，不触发更新

#### Scenario: 多工号人员单元格
- **WHEN** 某人员列值为逗号拼接的多个工号
- **THEN** 系统按逗号拆分为工号列表后交 employee-core 解析，合并结果按出现顺序去重为一组 open_id 写入同一人员单元格

#### Scenario: 工号不可解析跳过
- **WHEN** 某人员列工号为空、既未声明工号来源列也未声明姓名来源列、或解析器解析不到 open_id
- **THEN** 该列留空跳过，不纳入 diff，不因人员列触发更新

### Requirement: pivot 形态的配置与降级
pivot 映射 SHALL 同时声明`pivotHeaderColumn`（源列名）与`pivotIndexColumn`（输出索引列名）；`pivotIndexColumn` SHALL NOT 回退到`pivotHeaderColumn`。任一未声明、或源报表中不存在`pivotHeaderColumn`列时，系统 SHALL 记录 warn 并跳过该映射本轮同步，不影响其他映射。pivot 形态下 SHALL 不支持`derivedColumns`、`personFieldEmpNoSources`与`personFieldNameSources`；若同时出现，系统 SHALL 忽略这些项并记录 warn。

#### Scenario: 缺少 pivotHeaderColumn 或 pivotIndexColumn 跳过
- **WHEN** 某映射`shape: "pivot"`但未声明`pivotHeaderColumn`或`pivotIndexColumn`（或源报表无`pivotHeaderColumn`列）
- **THEN** 系统记录 warn 并跳过该映射本轮同步，其他映射照常执行

#### Scenario: pivot 下忽略不支持的选项
- **WHEN** pivot 映射同时声明了`derivedColumns`、`personFieldEmpNoSources`或`personFieldNameSources`
- **THEN** 系统忽略这些项、记录 warn，转置与写入照常进行
