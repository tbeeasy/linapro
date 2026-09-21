## Context

`linapro-recruit-pipeline` 插件骨架提供了飞书 Bitable connector、业务配置层和 Redis 状态层。本 change 实现招聘流水线的全部三条业务需求，三条需求共用同一个插件，合并在一个 change 内归档为单一 spec 文件。三条需求写入同一飞书多维表格文档下的三张表（候选人决策表 / 面试状态表 / 报表评分表，共用 App token、table id 不同，详见 Decisions「三张 Bitable 表分离」）。

需求1 的「简历写入 → 等 AI 计算 → 读回结果推进面试」是一个跨周期的异步流程。**待获取 AI 分析结果的候选人队列存储在 Redis**（不再依赖 Bitable 的 `stage` 字段轮询）。**采用定时轮询**：定时任务按申请时间（昨日0点到现在）拉取初筛阶段（105019）候选人，按 applicationId 去重后写入 Bitable 并入 Redis pending 队列；AI 判定定时任务从队列取项、等待窗口到期后读 `ai_verdict`，推进面试或出队。

**接口清单（已确认）**

| 需求       | 方法 | 路径                                                   | 入参主键                                    |
| ---------- | ---- | ------------------------------------------------------ | ------------------------------------------- |
| 1 轮询     | POST | `/api-platform/v2/data/ehrApplications`                | stageIds, applicationAppliedAtStartTime/End |
| 1 简历     | POST | `/api-platform/application/resumeContent/get`          | applicationId                               |
| 1 推进     | PUT  | `/api-platform/v1/applications/move_application_stage` | applicationId, stageId                      |
| 1 阶段表   | GET  | `/api-platform/v2/stage/getStagesList`                 | —                                           |
| 2 拉列表   | POST | `/api-platform/v2/data/ehrApplications`                | stageIds                                    |
| 2 面试信息 | POST | `/api-platform/v3/getInterviewInfos`                   | applicationIds（成功码 0）                  |
| 3 报表     | POST | `/api-platform/v1/getReportData`                       | reportId（来自 sys_config）                 |

**面试状态编码（已确认）**

| 字段                    | 值    | 含义                         |
| ----------------------- | ----- | ---------------------------- |
| `status`                | 1     | 未结束                       |
|                         | 2     | 已结束                       |
|                         | **3** | **已取消**（需求2 过滤条件） |
| `candidateAttendStatus` | 1     | 候选人未反馈                 |
|                         | 2     | 候选人未到场                 |
|                         | 3     | 候选人已拒绝                 |
|                         | 4     | 候选人已接受                 |
|                         | 5     | 候选人时间不合适             |

**全局约定**：Moka 侧接口主键统一用 `applicationId`（不是 `candidateId`）；Bitable 侧需求1.1 候选人行按 `applicationId` 列匹配、需求2 面试行按 `applicationId + 面试轮次` 组合键匹配、需求3 报表行按 `applicationId` 列匹配（报表评分表存 `applicationId`）；所有等待都由定时任务扫 Redis 队列里的时间戳实现，不 blocking sleep；`getReportData` 属于招聘域（不调 HCM 域）；reportId 从 sys_config 读取，不硬编码。

## Goals / Non-Goals

**Goals:**

- 需求1：注册定时任务（默认 5 分钟），按申请时间（昨日0点→现在）拉取初筛阶段（105019）候选人，按 applicationId 去重，不存在则获取简历写 Bitable 并入 Redis pending 队列；AI 判定定时任务从队列取项、等待窗口到期后读 `ai_verdict`，推进面试或出队。
- 需求2：注册定时任务，拉面试阶段候选人（`InterviewStageID`，type=201，默认 105021，非简历初筛 105019）→ 逐面试轮次提取面试信息 → 按 `applicationId + 面试轮次` 组合键匹配回写 Bitable。
- 需求3：注册定时任务，从 sys_config 读多个 reportId（`recruit_report_ids` JSON 数组）→ 逐表 `GetReportData` → 动态解析 headers → 按 applicationId 匹配 → 合并后统一回写姓名/人才画像评分/匹配度等级三列。

