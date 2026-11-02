## Context

`linapro-lark-sdk/larkim` 目前只有 `SendInteractiveCard`（`msg_type=interactive`），唯一的
飞书推送是 `linapro-eval-360/backend/internal/notify` 里与业务耦合的编排。飞书凭据寄居在
`plugin.linapro-employee-core.lark_apps`（employee-core 私有键），无法表达「独立推送应用」
这一角色。

**关键事实（决定了 D1/D2 的形态）**：推送链路只需要推送应用凭据。寻址是
`empcap.MapOwnLarkUserIDsByEmployeeNo(ctx, identityAppID)`——按 `lark_app_id` 查
`lark_identity` 表，`identity_app_id` 在发送链路里只是一个查表用的字符串。因此**推送插件
完全不需要、也不应读取身份应用（登录/同步应用）的密钥**，employee-core 也没有任何理由
读推送配置。两边保持各自的私有键即可，不需要中立共享段。

现状约束（均已核实）：

- **源码插件之间读配置没有隔离**：`hostconfigcap.Service.Get` 不校验键前缀。共享配置技术
  上今天就能做，本设计要解决的是「让共享配置有清晰的归属与迁移路径」。
- **插件之间没有任何机器身份认证**：`Permission()` 硬依赖 `bizCtx.UserId > 0`；宿主审计
  中间件在 `operUsername == ""` 时直接 return。对外接口必须插件自建鉴权与请求日志。
- **跨插件 import 只能走对方 `backend/cap/**`**，且须在 `plugin.yaml` 的
  `dependencies.plugins` 声明 owner 与版本。
- **`lark_identity` 表本身就是「谁在哪些企业有身份」的映射**（每行有 `lark_app_id` +
  `emp_id`），无需另造企业映射。
- 飞书标识的作用域不同：`open_id` 按 app 签发，`user_id` 按企业签发。所以身份应用同步落库的
  `lark_user_id` 可以直接交给**同企业**的推送应用投递——换凭据即换机器人，无需换 id。

业务前提：两个飞书企业（两个租户），各自一个独立的推送应用，与同企业的登录/同步应用是不同
app（机器人名不同）。预警类消息不能走考勤/登录应用的机器人。

## Goals / Non-Goals

**Goals:**

- 让任意插件以「工号 + 文本」发一条飞书消息，无需了解飞书应用与企业概念。
- 让外部系统通过受鉴权的 HTTP 接口做同样的投递。
- 从结构上保证推送消息永远走推送应用凭据，不可能误用身份应用（考勤机器人）。
- 推送应用凭据落在本插件自己的私有配置键，与 employee-core 的身份应用凭据互不侵扰。

**Non-Goals:**

- 对外 HTTP 发卡片、富文本、@ 人（对外接口做文本与文件；卡片仅进程内，见 D3 / FB-1；群聊见 D14）。
- 投递记录落库、失败重试队列、必达语义（失败只记日志并返回错误，由调用方重试）。
- 宿主站内信（不写 `notifycap`、不进 `usermsg`）。
- 推送应用（`push_groups`）的后台管理：飞书应用凭据仍在配置文件，经 YAML 锚点与 employee-core 共享。
  后台只管理对外签名凭据（D13）。
- 由系统替调用方决定「发给哪个企业」（调用方只给工号，系统按身份自动扇出）。

## Decisions

### D1：推送应用清单是本插件的私有配置键，不设中立共享段

> FB-2 起配置形态改为按调用方分组的 `push_groups`（见 D11）；下文关于「私有键、不设共享段、
> 显式 `identity_app_id`」的取舍仍然成立，只是清单从平铺改为按分组嵌套一层。

```yaml
plugin:
  linapro-lark-push:
    push_groups:   # 分组名 = 调用方插件 ID（见 D11）
      linapro-eval-360:
        - { app_id, secret_key, name, identity_app_id }
```

配置键：`plugin.linapro-lark-push.push_groups`。身份应用继续留在
`plugin.linapro-employee-core.lark_apps`，两边都不动对方的键。

**为什么不做中立共享段 `lark.apps` / `lark.push_apps`**：共享段的前提是「多个插件共读同一份
凭据」，而实际上推送只有一个消费方、身份应用只有 employee-core 一个归属方。强行合并会让一次
纯新增的能力变成一次**代码与配置必须同时上线**的迁移：新代码不读旧键，配置晚一步，飞书登录
与通讯录同步就直接失败关闭。用一个真实的部署事故点，换取一份「看起来更整齐」的配置，不划算。

**为什么不用 `<<: [*lark]` 锚点把它复制进各插件段**：YAML 的 merge key 是解析期深拷贝，不是
引用——复制之后就是 N 份互不知情的配置，改一处漏一处，运行时并不存在「共享」。更实际的问题是
`plugin.<id>.lark` 这个键已被现有 `lark-sync: &lark-sync` 锚点占用（形如 `{appId, appSecret}`），
再引入同名的 `{apps, push_apps}` 会在 merge 时静默丢一份。

**为什么用平铺清单而不是「按企业嵌套」**（`push_apps.<company>.app_id`）：嵌套式必须给每个
企业起一个名字用于结果标识与日志，而**发送时没有任何环节需要这个名字**——调用方只传工号，
企业由身份行推导。多一个字段就多一个填错的地方，且外部契约会误以为可以按企业选路。

**为什么不用「靠配置顺序或命名约定推断所属企业」**：顺序是隐式的、重排即错；命名约定不可校验。
显式 `identity_app_id` 至少能在装配期校验出「同一身份应用被两个推送应用引用」——后者会造成
同一人在同一企业收到两条消息。

