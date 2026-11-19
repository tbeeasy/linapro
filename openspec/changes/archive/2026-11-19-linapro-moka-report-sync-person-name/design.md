## Context

人员列管线现状：`preparePersonFields`把人员字段的值换成`personFieldSources`声明的工号列的值，`Plan`内用`empcap.LarkOpenIDResolverByEmployeeNos`把工号解析为 open_id 集合，判等与写入都用这一次解析的结果。

姓名寻址在`linapro-lark-push`已有先例（姓名收件人）：经`empcap.EmployeesByNamesAnyTenant`批量取员工行，消费方自己判定「在职 + 按工号去重 + 0/1/多」。本变更沿用同一口径。

## Goals / Non-Goals

**Goals:**
- 只给姓名的 Moka 报表列也能写进 Bitable 人员字段。
- 重名不猜人，并且让运维看得见。

**Non-Goals:**
- 不做一个单元格多个姓名（业务确认不存在）。
- 不改工号来源的解析语义（只改键名）。
- 不兼容旧键`personFieldSources`，也不对旧键做检测告警。
- pivot 形态不支持人员字段（与既有一致）。

## Decisions

### 1. 新增独立配置键，不按值格式自动识别

`personFieldNameSources`与`personFieldEmpNoSources`并列，显式声明来源是姓名还是工号。

- 备选「先按工号查、查不到再按姓名查」：配置零改动，但未命中时无法区分「工号错了」还是「姓名错了」，配错列还可能被姓名回退碰巧解析成功而掩盖。
- 备选「按是否含中文判断」：英文名、音译名会误判，否决。

### 2. 工号来源键改名为`personFieldEmpNoSources`

`personFieldSources`改名为`personFieldEmpNoSources`，与`personFieldNameSources`成对命名，避免再出现「把姓名列配进工号来源」的误配。

映射存在`sys_config`（JSON），`encoding/json`对不认识的键静默忽略，所以漏改的环境会让人员列静默留空。已评估过一种做法：检测到旧键时记 error 并跳过该映射。最终不采用，改由部署时同步更换各环境配置来保证（项目不考虑兼容）。

### 3. 姓名先换工号，再复用工号链路

姓名解析只做「姓名 → 工号」这一步，产物填回人员字段，后续`Plan`的 open_id 解析、集合判等、写侧完全不变。全链路仍只有一次 open_id 解析，不维护第二条身份链路。

### 4. 匹配口径

| 情况 | 处理 |
|---|---|
| 去重后 1 名在职员工且有工号 | 取其工号 |
| 0 名在职员工（不存在或已离职） | 留空跳过，记 warn（按映射汇总） |
| 1 名在职员工但无工号 | 同上，记 warn |
| ≥2 名在职员工 | 留空跳过，记 warn，周期末推送告警 |

- 姓名只去首尾空白、原值精确匹配，与 lark-push 一致。
- 去重键：工号非空用工号，否则用`EmpID`。同一自然人跨租户各有一行时工号相同，算一人。

### 5. 查询次数

每个映射收集本轮所有姓名来源列里出现过的姓名（去重），调用一次`EmployeesByNamesAnyTenant`，然后在内存里判定。查询次数等于「配置了姓名来源的映射数」，与行数无关；映射数是运营配置的小常量。

### 6. 重名告警

- 走共享库`larkalert`，配置键`plugin.linapro-moka-report-sync.alert`，凭据引用`_anchors.ops_alert`；未配置时静默不发，只留日志。
- `larkalert`按「配置键 + 种类」防抖。若每个映射各发一条，同一轮第二个映射的告警会被防抖吞掉。因此各映射只把重名姓名收进`MappingResult`，`RunOnce`在周期末汇总成**一条**告警，按映射分组列出姓名。
- 种类`person_name_duplicate`固定不变。告警会在每轮同步时重复推送（防抖窗口 30m，同步间隔通常更长），直到员工目录或报表修正为止。这是有意的：重名意味着这一格持续写不进去。

### 7. 来源冲突

同一人员字段同时出现在`personFieldEmpNoSources`与`personFieldNameSources`时，工号来源优先（工号是稳定标识），并对该映射记一次 warn。

## Risks / Trade-offs

- **[数据权限例外]** `EmployeesByNamesAnyTenant`跨租户读取员工行。本插件是`platform_only`的后台定时任务，没有用户上下文；工号来源路径同样不按租户过滤（按飞书应用作用域过滤）。读取结果只用于把姓名换成工号，不向任何调用端暴露。所以本变更沿用现有边界，不接入角色数据权限。
- **[姓名漂移]** 员工改名或报表里的姓名有错别字时会解析不到。这种情况落在「留空 + warn」，不会写错人。
- **[告警重复]** 重名不修正会每轮告警一次，这是期望的行为。如果嫌吵，可以调大`alert.interval`。

## 影响评估

- `i18n`：插件`i18n.enabled: false`，本变更只新增日志和告警正文，不改用户界面文案，无影响。
- 缓存一致性：不新增缓存。告警防抖复用宿主`cachecap`（larkalert 既有机制），无新增影响。
- 数据权限：见上方例外说明。
- 开发工具跨平台：不改脚本或工具，无影响。
- DI：新增依赖是`larkalert.Env`，由`Runner`已持有的`capability.Services`（启动期 registrar 注入的同一实例）派生`HostConfig()` / `Cache()`，再加纯构造函数`larkim.NewClient`。没有新建服务图。
