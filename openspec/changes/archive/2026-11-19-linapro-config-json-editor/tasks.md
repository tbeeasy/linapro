## 1. 后端值类型

- [x] 1.1 `apps/lina-core/pkg/configvaluetype/configvaluetype.go`：新增 `JSON Code = "json"`，同步更新 `IsSupported`、`All`
- [x] 1.2 `configvaluetype_options.go` `ValidateTypedValue`：新增 `JSON` 分支，空白值返回「json config value is required」，`json.Valid` 失败返回「json config value must be valid JSON」
- [x] 1.3 `internal/service/sysconfig/sysconfig_value_type.go`：`normalizePersistedValue` 对 `json` 调 `compactJSONValue`（内部用 `json.Compact`）去掉字符串之外的空白，并注释说明为何不用反序列化再序列化
- [x] 1.4 单测 `configvaluetype_test.go`：合法对象、数组、标量通过；`{"a":1,}`、空串、纯空白被拒；`All()` 包含 `json`
- [x] 1.5 单测 `sysconfig_value_type_test.go`：`json` 校验错误映射为 `CodeSysConfigTypedValueInvalid`；入库紧凑化后键序、大整数精度、字符串内空白不变；`compactJSONValue` 对非法 JSON 原样返回
- [x] 1.6 `api/config/v1/config.go`、`config_create.go`、`config_update.go`：`valueType` 的 `dc` 列表加入 `json`；同步 `manifest/i18n/zh-CN/apidoc/core-api-config.json` 中对应的中文说明

## 2. 数据库注释

- [x] 2.1 新增 `apps/lina-core/manifest/sql/013-config-json-editor.sql`：`COMMENT ON COLUMN sys_config."value_type"` 加入 `json`（只改注释，可重复执行）
- [x] 2.2 执行 `make db.init confirm=init`（不加 `rebuild`）与 `make dao`，确认 `dao/internal`、`model/do`、`model/entity` 中 `ValueType` 的注释已更新，且没有其他非预期的生成差异

## 3. 前端依赖

- [x] 3.1 `apps/lina-vben/pnpm-workspace.yaml` `catalog:` 新增 `vue-codemirror`、`codemirror`、`@codemirror/lang-json`、`@codemirror/lint`、`@codemirror/state`、`@codemirror/theme-one-dark`
- [x] 3.2 `apps/web-antd/package.json` 以 `catalog:` 引用上述依赖，并引用 catalog 中已有的 `json-bigint`（devDependencies 引用 `@types/json-bigint`）；执行 `pnpm install` 更新 `pnpm-lock.yaml`
- [x] 3.3 `pnpm check:dep` 无新增缺失或多余依赖（`@lina/web-antd` 只剩改动前就有的 `@vue/test-utils`、`virtual:*` 与 `vxe-pc-ui` 告警）

## 4. JsonEditor 组件

- [x] 4.1 新建 `apps/web-antd/src/components/code-editor/`（`index.ts` 导出 `JsonEditor`，`src/json-editor.vue` 实现）：基于 `vue-codemirror`，扩展为 `basicSetup`、`json()`、`linter(jsonParseLinter())`、`lintGutter()`；`v-model` 绑定 `modelValue: string`；支持 `height`、`placeholder`、`disabled` 属性
- [x] 4.2 暗色主题：读取 `usePreferences().isDark`，暗色时追加 `oneDark`，切换主题时编辑器跟随；打开编辑时对紧凑存储值格式化一次展示
- [x] 4.3 工具栏「格式化」按钮：合法 JSON 时重排为两空格缩进；非法时（含重复键）不改动内容，并用 `message.warning` 提示。用 `json-bigint` 解析，避免超过 15 位有效数字的数字在格式化时丢精度
- [x] 4.4 `src/adapter/component/index.ts`：参照 `RichText`，用 `defineAsyncComponent` 注册表单组件 `JsonEditor`，并加入组件类型联合与组件映射；`adapter/form.ts` 的 `modelPropNameMap` 登记 `JsonEditor: 'modelValue'`

## 5. 参数设置页接入

