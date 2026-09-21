## ADDED Requirements

### Requirement: 候选人轮询采集（需求1.1）
`linapro-recruit-pipeline` 插件 SHALL 注册候选人轮询定时任务 `RunCandidatePoll`（默认每 5 分钟执行一次），调用 `EhrApplications` 按申请时间（昨日 0 点北京时间到当前时间）拉取初筛阶段（105019，type=100）候选人，从返回的 `basicInfo` 提取 `applicationId`（int64）、`candidateId`（int64）、`name`（string）等候选人字段。Bitable 现有行按 `field_mapping.applicationId`（applicationId 列）匹配：命中则跳过（skip-once 去重），未命中则走完整流程（获取简历 → 下载附件 → 写 Bitable → 入 Redis 队列）。

#### Scenario: 拉取并写入新候选人
- **WHEN** 定时任务拉取到 applicationId 在 Bitable 中不存在的候选人
- **THEN** 触发简历获取与 Bitable 写入流程，写入后入 Redis pending 队列

#### Scenario: 重复拉取幂等
- **WHEN** 同一 applicationId 在后续轮次被再次拉取到
- **THEN** 按 applicationId 匹配到现有行，跳过写入与入队，Bitable 中不产生重复行

#### Scenario: applicationId 为零时跳过
- **WHEN** `basicInfo` 中 `applicationId` 缺失或为 0
- **THEN** 跳过该候选人，继续处理其余候选人

### Requirement: 简历获取与 Redis 入队（需求1.2）
候选人轮询任务 SHALL 对每个新候选人调用 `GetResumeContent(applicationId)` 获取纯文本简历，将候选人业务字段（含 `basicInfo.source` 简历来源与 `applicationId`）与 `resumeContent` 按 `field_mapping` 写入飞书 Bitable（按 applicationId 匹配 upsert），并取得该行的飞书 `recordID`。简历获取成功时，SHALL 调用 `state.Store.AddPending(recordID, applicationId, analyzingAtMs)` 将该候选人加入 Redis pending 队列（Set `recruit:pending` + Hash `recruit:cand:<recordID>`，`analyzingAtMs` 为当前 UTC 毫秒时间戳），键带安全网 TTL。简历获取失败时，仍写入其余业务字段但**不入队**（无简历即无从做 AI 分析），记录 error 日志，继续处理其余候选人。Redis 不可用时跳过入队并告警，其余写入照常完成。本需求同时负责简历附件同步（见「简历附件同步（需求1.3）」）。`source` 字段 SHALL 经 `field_mapping.source`（默认「简历来源」列）写入，取自 `basicInfo.source`（简历来源渠道文本，如「其它渠道」），与其他业务字段一并按 applicationId upsert。

#### Scenario: 简历获取成功并入队
- **WHEN** `GetResumeContent` 返回非空 `resumeContent`
- **THEN** Bitable 写入包含 resumeContent 与 source（简历来源）业务字段，且该行 recordID 以 `{applicationId, analyzing_at}` 加入 Redis pending 队列

#### Scenario: 简历获取失败不入队
- **WHEN** `GetResumeContent` 返回 error
- **THEN** Bitable 写入其余业务字段，不加入 Redis pending 队列，记录 error 日志，继续处理下一候选人

#### Scenario: Redis 不可用时降级
- **WHEN** Redis 连接不可用
- **THEN** Bitable 写入照常完成，跳过入队并记录 warning