**为什么不引入 appid ↔ 企业映射表**：`lark_identity` 已有 `(lark_app_id, emp_id)`，
「谁在哪些企业有身份」已可查得。真正缺的只是「推送应用对应哪个身份应用」，用一行配置即可
表达，不值得为它建映射表或复用 `dept_tenant_map`（后者是 Moka 部门名 → 租户，与飞书应用无关）。

**`name` 字段的定位**：仅用于日志与结果标识（如「系统通知(霍尔果斯)」）。飞书侧的机器人名在
控制台配置，不由本配置项驱动。

**已知取舍**：`identity_app_id` 指向 employee-core 配置里的身份应用，本插件看不到那份配置，
故**悬空引用无法在配置期识别**。它表现为 `status` 端点里该推送应用的
`addressable_employees == 0`——运行期必然暴露，部署验收看这一项即可。

### D2：`larkcfg` 放本插件的 `backend/internal`，只做 schema + 读取 + 校验

路径 `linapro-lark-push/backend/internal/larkcfg`。它是单消费方的推送配置解析器，不是共享库：
放进 `linapro-lark-sdk` 会让一个只服务一个插件、且绑死 `plugin.linapro-lark-push.*` 私有键的包
出现在所有 SDK 使用方的视野里，也让 SDK 的公共 API 面无故变大。SDK 只留 `larkim`——那才是
真正三方共用的东西。

为不引入 `lina-core` 依赖，该包定义本地最小接口：

```go
type Getter interface {
    Get(ctx context.Context, key string, defaultValue any) (*gvar.Var, error)
}
```

`hostconfigcap.Service` 在结构上直接满足它，消费方无需适配器。

**边界**：`larkcfg` 只做「结构体 + `Load` + `Validate` + `Pushable`」，不含任何旧键兼容或
迁移兜底逻辑。

### D3：employee-core 凭据读取保持原状；eval-360 卡片迁入本插件（FB-1）

本次**不迁移、不改写** employee-core 的飞书凭据：它继续读自己的
`plugin.linapro-employee-core.lark_apps`（登录换票与通讯录同步）。

**eval-360 卡片已迁入本插件（FB-1，用户决策「共用推送机器人」）**：原先 eval-360 直读
employee-core 私有键、用身份应用凭据以 `open_id` 发卡片（`open_id` 按应用作用域签发）。现改为
eval-360 调用本插件进程内 `SendCard`：寻址走与文本相同的「工号 → 企业级 `user_id`」，投递用
`push_apps` 凭据；卡片里引导员工免登的 `larkAppId` 取推送应用的 `identity_app_id`（员工端换票
用身份应用，推送应用不参与登录）。跨插件读私有配置的耦合由此消除。

按 Open Questions 1 的「共用」分支落地：不加应用、不加 `channel` 选路，`push_apps` 保持一企业
一个；测评卡片与预警等通知共用同一推送机器人。卡片模板须授权给推送应用（eval-360 的
`card_templates[].app_id` 改填推送应用 app_id）。

> **FB-2 推翻「共用推送机器人」**：考勤等插件也要推送，不能所有消息都显示同一个机器人名，
> 改为按调用方插件 ID 分组选路（见 D11）。eval-360 以 `Group=linapro-eval-360` 投递，
> `card_templates[].app_id` 改填该分组内推送应用的 app_id。

卡片只开放进程内门面，不进对外 HTTP（对外接口仍只做纯文本）：卡片内容由调用方按推送应用
构造（`CardBuilder`），这种「每企业一份内容」的契约不适合以静态请求体对外暴露。

### D4：新增 `empcap.MapOwnLarkUserIDsByEmployeeNo`，三态返回

```go
type LarkUserIDIndex struct {
    ByEmployeeNo        map[string]string   // 可投递：工号 → 企业级 user_id（own 且非空）
    BlankEmployeeNos    map[string]struct{} // 有 own 行但 user_id 为空的工号
    CollidedEmployeeNos map[string]struct{} // 同一工号对应多个不同 user_id 的工号
}
MapOwnLarkUserIDsByEmployeeNo(ctx context.Context, larkAppID string) (LarkUserIDIndex, error)
```

与既有 `MapOwnLarkOpenIDsByEmployeeNo` 严格对称，只换列（`lark_open_id` → `lark_user_id`），
并额外返回 `BlankEmployeeNos`/`CollidedEmployeeNos`。三个集合互不相交，需要人数时直接取长度。

**FB-14 修订（按人判定）**：原结构对空白行只返回行数 `BlankRows`，消费方无法知道空的是谁，只能按
企业整体猜——企业 B 只要有一个员工缺 user_id，所有「不在 B」的收件人都会被误判为「无 user_id」，
对外接口把已在企业 A 收到消息的人列为失败，调用方重试即重复投递。改为返回工号集合后按本人判定；
`BlankRows`、`Collisions` 两个计数与集合长度重复，一并删除（工号为空的行无法按工号寻址，不再计入）。

**为什么必须三态**：`lark_user_id` 为空的成因不同，处置也不同——
（a）身份应用缺「获取用户 user_id」权限 → 全表为空，是部署缺陷，须告警且不可回退；
（b）授权后新同步的部分行为空 → 时序问题，跳过即可；
（c）无 own 行 → 这个人不在该企业。只返回 `map` 会让消费方无法区分（a）与（c），把配置缺陷
误判为「这个人没身份」，从而静默漏发。

**为什么碰撞要显式返回**：既有 open_id 版对同工号多行静默取首条。推送场景下这等于**送错人**，
比漏发严重；宁可标记失败不发。

### D5：门面以「人」为寻址单位，扇出在实现内部完成

```go
type SendTextRequest struct {
    Group      string      // 推送分组 = 调用方插件 ID（FB-2，必填，见 D11）
    Recipients []Recipient // 工号 或 user_id，二选一
    Text       string
    BizSource  string      // 调用方标识（日志对账，不参与选路）
    BizRef     string      // 可选业务单号
}
```

