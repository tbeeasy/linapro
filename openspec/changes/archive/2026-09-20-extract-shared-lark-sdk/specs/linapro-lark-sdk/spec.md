## ADDED Requirements

### Requirement: 共享库模块边界

系统 SHALL 提供独立 Go module `linapro-lark-sdk`（位于
`apps/lina-plugins/linapro-lark-sdk/`），承载飞书 SDK 二次封装，供插件通过 go.mod
require + replace 复用。该模块 SHALL NOT 含 `plugin.yaml`，不作为可加载插件参与
构建发现与治理扫描。该模块的 module 名 SHALL NOT 以 `lina-plugin-` 前缀命名，避免治理规则
按 module 名前缀把共享库误识别为插件 owner。飞书 SDK 依赖 SHALL NOT 引入 `lina-core`。

#### Scenario: 库模块不被当作插件

- **WHEN** 执行插件构建发现（glob `apps/lina-plugins/*/plugin.yaml`）或治理扫描
  （按 `plugin.yaml` 是否存在过滤）
- **THEN** `linapro-lark-sdk` 因无 `plugin.yaml` 被跳过，不产生插件构建产物，也不触发
  插件治理检查

#### Scenario: 库模块不触发跨插件 import 边界检查

- **WHEN** 消费方插件的生产 Go 代码 import 共享库（如 `linapro-lark-sdk/larkbitable`），
  且治理规则 `scanGoCrossPluginImports` 按 module 名 `lina-plugin-` 前缀兜底识别插件 owner
- **THEN** 因共享库 module 名无 `lina-plugin-` 前缀，`ownerPluginIDFromImport` 不将其识别为
  插件 owner，消费方的 import 不产生 `PluginPackageBoundary` finding

#### Scenario: 依赖边界

- **WHEN** 检查 `lina-core` 的 go.mod
- **THEN** 其中 SHALL NOT 出现 `github.com/larksuite/oapi-sdk-go/v3` 依赖；该依赖仅存在于
  共享库与引用它的插件模块中

### Requirement: Bitable 读取接口

共享库 SHALL 提供 Bitable 读取能力：`ListFields` 返回字段名到飞书字段类型 ID 的映射；
`ListRecords` 按调用方指定的 uniqueField 值为键返回记录，uniqueField 值为空的记录 SHALL
跳过；`ListRecordsByID` 按飞书 record_id 为键返回全部记录。列表读取 SHALL 自动分页（页大小
≤500），页间节流。

`ListRecords` 与 `ListRecordsByID` 返回的记录 SHALL 同时携带**人员列结构化旁路**：对每个
`TypeUser`（人员）列，除在文本投影中回读去重姓名串外，另按飞书官方人员对象结构解析出该单元格的
用户身份集合（含 open_id 等字段），供调用方对人员列做 open_id 集合比对而非姓名文本比对。人员列
的结构化旁路 SHALL 由两个读取接口共享同一解析逻辑，使按 uniqueField 读取与按 record_id 读取在
人员列回读语义上一致；无人员列时该旁路为空。

共享库 SHALL 另提供 `BatchGetByIDs`，按调用方给定的 record_id 列表精准读取记录，避免为拉取
少量目标行而全表扫描。`BatchGetByIDs` SHALL 调用飞书 `records/batch_get` 接口，按 ≤100 个
record_id 切批（飞书单次上限），批次间节流；返回以飞书 record_id 为键的命中行映射，以及飞书
中已不存在的 record_id 列表（`absent_record_ids`）。传入空列表时 SHALL 直接返回空结果、不发起
请求。读取失败（`resp.Success()` 为假）SHALL 返回含飞书 code/msg 的错误。

#### Scenario: 拉取字段 schema

- **WHEN** 调用 `ListFields` 且目标表字段跨多页
- **THEN** 系统翻遍所有页，返回完整的「字段名 → 字段类型 ID」映射

#### Scenario: 按主键读取记录

- **WHEN** 调用 `ListRecords` 且某记录的 uniqueField 单元格为空
- **THEN** 该记录不出现在返回的映射中；其余记录以 uniqueField 值为键返回