### Requirement: 简历附件同步（需求1.3）
候选人轮询任务 SHALL 在 `field_mapping.resume_file` 列已配置且 `basicInfo.resumeUrl` 非空时，从 `resumeUrl`（Moka 提供的短时效下载链接）下载简历原文件到内存，调用飞书 `drive/v1` UploadAllMedia（`parent_type=bitable_file`、`parent_node=BitableAppToken`）转存取得 `file_token`，并把该 `file_token` 以 `[{file_token}]` 形式写入 Bitable 的简历附件列（列名取自 `field_mapping.resume_file`）。附件文件名 SHALL 取自候选人姓名并追加「-简历」后缀（姓名为空时回退 `resume`），扩展名优先从 `resumeUrl` 的路径推断、其次从 HTTP 响应 Content-Type 推断。简历原文件 SHALL NOT 写入本地磁盘（仅内存中转）。下载或上传任一步失败时，任务 SHALL 记录 error 日志、跳过附件列、照常写入其余业务字段；附件同步失败 SHALL NOT 影响 Redis pending 入队。`field_mapping.resume_file` 未配置或 `resumeUrl` 为空时，跳过附件同步。

#### Scenario: 简历附件成功转存
- **WHEN** `basicInfo.resumeUrl` 非空且 `field_mapping.resume_file` 已配置，下载与上传均成功
- **THEN** 该行简历附件列写入指向转存文件的 `file_token`，附件可从记录下载

#### Scenario: resumeUrl 为空时跳过
- **WHEN** `basicInfo.resumeUrl` 为空
- **THEN** 跳过附件同步，其余业务字段照常写入

#### Scenario: 下载失败降级
- **WHEN** `resumeUrl` 下载返回非 2xx、超时或超过大小上限
- **THEN** 记录 error 日志，不写附件列，其余业务字段照常写入，Redis 入队不受影响

#### Scenario: 上传失败降级
- **WHEN** 文件下载成功但飞书 UploadAllMedia 失败
- **THEN** 记录 error 日志，不写附件列，其余业务字段照常写入，Redis 入队不受影响

#### Scenario: 重复拉取覆盖附件
- **WHEN** 同一 applicationId 在后续轮次再次命中且 `resumeUrl` 有效（走 upsert 更新路径）
- **THEN** 重新下载并转存，覆盖该行的简历附件列，不产生重复行

### Requirement: 简历归属者人员字段（需求1.4·归属者回填）
候选人轮询任务（`RunCandidatePoll`）SHALL 把候选人归属人（HR）写入飞书「简历归属者」人员列（列名取自 `field_mapping.resume_owner`，默认「简历归属者」）。

**MODIFIED（假设失效修订）**：原设计假设归属人取自 `EhrApplications` 返回的 `basicInfo.owner`（内联工号），生产实测该字段恒为 `nil`，故归属人改从 Moka 另一张 **owner 报表**取得，并因报表非实时（5–20 分钟刷新）与轮询 skip-once 去重叠加，归属者写入改为**回填**语义。原「从 `basicInfo.owners.employee_id` 取工号」的机制作废。

**取值链（三段）**：任务每轮调用 `GetReportData(owner_report_id)`（sys_config `owner_report_id`，未配置则跳过归属者取值与回填、不影响其余字段），按报表「申请」列（applicationId，同需求3 固定标题）与 HR 邮箱列（列标题取自 sys_config `owner_email_column`，默认「简历接收邮箱」）建 `applicationId → HR 邮箱` 映射；HR 邮箱经 sys_config `owner_email_mapping`（JSON `{email:工号}`，约 10 个 HR、邮箱唯一）转为 Moka 工号，邮箱在查找前对报表值与配置 key 均做 `TrimSpace + ToLower` 归一化；工号经 `empcap.LarkOpenIDResolverByEmployeeNos(ctx, cfg.LarkAppID)`（按工号匹配 employee.moka_employee_no→lark_identity.open_id，按 lark_app_id 过滤、own+assoc 全返回、双租户同人多个 open_id 全写入）解析为 open_id 集合。该列为飞书人员字段（TypeUser），SHALL 经 `larkbitable.CreateOp.Persons`/`UpdateOp.Persons` 旁路以 `[{id}]` 对象数组写入（`Encoder.UserIDType=open_id`），SHALL NOT 进入普通文本字段；解析在插件边界完成后传入，共享库不做身份解析。

