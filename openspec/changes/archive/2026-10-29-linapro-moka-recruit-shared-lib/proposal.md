## Why

`linapro-moka-recruit`名义上是源码插件，实际只是 Moka 招聘 OpenAPI 客户端库：`init()`只注册自身，没有路由、任务、表。`linapro-moka-report-sync`与`linapro-recruit-pipeline`直接 import 它的`backend/moka`包，被插件治理判为跨插件越界（`plugin-cross-plugin-private-import`，共 5 条）。参照已完成的`linapro-moka-hcm`改造，把它改为非插件共享库，并让 capability 规格与实现一致。

## What Changes

- **BREAKING**：模块名`lina-plugin-linapro-moka-recruit`→`linapro-moka-recruit`；包路径`backend/moka`→模块根`moka/`。使用方导入路径改为`linapro-moka-recruit/moka`，`go.mod`的`require`+`replace`同步改名。
- 删除插件形态资源：`plugin.yaml`、`plugin_embed.go`、`backend/plugin.go`、`frontend/`、`manifest/`（含只承载插件名称/描述的`manifest/i18n/*/plugin.json`）。
- 新增中英双语`README.md`/`README.zh-CN.md`，说明共享库定位、模块名不带前缀的原因、认证方式、API 路径前缀、用法与使用方。
- 规格同步：`模块结构`、`鉴权自包含`、`GetReportData`的模块名与包路径更新；顺带纠正与实现长期不一致的描述（单请求超时 30s→60s、接口名`Auther`→`Author`、`PostJSON`请求体`any`→`[]byte`、删除与`linapro-moka-hcm`构造签名"对齐"的不实表述）。

**明确不在本变更**：

- 不补齐`EhrApplications`、`MoveApplicationStage`、`GetInterviewInformation`、`GetHandleResult`、`GetResumeContent`、`GetStagesList`、`GetJSON`、`PutQuery`等已实现接口的需求条目。
- 不处理`linapro-moka-report-sync`/`linapro-recruit-pipeline`import`empcap`但未在`plugin.yaml`声明依赖的 3 条`plugin-source-cap-import-missing-dependency`finding。
- 不清理本库`fmt.Errorf`等触发的 54 条 runtime i18n 命中（迁移前后数量一致，未新增）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `linapro-moka-recruit`：交付形态由源码插件改为非插件共享库；模块名、包路径变更；纠正客户端超时、接口名与`PostJSON`签名描述。

## Impact

- **代码**：`apps/lina-plugins/linapro-moka-recruit/`（目录结构与`go.mod`）；`linapro-moka-report-sync`（`go.mod`、`backend/internal/service/sync.go`）；`linapro-recruit-pipeline`（`go.mod`、`backend/plugin.go`、`backend/job/*`、`plugin.yaml`描述）。
- **宿主配置**：`apps/lina-core/manifest/config/`下`plugin.autoEnable`中的`linapro-moka-recruit`条目需由用户删除，否则宿主启动报`PluginAutoEnableManifestNotFound`。
- **不受影响**：根`go.work`（目录路径不变）、`hack/tools/emptoken/go.mod`、数据库（本库无表）。
