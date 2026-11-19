## Context

`sys_config` 的值类型由 `config-param-value-types` 治理，现有封闭集合为 `text` / `textarea` / `number` / `boolean` / `select` / `radio` / `multi_select` / `richtext`。值类型相关代码分布如下：

- 后端：枚举和校验在 `apps/lina-core/pkg/configvaluetype/`。`ValidateTypedValue` 是唯一的类型校验点，新增、更新、导入三条写路径都经 `sysconfig_value_type.go` 的 `validateTypedConfigValue` 调用它。
- 前端：`views/system/config/data.ts` 的 `valueFieldSchema` 按 `valueType` 查表返回值组件，`config-modal.vue` 只负责调度。弹窗尺寸由 `resolveConfigModalLayout` 统一决定，`richtext` 和 `textarea` 属于 spacious 档。
- 富文本先例：`richtext` 由宿主组件 `components/tiptap` 实现，在 `adapter/component/index.ts` 里用 `defineAsyncComponent` 注册为表单组件 `RichText`，按需加载。

管理员目前只能用 `textarea` 编辑 JSON 值。参数设置页的使用者是系统管理员，能直接读写 JSON，不需要表格化的结构编辑器。

## Goals / Non-Goals

**Goals:**

- 新增 `json` 值类型，写入前在服务端校验 JSON 合法性。
- 管理面为 `json` 提供代码编辑器：行号、高亮、括号匹配、折叠、搜索、实时语法错误标注、一键格式化，适配暗色主题。
- 编辑器作为宿主通用组件，以后插件设置页可以直接复用。
- 新依赖走 pnpm catalog，按需加载，不增加首屏体积。

**Non-Goals:**

- 不校验 JSON 结构（不引入 JSON Schema，也不限定对象或数组）。
- 不提供表格式结构编辑（这是 `linapro-config-json-value-types` 的范围）。
- 不改运行时读取路径、租户 fallback、`system_manageable`、缓存一致性语义。
- 不批量把存量参数改成 `json` 类型：内置种子数据里没有 JSON 值；非内置参数由管理员按需在编辑时改类型。
- 不改插件经 `HostConfig.SysConfig()` 写配置的路径。

## Decisions

### D1：只新增一个 `json` 类型，只校验合法性

`json` 接受任意合法 JSON 文本（对象、数组、字符串、数字、布尔、`null`），校验只调用 `json.Valid`。值为空或只有空白时视为缺值并拒绝，与 `number` 一致。

**备选**：按结构拆成 `json_object`、`json_array` 等多个类型。**否决**：管理员关心的是能不能写对，结构约束由读取该配置的业务代码负责；拆类型只会让下拉选项变多。

### D2：入库紧凑化，展示时再格式化

存储与排版分离：`normalizePersistedValue` 对 `json` 调 `json.Compact` 去掉字符串之外的空白，入库只存紧凑文本；管理面打开编辑器时再格式化为两空格缩进。

- **必须用 `json.Compact`**：它只删除空白，不改数字字面量、不丢大整数精度、不改键序。若先 `Unmarshal` 到 `any` 再 `Marshal`，超过 15 位有效数字的数字会被 float64 截断。
- **为什么压缩而不是保留原样**：`sysconfig_impl.go` 的 `refreshRuntimeParamSnapshotIfNeeded` 用 `previousValue == currentValue` 判断是否刷新运行时快照，保留排版会让「只改了缩进」的提交触发一次无意义的刷新；列表 `value` 列是 `showOverflow: 'tooltip'` 单行展示，多行文本在 tooltip 和 Excel 导出单元格里都难读；紧凑化还能吸收重复键、首尾空白这类排版噪声。
- **展示侧**由编辑器承担：`json-editor.vue` 拿到首个非空值时格式化一次并回写，用户后续输入不被改写；手动格式化按钮同样可用。格式化用 catalog 中已有的 `json-bigint`（`strict` 模式）解析，长数字原样写回；遇到重复键拒绝格式化，避免静默丢掉其中一个。
- 压缩失败时不在此处报错，交由 `validateTypedConfigValue` 返回结构化校验错误；合法 JSON 压缩不会失败，属于兜底。

**备选**：保留原文。**否决**：值不规范化，排版差异会变成写入噪声。

### D3：编辑器基于 `vue-codemirror`，不自写 CodeMirror 封装

- 组件使用 `vue-codemirror`，扩展为 `basicSetup`（行号、折叠、搜索替换、括号补全等）、`json()`、`linter(jsonParseLinter())` 和 `lintGutter()`。
- 暗色模式下追加 `@codemirror/theme-one-dark`；是否暗色取自 `@vben/preferences` 的 `usePreferences().isDark`，切换主题时编辑器跟随。
- 编辑区高度通过 `vue-codemirror` 的 `style` 属性设置（内部转成 `EditorView.theme`），高度值由弹窗布局策略传入。

