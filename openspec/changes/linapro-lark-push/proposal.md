## Why

系统里没有独立的「飞书消息推送」能力：`linapro-lark-sdk/larkim` 只提供交互卡片发送
（`SendInteractiveCard`），唯一的推送实现是 `linapro-eval-360/backend/internal/notify`
里与业务深度耦合的编排。其它插件想发一条飞书文本无处可调，外部系统更没有入口。

预警、告警类消息需要与考勤/登录应用的机器人分开投递（机器人名字不同、责任边界不同），
而现在所有飞书凭据都寄居在 employee-core 私有的 `plugin.linapro-employee-core.lark_apps`
下，无法表达「推送应用」这一独立角色。

需要注意：推送链路只需要**推送应用**的凭据。寻址是按 `lark_app_id` 查 `lark_identity`
得到企业级 `user_id`，不涉及身份应用的密钥。因此推送应用凭据落在新插件自己的私有配置键
即可，无需迁移或共享 employee-core 的配置。

## What Changes

- **新增纯能力插件 `linapro-lark-push`**（无菜单、无页面）：提供进程内 Go 门面
  `larkpushcap`，按 `user_id` 向飞书用户发送文本消息。
- **新增对外 HTTP 接口** `POST /x/linapro-lark-push/open/v1/message/text`，插件自建
  **HMAC-SHA256 签名**鉴权（FB-3；宿主无机器身份认证机制），并自建请求日志（宿主审计对匿名
  调用失效）。签名覆盖方法、路径、查询串、时间戳与 nonce（请求体不参与签名，FB-8 / FB-9），时间戳限 ±300 秒，nonce
  经宿主共享缓存去重以防重放；`secret` 只用于本地签名、不在网络上传输。
- **新增插件私有配置 `plugin.linapro-lark-push.push_groups`**（FB-2，取代平铺的 `push_apps`）：
  按调用方插件 ID 分组的推送应用清单，每个调用方用自己的机器人；每条声明
  `identity_app_id` 表示它服务哪个企业的 `user_id` 空间。门面请求必填 `Group`（调用方插件 ID），
  分组缺失 / 未配置时失败关闭、不回退全量；对外 HTTP 的 `api_keys` 改为 `{key, group}`，按 key
  绑定分组。employee-core 的
  `plugin.linapro-employee-core.lark_apps` **保持不变**，本次不迁移、不共享。
- **`linapro-lark-sdk` 新增能力**：`larkim.SendText` / `BuildTextContent`（`msg_type=text`）。
  配置读取与校验放在新插件的 `backend/internal/larkcfg`，不进共享 SDK。
- **`empcap` 新增 `MapOwnLarkUserIDsByEmployeeNo`**：以工号为键返回某身份应用作用域下
  `id_source='own'` 且 `lark_user_id` 非空的「工号 → 企业级 user_id」映射，三态返回
  （命中 / own 行存在但 id 为空 / 工号碰撞）。
- **`linapro-eval-360` 卡片迁入**（FB-1）：门面新增进程内 `SendCard` / `ListPushApps`，
  eval-360 的测评卡片改经本插件按工号投递（推送应用凭据 + `user_id`），不再读
  employee-core 的 `lark_apps`；以 `Group=linapro-eval-360` 使用独立的测评机器人（FB-2）。

- **签名凭据后台管理**（FB-5）：`api_keys` 从配置文件迁到数据表 `plugin_linapro_lark_push_api_key`，
  新增「系统设置 → 飞书推送凭据」管理页（增删改查、启停、查看密钥）；签名中间件每次请求查库，不缓存。
- **群聊投递**（FB-6）：收件人支持 `chat_id`（可指定推送应用），文本、卡片、文件三种投递均适用；对外
  HTTP 的群聊目标在后台配置到签名凭据上（FB-10），调用方不能自行指定。
- **文件推送**（FB-7）：新增 `POST /x/linapro-lark-push/open/v1/message/file`（multipart，一步式上传即
  推送）与门面 `SendFile`；图片按图片消息、其余按文件消息，按推送应用各上传一次。`larkim` 新增文件 /
  图片上传与发送。

### 关键不变量

1. `user_id` 来自 `identity_app_id` 指向的**身份应用**的 own 行；投递凭据取自
   **`push_groups.<group>`**。发送循环只遍历请求分组的推送应用，`identity_app_id` 只是一个查表键，
   本插件读不到、也不需要身份应用的密钥——从结构上杜绝「告警走考勤机器人」。
2. 同一分组内，同一个 `identity_app_id` 不得被两个 push app 引用（会导致同一人重复收到）。
3. 调用方只传工号，系统按「该人在哪些企业有身份」自动扇出；双发可接受，不做企业选择。
4. 调用方只能使用自己分组的推送应用：进程内按 `Group` 选路，对外 HTTP 按签名凭据绑定的分组
   选路；不存在「发给全部推送应用」的路径。

## Capabilities

### New Capabilities

- `linapro-lark-push`: 飞书消息推送能力——进程内门面契约（文本 + 交互卡片）、工号到 user_id 的跨企业
  扇出与投递编排、对外 HTTP 接口的 HMAC 签名鉴权与请求日志、配置形态与失败降级语义。

### Modified Capabilities

- `linapro-lark-sdk`: 新增文本消息发送能力（`SendText`/`BuildTextContent`）。

## Impact

**代码**

- 新增：`apps/lina-plugins/linapro-lark-push/`（插件全量骨架、门面、编排、中间件、controller）
- 修改：`apps/lina-plugins/linapro-lark-sdk/`（`larkim` 加文本发送）
- 修改：`apps/lina-plugins/linapro-employee-core/`（仅 `empcap` 新增 user_id 正向寻址方法及
  其实现；凭据读取保持原状）
- 修改：`apps/lina-plugins/linapro-eval-360/`（FB-1：notify 改经 `larkpushcap.SendCard`，
  `plugin.yaml` / `go.mod` 声明对本插件的依赖）

**配置**

- `apps/lina-core/manifest/config/config.template.yaml`
- `apps/lina-core/internal/packed/manifest/config/config.template.yaml`
- `apps/lina-core/manifest/config/config.online.yaml`
- `apps/lina-core/manifest/config/config.yaml`（gitignored，部署侧同步）
- 上述 4 份配置的 `plugin.autoEnable`（须排在 `linapro-employee-core` 之后，数组顺序即
  启用顺序）
- 既有 `plugin.linapro-employee-core.lark_apps` 段**保持不动**
- `hack/config.yaml` 的 `plugins.official.items`

**依赖与顺序**

- 新插件依赖 `linapro-employee-core` 的 `empcap`，须在 `plugin.yaml` 的
  `dependencies.plugins` 中声明（跨插件 import 只能走 `backend/cap/**`）。
- `lark-sdk`、`employee-core`、新插件同属 `apps/lina-plugins` submodule，须先发
  submodule PR 再发主仓 PR。

**外部依赖（人工前置）**

- 两个飞书企业各创建一个消息推送应用，开通 `im:message:send_as_bot` 并配置可用范围；
  给两个身份应用补充「获取用户 user_id」权限并发布版本。缺失时 `lark_user_id` 恒为空、
  推送无法寻址。

**不在本次范围**

- 对外 HTTP 的卡片消息 / 富文本（对外接口做文本与文件；卡片仅进程内）。
- 投递记录落库与失败重试队列（失败只记日志并返回错误，由调用方重试）。
- 宿主站内信（不写 `notifycap`、不进 `usermsg`）。
