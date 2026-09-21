## 1. 插件脚手架

- [x] 1.1 在 `apps/lina-plugins/linapro-recruit-pipeline/` 创建目录结构：`backend/config/`、`backend/state/`、`backend/job/`、`manifest/i18n/en-US/`、`manifest/i18n/zh-CN/`（飞书 Bitable connector 复用共享库 `linapro-lark-sdk/larkbitable`，不在本插件内新建 `backend/lark/`）
- [x] 1.2 编写 `go.mod`，模块名 `lina-plugin-linapro-recruit-pipeline`，Go 版本与 `linapro-moka-recruit` 一致，添加对 `lina-plugin-linapro-moka-recruit`、`linapro-lark-sdk`、`lina-core`、`github.com/larksuite/oapi-sdk-go/v3`、`github.com/gogf/gf/v2`、`github.com/gogf/gf/contrib/nosql/redis/v2` 的依赖
- [x] 1.3 在根 `go.work` 中追加 `apps/lina-plugins/linapro-recruit-pipeline` 条目，并添加 `replace lina-plugin-linapro-recruit-pipeline => ./apps/lina-plugins/linapro-recruit-pipeline` 指令
- [x] 1.4 创建 `plugin.yaml`（参照 `linapro-moka-recruit/plugin.yaml`，id/name 改为 `linapro-recruit-pipeline`，type 为 `source`，description 说明"招聘流水线业务编排层"）
- [x] 1.5 创建 `plugin_embed.go`（同 `linapro-moka-recruit`，embed 空前端占位）
- [x] 1.6 创建 `backend/plugin.go`，注册插件入口，后续步骤的 HTTP endpoint 和定时任务在此注册；持有 Moka client 与 Redis `state.Store` 的懒加载单例
- [x] 1.7 创建 `manifest/i18n/en-US/plugin.json` 和 `zh-CN/plugin.json`（空对象 `{}`）
- [x] 1.8 创建 `frontend/.gitkeep` 和 `frontend/placeholder.txt`

## 2. 飞书 Bitable Connector（复用共享库 `linapro-lark-sdk/larkbitable`）

- [x] 2.1 创建 `linapro-lark-sdk/larkbitable`（`client.go`/`types.go`），声明 `Table`（AppToken string、TableID string）、`ExistingRecord`（RecordID string、Fields map[string]string）、`Row`（map[string]string）、`CreateOp`（Fields Row）、`UpdateOp`（RecordID string、Fields Row）类型，和 `Client` 结构体，实现 `NewClient(appID, appSecret string) *Client`（基于 `larksuite/oapi-sdk-go/v3`）
- [x] 2.2 实现 `(c *Client) ListFields(ctx, t Table) (map[string]int, error)`，支持分页（pageSize=500），批次间间隔 250ms
- [x] 2.3 实现 `(c *Client) ListRecords(ctx, t Table, uniqueField string) (map[string]ExistingRecord, error)`（按姓名列建索引）与 `(c *Client) ListRecordsByID(ctx, t Table) (map[string]Row, error)`（按 recordID 建索引，供 AI 判定任务查表），支持分页，空 uniqueField 值记录跳过
- [x] 2.4 实现 `(c *Client) BatchCreate(ctx, t Table, creates []CreateOp, fieldTypes map[string]int) ([]string, error)`，返回新建行的 recordID，单批不超过 1000 行，批次间间隔 250ms
- [x] 2.5 实现 `(c *Client) BatchUpdate(ctx, t Table, updates []UpdateOp, fieldTypes map[string]int) error`，单批不超过 1000 行，批次间间隔 250ms

## 3. 配置层