请求里**没有企业参数**。实现遍历请求分组内的推送应用，对每个推送应用按 `identity_app_id` 查映射，
命中即用该推送应用凭据发送。

**为什么不在契约里暴露企业选择**：已确认业务语义是「他在几个企业有身份就发几条」，双发可接受。
暴露企业参数会把配置细节（app_id、企业名）泄漏成外部契约，且调用方并不知道某人在哪几个企业
有身份——那是本系统独有的数据。

**代价**：无法「只发给某一个企业的机器人」。若将来需要，追加可选的 `push_app_ids` 过滤参数
即可，不破坏现有契约。

### D6：发送循环只遍历请求分组的推送应用，身份应用绝不参与发送

这是把「告警不能走考勤机器人」变成结构约束而非文档约定：`newClient` 的入参只可能来自
`push_groups.<group>` 条目，身份应用凭据从未进入发送路径。

推送应用与身份应用的隔离由**本插件读不到身份应用密钥**这一事实保证：本插件只从
`plugin.linapro-lark-push.push_groups` 取凭据，身份应用那一侧的配置它根本无路可读。
`identity_app_id` 只被当作查 `lark_identity` 的键使用，从不用于构造客户端。

### D7：对外 HTTP 自建 HMAC 签名中间件，fail-closed（FB-3 取代静态 API Key）

宿主没有机器身份认证机制（`ClientType` 枚举刻意排除服务/机器身份），把机器认证塞进宿主
是框架级改造，与本次范围不匹配。插件内实现，**FB-3 起由静态 API Key 改为 HMAC-SHA256 签名**：

- 凭据：FB-5 起存放在数据表并由后台维护（见 D13），每条
  `{app_key, secret, group}`——`app_key` 是公开标识（进日志），`secret` 只用于本地计算签名、
  不上网络（不进日志），`group` 绑定推送分组（语义同 FB-2）。与 `push_groups` 分开——后者是
  飞书凭据，语义与轮换节奏都不同。
- 请求头：`X-App-Key`、`X-Timestamp`（Unix 秒）、`X-Nonce`（16~64 字符）、
  `X-Signature`（小写 hex HMAC-SHA256）。
- 待签串：`METHOD\nPATH\nCANONICAL_QUERY\nTIMESTAMP\nNONCE\nhex(SHA256(""))`；
  `CANONICAL_QUERY` 按参数名、再按值排序后以 `&` 连接 `urlencode(k)=urlencode(v)`；
  末行固定为空串摘要（`e3b0c442…`）。用 `subtle.ConstantTimeCompare` 比对。
- **请求体不参与签名**（FB-8 文件接口、FB-9 文本接口，用户要求）：调用方不必为签名读取 / 摘要请求体，
  中间件也不读请求体，请求体上限交给各处理器（文本 256 KB、文件 31 MB，超限 413 `BODY_TOO_LARGE`）。
  末行保留为固定值，使既有客户端只需把末行改为常量。代价是消息内容、文件与收件人不受签名保护，
  以 HTTPS 兜底；凭据校验、时间戳窗口与 nonce 防重放不受影响。
- **凭据表不可读 → 503 fail-closed**（FB-5 前为「配置为空 → 503」）；**缺签名头 / `app_key` 未知 / 时间戳超窗 / 签名不匹配 /
  `nonce` 重复 → HTTP 200 + 各自不同的 `errorCode`**（FB-12 前为 401，见 D16）。
- 通过后把 `key_id`（凭据记录 ID，非密钥内容）、`app_key` 与该 `app_key` 绑定的分组放进请求
  上下文，供投递选路与日志使用。

路由形态：`/x/linapro-lark-push/open/v1/...`，挂
`NeverDoneCtx → HandlerResponse → RequestBodyLimit → signature → bodylimit`，**不挂**宿主
`Auth/Tenancy/Permission`（FB-12 起增加按路由请求体上限中间件 `bodylimit`，见 D16）。

**为什么不再保留静态 Key 模式**：项目无历史负担、本插件尚未提交、没有存量部署。同时支持两种
鉴权只会让「哪些调用方还停留在无签名模式」变成长期隐患；签名本身已覆盖静态 Key 的全部安全
属性（识别调用方 + 不可伪造），且额外限定了方法、路径与查询串（请求体不签，见上）。

**为什么 `secret` 比原 `key` 更安全**：原方案把密钥直接放进请求头，任何能看到请求的地方
（代理日志、抓包、工单里贴的 curl）都能原样重放；签名方案下请求里只有签名值，观察到它无法
推导 `secret`，且签名绑定了方法、路径、查询串、时间戳与 nonce，改任何一项都失效。

### D12：nonce 防重放用宿主 `cachecap` 的原子 `Incr`，不自建存储

签名只能证明「请求由持有 `secret` 的一方构造」，不能证明「这是第一次发出来」。一条合法请求被
原样重放（例如 curl 命令进了工单、代理记了日志）会重复推送，因此必须记录已用过的 `nonce`。

**能力选型（均已核实宿主实现）**：

| 候选 | 能力 | 结论 |
|---|---|---|
| `capability.Services.Cache()` → `cachecap.Service` | `Get/Set/Delete/Incr/Expire` 等；后端按 `cluster.enabled` 在 `memory`（进程内加锁）与 `coordkv`（`kvStore.IncrBy`）间切换 | **采用** |
| `capability.Services.Lock()` → `lockcap.Service` | `Acquire/Renew/Release`，`MaxNameBytes=64` | 不采用 |

