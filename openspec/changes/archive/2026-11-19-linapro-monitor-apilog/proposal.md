## Why

宿主的操作日志（上游插件 `linapro-monitor-operlog`）只记录**有后台登录身份**的请求，取不到操作人就直接跳过。
因此员工端接口的入参和返回目前在系统里**没有任何留存**：360 评估的作答提交、员工飞书登录、员工身份查询，员工都用员工令牌或免登身份访问，没有后台用户名。

员工反馈「我提交了但系统没收到」「我提交的数据不对」「我登录不了」时，只能翻控制台日志。而日志只输出到 stdout、不落文件，也不含请求体。
需要一个统一的地方，按时间、调用方、接口查到当时**完整的请求和响应**。

## What Changes

- **新增源码插件 `linapro-monitor-apilog`（接口请求日志）**，不修改上游的 `linapro-monitor-operlog`：
  - 注册全局中间件，自动记录所有**没有后台登录身份**的插件接口请求，包括 GET。以后新增的员工端接口不用改代码就会被记录。
  - 每条记录保存：时间、方法、路径、查询串、客户端 IP、路由归属插件、调用方标识（EmpID / app_key 及其姓名、工号、租户）、HTTP 状态、耗时、request_id、请求头（脱敏）、**完整请求体**、**完整响应体**。
  - 请求体和响应体**不设大小上限**。上传文件只记字段名、文件名、类型和大小，不存文件内容；二进制响应只记类型和长度。
  - 密码、secret、token、签名等敏感字段一律脱敏。
- **按路由归属插件排除**：`linapro-lark-push`（已自行留痕，且明确不存消息正文）不记录。排除名单由配置项 `exclude_route_owners` 表达；**键缺失时回落到内置默认值 `[linapro-lark-push]`**，显式写 `[]` 则全量记录。
- **记录只增不删，永久保存**：
  - 不设保留期，不注册任何清理定时任务。
  - 不提供删除接口或页面入口，service 层不暴露 Delete 方法。
  - 卸载插件不删表；卸载后重装时新增列靠 `ADD COLUMN IF NOT EXISTS` 收敛。
  - 360 评估与考勤的记录同样永久保存。
- **按 `request_at` 做月度范围分区**：靠分区剪枝控制查询扫描量，分区由每日任务提前补齐 6 个月；任务只创建新分区，不删除、不 detach 已有分区。
  - PostgreSQL 14 不支持分区表上的 identity 列，因此主键为 `(id, request_at)`，`id` 由序列生成。
  - 详情查询需同时提供 `request_at`，否则会退化为全分区扫描。
  - `request_at` 是请求开始时间，由中间件显式写入；`created_at` 是写库时间，交给框架自动写入、不手动赋值，与 operlog 的 `oper_time` 同一做法。
- **调用方标识约定**：各插件的鉴权中间件在通过后，把一个 JSON 字符串写入约定的请求上下文变量（`kind` / `id` / `tenant` / `name` / `no`）。日志插件只读这个约定键，不 import 任何业务插件；业务插件也不依赖日志插件。
- **后台「系统监控 → 接口请求日志」查询页**：
  - 可按时间、归属插件、路径、调用方、HTTP 状态、request_id 筛选。
  - 详情抽屉展示完整请求和响应。
  - 列表和详情使用独立的权限点，因为详情含员工提交的业务数据。
- **接入调用方标识**：`empcap.EmpAuth()` 与 employee-core 的登录控制器各写一次。前者同时覆盖 `linapro-employee-core` 与 `linapro-eval-360` 的员工端。

## Capabilities

### New Capabilities

- `linapro-monitor-apilog`：非管理后台接口请求的自动记录、脱敏、按插件排除与后台查询，记录只增不删。

### Modified Capabilities

无。`empcap.EmpAuth()` 与登录控制器各增加一行写上下文变量，不改变任何插件的对外契约；报警走共享库 `linapro-lark-sdk/larkalert`，`linapro-lark-push` 不受影响。

## Impact

- **新插件** `apps/lina-plugins/linapro-monitor-apilog/`，包含：
  - 一张表 `plugin_linapro_monitor_apilog`；
  - 全局中间件、后台查询接口与页面（不启用 i18n，文案直接用中文）。无清理定时任务。
- **业务插件**：`linapro-employee-core` 的 `empcap.EmpAuth()` 与登录控制器各增加一行写入，`linapro-eval-360` 无需改动即被覆盖。`linapro-lark-push` **不受影响**。
- **共享库** `linapro-lark-sdk`：新增子包 `larkalert`（读配置 → 防抖 → 拼正文 → `larkim` 发送），供各插件上报运维告警。直接用宿主 capability 与 `lina-core/pkg/logger`，与 `linapro-moka-hcm`、`linapro-moka-recruit` 的做法一致。
  - 不改动该库既有的其他文件与边界文案（见 design D9 末尾的说明）。
- **插件依赖**：`linapro-monitor-apilog` **不依赖任何插件**（`plugin.yaml` 无 `dependencies.plugins`），可独立安装；`go.mod` 只增加共享库 `linapro-lark-sdk`。
- **配置**：三份配置文件的 `_anchors` 增加 `ops_alert`，由各插件按需用 YAML 别名引用——凭据登记一次，每个插件仍读自己的键。
- **存储**：请求体和响应体完整保存，且记录只增不删、没有清理出口。表会持续增长，接入考勤后更陡；可用的手段只剩「减少写入」（排除名单）与扩容。**上线前必须为这张表配置定期 `pg_dump` 备份**——应用用 `postgres` 超级用户连库，数据库权限挡不住误删，备份是唯一兜底。见 design 的风险部分。
- **隐私**：记录含员工提交的业务数据。详情只对持有对应权限点的管理员开放，敏感字段落库前脱敏；消息推送正文不入表。