**两条写入路径共用一次报表拉取**（`ownerMap: applicationId → 工号`）：
- **插入路径**：轮询发现的新候选人写行时，`ownerMap` 命中即写「简历归属者」；未命中（报表尚未收录）则留空，不阻塞插入。
- **回填路径**：遍历任务已加载的候选人决策表**全表现有行**（`ListRecordsByID` 结果，与候选人当前 Moka 阶段无关），对「简历归属者」列**为空**且 `ownerMap` 能解析出工号的行，收集进一次 `BatchUpdate` 补齐。回填 SHALL **只补空、不覆写**：已写过归属者的行不再改动（HR 换人不处理），保证幂等与最小写入。

回填放在候选人轮询任务内、复用其已加载的 `fieldTypes`/全表 records/lark client，SHALL NOT 新建独立定时任务，SHALL NOT 改动新候选人 skip-once 去重逻辑（回填是另加的增量 update 通道）。owner 报表的 7 天窗口由 Moka 报表定义侧配置（`GetReportData` 无时间过滤参数），代码只消费返回行。

**降级**（任一步失败均跳过「简历归属者」列，不阻断其余业务字段写入与 Redis pending 入队，与简历附件失败同款）：`owner_report_id` 未配置、报表拉取失败、applicationId 未命中报表、HR 邮箱未配 `owner_email_mapping`、工号解析不到 open_id（employee-core 未绑定、归属人未在员工表或飞书身份未回填）、`field_mapping.resume_owner` 未配置。

**跨 change 依赖**：`empcap.LarkOpenIDResolverByEmployeeNos`（多工号版）与底层 `Service.MapLarkOpenIDsByEmployeeNo` 由 `linapro-employee-core` change 提供，须先落地。

#### Scenario: 报表命中，归属者写入人员字段
- **WHEN** owner 报表已收录某 applicationId，其 HR 邮箱在 `owner_email_mapping` 配有工号，且该工号经 empcap 解析到至少一个 open_id
- **THEN** 该行「简历归属者」列以 `[{open_id}]` 写入（插入时命中则插入即写，否则由回填补上），飞书渲染显示归属人中文名

#### Scenario: 报表滞后，回填自愈
- **WHEN** 新候选人首次写入时 owner 报表尚未收录其 applicationId（5–20 分钟滞后），「简历归属者」列留空
- **THEN** 后续某轮报表收录该 applicationId 后，回填路径检测到该行归属者为空且可解析工号，`BatchUpdate` 补齐该列

#### Scenario: 只补空不覆写
- **WHEN** 某行「简历归属者」已写入 open_id，后续轮次报表仍返回该 applicationId
- **THEN** 回填跳过该行，不重复写入、不覆盖，即使报表值变化也不回改

#### Scenario: HR 邮箱未配映射或工号解析不到 open_id
- **WHEN** 报表 HR 邮箱不在 `owner_email_mapping`，或映射出的工号经 empcap 解析返回空
- **THEN** 跳过「简历归属者」列，其余业务字段照常写入，Redis 入队不受影响

#### Scenario: owner 报表未配置时跳过归属者
- **WHEN** `owner_report_id` 未配置
- **THEN** 不调用 `GetReportData`，插入与回填均跳过「简历归属者」列，其余业务字段与入队照常

#### Scenario: 报表拉取失败降级
- **WHEN** `GetReportData(owner_report_id)` 返回 error，或报表缺少「申请」/HR 邮箱列
- **THEN** 记录 warning 日志，本轮跳过归属者取值与回填，其余业务字段写入与 Redis 入队不受影响