- [x] 5.1 `src/api/system/config/model.d.ts`：`ConfigValueType` 加入 `'json'`
- [x] 5.2 `views/system/config/data.ts` `getValueTypeOptions`：加入 `json` 选项
- [x] 5.3 同文件 `ConfigModalLayout.richtextEditorHeight` 更名为 `editorHeight`，同步所有引用；`resolveConfigModalLayout` 新增 `json` 分支（宽弹窗、可全屏、`clamp(360px, 52vh, 640px)`）
- [x] 5.4 同文件 `valueFieldSchema` 新增 `json` 分支：返回 `JsonEditor` 及其高度、占位符属性，并附带 `JSON.parse` 校验规则（必填 + 格式不正确时提示）
- [x] 5.5 `config-modal.vue`：`refreshValueFieldSchema` 对 `json` 使用分支返回的校验规则，而非固定的 `'required'`；确认类型切换与编辑回显正常
- [x] 5.6 单测：新增 `views/system/config/data.test.ts`，覆盖 `resolveConfigModalLayout('json')` 为 spacious 档、`valueFieldSchema` 对 `json` 返回 `JsonEditor`、校验规则对合法和非法 JSON 的判定、`coerceValueForType` 和 `normalizeFormValue` 对 `json` 原样返回字符串

## 6. i18n

- [x] 6.1 `src/locales/langs/zh-CN/pages.json` 与 `en-US/pages.json`：补 `pages.system.config.valueTypes.json`、`placeholders.json`、格式化按钮文案、「JSON 格式不正确」「无法格式化」提示
- [x] 6.2 `make i18n.check` 无缺失（message/frontend key 覆盖检查通过；扫描失败项全部在既有插件目录，宿主与本变更文件无新增）

## 7. E2E

- [x] 7.1 `hack/tests/e2e/settings/config/TC007-config-param-value-types.ts` 新增 `TC-7e`：创建 `json` 参数，断言弹窗加宽并出现全屏入口、编辑器可见；输入非法 JSON 时确定被阻止并出现提示；改为合法 JSON 后点格式化、保存成功，列表中显示保存的值；最后清理测试数据
- [x] 7.2 运行 TC007 全部用例（5/5 通过，7a–7d 无回归）。注意 E2E 走 `9120/admin` 入口，实际加载的是 Vite dev 产物，不是 `pnpm build` 产物

## 8. 验证与影响分析

- [x] 8.1 后端：`go test ./pkg/configvaluetype/... ./internal/service/sysconfig/...` 通过
- [x] 8.2 前端：vitest 11/11 通过（`data.test.ts` 6、`format.test.ts` 3、`adapter/form.test.ts` 2）；eslint 对比改动前后无新增问题；`vue-tsc` 只剩改动前已有的 `components/tiptap/src/editor.vue` 一处报错；`pnpm check:circular` 仍是既有 2 处（form-ui、vxe-table）
- [x] 8.3 构建：`pnpm run build:antd` 成功（11 tasks）。CodeMirror 全部落在独立分块 `js/index-D7-mnrc8.js`（裸 453 KB / gzip 150 KB），由 `defineAsyncComponent` 的 `import()` 懒加载，`index.html` 的 modulepreload 未包含它，列表页首屏不会请求。静态检查该分块：可选链、空值合并、私有字段均为 0 处，说明已按 `es2015` 目标降级。**未做**的是用生产构建产物在浏览器里实跑编辑器（E2E 走的是 Vite dev 入口），列为待办
- [x] 8.4 回归：TC-7a（boolean）、TC-7b（select 内置）、TC-7c（自定义 select）、TC-7d（richtext）通过；后端 `TestImportDefaultsMissingValueTypeToText` 覆盖未知类型归一 `text`。`multi_select` 行为未变，由后端 `TestCreateMultiSelectNormalizesSeparator` 覆盖
- [x] 8.5 影响分析记录：
  - i18n：已补前端 locale 与 apidoc。
  - 缓存一致性：值仍是字符串，写路径与缓存失效逻辑不变，无影响。
  - 数据权限：不改租户 fallback 与 `system_manageable`，无影响。
  - 开发工具跨平台：只新增 npm 依赖，不改 Makefile 或脚本，无影响。
  - 测试策略：后端单测、前端单测和 TC007 E2E。
- [x] 8.6 DI 来源检查：无影响。未新增服务构造函数、启动装配、插件宿主适配器或 WASM host service；新增内容只有 `configvaluetype.JSON` 常量、前端异步组件与 npm 依赖
- [x] 8.7 `openspec validate linapro-config-json-editor --strict` 通过