**Non-Goals:**

- 简历纯文本（`resumeContent`）用于 AI 分析，简历原文件（`resumeUrl`）仅下载后转存飞书作为「简历附件」列，二者用途独立；不在本地磁盘持久化任何简历文件。
- 不自动淘汰候选人，命中排除列表（默认「建议淘汰/无匹配类型/谨慎考虑」）的判定一律出队不推进。
- 不在 Bitable 中维护 `stage` 状态机来驱动 AI 流程（该职责已移交 Redis 队列）。
- 需求3 按 applicationId 匹配报表评分表现有行，未命中则新建行（写入 `applicationId` 列 + 目标列）。
- 不处理 HCM 域报表。

## Decisions

**三条需求合并一个 change，specs 归入同一文件**

三条需求都属于 `linapro-recruit-pipeline`，写同一张 Bitable 表。拆成三个 change 会导致 specs 分散到三个主 spec 文件，归档后无法在一处查看完整的招聘流水线规格。合并后 `openspec/specs/recruit-pipeline/spec.md` 是这个插件行为的唯一规格来源。

**待判定队列存 Redis，不用 Bitable stage 字段轮询，也不用 host Cache 能力**

需求1 的等 AI 结果是跨周期异步流程，需要「枚举当前所有待判定候选人」的能力。三种选型：

- **Bitable `stage=analyzing` 轮询**（旧方案）：每轮定时任务全表扫 Bitable 找 `stage=analyzing`，既慢又把飞书表当状态机用，且 stage 字段与业务列耦合。
- **host `cachecap` 能力**：合约明确「lossy runtime acceleration data，不得作为业务状态/记录的权威」，且只有按 key 读写、**无法枚举 key**，拿不到「全部待判定项」。
- **专用 Redis 客户端**（选定）：插件自持一个 `gredis` 连接（配置来自 host 静态配置 `plugin.linapro-recruit-pipeline.redis.*`），用 Set + Hash 结构既能枚举又能按 recordID 取详情，且能跨任务重启存活。

因此新增 `backend/state` 包封装 Redis：

- Set `recruit:pending` 保存所有待判定的 Bitable `recordID`；
- Hash `recruit:cand:<recordID>` 保存 `{applicationId, analyzing_at}`；
- 两个键都打**安全网 TTL**（默认 72h，`redis.ttl_hours` 可调），防止漏删导致的无限堆积；
- `Store` 是长驻单例（持有连接池），`plugin.go` 中懒加载，严禁 per-request 新建。

**候选人定时轮询策略**

采用定时轮询方案：

- **轮询策略**：定时任务（默认 5 分钟）调用 `EhrApplications`，按申请时间过滤（`applicationAppliedAtStartTime`/`applicationAppliedAtEndTime`）拉取昨日 0 点（北京时间）到当前时间申请的初筛阶段（105019，type=100）候选人。
- **去重策略**：先 `ListRecords` 建立 `applicationId → recordID` 索引，遍历拉取结果时检查索引，已存在则跳过（不更新），不存在则走完整流程（获取简历 → 下载附件 → 写 Bitable → 入 Redis 队列）。
- **数据完整性**：`EhrApplications` 返回的 `basicInfo` 包含候选人信息（phone, email, experience, academicDegree, lastSchool, sourceName, resumeUrl 等），字段结构已与候选人采集流程对齐。**例外：`basicInfo.owner` 实测为 `nil`**，归属人改从 owner 报表取（见下文「简历归属者人员字段」小节），非本接口补全。
- **时间窗口**：昨日 0 点到现在的窗口保证不漏拉（每 5 分钟一次，窗口有重叠），同时按 applicationId 去重避免重复写入。历史候选人不在窗口内，不会被重复拉取。

定时任务承接全部候选人采集与入队逻辑（GetResumeContent + downloadResume + UploadMedia + 解析 open_id + buildRow + BatchCreate + AddPending）。

**候选人轮询任务与 AI 判定任务解耦（Redis 队列）**

候选人轮询定时任务成功写 Bitable 后调用 `AddPending(recordID, applicationId, now_ms)` 入队；AI 判定定时任务 `ListPending` 取全部待判定项，逐个 `GetPending` 拿时间戳与 applicationId。判定逻辑：