#### Scenario: 按 record_id 读取记录并回读人员列身份集合

- **WHEN** 调用 `ListRecordsByID` 且目标表含 `TypeUser` 人员列
- **THEN** 返回的每条记录除文本投影外，另在人员列旁路中携带该单元格解析出的用户身份集合
  （含 open_id），供调用方按 open_id 集合比对人员列

#### Scenario: 无人员列时旁路为空

- **WHEN** 调用 `ListRecordsByID` 且目标表不含任何 `TypeUser` 列
- **THEN** 返回记录的人员列旁路为空，文本投影不受影响

#### Scenario: 按 record_id 批量精准读取

- **WHEN** 调用 `BatchGetByIDs` 传入 250 个 record_id
- **THEN** 系统分 3 批（100+100+50）调用 `records/batch_get`，批次间节流，返回全部命中行以
  record_id 为键的映射

#### Scenario: 部分 record_id 已不存在

- **WHEN** 调用 `BatchGetByIDs`，其中若干 record_id 在飞书中已被删除
- **THEN** 返回的命中映射不含这些 record_id，且这些 record_id 出现在返回的 `absent_record_ids`
  列表中

#### Scenario: 空列表短路

- **WHEN** 调用 `BatchGetByIDs` 传入空 record_id 列表
- **THEN** 直接返回空命中映射与空 `absent_record_ids`，不发起任何飞书请求

### Requirement: Bitable 批量写入与限流

共享库 SHALL 提供 `BatchCreate` 与 `BatchUpdate`，按 ≤1000 行/批切块提交，批次间节流以
满足飞书 50 次/秒限制。`BatchCreate` SHALL 按输入顺序返回新建记录的 record_id。写入失败
（`resp.Success()` 为假）SHALL 返回含飞书 code/msg 的错误。

#### Scenario: 分批提交

- **WHEN** 调用 `BatchCreate` 传入 2500 行
- **THEN** 系统分 3 批（1000+1000+500）提交，批次间节流，返回全部 2500 个 record_id
  且顺序与输入一致

#### Scenario: 写入失败上报

- **WHEN** 飞书返回非成功码（如 `DatetimeFieldConvFail`）
- **THEN** 系统返回包含该 code 与 msg 的错误，不静默吞掉

### Requirement: 字段值编码

共享库写入前 SHALL 按目标字段的飞书类型对字符串值编码：`larkbitable.TypeNumber` 解析为
JSON 数字；`larkbitable.TypeDateTime` 解析为毫秒级 Unix 时间戳数字；其余类型按字符串写入。
字段类型判断 SHALL 使用 SDK 常量而非魔术数字。日期字段值为空或无法解析时 SHALL 跳过该列
（不写入），以避免整批因 `DatetimeFieldConvFail` 失败。

#### Scenario: 日期字段转毫秒时间戳

- **WHEN** 某列在目标表为 `TypeDateTime`，写入值为可识别的时间字符串
- **THEN** 系统将其编码为毫秒级 Unix 时间戳数字写入

#### Scenario: 空日期跳列

- **WHEN** 某 `TypeDateTime` 列的写入值为空串或无法解析
- **THEN** 系统跳过该列，不将其加入本行写入字段，避免触发 `DatetimeFieldConvFail`

#### Scenario: 数字字段转 JSON 数字

- **WHEN** 某列在目标表为 `TypeNumber`，写入值为可解析的数字字符串
- **THEN** 系统将其编码为 JSON 数字写入

### Requirement: 人员字段编码

