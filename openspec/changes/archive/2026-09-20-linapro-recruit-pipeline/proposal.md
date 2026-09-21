## Why

需要新建 `linapro-recruit-pipeline` 插件作为招聘流水线业务编排层，同时实现三条招聘业务需求：需求1（简历流水线：候选人采集 → AI 判定 → 推进面试阶段）、需求2（定时同步面试取消状态）、需求3（定时同步报表评分回写）。三条需求共用同一个插件和同一张 Bitable 招聘决策表，从插件骨架到业务逻辑全部在本 change 内完成。

需求1 落地时按执行单元细分为 1.1~1.5，分属两个定时任务：**候选人轮询任务**含 1.1 候选人轮询采集、1.2 简历获取与入队、1.3 简历附件同步、1.4 简历归属者回填；**AI 判定任务**为 1.5 AI 判定推进。

## What Changes

- 新建 `linapro-recruit-pipeline` 插件骨架（go.mod、plugin.yaml、plugin_embed.go、plugin.go），在根 `go.work` 中注册，依赖 `lina-plugin-linapro-moka-recruit`。
- 复用共享库 `linapro-lark-sdk/larkbitable` 的飞书 Bitable connector（基于 `larksuite/oapi-sdk-go/v3`）：ListFields、ListRecords（按指定唯一字段建索引）、ListRecordsByID（按 recordID 建索引）、BatchGetByIDs（按 recordID 批量精准读取）、BatchCreate、BatchUpdate、UploadMedia，批次间 250ms 节流，单批不超过 1000 行。
- 在 `backend/state/` 定义 Redis 状态层：从 `hostconfigcap` 读取 `plugin.linapro-recruit-pipeline.redis.*`（address/pass/db/ttl_hours），基于 `gogf/gf` 的 `gredis` 建立**长驻单例**连接池，用 Set（`recruit:pending`）+ Hash（`recruit:cand:<recordID>`）保存「待获取 AI 分析结果」的候选人队列，键带安全网 TTL（默认 72h）。
- 在 `backend/config/` 定义业务配置层，从 `hostconfigcap` 读取飞书凭证、Moka 凭证、Bitable 目标表、stageId、reportId、等待阈值、`field_mapping`（逻辑字段→飞书列名）等。
- 需求1.1/1.2（候选人采集与入队）：注册候选人轮询定时任务 `RunCandidatePoll`，从 `EhrApplications` 拉取初筛阶段候选人，获取简历写 Bitable，**将该行 recordID + applicationId + analyzing_at 入 Redis pending 队列**。
- 需求1.5（AI 判定推进）：注册 AI 判定定时任务 `RunAIVerdict`，**从 Redis 队列取待判定项**，等待窗口到期后读 Bitable 的 AI 判定字段，非空且不在排除列表则推进到「用人部门筛选」阶段，命中排除列表则出队，AI 未出结果则保留下轮再看，全程不淘汰候选人。
- 需求1.3（简历附件）：候选人轮询任务从 `basicInfo.resumeUrl`（48h 有效下载链接）下载简历原文件到内存，转存到飞书云盘（`drive/v1` UploadAllMedia，`parent_type=bitable_file`、`parent_node=BitableAppToken`）取得 `file_token`，写入 Bitable「简历附件」列（列名经 `field_mapping.resume_file` 配置）。下载/上传失败优雅降级，仅跳过附件列，不阻断其余字段写入与 AI 入队。
- 需求1.4（简历归属者回填）：`basicInfo.owner` 生产实测恒为 `nil`，归属人改从 Moka **owner 报表**（`owner_report_id`）取「简历接收邮箱」列（`owner_email_column`），经 `owner_email_mapping`（email→工号）转工号，再经 `empcap.LarkOpenIDResolverByEmployeeNos`（按 `cfg.LarkAppID` 作用域）解析为去重 open_id 集合后经 `CreateOp/UpdateOp.Persons` 旁路以 `[{id}]` 写入 Bitable「简历归属者」人员字段（`field_mapping.resume_owner`）。因报表滞后（5–20 分钟）叠加 skip-once，写入为**回填**语义（插入命中即写 + 遍历全表补空，只补空不覆写），全部在候选人轮询任务内，不新建定时任务。报表拉取失败/未命中/邮箱未配/解析空时跳过该列，不阻断其余字段与 AI 入队。依赖 `linapro-employee-core` change 新增 `MapLarkOpenIDsByEmployeeNo` 方法。
- 需求2：注册定时任务，拉取面试阶段候选人（`InterviewStageID`，type=201，默认 105021，非简历初筛 105019）→ 逐面试轮次提取面试信息 → 按 `applicationId + 面试轮次` 组合键匹配 Bitable 记录回写（未命中新建/跳过，命中更新）。
- 需求3：注册定时任务，从 sys_config 读多个 reportId（`recruit_report_ids` JSON 数组）→ 逐表调招聘域 `GetReportData` → 动态解析 headers → 按 applicationId 匹配 Bitable 记录（未命中新建）→ 合并后统一回写评分列。
- 需求2 与需求3 共用**插件内字段级差异规划器**（`backend/job/plan.go`，纯函数、无 SDK/IO）：命中唯一键后按飞书列类型（`ListFields` 权威类型）分派强类型比对——文本列 `TrimSpace` 后比对、日期列两侧归一到 `int64` 毫秒、数字列两侧 `float64`、人员列按 open_id 集合（顺序无关、去重、忽略空 id）——仅当存在差异列时产出只含差异列的 `UpdateOp`，无差异则冻结（跳过），稳态下不再整行重写飞书。未应约原因列改为无条件写（已应约写空串以显式清列），使比差范围恒定。人员列（面试官）的 open_id 集合比对依赖共享库 `linapro-lark-sdk` 的 `ListRecordsByID` 人员列回读旁路（见 `extract-shared-lark-sdk`）。定时任务日志区分「新建 / 更新 / 冻结」三类计数。