- [x] 3.1 创建 `backend/config/config.go`，定义 `Config` 结构体：LarkAppID、LarkAppSecret、BitableAppToken、BitableTableID（string）；MokaAPIKey、MokaBaseURL（string）；InterviewStageID（面试阶段，需求2 拉取来源，type=201）、DeptScreeningStageID（用人部门筛选，AI 判定通过后的推进目标，type=200）（int64，默认 105021/105020）；RecruitReportID（int64）；AIWaitMinutes（int，默认 5）；IntervalMinutes（int，默认 5）；ReportTargetColumns（[]string）；FieldMapping（map[string]string，逻辑字段→飞书列名，含默认值）
- [x] 3.2 实现 `Load(ctx, services) (*Config, error)`，从 `hostconfigcap` 读取静态凭证：飞书 `plugin.linapro-recruit-pipeline.lark.appId/.lark.appSecret`（与 report-sync 共用飞书应用，经 YAML anchor 合并），任一为空则返回 error；Moka BasicAuth 的 `plugin.linapro-recruit-pipeline.moka.apiKey` 与 `.moka.baseURL`
- [x] 3.3 在 `Load` 中从 `SysConfig` 读取 `recruit_bitable_app_token`、`recruit_bitable_table_id`、`recruit_report_id`、`ai_wait_minutes`、`interval_minutes`、`report_target_columns`（JSON 数组）、`field_mapping`（JSON 对象），不可用时使用默认值
- [x] 3.4 创建 `backend/state/config.go`，定义 `RedisConfig`（Address/Pass/DB/TTLHours）与 `LoadRedisConfig(ctx, hostconfigcap)`，从静态配置 `plugin.linapro-recruit-pipeline.redis.address/.pass/.db/.ttl_hours` 读取，TTLHours 默认 72

## 4. Redis 待判定队列（state 包）

- [x] 4.1 创建 `backend/state/redis.go`，基于 `gogf/gf` 的 `gredis` 建立连接（blank import `gogf/gf/contrib/nosql/redis/v2` 注册适配器），定义 `Store` 结构体持有 `*gredis.Redis` 与 TTL，实现 `New(cfg RedisConfig) (*Store, error)`（address 为空返回 error）与 `Close()`
- [x] 4.2 定义 Redis 键布局：Set `recruit:pending` 保存待判定 recordID，Hash `recruit:cand:<recordID>` 保存 `applicationId` + `analyzing_at`
- [x] 4.3 实现 `AddPending(ctx, recordID, appID, analyzingAtMs)`：HSet 详情 + SAdd 入集合 + 两键打安全网 TTL
- [x] 4.4 实现 `ListPending(ctx) ([]string, error)`（SMembers）、`GetPending(ctx, recordID) (appID, analyzingAtMs, ok, err)`（HGetAll，键失效返回 ok=false）、`Remove(ctx, recordID)`（SRem + Del）

## 5. 候选人采集与入队（需求1.1/1.2）

- [x] 5.1 在 `backend/plugin.go` 注册候选人轮询定时任务 `RunCandidatePoll`，默认每 5 分钟执行一次
- [x] 5.2 创建 `backend/job/candidate_poll.go`，调用 `EhrApplications` 按申请时间（昨日 0 点北京时间到当前时间）拉取初筛阶段（105019，type=100）候选人，从 `basicInfo` 提取 `applicationId`（int64，为 0 则跳过）、`candidateId`（int64）、`name` 等
- [x] 5.3 按 `field_mapping.applicationId`（applicationId 列）匹配 Bitable 现有行：命中则跳过（skip-once 去重），未命中则走完整流程（获取简历 → 下载附件 → 写 Bitable），upsert 后取得该行 recordID
- [x] 5.4 调用 `linapro-moka-recruit` 的 `GetResumeContent(ctx, applicationId)` 获取纯文本简历；成功则写入简历列，失败则仅写其余业务字段且不入队
- [x] 5.5 简历获取成功时调用 `state.Store.AddPending(recordID, applicationId, now_ms)` 入 Redis pending 队列；Redis 不可用时跳过入队并告警

## 5A. 简历附件同步（需求1.3）