共享库写入前 SHALL 对飞书人员字段类型（`larkbitablesdk.TypeUser`）的列做专门编码：从写入操作的
`Persons` 旁路（`CreateOp.Persons`/`UpdateOp.Persons`，列名 → 已解析的飞书用户 id 列表）取该列的
用户标识（**写表格应用作用域**的 open_id），编码为飞书人员字段要求的对象数组（每个元素含 `Id`）。
共享库 SHALL NOT 做任何身份解析（工号/姓名 → id）：解析是业务语义，由消费方在自身边界完成后经
`Persons` 旁路传入，因此 SDK 的形参语义与其承载的数据严格一致。id 集合为空时 SHALL 跳过该列
（不写入），与日期/数字/附件「无内容即跳列」一致，避免整批写入因人员字段失败。字段类型判断 SHALL
直接使用 SDK 常量 `larkbitablesdk.TypeUser`，不引入魔术数字，也不为此新增 `larkbitable` 包级类型别名导出。

`Row` 中出现的 `TypeUser` 列 SHALL 被忽略（记 error 级日志——人员字段只接受用户 id，`Row` 承载的是
普通文本，写入会被飞书整批拒绝），人员列的值只经 `Persons` 旁路写入。写侧识别符固定为
`user_id_type=open_id`；open_id 按（开发者应用）作用域签发——旁路传入的必须是写表格那个应用作用域的
id，不可跨应用混用。

#### Scenario: open_id 集合编码为人员对象数组

- **WHEN** 某列在目标表为 `TypeUser`，调用方经 `Persons` 旁路传入一个或多个**该应用作用域**的 open_id
- **THEN** 系统将该列编码为人员对象数组（每个 open_id 一个 `{Id}` 元素）写入；同一人有多个
  open_id（own + 关联组织视角、跨飞书租户同人）时全部写入，写侧 `user_id_type=open_id`

#### Scenario: 空集合跳列

- **WHEN** 某 `TypeUser` 列在 `Persons` 旁路中的 id 集合为空，或该列未出现在旁路中
- **THEN** 系统跳过该列，不将其加入本行写入字段，不阻断该行其余字段与整批写入

#### Scenario: Row 中的人员列裸值被忽略

- **WHEN** 调用方把某个 `TypeUser` 列的文本值（如工号、姓名）放进 `Row`，而非 `Persons` 旁路
- **THEN** 系统忽略该值并记 error 级日志，不发往飞书（人员字段不受纯文本，写入会整批失败）；
  该列的写入只认 `Persons` 旁路

### Requirement: 可注入的编码器扩展点

共享库 SHALL 支持通过可注入的 Encoder（日期解析、数字解析、单元格回读兜底三个可替换函数，
以及人员字段的 `UserIDType` 值）承载调用方差异化语义。共享库 SHALL 并列导出具名解析原语：
`ParseEpochMillisUTC`（ISO 按 UTC 解析，兼容秒/毫秒 epoch）、`ParseEpochMillisCST`（Moka 布局按
东八区墙上时间解析，兼容秒/毫秒 epoch）、`ParseNumberPlain`、`ParseNumberLoose`（容忍百分号与千分位）。
人员 id 的解析不在 Encoder 中，也无内置原语——它依赖调用方的业务数据源（如员工目录），由消费方在
自身边界解析后经 `CreateOp.Persons`/`UpdateOp.Persons` 旁路传入；`UserIDType` 只声明旁路传入 id 的
语义（写侧识别符）。未注入编码函数字段时 SHALL 使用默认组合（UTC 日期 + Plain 数字 + 通用单元格兜底）。

#### Scenario: 默认编码器

- **WHEN** 调用方以默认方式构造 Client 未注入 Encoder
- **THEN** 日期按 `ParseEpochMillisUTC`、数字按 `ParseNumberPlain` 编码

#### Scenario: 注入东八区语义

- **WHEN** 调用方注入 `ParseEpochMillisCST` + `ParseNumberLoose` + 自定义单元格兜底
- **THEN** 日期按东八区墙上时间解析、含百分号/千分位的数字被正确转换、单元格回读按注入的兜底
  函数归一化

### Requirement: 附件上传

共享库 SHALL 提供 `UploadMedia` 将文件字节上传为 Bitable 附件并返回 file_token；
`CreateOp`/`UpdateOp` SHALL 支持按列名携带 file_token 列表，编码为附件单元格结构。

#### Scenario: 上传并写入附件列