### Requirement: AI 判定定时任务（需求1.5·AI 判定推进）
`linapro-recruit-pipeline` 插件 SHALL 注册定时任务，调用 `state.Store.ListPending` 取出 Redis pending 队列中的全部 `recordID`；对每一项调用 `GetPending` 读取 `applicationId` 与 `analyzing_at`。任务 SHALL 调用共享库 `BatchGetByIDs(recordIDs)` 按 pending recordID 精准批量读取 Bitable 行（而非全表扫描），得到命中行映射与 `absent_record_ids`，再按 recordID 读取 AI 判定字段（列名来自 `AIVerdictField`，sys_config `ai_verdict_field`，默认「AI评估结论」），处理规则如下：Hash 已失效（`ok=false`）则从队列移除；`now - analyzing_at < AIWaitMinutes（毫秒）` 则本轮跳过；recordID 落入 `absent_record_ids`（Bitable 中已无该行）则从队列移除并告警；判定字段为空则保留队列下轮再看；判定值非空且不在排除列表（`AIVerdictExcluded`，sys_config `ai_verdict_excluded`，默认「建议淘汰/无匹配类型/谨慎考虑」）则调 `MoveApplicationStage(applicationId, DeptScreeningStageID)` 将候选人推进到「用人部门筛选」阶段，成功后出队（失败则保留下轮重试）；判定值命中排除列表则直接出队（忽略，不推进）。系统不自动淘汰候选人。注意：`ScreeningStageID`（简历初筛）仅为需求2 拉取候选人的来源阶段，本任务不向其推进；AI 判定通过的唯一推进目标是 `DeptScreeningStageID`（用人部门筛选）。本任务 SHALL 从**候选人决策表**（`CandidateBitableTableID`，sys_config `candidate_bitable_table_id`）按 recordID 回表读取；由于该 recordID 由候选人轮询任务写入候选人决策表后存入 Redis，AI 判定任务与候选人轮询任务必须指向同一张候选人决策表，不可分表，否则 recordID 无法命中。

#### Scenario: AI 判定通过（非空且不在排除列表）
- **WHEN** 队列项对应行的 AI 判定字段值非空、不在排除列表且 analyzing_at 已超过阈值
- **THEN** 调用 `MoveApplicationStage(applicationId, DeptScreeningStageID)` 将候选人推进到「用人部门筛选」阶段，并将该 recordID 从 Redis pending 队列移除

#### Scenario: AI 判定命中排除列表
- **WHEN** AI 判定字段值为非空且命中排除列表
- **THEN** 该 recordID 从 Redis pending 队列移除，不调用 `MoveApplicationStage`，不淘汰候选人

#### Scenario: AI 字段为空
- **WHEN** AI 判定字段为空（AI 尚未计算完成）
- **THEN** 保留该队列项，不做任何推进，下次定时任务继续检查

#### Scenario: 等待窗口未到
- **WHEN** `now - analyzing_at < AIWaitMinutes`
- **THEN** 本轮跳过该项，保留在队列中

#### Scenario: 队列项失效或行已删除
- **WHEN** Hash 已过期（`ok=false`），或 recordID 落入 `BatchGetByIDs` 返回的 `absent_record_ids`（Bitable 中已无该行）
- **THEN** 从 Redis pending 队列移除该项，避免无限堆积

#### Scenario: 推进阶段失败
- **WHEN** `MoveApplicationStage` 返回 error
- **THEN** 记录 error 日志，保留队列项，下轮重试

### Requirement: 面试状态同步定时任务（需求2）
`linapro-recruit-pipeline` 插件 SHALL 注册定时任务，从**面试阶段**（`InterviewStageID`，type=201，默认 105021）分两条路径拉取候选人并回写**面试状态表**（`InterviewBitableTableID`，sys_config `interview_bitable_table_id`；未配置回退候选人决策表 `candidate_bitable_table_id`）。飞书行以 **`applicationId` 字段 + 面试轮次（roundName）** 组合作为唯一标识：命中则按**字段级差异比对**决定是否更新，未命中则按路径规则新建或跳过。面试轮次数据的权威来源是 `EhrApplications` 返回的 `data[].interviewInfo` 对象（逐面试轮次条目），归档原因来源是 `basicInfo.archiveReasons`。`operatorEmail`（调用视频链接接口所需管理员邮箱）来自静态 host 配置 `plugin.linapro-recruit-pipeline.moka.operatorEmail`。