- [x] 5A.1 在 `linapro-lark-sdk/larkbitable/client.go` 新增 `UploadMedia(ctx, appToken, fileName, size, r)`，调用 `drive/v1` UploadAllMedia（`parent_type=bitable_file`、`parent_node=appToken`）返回 `file_token`
- [x] 5A.2 `larkbitable` 写模型支持附件：`CreateOp`/`UpdateOp` 增加 `Attachments map[string][]string`，`rowToFields` 将附件列渲染为 `[]map[string]any{{"file_token": t}}`，`BatchCreate`/`BatchUpdate` 透传
- [x] 5A.3 `CandidateBasicInfo` 增加 `ResumeURL` 字段；`config` 包增加逻辑键常量 `FieldKeyResumeFile = "resume_file"`（候选人轮询任务特殊注入，附件列不走通用字段提取路径）
- [x] 5A.4 新建 `job/resume_file.go`：`downloadResume` 内存下载（30s 超时、`io.LimitReader` 20MB 上限、非 2xx 失败、不落盘）；`resumeFileName` 取候选人姓名 + 「-简历」后缀（姓名为空回退 `resume`），扩展名优先从 URL 路径推断、其次从响应 Content-Type 推断
- [x] 5A.5 `processCandidate` 中 `uploadResumeAttachment`：列已配置且 `ResumeURL` 非空时下载→上传→取 token；下载/上传失败降级（记 error、跳过附件列、不阻断入队），并入 `upsertBitable` 的 `Attachments`
- [x] 5A.6 `config/config.go` 默认 `field_mapping` 补 `"resume_file": "简历附件"`

## 6. AI 判定定时任务（需求1.5）

- [x] 6.1 在 `backend/plugin.go` 注册定时任务，默认每 1 分钟执行一次
- [x] 6.2 创建 `backend/job/ai_verdict.go`，调用 `state.Store.ListPending` 取全部待判定 recordID；为空直接返回
- [x] 6.3 一次性 `ListRecordsByID` 拉全表 + `ListFields`；逐项 `GetPending`：`ok=false` 则 `Remove`；`now - analyzing_at < AIWaitMinutes*60*1000`（毫秒）则本轮跳过；recordID 不在表中则 `Remove` 并告警
- [x] 6.4 读取 `ai_verdict` 字段：空值保留下轮再看；「推荐面试」则调 `MoveApplicationStage(applicationId, DeptScreeningStageID)` 推进到「用人部门筛选」阶段，成功后 `Remove`；其它非空值直接 `Remove`
- [x] 6.5 `MoveApplicationStage` 失败时记录 error 日志，保留队列项下轮重试；系统不淘汰候选人

## 7. 面试取消状态同步定时任务（需求2）

- [x] 7.1 在 `backend/plugin.go` 注册定时任务，间隔使用 `config.IntervalMinutes`，默认 5 分钟
- [x] 7.2 创建 `backend/job/interview_sync.go`，调用 `EhrApplications(ctx, []int64{config.InterviewStageID})` 拉取面试阶段候选人；结果为空时记录 info 日志直接返回
- [x] 7.3 从每条 `BasicInfo` 提取 `ApplicationID` 与 `Name`（建 appID→name 映射），按每批不超过 50 个调用 `GetInterviewInfos`，合并所有批次结果
- [x] 7.4 过滤 `Status == 3` 的记录，按候选人姓名匹配 Bitable 现有行回写：`interview_status`、`attend_status` 原值、`sync_at`（当前 UTC 毫秒时间戳）；姓名匹配不到则跳过

## 8. 报表评分回写定时任务（需求3）

- [x] 8.1 在 `backend/plugin.go` 注册定时任务，间隔复用 `config.IntervalMinutes`
- [x] 8.2 创建 `backend/job/report_sync.go`，检查 `config.RecruitReportID == 0` 时记录 warn 日志直接返回
- [x] 8.3 调用 `GetReportData(ctx, config.RecruitReportID)` 获取报表数据
- [x] 8.4 遍历 `headers` 按 `title` 匹配 `config.ReportTargetColumns`（nil 则回写所有列除姓名列），建立 `title → dataIndex` 映射；找不到的列记录 warn 日志跳过
- [x] 8.5 调用 `lark.Client.ListRecords` 加载 Bitable 现有记录，按姓名字段建立索引
- [x] 8.6 遍历 `rows`，按姓名匹配 Bitable 索引，匹配到则 `BatchUpdate` 回写目标列；找不到则记录 debug 日志跳过（不新增行）

## 9. 构建验证

- [x] 9.1 在工作区根执行 `go build ./apps/lina-plugins/linapro-recruit-pipeline/...`，构建成功
- [x] 9.2 在工作区根执行 `go vet ./apps/lina-plugins/linapro-recruit-pipeline/...`，无报错
- [x] 9.3 执行 `openspec validate --strict linapro-recruit-pipeline`，通过

## 10. 集成验证