`cachecap` 没有 `SetNX`/CAS，但 `Incr` 已经够用且是原子的：对键 `nonce:<app_key>:<nonce>` 执行
`Incr(…, 1, TTL)`，返回 1 表示首次、≥2 表示重放。一次调用同时完成「查」与「写」，两个并发
到达的重放请求不可能都拿到 1（`Get` 判空 + `Set` 会有经典竞态）。用计数器而非 `Set` 的原因
就是宿主没给 `SetNX`，而计数器语义正好表达「用过一次」。

**集群一致性**：直接复用启动期经 `registrar.Services()` 传入的插件作用域适配器，不在中间件里
自行构造实例，`cluster.enabled=true` 时自动落到共享 KV——满足
`.agents/rules/cache-consistency.md`「集群模式下不得退化为仅本节点可见」。`Cache()` 只存在于
插件作用域视图（`scopedDirectory`）上，已核实 `newSourceHTTPRegistrar` 传给插件的是
`sourceServicesForPlugin(...)`，故路由注册回调里拿到的就是作用域视图。

**顺序：先验签后登记 nonce**（用户确认）。未通过认证的请求不产生任何状态变更，攻击者无法用
错误签名的请求把别人正在传输中的 `nonce` 提前「烧掉」。代价是暴力重放同一请求最终命中
「nonce 重复」而非「签名不匹配」——但签名本就正确，这个区分不泄露任何信息。

**窗口与 TTL**：时间戳窗口 ±300 秒；去重条目 TTL 取 `2 × 300s = 600s`，覆盖窗口两端，使
「窗口内仍可接受」的请求在整段时间里都能被识别为重放。

**残余风险**：缓存是 lossy 的加速设施（契约明确写了不得作为权威数据）。若后端提前淘汰条目，
窗口内的重放可以再次通过。这个边界与「完全不记 nonce」等价，而窗口本身只有 5 分钟，故接受；
不为此引入落库，那是投递记录表范畴（已在 Non-Goals）。

**为什么不用 `lockcap`**：`Acquire` 拿到即首次，语义上也能做，但需要「永不 Release」地占锁、
lease 上限 5 分钟、名字还要控制在 64 字节内，比 `Incr` 复杂且没有额外收益。

### D8：请求日志替代宿主审计

宿主审计中间件在无宿主操作人时直接返回，外部调用完全不入审计。因此 controller/service 层
显式输出结构化日志：`request_id`、`key_id`、`push_app_id`、工号、状态、飞书 `code` 与
`req_id`。

**为什么不落投递记录表**：已确认失败由调用方重试，且不希望为此引入 DDL、清理任务与正文留存的
隐私问题。日志轮转后的不可追溯性是被接受的取舍（已记入 Risks）。

### D9：`lark_user_id` 为空时跳过而非回退

某企业 own 行 `lark_user_id` 全空时，**不回退**为使用身份应用凭据或 open_id 发送。
回退会让「权限没配好」这件部署缺陷被掩盖成「能发但发的是考勤机器人」，正是本次要杜绝的。

### D10：直接给 `larkim` 加 `SendText`，不另造发送器

复用库内 `larkhttp` 的 429 退避与 token 管理（官方 SDK 经同一个 HttpClient 自动续期）。
在插件内另写发送器会重复实现限流退避，且容易破坏「`larkim` 不引入 `lina-core`」的边界。
做法是把现有 `SendInteractiveCard` 的请求构造抽成私有 `createMessage`，两个公开方法共享。

### D11：推送应用按调用方插件 ID 分组（FB-2）

**问题**：原设计所有调用方共用整份 `push_apps`，任何插件发消息都会经全部推送应用扇出，接收方
看到的永远是同一个机器人名。考勤等插件也要推送，测评卡片、考勤提醒、运维告警需要各自的机器人。
飞书机器人名在开发者后台按应用配置、接口无法改写，所以「不同机器人名」只能落到「不同调用方用不同
推送应用」。

**配置形态**：

```yaml
plugin:
  linapro-lark-push:
    push_groups:
      linapro-eval-360:              # 分组名 = 调用方插件 ID
        - app_id: cli_aaa
          secret_key: "..."
          name: 360测评助手(企业A)
          identity_app_id: cli_xxx
      linapro-attend-poc:
        - app_id: cli_ccc
          secret_key: "..."
          name: 考勤助手(企业A)
          identity_app_id: cli_xxx
      ops-alert:                     # 对外 HTTP key 绑定的分组，名字自定
        - ...
    api_keys:
      - app_key: "ops-alert-prod"    # 公开标识，进日志
        secret: "..."                # 只用于本地算签名，不上网络
        group: ops-alert
```

**决策**：

1. **分组名用调用方插件 ID**：调用方直接用自己的插件 ID 常量，无需额外约定名字；映射键天然唯一。
   对外 HTTP 调用方不是插件，其分组名由运维自定，经签名凭据绑定（FB-3 前为静态 API Key）。
2. **`Group` 必填、fail-closed**：`SendTextRequest`/`SendCardRequest` 增 `Group`，
   `ListPushApps(ctx, group)`。分组为空返回参数错误；分组不存在或组内没有凭据齐备的应用时返回
   `CodeNoPushApp`（新增参数 `group`）。**绝不回退到全部推送应用**——回退会让「忘配分组」退化成
   「用别人的机器人发」，正是本次要杜绝的。
3. **`BizSource` 不参与选路**：它是日志对账字段，选路字段与日志字段分开，避免改日志标识时意外改路由。
4. **校验按组隔离**：组内校验 `app_id`/`secret_key`/`identity_app_id` 非空、`app_id` 唯一、
   `identity_app_id` 唯一；一个分组非法只拒绝该分组的请求，不拖垮其它分组（原设计任一条目非法即
   整体不可用）。只有 `push_groups` 整体结构无法解析时才全部不可用。`Status` 按分组输出全部问题。
