# 飞书长连接接入的实测约束，以及同批验证出的两条插件接入结论

2026-08 用一个临时源插件（`linapro-attend-poc`）实跑验证了四件事：飞书长连接生命周期、无请求 ctx 的租户定位、插件粒度启停、三层数据权限接入插件表。四项均通过，但暴露了若干必须写进落地方案的硬约束。本文记录这些约束——它们是**实测事实**，不会因为正式插件重新生成代码而改变。

实测环境：Windows + 本机 PostgreSQL + `go run` 直启后端，飞书测试应用走长连接模式。

## 一、飞书长连接：优先用 HTTP 事件订阅，长连接须自行治理

**决策**：正式插件接入飞书事件**优先选 HTTP 事件订阅模式**——框架原生支持，无下述两个缺陷。长连接模式作为需要低延迟时的备选，选它就要接受自行承担连接治理。

**为什么**：长连接实测暴露两个约束，根因是同一个——SDK 关不干净的连接，撞上宿主的生命周期钩子超时。

1. **宿主对生命周期钩子有 5s 硬超时**（`DefaultLifecycleHookTimeout`）。`BeforeDisable` 耗时超 5s，宿主否决禁用并报 `PLUGIN_LIFECYCLE_PRECONDITION_VETOED`，插件卡在**无法禁用**状态。而「禁用插件即停 handler」正是插件粒度启停的核心手段，禁用一旦失灵，治理手段就废了。实测把优雅关闭兜底设为 3s 后，禁用恢复正常（耗时 3.09s）。
2. **larkws SDK 没有 `Close()` 接口**，`Start()` 阻塞在 `select{}`，长连接 goroutine 只能随进程退出，无法随插件禁用回收。封装层只能用超时兜底捕获，日志为 `Feishu WS connection did not stop within 3s; SDK lacks a Close() seam`。

长连接落地时三选一：fork SDK 补 `Close()`、改用 HTTP 事件订阅、或接受「禁用时连接悬挂至多到进程重启」。

**多租户注意**：N 个租户 = N 条 WS 时，`BeforeDisable` 里**必须并行关停**——串行 N×3s 会突破 5s 触发否决（两租户 3s+3s=6s>5s）。并行关停 + `BeforeDisable` 恒返回 `allow=true` 是近零成本的保险。

## 二、上述超时约束的触发边界（已代码核实，勿当阻塞项重议）

`BeforeDisable` 钩子**仅由运行时显式禁用插件触发**（管理员经治理 API `disableSourcePlugin`）；**进程关闭、重启、SIGTERM 都不触发它**。

- **进程整停场景**（部署重启、崩溃）：钩子不跑，连接随进程死，5s 否决与 goroutine 泄漏都不发生——两个约束是同一根因，进程整停时一起消失。
- **故对「核心常驻、只随整服务重启」的插件**：若从不运行时单独禁用，这两个约束实际踩不到。
- **仍会踩到的口子**：插件热升级（disable→enable）、把「禁用插件」当作暂停同步的手段、后台误点禁用、依赖级联。

## 三、数据范围：源码插件只能用编程式，声明式走不通

**决策**：插件表的行级数据范围用**编程式**接入（`services.BizCtx().Current(ctx).DataScope` + `services.Org().Assignment().GetUserDeptIDs()`），不要指望 manifest 里声明 `dataScope` 自动生效。

**为什么**：声明式 `dataScope` 路径目前只对 dynamic 插件（wasmbuilder）支持，源码插件上未走通。实跑四种身份、同一张插件表、同一接口，编程式过滤结果全部正确：平台超管见全部租户，平台运营见全部，租户管理员只见本租户，部门角色只见本部门，普通员工只见自己。

**两条踩坑，须纳入落地流程**：

1. **插件的按钮权限码不会自动授予任何角色**。必须把插件 menu 的 `menu_id` 写进 `sys_role_menu`，否则非超管账号调接口会被 `middlewares.Permission()` 拦截、返回空。落地时要么随插件 mock-data 附带角色授权，要么后台手工配。
2. **dept 范围除依赖 `linapro-org-core` 启用外，还要求用户在 `plugin_linapro_org_core_user_dept` 有部门分配记录**；无记录时按设计静默降级为本人范围——排查「主管看不到数据」时先查这张表。

## 四、无请求 ctx 的租户定位：可手动构造 ctx，形态成立

定时任务、长连接回调不走 HTTP 请求链路，`CurrentTenantID(ctx)` 拿不到上下文。实测从 `context.Background()` 出发、用 `bizctxcap.WithCurrentContext` 手动注入 `TenantID`，一次调用同时写两个租户的数据，读回严格隔离——**「遍历启用租户逐个拉数据」的定时任务形态成立**。

链路：`bizctxcap.WithCurrentContext`（`TenantID>0` 时 `PlatformBypass=false`）→ 宿主 `BizCtx().Current(ctx)` 回落读 `CurrentFromContext` → `ApplyPluginTableFilter` 自动加 `WHERE tenant_id=?`。

**仍未验证的一小段**：飞书**回调**模式下「租户从哪来」是另一子情形——每租户独立应用，回调到达时租户由「哪条连接/哪个应用收到」反推。落库机制与定时任务同款，但「从连接反推租户」需真实飞书回调验证。

## 五、插件粒度启停：闭环成立

disable/enable 均返回成功，`enabled` 字段正确切换，每次 enable 都重新触发 `afterEnable`。「禁插件 → handler 与连接停、启插件 → 自动恢复」闭环成立——受第一节 5s 超时约束限制。插件可拆成「事件回调」「定时同步」「配置与表 owner」三者独立启停、互不影响，**但每个的 `BeforeDisable` 优雅关闭都须 < 5s**。