- [ ] 10.1 集成验证：真实 Moka 凭证 + 真实飞书表 + 可用 Redis + 运行中宿主，端到端跑通简历流水线（候选人轮询入队 → AI 判定出队 → 推进面试）与报表评分回写，核对 Bitable 数据与 Redis 队列符合预期。**待执行**：需真实凭证与运行环境。

## Feedback

- [x] **FB-1**: recruit-pipeline 同步飞书多维表格新增 source（简历来源）字段，取自 `EhrApplications` 返回的 `basicInfo.source`
- [x] **FB-2**: AI 判定通过后推进目标阶段错误——修正为推进到「用人部门筛选」（`DeptScreeningStageID`）而非面试阶段；澄清 `ScreeningStageID`（简历初筛）仅为需求2 拉取来源、非推进目标；并将 `screening_stage_id`/`dept_screening_stage_id` 两个 sys_config 覆盖键接入 `loadSysConfig`
- [x] **FB-3**: 需求2「面试取消状态同步」从「面试」阶段（`InterviewStageID`，type=201，默认 105021）拉取候选人，将 `InterviewStageID` 接入 `loadSysConfig`（键 `interview_stage_id`）
- [x] **FB-4**: AI 判定推进逻辑错误且字段名/排除值硬编码——原实现仅在判定值等于「推荐面试」时推进，其余非空值全部出队不推进；应改为负向排除逻辑：非空且不在排除值列表中（「建议淘汰」「无匹配类型」「谨慎考虑」）即推进。同时将 AI 判定字段名（默认「AI评估结论」）和排除值列表提取到 `Config`，通过 sys_config 可调
- [x] **FB-5**: 报表同步（需求3）当前只读单表——`config.RecruitReportID`（sys_config `recruit_report_id`）仅一个报表 ID，但 HR 在 Moka 配置了多个报表；应改为多报表 ID 数组（sys_config `recruit_report_ids`，JSON int64 数组），`RunReportSync` 逐表 `GetReportData`、按 recordID 合并后统一一次 `BatchUpdate`，单表失败 warn 继续
- [x] **FB-6**: `RunAIVerdict`/`RunInterviewSync`/`RunReportSync` 三个任务当前共用单一 `recruit_bitable_table_id`，但真实飞书部署里候选人决策表、面试状态表、报表评分表是三张不同的表。拆分为三张表（同文档共用 `recruit_bitable_app_token`，table id 不同）：候选人决策表 `recruit_bitable_table_id`（候选人轮询 + AI 判定，因 recordID 回表必须同表）、面试状态表 `interview_bitable_table_id`（需求2）、报表评分表 `report_bitable_table_id`（需求3）；后两者未配置时回退候选人表 table id 保持单表兼容。更新 `Config`、`loadSysConfig` 与两处任务 table 装配，同步 spec/design
- [x] **FB-7**: 需求2「面试状态同步」方案重构——原实现按阶段 ID 经 `GetInterviewInfos(v3)` 拉取、过滤 status=3、按**姓名**回写应约/到场状态。改为两条路径，权威数据源改为 `EhrApplications` 的 `data[].interviewInfo`（逐面试轮次），归档原因取 `basicInfo.archiveReasons`，飞书匹配键从姓名改为 **`applicationId 字段 + 面试轮次`**：
  - **路径一（未归档 archived=false）**：逐轮提取 roundName/interviewType/startTime/intervieweeVideoUrl/status；`status=已取消`即未应约→取 archiveReasons 作未应约原因；已应约且视频面试→调 `GetInterviewInformation`（`POST /api-platform/v1/interview/interview-information`，入参 applicationIds+email）补 `entities[].intervieweeVideoUrl`。按 applicationId+轮次 upsert 面试方式/时间/视频链接/是否应约。
  - **路径二（已归档 archived=true + 昨日0点至今）**：服务端 `updateAtStartTime`/`updateAtEndTime`（北京时间）过滤，仅更新是否应约+未应约原因两列，不新建行。
  - 配套：`EhrApplications` 增加 `archived`/时间范围服务端过滤参数；新增 `GetInterviewInformation` client 方法；建模 `interviewInfo`/`archiveReasons`；`Config` 增加 `MokaOperatorEmail`（静态配置 `plugin.linapro-recruit-pipeline.moka.operatorEmail`）；`field_mapping` 增加 `applicationId`/`interview_round`/`interview_type`/`interview_time`/`video_url`/`attend_result`/`unattend_reason` 列，移除旧 `interview_status`/`attend_status`；host `config.yaml` 补 `operatorEmail`。同步 spec/design。