## Capabilities

### New Capabilities

- `linapro-recruit-pipeline`：该插件内的三条招聘业务流水线，含候选人轮询任务、Redis 待判定队列、AI 判定定时任务、面试取消状态同步任务、报表评分回写任务，以及需求2/需求3 共用的字段级差异规划器（命中唯一键后按列类型强类型比差、只写差异列、无变更冻结）。

### Modified Capabilities

（无）

## Impact

- 影响范围：`apps/lina-plugins/linapro-recruit-pipeline/backend/` 内新增候选人轮询任务、Redis 状态层（`state` 包）、三个定时任务实现。
- 依赖 `linapro-moka-recruit` 提供的 `GetResumeContent`、`EhrApplications`、`MoveApplicationStage`、`GetReportData` 接口。
- 依赖插件骨架提供的 `lark.Client`、`config.Load` 与 `state.Store`。
- 代码：新增 `backend/job/plan.go`（字段级差异规划器）及其单测；`job/report_sync.go`、`job/interview_sync.go` 接入规划器（命中/新建判定与差异计算改由规划器完成）。稳态下面试/报表同步的 Bitable 写入量显著下降（未变更行不再重写），下游依赖 `update_time` 的判断不再被无谓刷新。依赖 `linapro-lark-sdk` 的 `ListRecordsByID` 人员列回读旁路（`extract-shared-lark-sdk` 提供），两处调用点适配其返回类型变更。不复用/不合并 `linapro-moka-report-sync` 的 `syncer.Plan`（语义相反：其空值跳过，本插件空串=显式清列）。
- 新增出站依赖：候选人轮询任务需能 HTTP GET Moka `resumeUrl`（阿里云 OSS 等外链）并调用飞书云盘 `drive/v1` UploadAllMedia，简历原文件仅在内存中转存、不落盘。附件列名经 `field_mapping.resume_file`（默认「简历附件」）配置。
- 新增一处 Redis 依赖：需在 host 静态配置提供 `plugin.linapro-recruit-pipeline.redis.address`（及可选 pass/db/ttl_hours）；Redis 不可用时轮询任务仍写 Bitable，仅跳过 AI 待判定入队，AI 判定任务当轮跳过（优雅降级）。
- 合规红线：AI 字段仅作建议，命中排除列表（默认「建议淘汰/无匹配类型/谨慎考虑」）一律出队不推进，系统不自动淘汰候选人。