- Hash 已失效（TTL 过期或被删）→ `ok=false`，从 Set 清掉该项；
- `now - analyzing_at < AIWaitMinutes` → 等待窗口未到，本轮跳过；
- Bitable 中已无该 recordID（行被删）→ 从队列移除；
- AI 判定字段（`AIVerdictField`，sys_config `ai_verdict_field`，默认「AI评估结论」）为空 → AI 尚未算完，保留队列下轮再看（不误判）；
- AI 判定字段非空且不在排除列表（`AIVerdictExcluded`，sys_config `ai_verdict_excluded`，默认「建议淘汰/无匹配类型/谨慎考虑」）→ 调 `MoveApplicationStage(applicationId, DeptScreeningStageID)` 推进到「用人部门筛选」阶段，成功后出队；失败则保留队列下轮重试；
- AI 判定字段命中排除列表 → 直接出队，不推进、不淘汰。

Redis 不可用时优雅降级：轮询任务仍完成 Bitable 写入，仅跳过入队并告警；AI 判定任务当轮直接返回。

**Moka SDK 扩展：支持申请时间过滤**

`linapro-moka-recruit` 的 `EhrApplicationsQuery` 现仅支持 `updateAtStartTime/End`（更新时间），需扩展支持 `applicationAppliedAtStartTime/End`（申请时间）。同时扩展 `ApplicationBasicInfo` 结构，添加 phone, email, experience, academicDegree, lastSchool, sourceName, resumeUrl, resumeKey, appliedAt 等字段（与 Moka API 实际返回对齐）。`owner` 字段保留但实测恒为 `nil`，归属人不从此处取，改走 owner 报表（见「简历归属者人员字段」小节）。

**三张 Bitable 表分离，同文档不同 table id（FB-6 修订）**

三条需求原设计共用同一张 Bitable 表，但真实飞书部署里候选人决策、面试取消状态、报表评分分属三张不同的表。故拆分为三张表，位于同一飞书多维表格文档（共用 `BitableAppToken`）、仅 table id 不同：

- **候选人决策表**（`CandidateBitableTableID`，sys_config `candidate_bitable_table_id`）：候选人轮询写入候选人行、AI 判定任务回表读取。二者**必须同表**——候选人轮询 upsert 后把飞书 `recordID` 存入 Redis，AI 判定任务靠该 recordID `BatchGetByIDs` 回表读判定字段，分表会导致 recordID 失配，故不可拆分。
- **面试状态表**（`InterviewBitableTableID`，sys_config `interview_bitable_table_id`）：需求2 面试取消状态回写目标。
- **报表评分表**（`ReportBitableTableID`，sys_config `report_bitable_table_id`）：需求3 报表评分回写目标。

面试表 table id 未配置时回退到候选人决策表 table id，保持单表部署兼容。报表表 table id **不回退**：未配置时 `RunReportSync` 直接跳过本轮，避免把报表评分误写进候选人决策表（FB-10 修订）。面试任务按 `applicationId + 面试轮次` 匹配现有行；报表任务按 `applicationId` 匹配现有行，未命中新建。

**Bitable 三张表各按唯一键匹配**

需求1.1 写 Bitable 以 `field_mapping.applicationId` 列匹配现有行（applicationId 同时作为业务列写入）：命中则 `BatchUpdate`、未命中 `BatchCreate` 新建；需求2 以 `applicationId + 面试轮次` 组合键匹配；需求3 报表评分表按 `applicationId` 列匹配现有行，命中则更新姓名/人才画像评分/匹配度等级三列、未命中则新建。Redis 队列侧以飞书 `recordID` 作为待判定项标识（候选人轮询任务 upsert 后返回的 recordID），applicationId 作为调 Moka 推进接口的入参存在 Hash 里。

**需求2 GetInterviewInfos 每批 50 个**

V3 接口未明确文档单次上限，保守取 50，实测后可调整。

**需求2 重构（FB-7）：双路拉取 + interviewInfo 数据源 + application×轮次匹配**