- [x] **FB-8**: 配置可读性整理——(1) 逻辑字段键抽为 `config` 包导出常量 `FieldKey*`，`defaultFieldMapping`/`resolveInterviewColumns`/候选人轮询字段提取逻辑共用，消除多处硬编码同一字符串；(2) `config.go` 配置键按「静态 host 配置 / sys_config / 默认值」三组重排，边界清晰；(3) 候选人决策表 sys_config 键 `recruit_bitable_table_id` 更名为 `candidate_bitable_table_id`，与 `interview_`/`report_bitable_table_id` 命名风格统一（Go 侧 `keyBitableTableID`→`keyCandidateBitableTableID`、`Config.BitableTableID`→`Config.CandidateBitableTableID`）。同步 spec/design（`recruit_bitable_app_token` 三表共用 App token 保持不变）。历史条目 3.3、FB-6 保留原文记录当时状态。
- [x] **FB-9**: 面试同步（需求2）与报表同步（需求3）定时任务轮询间隔拆为两个独立 sys_config 键与独立默认值——原共用 `interval_minutes`（`config.IntervalMinutes`）拆为 `interview_sync_interval_minutes` 与 `report_sync_interval_minutes`，两任务各自独立配置、互不影响；默认值也拆开不共用：`defaultInterviewSyncIntervalMinutes`(5) 与 `defaultReportSyncIntervalMinutes`(5)。Go 侧：`Config.IntervalMinutes`→`InterviewSyncIntervalMinutes`+`ReportSyncIntervalMinutes`；注册期读取函数 `config.IntervalMinutes()`→`config.InterviewSyncIntervalMinutes()`+`config.ReportSyncIntervalMinutes()`（共用私有 `intervalMinutesOrDefault(ctx, services, key, def)`，默认值经 def 参数传入）；`plugin.go` 两任务分别用各自间隔。历史条目 3.1、3.3、7.1、8.1 保留原文记录当时状态。
- [x] **FB-10**: 报表评分表（需求3）去回退 + 明确只更新语义——(1) `report_bitable_table_id` 未配置时**不再回退**候选人决策表，`RunReportSync` 直接记录 warn 日志跳过本轮，避免把报表评分误写进候选人决策表；(2) 保留原「按候选人姓名匹配现有行、命中更新目标评分列、未命中跳过（不新增行）」语义不变。Go 侧：`loadSysConfig` 报表表分支去掉 `else` 回退（保持空串），`RunReportSync` 增加 `cfg.ReportBitableTableID == ""` 跳过守卫；结构体/键注释同步。测试：新增 `TestRunReportSync_SkipsWhenReportTableUnconfigured`，`TestLoadSysConfig_TableIDFallback` 断言报表表未配置保持空串。同步 spec/design（修正此前误入的 applicationId 匹配 + create-on-no-match 描述，回归姓名匹配只更新）。
- [x] **FB-11**: 报表同步（需求3）匹配键改为 applicationId + 目标列固定三列 + 字段键统一 applicationId 命名——(1) 匹配键从「候选人姓名」改为 **applicationId**（Moka 报表「申请」列值，对应飞书表 `applicationId` 字段），未命中由「跳过」改为「新建行」；(2) 目标列由可配置的 `report_target_columns`（空则回写所有列）改为**固定三列**「姓名/人才画像评分/匹配度等级」，列名经 `field_mapping` 可调，不做全行覆盖；(3) 字段键 `FieldKeyReportApplication` 更名为 `FieldKeyReportApplicationID`（逻辑键 `report_application_id`），新增 `FieldKeyReportName`/`FieldKeyReportScore`/`FieldKeyReportMatchLevel`，默认映射「applicationId」「姓名」「人才画像评分」「匹配度等级」，移除 `ReportTargetColumns` 配置。同步 spec/design。
- [x] **FB-12**: 报表同步（需求3）列映射搞错导致目标列全部找不到——`mapReportColumns` 错误假设「Moka 报表列标题 == 飞书 Bitable 列名」，直接用飞书列名（姓名/人才画像评分/匹配度等级）去 Moka 报表 headers 的 `title` 里查找，但两侧列名不同（Moka 侧为 候选人/最终总分/匹配度定级备份），导致三列全部 warn「target column not found」被跳过。修复：(1) 报表列映射同时保存 **Moka 源列标题** 与 **飞书目标列名** 两侧；(2) 需求3 报表映射从 `field_mapping`（需求1/2 共用）中**独立拆出**为新的 sys_config 键 `report_field_mapping`（JSON 对象，key=Moka 报表列标题、value=飞书目标列名），默认 `{"申请":"applicationId","候选人":"姓名","最终总分":"人才画像评分","匹配度定级备份":"匹配度等级"}`；(3) `mapReportColumns` 按 Moka 标题（源）查 dataIndex、按飞书列名（目标）写回，`「申请」→applicationId` 作为唯一键单独处理。Go 侧：移除 `FieldKeyReport*` 常量与 `defaultFieldMapping` 中的 4 个报表项，新增 `defaultReportFieldMapping`/`keyReportFieldMapping`/`Config.ReportFieldMapping`，`resolveReportColumns` 改读 `cfg.ReportFieldMapping`。同步 spec/design。
- [x] **FB-13**: 候选人采集（需求1.1）匹配键从「候选人姓名」改为 **applicationId**——原实现按 `field_mapping.name` 匹配 Bitable 现有行（同名更新、否则新建）。改为：(1) 候选人轮询任务新增 `FieldKeyApplicationID`（`strconv.FormatInt(basicInfo.ApplicationID, 10)`），applicationId 作为业务列写入 Bitable；(2) 匹配改为 `ListRecordsByID` + `buildCandidateIndex`（applicationId 数值归一化，兼容数字列回读科学计数法），命中更新、未命中新建；(3) `upsertBitable` 匹配键由候选人姓名改为 applicationId。同步 spec/design。
- [x] **FB-14**: 报表同步（需求3）匹配度列改为多源列→单目标列合并——匹配度列来自三个不同报表数据源，各表字段名无法统一，分别命名为「匹配度等级-初/中/高」，但飞书报表评分表只有一列「匹配度等级」。`defaultReportFieldMapping` 把「匹配度定级备份」一项替换为「匹配度等级-初/中/高」三项、均映射到飞书「匹配度等级」（多源列→单目标列，天然被 `map[Moka标题]飞书列名` 结构支持）。同一候选人在多报表命中时按 recordID 合并、后出现报表覆盖先出现值。同步 spec。
- [x] **FB-15**: 报表同步（需求3）多源列缺失告警刷屏——FB-14 后每个报表只含匹配度三源列（初/中/高）之一，另两源列必然缺失，`mapReportColumns` 逐个源列判断、缺失即 warn，导致每轮刷两条 `source column "匹配度等级-X" not found`。改为**按飞书目标列（value）分组**候选 Moka 源列（key，运行时从 `cols.values` 反向聚合、不写死列名）：任一候选源列命中即视为该目标列成功；仅当某目标列的**全部**候选源列都缺失时才记录一条 warn（文案改为按目标列聚合 + 列出候选源列）。单源列组行为不变。同一组多源列同表并存时取首个命中（业务上三数据源分属三报表、单表只含一个匹配度列，不会并存）。同步 spec。
- [x] **FB-16**: AI 判定任务（需求1.5）读表由全表扫描改为按 pending recordID 精准批量读取——原 `RunAIVerdict` 每轮用 `ListRecordsByID` 一次性拉取候选人决策表全部行仅为查出 Redis pending 队列里的少量待判定记录，历史候选人累积后全表分页请求数/流量/耗时线性增长。改为调用共享库新增的 `BatchGetByIDs(pendingIDs)`（依赖 `linapro-lark-sdk` change 7.x），只拉 pending 行；`bitableClient` 接口的 `ListRecordsByID` 换成 `BatchGetByIDs([]string) (map[string]Row, []string, error)`；「行已删除→出队」清理由返回的 `absent_record_ids` 驱动，替代原「遍历全表索引判断 exists」。保留 Redis 待办清单语义，不新增 Bitable 字段。`ai_verdict_test.go` 的 fake client 适配新接口。同步 spec。
- [x] **FB-17**: 候选人采集（需求1.4·归属者）新增「简历归属者」人员字段——`EhrApplications` 返回的 `basicInfo.owners` 内联归属人（name/phone/email/employee_id 工号），无需另从 Moka 报表拉取或做邮箱→中文名转换。**匹配键从「姓名」改为工号 `owners.employee_id`**（Moka 工号是 employee 表 `moka_employee_no` 的直接外键，无姓名归一/同名歧义）。`CandidateBasicInfo` 增加 `Owners` 子结构（Name/Phone/Email/EmployeeID）；候选人轮询任务新增 `FieldKeyResumeOwner` 取 `basicInfo.Owners.EmployeeID`（工号字符串）；注入 `empcap.LarkOpenIDResolverByEmployeeNos(ctx, cfg.LarkAppID)`（与需求2 面试官人员字段同款机制，但按工号而非姓名解析 open_id），`Encoder.UserIDType=open_id`，把工号解析为写表格应用作用域下的 open_id 后以 `[{id}]` 写入「简历归属者」人员列（`field_mapping.resume_owner`，默认「简历归属者」）。owners 缺失/工号为空/解析不到 open_id 时跳过该列，不阻断其余字段写入与 Redis 入队。`config` 增加 `FieldKeyResumeOwner` 常量与默认映射 `resume_owner→简历归属者`。**跨 change 依赖**：`empcap.LarkOpenIDResolverByEmployeeNos` 与底层 `Service.MapLarkOpenIDsByEmployeeNo` 属 `linapro-employee-core` change 待新增（JOIN employee.moka_employee_no→lark_identity.open_id，按 lark_app_id 过滤、跨租户、own+assoc 全返回），须先落地。同步 spec/design。
- [x] **FB-18**: 「简历归属者」假设失效修订——归属者改从 owner 报表取 + 回填（**取代 FB-17 的 `basicInfo.owner` 内联假设**）。生产实测 `EhrApplications` 的 `basicInfo.owner` 恒为 `nil`，且 owner 报表非实时（5–20 分钟刷新）叠加轮询 skip-once 去重，故归属者取值改为**报表 + 回填**语义，全部落在 `RunCandidatePoll` 内、不新建定时任务、不改 skip-once。拆为独立需求「需求1.4·归属者回填」。
  - [x] **18.1 config**：新增 3 个 sys_config 键与对应 `Config` 字段——`owner_report_id`（int64，owner 报表 ID，独立于 `recruit_report_ids`，未配置则跳过归属者取值与回填）、`owner_email_column`（string，报表 HR 邮箱列标题，默认「简历接收邮箱」）、`owner_email_mapping`（JSON `{email:工号}`，约 10 个 HR、邮箱唯一）；`loadSysConfig` 解析三键，`owner_email_mapping` 的 key 存前 `TrimSpace+ToLower` 归一化。
  - [x] **18.2 报表取数**：在 `candidate_poll.go` 新增 `loadOwnerMap(ctx, mokaClient, cfg)`——`GetReportData(cfg.OwnerReportID)`，按报表「申请」列（applicationId，同需求3 固定标题 `ReportSourceApplicationTitle`）与 `owner_email_column` 列标题定位 dataIndex，遍历 rows 建 `applicationId → 工号`（HR 邮箱 `TrimSpace+ToLower` 后查 `owner_email_mapping`）；报表拉取失败/缺列记 warning 返回空 map（不阻断轮询）。
  - [x] **18.3 插入路径**：`buildRowFromBasicInfo` 移除对 `info.Owner`（恒 nil 死分支）的读取，改为入参传入 `ownerEmployeeNo string`；`processCandidate` 从 `ownerMap[appID]` 取工号传入，命中即写「简历归属者」，未命中留空。
  - [x] **18.4 回填路径**：`RunCandidatePoll` 在新候选人插入循环后，遍历已加载的候选表全表 `records`，对 `field_mapping.resume_owner` 列**为空**且 `ownerMap[appID]` 有工号的行收集 `lark.UpdateOp`，一次 `BatchUpdate` 补齐。**只补空、不覆写**（读回 records 时 person 列已按 fieldTypes 解码为姓名，空串即视为未写）。复用已加载的 `fieldTypes`/`records`/lark client，不重复扫表。
  - [x] **18.5 降级**：`owner_report_id` 未配置、报表失败、appID 未命中报表、邮箱未配映射、工号解析不到 open_id、`resume_owner` 未配置——均跳过该列，不阻断其余字段写入与 Redis 入队。
  - [x] **18.6 验证**：`go build` / `go vet` / `openspec validate --strict`；单测覆盖 `loadOwnerMap`（邮箱归一化、缺列降级）与回填「只补空不覆写」。
  - **跨 change 依赖**：`empcap.LarkOpenIDResolverByEmployeeNos`（多工号版，工号→open_id）沿用，无新增。owner 报表 7 天窗口由 Moka 报表定义侧配置。同步 spec/design（已完成）。