5. **同一 `app_id` 可出现在多个分组**：是否共用机器人由运维决定，配置层不禁止，也不做跨组一致性校验。
6. **对外 HTTP 的分组由签名凭据决定**：`api_keys` 为 `[{app_key, secret, group}]`（FB-3 起由
   静态 key 改为 HMAC 签名），鉴权中间件把命中的 `app_key` 绑定的分组放进上下文，controller 以它
   投递。请求体不加 `group` 字段（`DisallowUnknownFields` 下会被 400 拒绝），持凭据者无法冒用
   其它分组的机器人。`app_key`、`secret` 或 `group` 为空的条目不参与匹配。
7. **不做旧键兼容**：项目无历史负担，本插件尚未提交、没有存量部署；`push_apps` 直接移除，`larkcfg`
   不读旧键。
8. **分组只是选路约定，不是鉴权**：进程内调用无法校验调用方真实身份，源码插件之间本就同信任级；
   填别人的插件 ID 属于代码审查问题。真正需要隔离的对外 HTTP 由签名凭据绑定的分组保证。

**`larkcfg` 形态**：`Load` 返回 `map[string][]PushApp`；`Validate(group, apps)` 产出该组问题，
`Field` 形如 `push_groups.linapro-eval-360[0].secret_key`；`Pushable` 不变（按组调用）。
发送服务 `loadPushApps(ctx, group)` 只校验并返回该组。

**运维代价**：所需飞书应用数 = 分组数 × 企业数，每个应用都要开通发消息与机器人能力、设可用范围；
eval-360 分组的应用还须授权卡片模板。

**被否决的方案**：

- *给 `push_apps` 条目加 `plugins: [...]` 标签*：同一份清单里既要按企业去重又要按插件过滤，校验规则
  变成二维交叉，一眼看不出「某插件会用哪几个机器人」。
- *请求体 / 门面接收 `push_app_ids` 过滤*：把配置细节（app_id）泄漏给调用方，调用方要感知企业与应用。
- *对外 HTTP 请求体携带 `group`*：任何持 key 者都能使用任意分组的机器人。

### D13：签名凭据入库，后台管理，不缓存（FB-5）

**问题**：对外调用方会越来越多，每接一个都要改配置文件并同步多份 yaml，运维不便。

**决策（均经用户确认）**：

1. 新表 `plugin_linapro_lark_push_api_key`：`id`、`name`、`app_key`、`secret`、`push_group`（避开保留字
   `group`）、`status`、`remark`、`created_at`、`updated_at`、`deleted_at`。软删除；`app_key` 唯一索引
   带 `WHERE deleted_at IS NULL`，删除后同名可重建。无 `tenant_id`：插件 `platform_only`。
2. 状态复用宿主字典 `sys_normal_disable`（`1` 正常、`0` 停用），不新建字典类型。
3. `secret` 为 16~128 个可见 ASCII 字符。新增时必填（FB-13 修订：原「留空由服务端生成」取消）：管理页
   打开新增表单即用浏览器 `crypto.getRandomValues` 预填 64 位字母数字，可改可重新生成，前后端都拒绝空值；
   编辑留空保持原值。列表与详情不返回，查看走独立接口 `GET /api-keys/{id}/secret` 与
   独立权限点。
4. 分组必须是 `push_groups` 已配置的分组名（保存时校验）；分组下拉由 `GET /push-groups` 读同一配置。
   事后从配置删掉分组不级联处理凭据：请求以 `CodeNoPushApp` 失败关闭，与 D11 一致。
5. 签名中间件改为每次请求按 `app_key` 查库（`status=1` 且未删除），**不加缓存**：请求量低，换来停用 /
   删除即时生效，也不需要处理集群失效。查库失败返回 503 新码 `CodeCredentialStoreUnavailable`；原
   `CodeSignatureNotConfigured`（「配置为空」）语义消失，删除。查不到或已停用一律以
   `CodeSignatureUnknownAppKey` 拒绝（原为 HTTP 401，FB-12 起为 HTTP 200 + 该 `errorCode`，见 D16），不区分
   两者，避免向外泄露哪些 `app_key` 存在。
6. 配置键 `plugin.linapro-lark-push.api_keys` 彻底移除，不保留兜底；主仓 yaml 中的注释示例同步删除。
7. 组件：`backend/internal/service/apikey`（`Service` 接口：管理端 CRUD + `FindEnabledByAppKey`），由
   `plugin.go` 一次构造，同一实例注入管理端 controller 与签名中间件。中间件直接依赖 `apikey.Service`，
   不另定义窄接口（`architecture.md`）。
8. 菜单：`系统设置 → 飞书推送凭据`（`parent_key: setting`），按钮权限点
   `linapro-lark-push:api-key:{list,add,edit,remove,secret}`。插件 `i18n.enabled=false`，前端文案直接用中文。

**数据权限例外**：凭据是平台级配置，不归属组织或个人，访问边界由菜单 / 按钮权限点决定，不接入组织数据
权限过滤（`data-permission.md` 例外条款：平台配置）。

**被否决**：*服务端生成、只显示一次*——用户要求可反复查看，便于把凭据交给调用方后再次核对。

### D14：群聊作为一种收件人，按指定推送应用投递一次（FB-6）

`chat_id` 归属单个企业，且只有已在群里的机器人才能发消息，所以群聊不能像个人那样按企业扇出。

1. **收件人模型**：`larkpushcap.Recipient` 增 `ChatID`、`PushAppID` 两个字段，`Kind()` 新增
   `RecipientKindChatID`。沿用单一收件人列表，这样 `CardBuilder` 的签名不变：对群聊调用时收件人参数带
   `ChatID`，调用方可以给群发另一种卡片。对外 HTTP 用独立的 `chats` 字段，在 DTO 投影时并入
   `Recipients`。