**字段级差异比对**：命中现有行后，任务 SHALL 仅在存在实际变更的列时产出更新，且 `UpdateOp` 只携带差异列；无任何差异列时 SHALL 冻结该行（不写入）。比对 SHALL 按飞书列类型（`ListFields` 权威类型）分派为强类型比对，不做纯字符串比对：
- `TypeDateTime`（面试时间）：两侧解析为 `int64` 毫秒后比对（回读经解码为数字、写入为毫秒，两侧同解析器归一后比数值，规避科学计数法/文本形态差异）；
- `TypeNumber`（若存在数字列）：两侧解析为 `float64` 后比对；
- `TypeUser`（面试官）：按 **open_id 集合**比对——比对对象为回读记录人员单元格解析出的 **open_id 集合**与本轮解析出的期望 open_id 集合（顺序无关、去重、忽略空 id），不使用人员单元格的姓名文本；
- 其它/文本列（面试方式、视频面试链接、是否应约、未应约原因等）：两侧 `TrimSpace` 归一后按字符串比对。

**未应约原因列无条件写**：未应约原因列 SHALL 在每轮为命中行无条件赋值——未应约（`status`=已取消）时写 `basicInfo.archiveReasons`，已应约时写空串以显式清列——使该列恒定参与差异比对，不再因「有时写、有时不写」而产生比对特例。

**路径一（未归档，全量 upsert）**：调用 `EhrApplications` 拉取面试阶段且 `archived=false` 的候选人。对每条候选人的每个 `interviewInfo` 面试轮次，提取面试轮次 `roundName`、面试方式 `interviewType`、面试时间 `startTime`、视频面试链接 `intervieweeVideoUrl`、是否应约（`status` 为「已取消」即未应约，其余为已应约）：
- **未应约**：从 `basicInfo.archiveReasons`（归档原因名称）提取未应约原因。
- **已应约**且面试方式为**视频面试**：调用 `GetInterviewInformation(applicationIds, operatorEmail)`（`POST /api-platform/v1/interview/interview-information`），从返回 `data[].entities[].intervieweeVideoUrl` 取视频面试链接（覆盖 `interviewInfo` 中的空值）。已应约但非视频面试不调该接口。

按 `applicationId + 面试轮次` 匹配面试状态表现有行：不存在则新建，存在则按字段级差异比对更新**面试方式、面试时间、视频面试链接、是否应约、未应约原因、面试官**中实际变更的列。

**路径二（已归档，仅更新两列）**：调用 `EhrApplications` 拉取面试阶段、`archived=true` 且**归档时间在昨日 0 点至当前时间**的候选人（服务端 `updateAtStartTime`/`updateAtEndTime` 时间范围过滤，传北京时间 `YYYY-MM-DDTHH:mm:ss.sssZ`）。同样按 `status` 判定是否应约，未应约时取 `archiveReasons` 未应约原因。按 `applicationId + 面试轮次` 匹配现有行，**仅在是否应约或未应约原因两列存在变更时更新**，不新建行、不更新其他字段。

服务端过滤参数 `archived`（true/false）、`updateAtStartTime`、`updateAtEndTime` 由 `EhrApplications` 透传给 Moka `/api-platform/v2/data/ehrApplications`。

定时任务日志 SHALL 区分「新建 / 更新 / 冻结」三类计数，其中「更新」计数反映真实存在字段变更的行数。

#### Scenario: 未归档路径新建面试轮次行
- **WHEN** 面试阶段存在 `archived=false` 候选人，其某面试轮次在面试状态表中无匹配（applicationId+轮次）行
- **THEN** 新建一行，写入 applicationId、面试轮次、面试方式、面试时间、视频面试链接、是否应约

#### Scenario: 未归档路径仅更新变更列
- **WHEN** `applicationId + 面试轮次` 在面试状态表已有匹配行，且本轮拉取值与现有行相比仅面试时间发生变化
- **THEN** 产出的 `UpdateOp` 只包含面试时间一列，其余未变更列不出现在更新中