## 消费方迁移：人员列身份解析归位（Persons 旁路）

- [x] **FB-20**: 人员列（「简历归属者」/「面试官」）的身份解析在插件侧完成一次，经 `CreateOp.Persons`/`UpdateOp.Persons` 旁路写入共享库（人员列不进 `Row`）。要点：`candidate_poll.go` 的 `buildRowFromBasicInfo` 不写归属者列，新增 `buildOwnerPersons` 产出 open_id 集合旁路；`collectOwnerBackfill` 增加解析器参数、产出 `UpdateOp.Persons`（解析不到的行不补，保持只补空、不写空值）；`interview_sync.go` 面试官列同款改造，多工号合并去重上收 empcap（本插件不再自持 `multiEmployeeNoResolver`）；两处 encoder 只设 `UserIDType=open_id`；解析器统一用 empcap 复数版 `LarkOpenIDResolverByEmployeeNos`。验证：`go test ./... -count=1` 全绿（新增 `TestBuildInterviewerPersons`，回填与面试同步用例断言改为 `Persons` 旁路）、`make lint dir=apps/lina-plugins/linapro-recruit-pipeline plugins=0` 0 issues。DI 来源检查：未新增运行期依赖——解析器仍为任务开始时经 empcap 门面构造一次的闭包（owner=linapro-employee-core，复用启动期绑定的员工服务实例），无新增构造路径。