2. **选应用**：分组只有一个推送应用时 `PushAppID` 可省略；有多个时必填，且必须属于该分组。校验放在拿到
   分组推送应用之后、发起任何飞书请求之前，任一群聊收件人不合法即整体返回参数错误，避免半批发出。
> FB-10 修订：对外 HTTP 不再接受调用方传入的 `chats`（用户反馈「客户端传 chat_id 不可控」）。群聊目标
> 改为后台配置在签名凭据上（`chat_id` + 可选 `chat_push_app_id`），见第 6 条；门面层的群聊收件人模型不变。

3. **扇出**：在 `dispatch` 的「推送应用 × 收件人」循环里，群聊收件人只在指定应用那一轮投递，其它应用
   直接跳过，不产生明细（与「无身份」不同，这里不是未覆盖，而是本来就不该覆盖）。
4. **不登记白名单**：能往哪些群发，由飞书侧「机器人是否在群里」决定，这是天然的授权边界；凭据持有者
   只能用本分组的机器人（用户确认）。
5. 混用字段（工号与 `chat_id` 同时给出）按参数错误处理；`PushAppID` 只对群聊有意义，给个人收件人带上
   同样是参数错误。
6. **对外 HTTP 的群聊来自凭据配置**（FB-10，用户确认）：凭据表增 `chat_id`、`chat_push_app_id` 两列，后台
   编辑时选择；签名中间件把二者随 `Identity` 带进上下文，控制器在个人收件人之后追加该群，再交给门面。
   凭据未配置群聊时 `recipients` 必填。请求体不再有 `chats` 字段（`DisallowUnknownFields` 下带上即 400）。
   取舍：一条凭据只对应一个群——不同的群用不同的凭据，这样「哪个调用方能发到哪个群」完全由后台决定、
   可审计；配置后的每次推送都会发到该群，不提供「本次不发群」开关（需要只发个人时用未配置群聊的凭据）。
   推送应用在保存时按分组校验一次，发送时 `bindChatPushApps` 按同一规则再校验（配置文件后来增删推送
   应用时返回 400、不发半批）。

### D15：一步式文件推送，按推送应用懒上传（FB-7）

**事实约束**：飞书 `file_key` / `image_key` 归属上传它的应用，不同应用之间不能复用。本插件一次请求可能
经分组内多个推送应用发出，所以「先上传拿 key、之后引用」的两步式行不通。

1. **一步式**（用户确认）：`POST /open/v1/message/file`，`multipart/form-data`，字段为 `file`、
   `recipients`（JSON 字符串）、`chats`（JSON 字符串）、`biz_ref`；其它字段返回 400，与文本接口
   `DisallowUnknownFields` 的口径一致。**请求体不参与签名**（FB-8，见 D7）：调用方无需为签名把整个
   文件读进内存算摘要，multipart 交给 HTTP 客户端组装即可。
2. **懒上传**：`deliverFunc` 闭包按推送应用记住上传结果（`file_key` 或错误）。只有某应用出现第一条可
   投递明细时才上传；上传失败把该应用下所有明细记为 `failed`，不影响其它应用。
3. **图片 / 文件判定**（用户确认图片按图片消息发）：对前 512 字节调用 `http.DetectContentType`，命中
   JPEG / PNG / GIF / WEBP / BMP / ICO 且不超过 10 MB 时走图片；其余走文件，`file_type` 按扩展名映射，
   未知类型为 `stream`。文件超过 30 MB 或为空时返回参数错误。按内容而不是扩展名判断，避免调用方给
   `.png` 改名后飞书拒收。
4. **SDK**：`larkim` 新增 `UploadFile`、`UploadImage`、`SendFile`、`SendImage`，上传沿用
   `messageCreator` 式的最小接缝便于单测；`MessageSender` 接缝随之扩展。
5. **请求体上限**：`/open/v1` 三条路由共用同一签名中间件（不读请求体）；文本 256 KB、文件 31 MB
   （30 MB + 1 MB 封装）由各处理器以 `Content-Length` 预检 + `http.MaxBytesReader` 把关，超限返回 413
   `LINAPRO_LARK_PUSH_BODY_TOO_LARGE`。
6. **门面**：`larkpushcap.SendFile(SendFileRequest{Group, Recipients, FileName, Content, ...})`，语义与
   `SendText` 一致，供进程内调用方复用。

### D16：对外接口响应改用宿主统一结构（FB-12）

**问题**：控制器与签名中间件原先自行写 JSON（成功 / 部分失败 `{all_succeeded, failed}`、错误 `{error, message}`），
并以 HTTP 400 / 401 / 502 区分结果，与后台接口的 `{code, message, data}` 不一致，对接方要按两套格式解析。原理由
「外部系统需要稳定的 HTTP 状态码语义」不成立：统一结构与保留必要的状态码并不冲突。

1. **结构**：所有响应交给宿主 `HandlerResponse` 包装为 `{code, message, data, errorCode, messageKey, messageParams}`。
   控制器改为 GoFrame 强类型签名（`api/push/v1` + `make ctrl` 生成接口，`group.Bind` 注册），只返回 `(res, err)`；
   签名中间件拒绝时 `r.SetError(err)` 且不调用 `Next`。插件不复制宿主响应结构体，`message` 由宿主统一本地化。
2. **状态码**（用户确认）：只保留 413（请求体超限）、503（凭据表 / 去重存储 / 推送能力 / 员工能力 / 宿主配置不可用）、
   500（推送配置问题与未归类内部错误），其余一律 200、靠 `code` / `errorCode` 区分。映射集中在
   `larkpushcode.WithHTTPStatus`，中间件与控制器共用，保证同一错误码在任何入口返回同一状态码。GoFrame 在中间件已处理
   且未显式设置状态码时返回 200，与后台业务错误的表现一致。