#### Scenario: 无字段变更时冻结
- **WHEN** `applicationId + 面试轮次` 命中现有行，且所有待写列（面试方式/时间/视频链接/是否应约/未应约原因/面试官）经比对均与现有值相等
- **THEN** 该行被冻结（不产出更新），日志「更新」计数不含此行

#### Scenario: 面试时间日期按 int64 毫秒比对
- **WHEN** 现有行面试时间列回读为数字型日期值，其解析出的毫秒与本轮写入值解析出的毫秒相等
- **THEN** 面试时间列被判定为无变化，不因数字文本形态（如科学计数法）不同而误判为变更

#### Scenario: 面试官人员列 open_id 集合等价时冻结
- **WHEN** 命中行的面试官人员列回读的 **open_id 集合**与本轮解析出的期望 open_id 集合在去重、忽略顺序、忽略空 id 后等价
- **THEN** 面试官列被判定为无变化，不产出人员列更新（比对只认 open_id 集合，不用回读的姓名文本）

#### Scenario: 未应约取归档原因
- **WHEN** 候选人某面试轮次 `status` 为「已取消」（未应约）
- **THEN** 是否应约写入「未应约」，未应约原因取自 `basicInfo.archiveReasons`

#### Scenario: 轮次由未应约转已应约时清空未应约原因
- **WHEN** 命中行现存未应约原因非空，而本轮该轮次已应约
- **THEN** 未应约原因列被无条件写为空串（显式清列），并作为一处差异列纳入更新

#### Scenario: 已应约视频面试补视频链接
- **WHEN** 候选人某面试轮次已应约且面试方式为视频面试，且 `interviewInfo.intervieweeVideoUrl` 为空
- **THEN** 调用 `GetInterviewInformation` 从 `entities[].intervieweeVideoUrl` 取链接写入视频面试链接列

#### Scenario: 已应约非视频面试不调接口
- **WHEN** 候选人某面试轮次已应约但面试方式非视频面试
- **THEN** 不调用 `GetInterviewInformation`，视频面试链接列保持 `interviewInfo` 原值（可能为空）

#### Scenario: 已归档路径仅在两列变更时更新
- **WHEN** 面试阶段存在归档时间在昨日 0 点至今、`archived=true` 的候选人，其 `applicationId + 面试轮次` 在面试状态表已有匹配行，且是否应约或未应约原因与现有值不同
- **THEN** 仅更新发生变化的是否应约/未应约原因列，不新建行、不更新面试方式/时间/视频链接；两列均无变化时冻结该行

#### Scenario: 已归档路径无匹配行跳过
- **WHEN** 已归档候选人的 `applicationId + 面试轮次` 在面试状态表无匹配行
- **THEN** 跳过，不新建行

#### Scenario: 面试状态表未配置时回退
- **WHEN** `interview_bitable_table_id` 未配置
- **THEN** 两条路径均回写到候选人决策表（`candidate_bitable_table_id`），保持单表部署兼容

#### Scenario: 面试官人员列经 Persons 旁路写入
- **WHEN** 某面试轮次的 `interviewInfo[].interviewerFeedbacks[].interviewer.employeeId` 含一名或多名面试官工号，且 `field_mapping.interviewer` 已配置，且经比对该列相对现有行存在变更
- **THEN** 工号先按逗号拼接做输入格式归一，再经 `empcap.LarkOpenIDResolverByEmployeeNos(ctx, cfg.LarkAppID)` 解析为 **去重后的 open_id 集合**，经 `CreateOp.Persons`/`UpdateOp.Persons` 旁路以 `[{id}]` 对象数组写入面试官人员列（`Encoder.UserIDType=open_id`）；该列 SHALL NOT 进入普通文本字段

#### Scenario: 面试官列解析降级
- **WHEN** employee-core 未绑定、映射查询失败、或全部工号都解析不到 open_id
- **THEN** 面试官人员列本轮不写入（不阻断该行其余列与整批写入）