需求2 原实现走 `GetInterviewInfos(v3)` 取 status、过滤 status=3、按**姓名**回写应约/到场状态。FB-7 按业务重排为两条路径，权威数据源改为 `EhrApplications` 返回体内的 `data[].interviewInfo`（逐面试轮次），归档原因取 `basicInfo.archiveReasons`：

- **路径一（未归档，archived=false）**：逐面试轮次提取 roundName / interviewType / startTime / intervieweeVideoUrl / status。`status=已取消` 即未应约，取 `archiveReasons` 作未应约原因；已应约且**视频面试**时调 `GetInterviewInformation`（`POST /api-platform/v1/interview/interview-information`，入参 `applicationIds`+`email`）补 `entities[].intervieweeVideoUrl`。按 `applicationId+轮次` upsert 面试方式/时间/视频链接/是否应约。
- **路径二（已归档，archived=true + 昨日0点至今）**：仅更新是否应约 + 未应约原因两列，不新建行。

关键取舍：

- **匹配键从姓名改为 `applicationId 字段 + 面试轮次`**：一个候选人可有多轮面试，姓名无法区分轮次。飞书面试状态表新增 `applicationId`、`interview_round` 两列作组合唯一键；面试方式/面试时间/视频面试链接/是否应约/未应约原因各占一列（均经 `field_mapping` 可配）。
- **服务端过滤**：`EhrApplications` 透传 `archived`（true/false）、`updateAtStartTime`/`updateAtEndTime`（北京时间 `YYYY-MM-DDTHH:mm:ss.sssZ`）给 Moka，不在客户端内存过滤，避免全量拉取。已归档路径的时间窗为「昨日 0 点（北京时间）→ 当前时间」。
- **operatorEmail 静态配置**：视频链接接口需 `email` 参数（管理员邮箱，基本不变），存于静态 host 配置 `plugin.linapro-recruit-pipeline.moka.operatorEmail`，非 sys_config。
- **interviewType 视频面试判定**：`interviewInfo.interviewType` 按 Moka 文档为字符串（现场面试/电话面试/视频面试），用命名常量集中管理，仅「视频面试」触发补链接。

**需求3 目标列固定三列，列名经 field_mapping 可调**

报表评分表回写目标固定为候选人姓名、人才画像评分、匹配度等级三列（`field_mapping` 键 `report_name`/`report_score`/`report_match_level`，默认「姓名」「人才画像评分」「匹配度等级」），不进行全行覆盖；列名可经 `field_mapping` 覆盖，报表中的其余列不写入。

**简历附件：下载原文件转存飞书，不能直接写 URL**

飞书 Bitable 附件字段（type 17）的单元格值是 `[{file_token}]` 数组，不接受 URL 字符串。因此把 Moka `resumeUrl` 落到「简历附件」列必须走「下载 → 转存飞书 → 写 file_token」：

- 文件来源：`EhrApplications` 返回的 `basicInfo.resumeUrl`（48h 有效外链），不复用 `GetResumeContent`（后者只返回 `resumeKey`/`resumeContent`，无 URL）。
- 转存：HTTP GET 到内存 `[]byte`（30s 超时、20MB 上限、非 2xx 视为失败），再用 `drive/v1` UploadAllMedia（`parent_type=bitable_file`、`parent_node=BitableAppToken`）上传，文件归属该多维表格、随记录可下载。**全程不落盘**，`UploadAllMedia` 需 `Size`，故先读全量拿字节数后 `bytes.NewReader` 上传。
- 文件名：取候选人姓名并追加「-简历」后缀（姓名为空回退 `resume`），扩展名优先从 `resumeUrl` 路径推断、其次从 HTTP 响应 Content-Type 推断。
- 降级：下载或上传失败 → 记 error 日志、跳过附件列、其余业务字段照写；附件失败**不影响** Redis pending 入队（入队仍由 `resumeContent` 成功驱动）。
- 列名经 `field_mapping.resume_file`（默认「简历附件」）配置；附件由候选人轮询任务在写行时特殊注入，不走通用字段提取路径（与 `resume` 逻辑键同类）。