3. **部分投递失败**由 502 改为 HTTP 200 + 新错误码 `LINAPRO_LARK_PUSH_SEND_PARTIAL_FAILED`（`gcode.CodeOperationFailed`，
   参数 `count`），失败明细在 `data.failed`。**`code` 不能为 0**：否则只判 `code == 0` 的调用方会把失败当成功、
   静默丢消息。502 也会让网关 / 监控误判为服务故障，部分 HTTP 客户端还会自动重试导致已送达者重复收到。
4. **请求体上限前移到中间件**：强类型处理器在调用前由框架解析请求体，框架读请求体失败会 panic 成 500。因此新增
   `bodylimit` 中间件挂在签名之后，按路由后缀（文本 256 KB、文件 31 MB）先读完请求体：multipart 在上限内解析到内存
   （框架随后复用已解析表单），其它内容换成可重复读取的请求体；超限 413、表单非法为参数错误。未通过鉴权的请求不读请求体。
5. **严格校验保留**：框架参数绑定会静默忽略未知字段，处理器仍按原始请求体（`DisallowUnknownFields`）与原始表单
   严格校验，`group` / `chats` 等字段照旧拒绝。
6. **已知例外**：插件未启用时，宿主路由守卫直接返回 404（非 JSON），属宿主行为，不在本插件范围内。

### D17：告警通道独立于业务推送（FB-17）

**问题**：部署缺陷（`push_groups` 配置非法、分组无可用推送应用、empcap 未绑定、签名凭据表不可用）
与数据缺陷（某企业整表 `lark_user_id` 为空、工号碰撞）此前只写日志。日志需要有人看，而这些问题
的表现都是「消息发不出去」，往往要等到业务方发现才被追问。

1. **独立配置与独立发送器**：告警凭据取自 `plugin.linapro-lark-push.alert`，发送器在 `plugin.go`
   装配时用 `larkim.NewClient` 直接构造，不经过 `send` 组件、不读 `push_groups`。原因是
   `config_invalid` / `no_push_app` 正是要报告的故障本身，若告警复用业务通道，它会跟着一起失败。
   同理不沿用「告警走考勤机器人」的旧约束（D6）——也不走任何业务机器人。
2. **只报插件自己看得见的缺陷**：签名类错误（缺头、时间戳超窗、签名不匹配、nonce 重放、`app_key`
   未知）都属于调用方问题，会被扫描器反复触发，一律不告警；单个 `user_id` 缺失、单人在某企业无身份、
   飞书侧单条失败也属业务常态，同样不告警。白名单见 spec 的同名 Requirement。
3. **覆盖边界必须显式写清**：插件未启用（`init()` 未执行）、进程已退出、宿主配置能力本身不可用
   （`CodeHostConfigMissing` 自指矛盾——配置读不出来就没法读告警配置）这三类无法自我报告。
   部署侧须配置外部探针轮询 `GET /open/v1/status`，以 503 判断推送能力不可用。这条限制写进
   spec 的 Scenario 与 `buildText` 的正文，避免运维误以为「没告警就是没问题」。
4. **防抖复用宿主缓存**：同一「种类 + 分组 + 推送应用」在 `interval`（默认 30 分钟）内只发一条，
   用 `cachecap.Incr` 占位（与 D12 同一原语、同一理由：`Get + Set` 在并发下会齐发），
   `cluster.enabled=true` 时跨实例共享。缓存不可用时 fail-open——告警的代价是多发一条，
   漏发的代价是故障无人知晓。
5. **不递归、不影响推送**：告警发送失败只记 ERROR，绝不触发新告警；`alert` 段缺失或不完整时
   静默不告警，推送能力照常工作，启动时记录一次提示。
6. **不做恢复通知**（用户确认）：只发问题发生的那一条，问题消失后不发「已恢复」。
7. **不保存失败码分布**（用户确认）：`status` 端点保留凭据齐备性、`identity_app_id` 有效性、
   可寻址员工数与空 `user_id` 员工数，不新增最近失败码的存储——失败由告警通道主动推出，
   再存一份是重复投入。

## Risks / Trade-offs

- **[推送应用可见范围与身份池不一致]** 身份应用枚举到的人，推送应用未必能发（飞书侧返回
  「用户不在应用可见范围」）。身份侧全绿、投递侧全红，且日志里没有基线可对比 →
  提供 `status` 自检端点，报告每个推送应用的凭据齐备性、`identity_app_id` 有效性、
  可寻址员工数与空 `user_id` 员工数；不保存最近失败码分布（用户确认不要），失败由告警通道
  主动推送（D17）；上线 checklist 要求两企业各真发一条。
- **[`lark_user_id` 权限缺失被误读为「没人有身份」]** → D4 的三态返回 + `BlankEmployeeNos` 占满时
  推送到告警群（D17）。
- **[双发导致同一人收到两条]** 同一个人在两家企业都有身份时必然双发 → 已确认为可接受
  （两个企业的机器人不同，用户视角是两套系统各通知一次）。
- **[日志轮转后不可追溯]** 外部系统追问「上周三那条为什么没到」时可能无从查证 → 已接受；
  若后续需要，可追加投递记录表（DDL 与保留策略另行设计），不影响现有契约。
- **[`identity_app_id` 悬空无法在配置期识别]** 它指向 employee-core 的配置，本插件看不到
  → `status` 端点报告该应用的 `addressable_employees == 0`，部署验收须逐个确认非零；出错时的
  表现是「这条消息发不出去」，不会误发给别人。
- **[测评卡片与预警共用推送机器人]** ~~eval-360 卡片迁入后（FB-1）与其它通知同一机器人发出~~ →
  FB-2 已改为按调用方插件 ID 分组，各插件用各自的推送应用。