#### Scenario: 幂等重复执行（需求2）
- **WHEN** 同一候选人同一面试轮次在两次定时任务中均命中，且期间业务值未变
- **THEN** 第二轮该行经差异比对被冻结，不产生重复写入，最终结果一致、无重复行

### Requirement: 报表评分回写定时任务（需求3）
`linapro-recruit-pipeline` 插件 SHALL 注册定时任务，从 `config.RecruitReportIDs` 读取一个或多个报表 ID（来自 sys_config `plugin.linapro-recruit-pipeline.recruit_report_ids` 的 int64 JSON 数组，为空时记录 warn 日志并跳过本轮）；对每个 reportId 调用 `GetReportData(reportId)`。报表列映射来自独立于 `field_mapping`（需求1/2 专用）的 sys_config 键 `plugin.linapro-recruit-pipeline.report_field_mapping`（`config.ReportFieldMapping`，JSON 对象，key 为 **Moka 报表列标题**、value 为 **飞书目标列名**），默认 `{"申请":"applicationId","候选人":"姓名","最终总分":"人才画像评分","匹配度等级-初":"匹配度等级","匹配度等级-中":"匹配度等级","匹配度等级-高":"匹配度等级"}`。映射允许**多个 Moka 源列标题指向同一飞书目标列**（多源列→单目标列合并）：匹配度列因来自三个不同报表数据源、各表字段名无法统一（匹配度等级-初/中/高）而分别命名，但都回写飞书同一列「匹配度等级」。任务遍历 `headers`：按 Moka 报表列标题匹配 `report_field_mapping` 的 key 取得该列 `dataIndex`，映射到对应的飞书目标列名（value）；其中固定标题「申请」映射到的飞书列（默认 `applicationId`）作为唯一键列单独处理。遍历 `rows` 按 applicationId（Moka 报表「申请」列的值，对应飞书唯一键列）匹配 Bitable 已有记录：命中则按**字段级差异比对**回写实际变更的目标列，applicationId 不匹配时新建行（写入唯一键列 + 目标列）。Bitable 现有记录与字段类型仅加载一次，多个报表产生的新建按 applicationId 合并、更新按 recordID 合并后统一调用 `BatchCreate` + `BatchUpdate`；单个报表拉取失败或「申请」列缺失时记录 warn 日志并继续处理其余报表，不阻断整轮同步。本任务 SHALL 回写到**报表评分表**（`ReportBitableTableID`，sys_config `report_bitable_table_id`），该表与候选人决策表位于同一飞书多维表格文档（共用 `BitableAppToken`）但 table id 不同；`report_bitable_table_id` 未配置时不回退，直接记录 warn 日志跳过本轮，避免把报表评分误写进候选人决策表。

**字段级差异比对**：命中现有行后，任务 SHALL 仅在存在实际变更的目标列时产出更新，且 `UpdateOp` 只携带差异列；无差异列时 SHALL 冻结该行（不写入）。比对 SHALL 按飞书列类型分派为强类型比对：`TypeNumber` 目标列（如「人才画像评分」）两侧解析为 `float64` 后比对，`TypeDateTime` 目标列两侧解析为 `int64` 毫秒后比对，其它/文本目标列两侧 `TrimSpace` 归一后按字符串比对。定时任务日志 SHALL 区分「新建 / 更新 / 冻结」三类计数，「更新」计数反映真实存在字段变更的行数。

#### Scenario: 回写报表评分表
- **WHEN** `report_bitable_table_id` 已配置且报表返回可匹配 applicationId 的行
- **THEN** 评分列被写入 `report_bitable_table_id` 指向的报表评分表，而非候选人决策表

#### Scenario: 命中行仅更新变更列
- **WHEN** 报表 row 的 applicationId 命中 Bitable 现有记录，且仅人才画像评分一列相对现有值发生变化
- **THEN** 产出的 `UpdateOp` 只包含人才画像评分一列，其余目标列不出现在更新中

