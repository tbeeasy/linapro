## Why

参数设置（`sys_config`）里有不少值是一大段 JSON，目前只能按 `text`/`textarea` 类型在普通文本框里编辑：没有缩进、没有高亮、看不出括号对应关系，少一个逗号也要到运行时才发现。参数设置页只给系统管理员使用，管理员看得懂 JSON，缺的是一个像样的 JSON 编辑器和写入前的格式校验。

## What Changes

- 值类型封闭集合新增 `json`：值必须是合法 JSON 文本（对象、数组或标量均可），不约束结构；入库前删除多余空白（紧凑化），键序、数字和字符串内容不变。
- 后端写路径（新增、更新、导入）对 `json` 类型做合法性校验，非法 JSON 拒绝写入，复用既有错误码 `SYSCONFIG_TYPED_VALUE_INVALID`。
- 管理面新增宿主组件 `JsonEditor`：基于 `vue-codemirror`（CodeMirror 6），提供行号、语法高亮、括号匹配、折叠、搜索替换、实时语法错误标注和「格式化」按钮，跟随系统暗色主题。组件按需异步加载，只在打开 `json` 类型参数时下载。
- `json` 类型归入弹窗 spacious 档：加宽弹窗、提供全屏入口、编辑区高度随视口变化。
- 前端依赖 `vue-codemirror`、`codemirror`、`@codemirror/*` 统一登记在 `pnpm-workspace.yaml` 的 catalog，`web-antd` 以 `catalog:` 引用。
- API 文档、数据库列注释与 i18n 资源补充 `json` 类型说明。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `config-param-value-types`：封闭值类型集合加入 `json`；写路径增加 `json` 合法性校验；管理面按 `json` 类型渲染代码编辑器并归入 spacious 弹窗档。

## Impact

- **后端**：`apps/lina-core/pkg/configvaluetype/`（枚举与校验）、`apps/lina-core/api/config/v1/` 的 `dc` 说明、`manifest/i18n/*/apidoc/core-api-config.json`；新增迭代 SQL 只更新 `sys_config.value_type` 列注释，随后 `make dao` 刷新生成代码注释。表结构与数据不变。
- **前端**：`apps/lina-vben/apps/web-antd/src/components/code-editor/`（新组件）、`src/adapter/component/index.ts`（注册 `JsonEditor`）、`src/views/system/config/data.ts`（类型选项、`valueFieldSchema`、弹窗布局）、`src/api/system/config/model.d.ts`、项目 locale `pages.json`。
- **依赖**：新增 `vue-codemirror`、`codemirror`、`@codemirror/lang-json`、`@codemirror/lint`、`@codemirror/state`、`@codemirror/theme-one-dark`。异步分块约 140 KB（gzip），不影响首屏。
- **不涉及**：运行时读取路径（仍只读字符串 `value`）、`system_manageable`、租户 fallback、缓存一致性、数据权限、插件 `HostConfig.SysConfig()` 契约。
- **相关变更**：`linapro-config-json-value-types`（未实现）计划为非开发者提供 `json_map`/`json_list`/`json_list_map` 表格式结构编辑器。本变更面向管理员的原始 JSON 编辑，两者可以并存：本变更只新增 `json` 一个类型，不占用对方的类型名。两者都会改 `data.ts` 中的类型选项和 `valueFieldSchema`，后实现的一方需要合并。