## 14. 字段级差异规划器（需求2/需求3 共用）

- [x] 14.1 新增 `job/plan.go`：纯函数规划器（无 SDK/IO），输入 desired rows、现有记录（含人员旁路）、唯一键索引、`fieldTypes`，输出 `{Creates, Updates, Frozen}`；`UpdateOp` 只含差异列
- [x] 14.2 比对按飞书列类型分派做强类型比对：`TypeDateTime` 两侧 `lark.ParseEpochMillisUTC` → int64 相等；`TypeNumber` 两侧 `strconv.ParseFloat` → float64 相等；`TypeUser` 按 open_id 集合比对（去重、顺序无关、忽略空 id、双方空集相等，比对回读 open_id 集合 vs 期望集合，不用姓名文本）；其它/文本列两侧 `TrimSpace` 后字符串比对
- [x] 14.3 比差范围恒定为「待写集合的键 ∩ 表内该列」，不做空值过滤（空串=显式清列，须参与比差）
- [x] 14.4 新增 `job/plan_test.go`：未变冻结、单列变只写该列、人员列 open_id 集合等价冻结、日期 int64 等价冻结、数字 float64 等价冻结（回读 `"90"` vs 报表 `"90.0"`）、空串清列产生更新
- [x] 14.5 需求3 `report_sync.go` 接入规划器：保留「构建 desired row」，命中/新建判定与差异计算改由规划器完成；新建按 applicationId 合并、更新按 recordID 合并；日志区分「新建/更新/冻结」计数；更新 `report_sync_test.go`
- [x] 14.6 需求2 `interview_sync.go` 两条路径接入规划器；未应约原因列改为无条件写（`attended` 时写空串清列）；面试官人员列仅在 id 集合相对现有行变更时纳入更新，解析降级时该列本轮不写；日志区分三类计数；更新 `interview_sync_test.go`
- [x] 14.7 验证：两模块 `go build`/`go vet`/`go test ./... -count=1` 全绿，`make lint dir=apps/lina-plugins/linapro-recruit-pipeline plugins=0` 0 issues