- **[分组漏配导致推送不可用]** 新插件接入时若忘配 `push_groups.<plugin-id>`，发送会以
  `CodeNoPushApp(group=...)` 失败关闭而非回退 → 错误参数带分组名，`status` 按组列出；调用方
  （如 eval-360）应在发布前用 `ListPushApps(group)` 预检。
- **[飞书应用数量膨胀]** 应用数 = 分组数 × 企业数 → 已接受；同一 `app_id` 允许出现在多个分组，
  不需要独立机器人的调用方可以共用。
- **[submodule 与主仓的提交顺序]** 三个模块同属 `apps/lina-plugins` submodule，主仓的
  `config.template.yaml` 在主仓 → 先发 submodule PR 再发主仓 PR，否则主仓 CI 会拉到未升级的
  submodule 而编译失败。
- **[签名密钥明文入库]** FB-5 起 `secret` 存数据表（HMAC 验签必须拿到明文），后台可反复查看（用户确认）。
  → 列表与详情接口不返回 `secret`，查看走独立权限点 `linapro-lark-push:api-key:secret`；数据库备份与
  只读账号须按含密钥数据管理。本期不加 IP 白名单、不做落库加密（宿主无密钥管理能力，自建主密钥只是把
  问题搬到配置文件）。轮换：新建一条凭据交给调用方，确认切换后停用或删除旧条目。
- **[每次请求查库]** 签名中间件按 `app_key` 查一次凭据表（唯一索引命中，单行投影），用户确认请求量不大、
  不加缓存，换来停用 / 删除即时生效、无需处理集群失效。
- **[请求体不签名]** 传输途中被篡改的消息内容、文件或收件人无法被签名发现 → 接受（用户要求，FB-8 / FB-9），
  以 HTTPS 兜底；凭据校验、时间戳窗口与 nonce 防重放不受影响。
- **[文件请求占用内存]** multipart 解析把文件留在内存（上限 31 MB），并把文件内容按推送应用
  重复上传 → 接受；调用量低，且飞书单文件上限本身就是 30 MB。宿主 `RequestBodyLimit` 对 multipart 的
  上限为 `sys.upload.maxSize + 1 MB`，若运维把它调到 30 MB 以下，大文件会先被宿主拒绝。
- **[nonce 去重依赖缓存可用性]** 缓存后端不可用时无法判定重放 → 中间件**失败关闭**
  （503，错误码与「未配置凭据」区分），不降级为「跳过去重放行」。缓存是 lossy 设施，条目
  提前淘汰会让窗口内的重放再次通过，最坏情况与「完全不记 nonce」等价（窗口仅 5 分钟）。
- **[调用方时钟偏移]** 时间戳窗口 ±300 秒，机器时钟偏移超出即全部被拒（`SIGNATURE_TIMESTAMP_INVALID`）→ README 写明需
  NTP 对时；错误码可区分「时间戳超出窗口」，便于定位。

## Migration Plan

分阶段，每阶段可独立验证与回滚：

| 阶段 | 内容 | 验证 |
|---|---|---|
| M0（人工） | 两个企业各建推送应用 + 开通 `im:message:send_as_bot` + 设可用范围；给两个身份应用补「获取用户 user_id」权限并发布版本 | 手工各发一条，确认机器人名是推送应用 |
| M1 | SDK：`larkim.SendText` + `BuildTextContent` | SDK 单测；纯新增零行为变更 |
| M2 | employee-core：`MapOwnLarkUserIDsByEmployeeNo`（凭据读取不变） | 跑一轮全量同步，`lark_identity` 行数与基线一致；抽查两企业 `lark_user_id` 非空率 |
| M3 | 主仓 4 份 yaml 新增 `plugin.linapro-lark-push.push_groups` 段（FB-2 前为 `push_apps`；既有 `lark_apps` 不动） | 启动后登录/同步照旧，`status` 能按分组列出台账 |
| M4 | eval-360：卡片改经 `larkpushcap.SendCard`（FB-1），`card_templates` 改按推送应用配置 | `Precheck` 通过，内部账号经推送应用收到卡片且点开免登 |
| M5 | 新插件骨架 + 门面 + 编排 + 单测（先不暴露 HTTP） | 单测覆盖；进程内调用发通一条 |
| M6 | HMAC 签名中间件（FB-3）+ controller + 请求日志 + `status` 端点 | curl/Go/PHP 矩阵（缺头、时间戳超窗、nonce 重放均为签名类拒绝：原为 401，FB-12 起为 HTTP 200 + 各自 `errorCode`；存储不可用→503、正常→200）；两企业各收一条 |
| M7 | 收尾：`plugin.autoEnable`（排在 employee-core 之后）、`hack/config.yaml`、README、`make plugins.check` | 从零部署一遍全绿 |

**部署注意**：本方案不触碰既有飞书凭据，因此代码与配置的上线顺序是自由的。唯一的前置是
M0（飞书侧建推送应用并授权）；未完成时推送能力会以 `CodeNoPushApp` / `ConfigInvalid` 失败关闭，
登录与同步完全不受影响。

**回滚**：卸载 `linapro-lark-push` 即可，其余插件无感知。

## Open Questions

1. **（FB-1 定为共用，FB-2 改为分组）** 推送应用按调用方插件 ID 分组，各插件使用各自机器人；
   对外 HTTP 按签名凭据绑定分组；同一 `app_id` 允许出现在多个分组（见 D11）。
2. 外部调用方是否需要 IP 白名单（当前设计只有 HMAC 签名 + nonce 防重放）。
3. 两个推送应用在日志与结果中的 `name` 取值（建议「系统通知(霍尔果斯)」/「系统通知(星嘉)」）。
