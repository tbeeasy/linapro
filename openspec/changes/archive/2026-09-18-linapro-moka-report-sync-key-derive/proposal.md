## Why

现有 `linapro-moka-report-sync` 只支持单列 `uniqueField` 做主键，且对报表列只做「原样搬运」——遇到「唯一键其实是两列组合」「某列要按年月拆成多列」这类真实需求无法表达。若每来一个新形态就在 Bitable 里加一个冗余合并列、或在管线里塞一个专用函数，会不断积累补丁。本变更从代码层把「键」和「列变换」抽象出来，让后续同类需求基本只加配置。

## What Changes

- **复合唯一键**：用 `uniqueFields`（列名列表）+ `keySeparator` 替代原单列 `uniqueField`。引入 `syncer.KeySpec` 与其 `KeyOf(row)` 方法，把「怎么从一行算出匹配键」收敛到一处，贯穿 `CoalesceRows`、`Plan`、共享库 `ListRecords` 三处。键**仅用于匹配已有记录，不写入任何物理列**，天然支持 N 列做键。
- **BREAKING**：删除单列 `uniqueField` 配置属性，不做向后兼容；配置一律写 `uniqueFields`（单列即长度为 1 的列表）。共享库 `larkbitable.ListRecords` 参数由 `uniqueField string` 改为 `keyOf func(Row) string`。
- **列派生变换**：在 `Plan` 之前引入一个封闭的、命名 `kind` 的「列派生」注册表（`date` / `split` / `regex` 等），每个 `kind` 是纯函数。`date` 复用现有日期解析（`ParseEpochMillisCST`），按各目标列的 layout 提取年/月等。配置声明 `kind + sources + targets + params`。新增一种特殊处理 = 加一个纯函数 + 注册一项，不动管线主体。
- **固定变换顺序**：`Flatten → 列派生 → Coalesce(按 KeyOf 去重) → Normalize → preparePersonFields → Plan`。
- **回读对称性**：派生产出列与键组成列必须按 Bitable 字段类型归一，保证报表侧写入值与下一轮从 Bitable 回读值严格相等，避免误判为差异反复重写、或复合键每轮新建重复记录。

## Capabilities

### New Capabilities
<!-- 无新增能力，均为现有能力的需求变更 -->

### Modified Capabilities
- `linapro-moka-report-sync`: 主键对齐由单列改为复合键（`uniqueFields` + `KeyOf`）；新增「列派生变换」需求；交集完整性门闩与配置分层的相关场景随主键与配置结构调整。

## Impact

- 插件 `apps/lina-plugins/linapro-moka-report-sync`：
  - `backend/internal/config/config.go`：`ReportMapping` 删除 `uniqueField`，新增 `uniqueFields` / `keySeparator` / `derivedColumns`；`loadMappings` 归一默认值。
  - `backend/internal/syncer`：新增 `KeySpec` 与 `KeyOf`；新增列派生注册表与各 `kind` 纯函数；`CoalesceRows`、`Plan`（`PlanInput.Key`、`diffFields` 跳过键组成列集合）改造；管线接入派生步骤。
  - `backend/internal/service/sync.go`：按固定顺序编排派生，构造 `KeySpec` 传入三处。
- 共享库 `apps/lina-plugins/linapro-lark-sdk/larkbitable`：`ListRecords` 签名由 `uniqueField string` 改为 `keyOf func(Row) string`（BREAKING，需同步调整其它调用方）。
