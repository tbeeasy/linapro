## Why

`linapro-moka-hcm`名义上是源码插件，实际只是 Moka HCM OpenAPI 的 Go 客户端库：`init()`只注册自身，没有路由、任务、表，能力注册的唯一消费者是直接 import 包的使用方。它已经被改为非插件共享库（module 名`linapro-moka-hcm`、包在模块根`hcm/`），但主规格仍描述插件形态，且多处以早已失效的接口签名和路径为准。

本变更把主规格补齐到与实现一致。改造本身在代码上已经完成，本变更负责把「为什么改、改了什么、验证过什么」补上，使主规格由归档写入而非手改。

## What Changes

- **BREAKING**：模块名`lina-plugin-linapro-moka-hcm`→`linapro-moka-hcm`；包路径`backend/hcm`→模块根`hcm/`。使用方导入路径改为`linapro-moka-hcm/hcm`，`go.mod`的`require`+`replace`同步改名。
- 删除插件形态资源：`plugin.yaml`、`plugin_embed.go`、`backend/plugin.go`、`frontend/`、`manifest/`（含只承载插件名称/描述的`manifest/i18n/*/plugin.json`）。
- 新增中英双语`README.md`/`README.zh-CN.md`，说明共享库定位、模块名不带前缀的原因、API 面、用法与使用方。
- 规格同步：删除`插件注册与客户端工厂`要求（`OnStart`读四项配置、注册`*hcm.Client`为插件能力），新增`共享库模块边界`要求；并纠正与实现长期不一致的描述——接口名`Auther`→`Author`、`ApplyAuth`增加`extra`参数、`PostJSON`签名改为`(ctx, path, apiCode, body []byte, extra)`、认证由`Client`内部`HCMAuth`完成、`HCMEmployee`字段集与`Realname`用途、包内文件清单、`APICodeKey*`常量。

**明确不在本变更**：

- 不新增或修改任何客户端行为、接口方法或鉴权逻辑。
- 不把本库改造为`backend/cap`领域能力契约。
- 不处理`linapro-moka-report-sync`/`linapro-recruit-pipeline`import`empcap`但未在`plugin.yaml`声明依赖的 3 条`plugin-source-cap-import-missing-dependency`finding。
- 不清理本库`fmt.Errorf`/`gerror`等触发的 runtime i18n 命中（迁移前后数量一致，未新增）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `linapro-moka-hcm`：交付形态由源码插件改为非插件共享库；模块名、包路径变更；删除插件注册与客户端工厂要求；纠正认证接口、客户端签名与员工列表字段描述。

## Impact

- **代码**：`apps/lina-plugins/linapro-moka-hcm/`（目录结构与`go.mod`）；`linapro-employee-core`（`go.mod`、`backend/plugin_sync.go`）；`linapro-moka-report-sync`（`go.mod`、`backend/internal/config/config.go`、`backend/internal/service/sync.go`）；`hack/tools/emptoken/go.mod`的`replace`路径。
- **宿主配置**：`apps/lina-core/manifest/config/`下`plugin.autoEnable`中的`linapro-moka-hcm`条目需由用户删除，否则宿主启动报`PluginAutoEnableManifestNotFound`。另需由用户清理`sys_plugin`表中的孤儿记录。
- **不受影响**：根`go.work`（目录路径不变）、数据库（本库无表）。
