## Context

`linapro-moka-hcm`只提供 Moka HCM OpenAPI 的认证、HTTP 传输与两个业务接口（`GetReportData`、`ListEmployees`/`ListAllEmployees`），除向宿主注册自身外没有任何插件行为：没有路由、没有后台任务、没有数据表、没有前端资源。它已被改为共享库，模块名`linapro-moka-hcm`、客户端包位于模块根`hcm/`。

本变更补齐规格记录。代码改造先前已落地但未走`OpenSpec`流程，主规格停留在插件形态；本变更把主规格修正为共享库形态，并顺带纠正规格与实现之间长期存在的偏差。

## Goals / Non-Goals

**Goals:**

- 主规格反映真实交付形态：共享库，非插件。
- 删除已不存在的`插件注册与客户端工厂`要求及其三个场景。
- 让规格中的接口名、方法签名、字段集、包路径与实际代码一致。

**Non-Goals:**

- 不新增或修改任何客户端行为、接口方法或鉴权逻辑。
- 不把本库改造为`backend/cap`领域能力契约。
- 不补齐`GetJSON`等未实现接口的需求条目，也不为本库补测试。

## Decisions

- **共享库而非`backend/cap`契约**：`backend/cap`要求存在 owner 插件，且使用方须在`plugin.yaml`声明依赖；本库是无状态客户端，没有需要宿主生命周期的运行期状态。以普通 Go 模块经`require`+`replace`复用最直接，也与`linapro-lark-sdk`、`linapro-moka-recruit`一致。
- **模块名不带`lina-plugin-`前缀**：插件治理`ownerPluginIDFromImport`会按该前缀兜底识别插件 owner，即使没有`plugin.yaml`也会给每个引入方报`PluginPackageBoundary`。
- **包上移到模块根`hcm/`**：没有插件后`backend/`层级不再有意义；用`git mv`保留历史。
- **删除`manifest/i18n/*/plugin.json`**：其中只有`plugin.<id>.name/description`，仅供插件管理页展示，非插件后无消费者。
- **删除`插件注册与客户端工厂`而非改写**：`OnStart`读配置、把`*hcm.Client`注册为插件能力这套流程整体消失；凭据改由各使用方从自己的运行期配置读取。改写会留下一个没有实现主体的要求，直接`REMOVED`更准确。
- **顺带纠正签名描述而非留作后续变更**：`Auther`/`PostJSON`签名/`HCMEmployee`字段集属于同一条要求的同一段文字，且已与代码不符多时；若保留错误描述，规格会持续误导使用方。

## Risks / Trade-offs

- [宿主`plugin.autoEnable`仍列出`linapro-moka-hcm`，启动时报`PluginAutoEnableManifestNotFound`] → 由用户自行从宿主配置删除该条目，框架目录不在本次修改范围。
- [`sys_plugin`表残留`linapro-moka-hcm`记录] → 由用户清理，本变更不触碰数据库。
- [linactl 生成的`temp/official-plugins/plugins.go`仍残留旧 import] → 生成器只收录同时存在`plugin.yaml`与`backend/plugin.go`的模块，下次 plugin-full 构建自动去除；该文件位于被忽略的`temp/`，不手改。
- [`Realname`的用途描述从「飞书通讯录 JOIN 键」改为「仅作展示」] → JOIN 实际用工号（见`linapro-employee-core`的 D13），旧描述会让使用方以为可以按姓名匹配。

## Migration Plan

使用方同步改导入路径即可，无数据迁移、无 schema 变更、无配置键变更。凭据仍由各使用方插件从自己的运行期配置读取，本库与数据库都不保存凭据。

部署随宿主编译。回滚：恢复旧模块名与`backend/hcm`路径，并让使用方`go.mod`回退；宿主`autoEnable`需相应恢复条目。

## 影响分析

- `i18n`：删除的`plugin.json`仅为插件名称/描述，无其他消费者；runtime i18n 命中数迁移前后一致，无新增。
- 缓存一致性：无缓存影响。
- 数据权限：无数据操作影响，本库无表、无接口。
- 开发工具跨平台：不修改任何工具或脚本。
- DI 来源检查：未新增运行期依赖。使用方仍在各自的启动装配处（`linapro-employee-core/backend/plugin_sync.go`、`linapro-moka-report-sync/backend/internal/config/config.go`）以`hcm.NewClient`构造客户端，仅导入路径变化，不涉及新的服务构造、关键路径装配或宿主服务适配器。
- 测试策略：本库现有`sign_test.go`、`employee_test.go`不涉及导入路径，随包移动即可；不新增测试。