**简历归属者人员字段：报表取 HR 邮箱 → 邮箱映射工号 → 解析 open_id（FB 修订：假设失效）**

原设计假设 `EhrApplications` 返回的 `basicInfo.owner` 内联归属人对象（name/phone/email/employeeId 工号），故「无需从 Moka 另一张表拉取」。**该假设已被生产环境推翻**：`EhrApplications` 返回的 `basicInfo.owner` 实测为 `nil`，拿不到归属人。因此 owner 只能改从 Moka 的另一张**报表**取得。

**取值链改为三段**：

```
GetReportData(owner_report_id)                    ← Moka owner 报表
   headers/rows，按「申请」列建索引
        appId ──► 「简历接收邮箱」列的值（HR 邮箱）
                     │  owner_email_mapping（sys_config, email→工号）
                     ▼
                  HR 工号
                     │  LarkOpenIDResolverByEmployeeNos（多工号版，工号→open_id）
                     ▼
                  open_id ──► 写「简历归属者」人员列 [{open_id}]
```

报表 owner 列给的是 HR 邮箱而非工号，公司约 10 个 HR、邮箱唯一，故用一张 sys_config 小映射表 `owner_email_mapping`（`{"hr@x.com":"GZ001", ...}`）把邮箱转成工号。**转工号而非邮箱直配 open_id**：工号是 `employee.moka_employee_no` 稳定外键，可复用既有的 `LarkOpenIDResolverByEmployeeNos`（多工号版；按 larkAppID 过滤、own+assoc 全返回、`UserIDType=open_id`），零新增 Lark 调用路径。邮箱查找前对报表值与配置 key 均做 `TrimSpace + ToLower` 归一化，避免大小写/空格漏配。

工号→open_id 段仍依赖 employee-core 飞书通讯录回填（按姓名 JOIN）已为该 HR 落 lark_identity；未对上则解析返回空、跳过该列——该 fragility 在上游、未消除，但查找侧不二次归一。

**报表滞后 × skip-once → owner 是回填问题，不是插入问题**

owner 报表非实时（Moka 说法 5–20 分钟刷新），而候选人轮询每 5 分钟一次且已存在的 applicationId 直接跳过（skip-once）。二者组合导致：新候选人首次写入时报表几乎必然还没收录它，若只在插入时写 owner，则该行 owner 列永久为空。故 owner 写入必须做成**回填**：

- **owner 报表每轮拉取一次**，构建 `ownerMap: appId → 工号`（经上述三段解析）。
- **插入路径**（新候选人）：`ownerMap[appId]` 命中就写「简历归属者」，通常为空，免费尝试、不阻塞。
- **回填路径**（新增）：遍历 `RunCandidatePoll` 已加载的 Bitable 全表 `records`（注意该 records 来自候选表全表、与 Moka 当前阶段无关，候选人推进出初筛后行仍在、照样能补），对**「简历归属者」列为空且 `ownerMap[appId]` 有工号**的行收集进一次 `BatchUpdate` 补齐。
- **只补空、不覆写**：owner 一旦写过不再改（HR 换人暂不处理），保证幂等、写入最小、BatchUpdate 保持小。
- **自愈**：任意一轮只要报表终于收录某 appId，下一轮回填即补上，5–20 分钟滞后被完全吸收。

**为何放在 `RunCandidatePoll` 内、不新建独立 owner-sync job**：候选人轮询任务已加载 `ListFields`(fieldTypes) + `ListRecordsByID`(全表 records) + `appId→recordID` 索引 + lark client，回填复用这些，边际成本仅一次报表拉取 + 一次 BatchUpdate。新建独立 job 会重复一遍全表扫描、多一个 cron 与一份代码，而 owner 报表与候选表本就是该任务的地盘，独立节奏无价值，故不拆。**不改 skip-once**：插入去重逻辑不动，回填是另加的一条纯增量 update 通道。

**7 天窗口在 Moka 报表定义侧**：`GetReportData` 只有 `reportId` 参数、无时间过滤，故「只留最近 7 天」由 Moka 后台把该报表配成滚动 7 天视图实现，代码只消费返回行、不做截断。

