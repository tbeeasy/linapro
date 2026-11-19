## 1. 共享 SDK：文本与文件能力

- [x] 1.1 把 `larkim/client.go` 中 `SendInteractiveCard` 的请求构造抽成私有
      `createMessage(ctx, receiveIDType, receiveID, msgType, content)`，原方法改为薄封装，
      保证既有卡片行为与错误信息不变
- [x] 1.2 新增 `larkim/text.go`：`SendText(ctx, receiveIDType, receiveID, text)`
      （`msg_type=text`）+ `BuildTextContent(text)`（严格 JSON 转义、长度上限校验）
- [x] 1.3 新增 `larkim/file.go`：`UploadFile` / `UploadImage` / `SendFile` / `SendImage`、
      `FileTypeOf`、`IsUploadableImage`、`MaxFileBytes` / `MaxImageBytes`；上传沿用最小接缝
      便于单测，失败返回结构化飞书错误
- [x] 1.4 补单测：文本覆盖正常发送、飞书错误映射、含引号/反斜杠/换行/emoji 的文本编码、
      空文本与超长文本报错；文件覆盖扩展名映射、按内容识别图片、上传参数与 key、空 / 超限不发请求
- [x] 1.5 更新 `linapro-lark-sdk/README.md` 与 `README.zh-CN.md`，补充 `larkim` 文本与文件能力
      （不改动 SDK 的配置职责：飞书配置解析归各插件自己）

## 2. employee-core：user_id 正向寻址（凭据读取不变）

- [x] 2.1 确认 `backend/internal/lark/credential.go` 保持读本插件私有键
      `plugin.linapro-employee-core.lark_apps`（不迁移、不共享，因推送链路不需要身份应用密钥）
- [x] 2.2 为 2.1 补单测：私有键读取、配置缺失返回空清单、结构非法报错、凭据解析失败关闭
- [x] 2.3 在 `backend/cap/empcap/empcap.go` 新增 `LarkUserIDIndex` 类型与
      `MapOwnLarkUserIDsByEmployeeNo(ctx, larkAppID)` 接口方法，写明三态语义与碰撞不静默取值
- [x] 2.4 在 `backend/internal/service/employee/employee.go` 实现该方法：照
      `MapOwnLarkOpenIDsByEmployeeNo` 的 JOIN 写法，过滤 `id_source='own'` 且
      `lark_user_id <> ''`，产出 `ByEmployeeNo` / `BlankEmployeeNos` / `CollidedEmployeeNos`
      三个互不相交的集合（工号为空的行不计入）
- [x] 2.5 为 2.4 补单测（把「rows → index」的装配逻辑抽成纯函数后测试三态、碰撞与集合互斥）
- [x] 2.6 在 `empcap_facade.go` 增加与 `LarkOpenIDResolverByEmployeeNos` 对齐的便捷闭包
      （按需），并更新 `empcap_facade_test.go` 的 fake 实现以编译通过

## 3. 主仓配置：新增推送应用私有段

- [x] 3.1 在 `apps/lina-core/manifest/config/config.template.yaml` 的
      `plugin.linapro-lark-push` 下新增 `push_groups` 段（含字段注释与「推送应用不得复用
      登录应用」说明），`linapro-employee-core.lark_apps` 保持原样
- [x] 3.2 同步 `apps/lina-core/internal/packed/manifest/config/config.template.yaml`
- [x] 3.3 同步 `apps/lina-core/manifest/config/config.online.yaml`
- [x] 3.4 在 `apps/lina-core/manifest/config/config.yaml`（gitignored）写入本地开发用
      `push_groups` 占位（`identity_app_id` 填真实身份应用，凭据待补）
- [x] 3.5 验证：启动后登录换票与一轮全量同步正常（行为应与改造前完全一致），
      `lark_identity` 行数不变；`GET /open/v1/status` 能按分组列出推送应用台账

## 4. eval-360：卡片改经本插件投递

- [x] 4.1 删除 `backend/internal/notify/notify.go` 中的 `larkAppsConfigKey` 与
      `loadLarkApps`，卡片改调 `larkpushcap.SendCard`（`Group=linapro-eval-360`）
- [x] 4.2 卡片免登链接的 `larkAppId` 取该分组推送应用的 `identity_app_id`；
      `card_templates[].app_id` 改填该分组推送应用的 app_id
