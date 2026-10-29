## Context

`linapro-moka-recruit`只提供 Moka 招聘 OpenAPI 的鉴权与 HTTP 客户端，除向宿主注册自身外没有任何插件行为。`linapro-moka-hcm`已按同一模式改为共享库（module 名`linapro-moka-hcm`、包在模块根`hcm/`），本变更照此先例执行。

## Goals / Non-Goals

**Goals:**

- 消除使用方 import 本库触发的`plugin-cross-plugin-private-import`finding。
- capability 规格与实际实现一致。

**Non-Goals:**

- 不新增或修改任何客户端行为、接口方法或鉴权逻辑。
- 不把本库改造为`backend/cap`领域能力契约。

## Decisions

- **共享库而非`backend/cap`契约**：`backend/cap`要求存在 owner 插件，且使用方须在`plugin.yaml`声明依赖；本库是无状态客户端，没有需要宿主生命周期的运行期状态。以普通 Go 模块经`require`+`replace`复用最直接，也与`linapro-lark-sdk`、`linapro-moka-hcm`一致。
- **模块名不带`lina-plugin-`前缀**：插件治理`ownerPluginIDFromImport`会按该前缀兜底识别插件 owner，即使没有`plugin.yaml`也会给每个引入方报`PluginPackageBoundary`。
- **包上移到模块根`moka/`**：没有插件后`backend/`层级不再有意义；用`git mv`保留历史。
- **删除`manifest/i18n/*/plugin.json`**：其中只有`plugin.<id>.name/description`，仅供插件管理页展示，非插件后无消费者。

## Risks / Trade-offs

- [宿主`plugin.autoEnable`仍列出`linapro-moka-recruit`，启动时报`PluginAutoEnableManifestNotFound`] → 由用户自行从宿主配置删除该条目，框架目录不在本次修改范围。
- [linactl 生成的`temp/official-plugins/plugins.go`仍残留旧 import] → 生成器只收录同时存在`plugin.yaml`与`backend/plugin.go`的模块，下次 plugin-full 构建自动去除；该文件位于被忽略的`temp/`，不手改。

## 影响分析

- `i18n`：删除的`plugin.json`仅为插件名称/描述，无其他消费者；runtime i18n 命中数迁移前后一致（总 955 条，本库 54 条），无新增。
- 缓存一致性：无缓存影响。
- 数据权限：无数据操作影响，本库无表、无接口。
- 开发工具跨平台：不修改任何工具或脚本。
- DI 来源：未新增运行期依赖；使用方仍在各自启动装配处以`NewClient`构造客户端，仅导入路径变化。