**列定位**：报表按 header title 定位 dataIndex——join 键列标题为「申请」（同需求3），HR 邮箱列标题经 sys_config `owner_email_column` 配置，默认「简历接收邮箱」。

降级与附件同款：报表拉取失败/appId 未命中报表/邮箱未配映射/工号解析不到 open_id → 跳过该列（插入与回填均如此），不阻断其余字段写入与 Redis 入队。

**新增 sys_config 键（3 个）**：

| 键                    | 类型                | 说明                                                                        |
| --------------------- | ------------------- | --------------------------------------------------------------------------- |
| `owner_report_id`     | int64               | owner 报表 ID（独立于 `recruit_report_ids`，未配置则跳过 owner 取值与回填） |
| `owner_email_column`  | string              | 报表内 HR 邮箱列标题，默认「简历接收邮箱」                                  |
| `owner_email_mapping` | JSON `{email:工号}` | ~10 个 HR 的邮箱→工号映射                                                   |

「简历归属者」目标列名仍复用既有 `field_mapping.resume_owner`（默认「简历归属者」）。

选型（工号→open_id 段，沿用原结论）：

- **A（选定）复用 empcap `MapLarkOpenIDsByEmployeeNo` + `LarkOpenIDResolverByEmployeeNos`**：与需求2 面试官人员字段同款机制，仅查找键为工号。零新 Lark 调用路径。
- **B 飞书 getUserId（email→open_id）**：`owner.email` 经 `POST /contact/v3/users/get_id` 直转 open_id，O(1) 不依赖 employee-core。但引入新 Lark 调用路径与新权限，与现有人员字段写入选型不统一；且用户已明确按工号匹配，故不取。

取 A。定时任务每次构建 lark client 触发一次 employee+lark_identity 全表 JOIN；候选人轮询频率不高可接受，如成瓶颈可插件级缓存 resolver（带 TTL，仿 `sharedMoka`/`sharedRedis` 单例）——实现阶段视实测决定。

**跨 change 依赖**：`empcap.Service.MapLarkOpenIDsByEmployeeNo` 与 facade `LarkOpenIDResolverByEmployeeNos` 属 `linapro-employee-core` change 的新增（JOIN employee.moka_employee_no→lark_identity.open_id，按 lark_app_id 过滤，跨租户、own+assoc 全返回、双租户同人多个 open_id 全返回），须先落地；recruit-pipeline 依赖之。

**需求2/需求3 字段级差异规划器（插件内自写，不复用 report-sync 的 `syncer.Plan`）**

需求2、需求3 命中唯一键后原为**无条件整行重写**，稳态下每轮把大量未变更行重复写回飞书、刷新 `update_time`、放大写入量与限流压力。改为插件内共享**差异规划器**（`backend/job/plan.go`，纯函数、无 SDK/IO）：命中后仅在存在差异列时产出只含差异列的 `UpdateOp`，无差异则冻结（跳过）；日志区分「新建/更新/冻结」。关键决策：

- **不复用 report-sync 的 `syncer.Plan`**：其 `diffFields` 用 `v == "" { continue }` 跳过空值（报表语义：Moka 空值不清飞书已有值），而本 change 的未应约原因列要求「空串=显式清列」**必须让空值参与比差**，语义相反；键组成列来源、人员列解析时机也不同。参数化一个跨两插件公共函数会开出多个开关，比两份独立实现更难读；且共享库 `linapro-lark-sdk` 定位「只序列化、不做业务判断」，差异判定是业务决策，塞进去破坏边界。人员列判等（去重/顺序无关/忽略空 id/双空相等）约二十行照抄进插件，比跨插件建包便宜。
- **按飞书列类型分派做强类型比对，不做纯字符串比对**：回读侧统一是字符串，但飞书 SDK 把 JSON number 解码为 `float64`，字符串化后日期/数字会出现科学计数法、尾零/精度差异、大整数假阳性。规划器按 `fieldTypes`（`ListFields` 权威类型）分派——`TypeDateTime` 两侧 `ParseEpochMillisUTC`→int64 毫秒相等；`TypeNumber` 两侧 `ParseFloat`→float64 相等；`TypeUser` 按 open_id 集合相等；其它/文本两侧 `TrimSpace` 后字符串相等。`ParseFloat` 天然消化科学计数法，无需注入 `Stringify`。数字列两侧同源（飞书存的就是上轮写入值）round-trip 回来仍是同一 `float64`，精确相等安全。
- **`ListRecordsByID` 补人员列 open_id 集合旁路**：人员列（面试官）经 `Persons` 旁路以 open_id 写入，回读侧需拿到 open_id 集合才能比差；该旁路由共享库 `linapro-lark-sdk` 的 `ListRecordsByID` 提供（见 `extract-shared-lark-sdk`），recruit 侧两处调用点适配返回类型变更。
- **未应约原因列无条件写**：`attended` 为真时写空串以显式清列、为假时写归档原因，使该列恒定参与比差，消除「有时写、有时不写」的比对特例。