- **WHEN** 调用方先 `UploadMedia` 获得 file_token，再在写入操作的附件列附上该 token
- **THEN** 系统将该列编码为附件单元格（file_token 对象数组）写入目标记录

### Requirement: 通讯录全量枚举

共享库 SHALL 提供 `larkcontact` 子包，用一份 app 级凭证枚举一个飞书企业与关联组织的成员，返回中立类型
`User{OpenID, UserID, Name, Source}` 列表并按 open_id 去重。`Source` 标识来源：`own`=本租户原生成员
（`contact.User.List`），`assoc`=关联组织视角成员（`directory.collaboration_share_entity.list`，仅 open_id，
无 user_id）。`ListAllUsers` SHALL 枚举 own 租户通讯录；另提供关联组织枚举方法，按 **app 级配置开关** gating
（默认关），经 `directory.collaboration_tenant.list` 列关联租户、逐租户递归 `collaboration_share_entity.list`
（`TargetTenantKey` 定位目标租户）拉共享成员。因飞书 `contact.user.list` 只返回指定部门的直属成员且不递归子部门，
`ListAllUsers` SHALL 先递归枚举部门（`Department.Children` 且 `fetch_child=true`，始终含根部门 "0"），仅保留
`member_count>0` 的部门（根部门无 member_count，始终保留），再逐部门 `User.FindByDepartment` 分页拉取直属成员，
跨部门按 open_id 去重（同一人可隶属多个部门）。open_id 或 name 为空的成员 SHALL 跳过。关联组织枚举失败
SHALL soft-fail（记 warning，不阻断 own）。任一步 API 失败（`resp.Success()` 为假）SHALL 返回含飞书 code/msg 的错误。

#### Scenario: 递归枚举并跳过空部门

- **WHEN** 调用 `ListAllUsers`，企业含若干 `member_count>0` 的部门与若干 `member_count=0` 的空部门
- **THEN** 系统对根部门 "0" 与每个非空部门调用 `FindByDepartment`，`member_count=0` 的部门被跳过、
  不发起成员查询

#### Scenario: 跨部门按 open_id 去重

- **WHEN** 同一成员（相同 open_id）隶属两个部门，两个部门都返回该成员
- **THEN** 该成员在返回列表中只出现一次

#### Scenario: 缺字段级权限的成员被跳过

- **WHEN** `FindByDepartment` 返回的成员因应用缺字段级读取权限而 open_id 或 name 为空
- **THEN** 该成员被跳过，不进入返回列表；跳过条数以 debug 日志计数，提示可能的 scope 缺失

#### Scenario: 关联组织枚举返回 assoc 身份

- **WHEN** 开启某 app 的关联组织枚举开关，`collaboration_tenant.list` 返回关联租户 b
- **THEN** 系统对该租户调 `collaboration_share_entity.list`，返回的共享成员 `Source="assoc"`、仅带 open_id（无 user_id），与 own 用户在同一列表中按 open_id 去重

#### Scenario: 关联组织枚举 soft-fail

- **WHEN** 关联组织枚举因缺 scope / 限频等失败
- **THEN** 系统记 warning 并跳过该 app 的 assoc 通道，不阻断 own 通道枚举

### Requirement: 重构行为等价

引用共享库改造后，`linapro-recruit-pipeline` 与 `linapro-moka-report-sync` SHALL 保持对外
可观测行为不变：同步结果、日期与数字写入语义、限流节奏、幂等性均与改造前一致。各插件 SHALL
注入与其原有实现等价的 Encoder。

#### Scenario: report-sync 语义保持

- **WHEN** report-sync 改用共享库并注入 CST 日期 + Loose 数字 + `Stringify` 兜底
- **THEN** 报表日期按东八区、百分比/千分位数字、`-` 占位符归一化行为与改造前完全一致

#### Scenario: recruit-pipeline 语义保持

- **WHEN** recruit-pipeline 改用共享库（默认 UTC + Plain 编码器）
- **THEN** 面试时间列仍写入毫秒时间戳（此前 `DatetimeFieldConvFail` 修复的场景），行为不回退