**为什么不自写封装**：`vue-codemirror` 已经处理好三件容易出错的事——外部改值时不让光标跳走、不清空撤销历史，切换只读时不重建编辑器，卸载时销毁编辑器。自写封装只省大约 20 KB（gzip），这个页面访问量低、编辑器又是按需加载，不值得。

**风险**：`vue-codemirror` 最后一次发版是 2023-08。它对 CodeMirror 核心包以 `6.x` 声明依赖，源码只有两百来行。若将来与 CodeMirror 新版本不兼容，可以把源码内联到组件目录自己维护，迁移成本低。

### D4：依赖登记在 catalog，组件放在宿主 `components/code-editor`

**依赖**：`pnpm-workspace.yaml` 的 `catalog:` 新增 `vue-codemirror`、`codemirror`、`@codemirror/lang-json`、`@codemirror/lint`、`@codemirror/state`、`@codemirror/theme-one-dark`，`apps/web-antd/package.json` 统一写 `catalog:`。格式化用到的 `json-bigint` 与 `@types/json-bigint` 已在 catalog 中，`web-antd` 直接引用。

- `vue-codemirror` 把 `codemirror` 声明为 peer 依赖，所以 `codemirror` 必须由应用显式声明。
- 组件代码直接导入 `@codemirror/state` 的 `Extension` 类型，在 pnpm 严格模式和 `pnpm check:dep` 下必须声明为直接依赖，不能依赖传递安装。`@codemirror/view` 不直接导入，由 `vue-codemirror` 传递引入，不单独声明。

**组件**：

- 新建 `apps/web-antd/src/components/code-editor/`，导出 `JsonEditor`。
- 在 `adapter/component/index.ts` 中参照 `RichText`，以 `defineAsyncComponent` 注册为表单组件名 `JsonEditor`。
- 组件以 `modelValue: string` 进行 `v-model` 双向绑定，可直接接入 vben 表单。

**备选**：

- 放进 `packages/effects/common-ui`：可以跨 UI 库复用。但本仓库只有 `web-antd` 一个应用，`RichText` 也放在应用层，保持一致。
- 做成通用 `CodeEditor` 并接收 `language` 参数：目前只有 JSON 一个需求，不提前抽象。

### D5：前端提交前校验，服务端最终校验

- 编辑器实时用 lint 标注语法错误的位置。
- `valueFieldSchema` 为 `json` 返回自定义校验规则：`JSON.parse` 失败时阻止提交，并在表单项下显示「JSON 格式不正确」。
- 服务端校验是最终防线，覆盖导入和直接调用 API 的路径。

### D6：`json` 归入弹窗 spacious 档，编辑区高度字段改为通用名

- `resolveConfigModalLayout` 新增 `json` 分支，弹窗宽度、全屏入口、编辑区高度沿用 `richtext` 的策略：`w-[min(960px,96vw)]`、可全屏、`clamp(360px, 52vh, 640px)`。
- `ConfigModalLayout.richtextEditorHeight` 更名为 `editorHeight`，由 `richtext` 和 `json` 共用，避免再为代码编辑器加一个同义字段。

### D7：类型切换与回显沿用现有归一函数

`coerceValueForType` 和 `normalizeFormValue` 对 `json` 都落到默认的 `String(value)` 分支，不需要新分支。从 `multi_select` 切到 `json` 时，数组会按既有逻辑先拼接成字符串，再由管理员改成 JSON。单测锁定这一行为，防止以后误加数组处理。

## Risks / Trade-offs

- **`vue-codemirror` 停更** → 依赖范围锁在 `^6.1.1`。若出现不兼容，按 D3 的方案内联源码。
- **两个变更改同一处代码**：`linapro-config-json-value-types` 也会改 `getValueTypeOptions`、`valueFieldSchema` 和后端枚举 → 两者的类型名互不占用，后实现的一方需要合并 `switch` 分支和枚举列表，合并点只有这几处。
- **暗色主题配色**：one-dark 的背景色与 vben 暗色背景不完全一致 → 编辑器带边框嵌在表单中，视觉上可以接受。如需统一，可后续用 `EditorView.theme` 覆盖背景色为 `hsl(var(--background))`。
- **构建目标是 `es2015`**：CodeMirror 6 用了较新的语法 → esbuild 会转译。tiptap 已经验证过同类情况，实现后以 `pnpm build` 产物在浏览器中实测确认。
- **i18n**：新增类型名、占位符、格式化按钮和校验提示的文案，`make i18n.check` 会检查是否缺失。

## Migration Plan

纯增量，无数据迁移：

1. 新增迭代 SQL `013-config-json-editor.sql`，只用 `COMMENT ON COLUMN` 更新 `sys_config.value_type` 的列注释（该语句天然幂等）；执行 `make db.init` 和 `make dao`，刷新生成代码中的注释。
2. 宿主重新编译即可生效，存量行不受影响。
3. 回滚：移除枚举值和前端分支即可。已改为 `json` 类型的行，在管理面投影时按既有规则归一为 `text`，值本身不受影响。

## Open Questions

无。