#### Scenario: 无字段变更时冻结
- **WHEN** 报表 row 命中现有记录，且全部目标列经比对均与现有值相等
- **THEN** 该行被冻结（不产出更新），日志「更新」计数不含此行

#### Scenario: 数字列按 float64 等价时冻结
- **WHEN** 「人才画像评分」为数字列，回读值解析出的 `float64` 与本轮报表值解析出的 `float64` 相等（如回读 `"90"` 与报表 `"90.0"`）
- **THEN** 该列被判定为无变化，不因字符串形态不同而误判为变更

#### Scenario: 报表评分表未配置时跳过
- **WHEN** `report_bitable_table_id` 未配置
- **THEN** 记录 warn 日志后跳过本轮报表同步，不发起 Moka 或 Bitable 网络调用，不回退候选人决策表

#### Scenario: 正常回写评分
- **WHEN** `GetReportData` 返回包含目标列的报表，Bitable 中存在对应 applicationId 的记录且目标值有变化
- **THEN** 该记录的变更评分列被更新，error 为 nil

#### Scenario: 多报表逐表回写
- **WHEN** `config.RecruitReportIDs` 配置了多个报表 ID，且各报表均返回包含目标列的行
- **THEN** 依次对每个报表调用 `GetReportData`，将命中 applicationId 匹配的新建按 applicationId 合并、更新按 recordID 合并后一次性 `BatchCreate` + `BatchUpdate` 回写

#### Scenario: 单报表失败不阻断其它
- **WHEN** 某一报表的 `GetReportData` 返回 error 或缺少「申请」列
- **THEN** 记录 warn 日志后继续处理其余报表，其余报表的更新照常回写

#### Scenario: 报表 ID 未配置时跳过
- **WHEN** `config.RecruitReportIDs` 为空
- **THEN** 记录 warn 日志后跳过本轮，不调用 `GetReportData`

#### Scenario: applicationId 不匹配时新建行
- **WHEN** 报表 row 的 applicationId 在 Bitable 中不存在
- **THEN** 新建 Bitable 记录，写入 applicationId 列与目标列

#### Scenario: 目标列不存在于报表
- **WHEN** 某个飞书目标列的**全部**候选 Moka 源列（`report_field_mapping` 中映射到该目标列的所有 key）在报表 headers 的 title 中都找不到
- **THEN** 该目标列被跳过，其余可匹配列正常回写，记录一条 warn 日志（按目标列聚合、列出候选源列，不逐个源列告警）

#### Scenario: 多源候选列部分缺失不告警
- **WHEN** 某飞书目标列由多个 Moka 源列供给（如匹配度等级-初/中/高 → 匹配度等级），当前报表只含其中一个源列，另外的候选源列缺失
- **THEN** 该目标列按命中的源列正常回写，不记录 warn 日志（只要任一候选源列命中即视为成功）

#### Scenario: Moka 源列名与飞书目标列名不同
- **WHEN** 报表 headers 的 title 为 Moka 侧列名（候选人/最终总分/匹配度等级-初/中/高），与飞书目标列名（姓名/人才画像评分/匹配度等级）不同
- **THEN** 任务按 `report_field_mapping` 的 key（Moka 标题）定位 dataIndex、按 value（飞书列名）回写，各列均正确命中，不再出现「target column not found」

#### Scenario: 多个 Moka 源列映射到同一飞书列
- **WHEN** 不同报表数据源分别提供匹配度列（匹配度等级-初/中/高），三者在 `report_field_mapping` 中都映射到飞书同一列「匹配度等级」
- **THEN** 每个报表命中的匹配度值都回写到飞书「匹配度等级」列；同一 applicationId 在多个报表命中时按 recordID 合并，后出现的报表覆盖先出现的值

#### Scenario: 幂等重复执行（需求3）
- **WHEN** 同一 applicationId 报表数据在两次定时任务中均命中，且期间目标值未变
- **THEN** 第二轮该行经差异比对被冻结，不产生重复写入，最终结果一致、无重复行