- [x] 4.3 更新 `notify_test.go` 为 `SendCard` 替身，断言收到 `Group` 与卡片内容
- [x] 4.4 验证：不读 employee-core 配置即可通过 `Precheck`，并对内部测试账号推送到一张卡片

## 5. 新插件骨架与进程内门面

- [x] 5.1 创建 `apps/lina-plugins/linapro-lark-push/`：`plugin.yaml`
      （`type: source`、`managed`、`platform_only`、`supports_multi_tenant: false`、
      `global`、声明 `dependencies.plugins` 含 linapro-employee-core）、
      `plugin_embed.go`、`go.mod`、`Makefile`、`hack/config.yaml`
- [x] 5.2 实现 `backend/cap/larkpushcap/`：`OwnerPluginID`、`Recipient`、`SendTextRequest`、
      `SendCardRequest`、`SendFileRequest`、`Delivery`、`SendResult`、`Sender` 接口、
      `BindSender` / `BoundSender` / 包级便捷函数
- [x] 5.3 实现 `larkpushcode` 错误码（未绑定 / 无可用推送应用 / 配置非法 / 参数非法 / 能力不可用 /
      签名类 / 请求体超限 / 部分失败），并按 `bizerr.MessageKey` 规则在
      `manifest/i18n/{zh-CN,en-US}/error.json` 补齐嵌套键
- [x] 5.4 实现发送编排 `backend/internal/service/send/`：参数校验 → 读分组配置 → 遍历
      分组推送应用 → 按 `identity_app_id` 调 empcap 查工号映射 → 逐收件人发送 → 汇总结果；
      单条失败不中断。主文件只留契约（`Service` 接口 + `serviceImpl` + `New`），实现按
      `send_text` / `send_card` / `send_file` / `send_request` / `send_dispatch` / `send_status` 拆分；
      运行期依赖经构造函数显式传入
- [x] 5.5 为编排补单测：两企业扇出且凭据交叉正确、某企业无身份只发另一家、user_id 为空跳过、
      其他员工 user_id 为空不影响本人、工号未找到、碰撞不发、单条失败不中断、无推送应用、
      纯 user_id 寻址、文本空/超长、收件人数量边界、卡片按应用构造与干跑
- [x] 5.6 在 `backend/plugin.go` 完成装配：构造实现并 `BindSender`，前置不可用时降级为
      nil 但不阻断插件注册
- [x] 5.7 验证：单元测试全绿；进程内调用对一个测试工号发通一条文本

## 6. 对外 HTTP 接口

- [x] 6.1 实现 `backend/internal/middleware/signature/`：HMAC-SHA256 验签、规范化待签串、
      常量时间比对、时间戳窗口、nonce 去重（宿主 `cachecap` 原子 `Incr`）、凭据查库 fail-closed
- [x] 6.2 为 6.1 补单测：签名放行、篡改方法 / 路径 / 查询串、时间戳过期与超前、nonce 重放、
      签名失败不消耗 nonce、app_key 未知、缺各请求头、凭据表与缓存不可用 503、
      签名后处理器仍能读到完整请求体
- [x] 6.3 实现 `backend/internal/middleware/bodylimit/`：按路由后缀在上限内读完请求体
      （multipart 解析到内存、其它换成可重复读取），超限 413、表单非法按参数错误
- [x] 6.4 实现 `backend/internal/middleware/bindlog/`：框架绑定失败时补记
      `request_id`、路径、凭据标识与请求体摘要（multipart 只记字段值与文件信息）
- [x] 6.5 实现 `api/push/v1`（`g.Meta` + `dc` / `eg`）与 `backend/internal/controller/push/`：
      文本、文件、自检三个接口，强类型 `(res, err)`，只返回结论与失败项
- [x] 6.6 在 `backend/plugin.go` 注册路由组 `/open/v1`，挂
      `NeverDoneCtx → HandlerResponse → RequestBodyLimit → signature → bodylimit → bindlog`，
      **不挂** `Auth/Tenancy/Permission`
- [x] 6.7 实现请求日志：`request_id`、`key_id`（不含密钥内容）、`group`、`push_app_id`、工号、
      状态、飞书 `code` 与 `req_id`；失败场景记录错误详情
- [x] 6.8 实现 `status` 自检端点：按「分组 × 推送应用」输出凭据齐备性、`identity_app_id` 有效性、
      可寻址员工数与空 `user_id` 员工数