## Risks / Trade-offs

- **Bitable AI 字段计算时间不确定** → 阈值默认 5 分钟，AI 为空时保留队列不误判，属已知可接受风险。
- **Redis 不可用** → 候选人轮询任务仍写 Bitable 但漏入队，该候选人不会被 AI 判定推进；已加告警日志，运维需保障 Redis 可用性。安全网 TTL（默认 72h）兜底防止漏删堆积。
- **需求3 applicationId 重复** → 多个报表中同一 applicationId 的新建按 applicationId 合并、更新按 recordID 合并，避免重复行。
- **定时轮询去重保证**：按 applicationId 匹配的 upsert 保证幂等（同一 applicationId 更新同一行、重复入队对 Redis pending 集合幂等）。
- **owner 报表滞后（5–20 分钟）** → 新候选人首次写入拿不到 owner，靠每轮回填补空自愈；只补空不覆写，HR 换人不回改。若某 appId 始终不在报表（如报表 7 天窗口已滚出），其 owner 列保持空，属已知可接受降级。
- **owner 报表全量拉取成本** → `GetReportData` 无分页/过滤，每轮拉全表；靠 Moka 报表侧配成滚动 7 天视图控制体积，如仍过大需 Moka 侧进一步收窄。

## Open Questions

- Bitable 表中 `ai_verdict` 字段的确切列名——**已落地**：列名经 sys_config `ai_verdict_field` 可调（默认「AI评估结论」），排除值列表经 `ai_verdict_excluded` 可调（默认「建议淘汰/无匹配类型/谨慎考虑」），不再硬编码。
- 需求3 目标回写列名（「人才画像总分」等）的飞书字段名需业务侧确认后写入 sys_config。
- Redis 部署形态（与主框架共用实例 vs 插件专用实例、是否需要独立 DB index）待运维确认，当前通过 `redis.db` 配置项支持逻辑库隔离。
- 归属人来源——**已修订**：原假设 `basicInfo.owner` 内联返回，生产实测恒为 `nil`，改从 owner 报表（`owner_report_id`）取「简历接收邮箱」列，经 `owner_email_mapping`（email→工号）解析后按工号写「简历归属者」；owner 报表滞后靠每轮回填补空。详见「简历归属者人员字段」小节。
- **（FB-7）`interviewInfo` 非空时的确切 JSON 结构**：Moka `ehrApplications` 返回样例中 `interviewInfo` 为 `null`（该候选人无面试）。实现按业务字段（roundName / interviewType / startTime / intervieweeVideoUrl / status）逐轮建模，并做容错解析（对象或数组、字段缺失容忍），**须在集成阶段用真实含面试候选人的响应核对结构后固化**。
- **（FB-7）`basicInfo.archiveReasons` 的类型**：Moka 文档标注为 `string`（归档原因），但反馈描述为 `archiveReasons.name`。实现按「字符串或含 `name` 字段的对象」两种形态容错解析，须用真实归档候选人响应核对。
- **（FB-7）`interview-information` 接口 `email` 语义**：确认为组织管理员邮箱（`operatorEmail`），随请求 `applicationIds` 批量查询；批量上限沿用 50，实测后可调整。