- [x] 6.9 验证：curl 矩阵（缺签名头 / `app_key` 未知或停用 / 时间戳超窗 / nonce 重放 / 参数错误 →
      HTTP 200 + 各自 `errorCode`，凭据表或去重存储不可用 → 503，分组无可用推送应用 → 500，
      正常 → 200 且 `code` 为 0），两个企业各收到一条真机文本，且发送方机器人名是推送应用

## 7. 签名凭据后台管理

- [x] 7.1 新增 `manifest/sql/001-linapro-lark-push-api-key.sql`：`plugin_linapro_lark_push_api_key`
      建表（`app_key` 部分唯一索引 `WHERE deleted_at IS NULL`）、`chat_id` / `chat_push_app_id` 两列，
      附带卸载 SQL；`hack/config.yaml` 配置 dao 生成，`linactl dao` 生成 `dao` / `do` / `entity`
- [x] 7.2 实现 `backend/internal/service/apikey/`：`Service` 接口（List / Get / Create / Update /
      SetStatus / Delete / GetSecret / ListGroups / FindEnabledByAppKey）、参数规范化与校验
      （`secret` 新增必填、`chat_id` 格式、群聊推送应用须属于绑定分组）
- [x] 7.3 实现 `api/apikey/v1` 与控制器：8 个接口，权限点
      `linapro-lark-push:api-key:{list,add,edit,remove,secret}`；`plugin.yaml` 新增菜单
      「系统设置 → 飞书推送凭据」
- [x] 7.4 实现前端 `api-key-client.ts`、`api-key-management.vue`、
      `components/api-key-modal.vue`、`components/api-key-secret-modal.vue`
      （状态开关、查看密钥、新增预填随机 secret、群聊字段随分组联动）
- [x] 7.5 补测试：`apikey` 连库用例（新增必填 secret、列表不含 secret、app_key 唯一、分组校验、
      编辑留空保持 secret、启停影响鉴权查询、软删除后同名重建、群聊字段规范化）+ 前端 E2E
      `TC001-lark-push-api-key-management.ts`

## 8. 告警通道

- [x] 8.1 实现 `backend/internal/service/alert/`：独立配置块读取、8 类事件白名单、
      防抖（宿主 `cachecap.Incr`）、fail-open、不递归、`Enabled`
- [x] 8.2 在 `plugin.go` 与 `send` / `signature` 挂载告警点：装配失败、配置非法、无可用推送应用、
      empcap 未绑定、整表空 `user_id`、工号碰撞、凭据存储不可用、nonce 存储不可用；
      签名类错误与业务常态不告警
- [x] 8.3 补测试：`alert_test.go`、`alert_config_test.go`、`alert_notify_test.go`、
      `send_alert_test.go`、`signature_alert_test.go`

## 9. 集成测试与门禁

- [x] 9.1 新增 `larkim` 集成测试（`//go:build integration`）：按 flag 传入推送应用凭据与
      已知 user_id 真发一条；另用错误 user_id 验证错误映射；无 flag 时 `t.Skip`
- [x] 9.2 新增插件级集成测试（`//go:build integration`）：真实配置 → 真实 empcap → 真发一条，
      覆盖「user_id 权限 + 身份池 + 推送应用可见范围」三件套
- [x] 9.3 在 `apps/lina-core/manifest/config/config.yaml` 的 `plugin.autoEnable` 追加
      `linapro-lark-push`，位置必须在 `linapro-employee-core` 之后
- [x] 9.4 在 `hack/config.yaml` 的 `plugins.official.items` 补充插件条目（视发布渠道）
- [x] 9.5 编写 `README.md` 与 `README.zh-CN.md`：能力边界、配置键、签名算法与示例（Go / PHP / curl）、
      凭据后台管理与轮换、部署验收清单（`status` 绿 + 两企业各收一条 + 机器人名正确）
- [x] 9.6 运行 `make plugins.check`、`make lint`、`make test`，确保跨插件 import 与
      `dependencies.plugins` 声明合规；E2E `TC001-lark-push-api-key-management.ts` 实跑通过

## 10. 配置归属核对

- [x] 10.1 确认 4 份配置中不存在顶层 `lark` 段，`plugin.linapro-employee-core.lark_apps`
      原样保留
- [x] 10.2 确认 `plugin.linapro-lark-push.push_groups` 已写入 4 份配置
- [x] 10.3 确认 employee-core / eval-360 的配置读取代码为各自应有的形态
      （employee-core 读自己的私有键，eval-360 不再读 employee-core 的配置）
- [x] 10.4 核对 README、design、spec、proposal 中关于配置归属的描述与实现一致
