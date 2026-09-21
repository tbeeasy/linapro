---
name: my-archive-gate
description: >-
  OpenSpec 归档前的 capability 一致性闸门：校验 change 的 proposal Capabilities 段
  与 specs 子目录、openspec/specs 现状一致后，透传官方 openspec archive 归档；
  支持 --check-only 只校验不归档。必须用户手动触发，禁止自动触发。
compatibility: 依赖 OpenSpec CLI（openspec），在 LinaPro 仓库根目录执行。
---

# my-archive-gate（归档前 capability 闸门）

在调用官方 `openspec archive` 之前，对 change 的 **capability 命名一致性**做硬校验，挡住「给既有能力加方法却另起 per-change 临时能力目录、导致主 specs 冒出冗余顶层目录」这一类错误。校验通过才透传官方归档；不通过则 skip 并指出该改 proposal 的哪一段。

**只校验，不改文档。** 本技能禁止修改 proposal.md / specs / tasks / design 任何文件，禁止 `--no-validate`、禁止手动 `mv`、禁止合并/删除归档目录。它的唯一写动作是校验通过后调用 `openspec archive -y "<name>"`。

## 核心事实（校验依据）

- **capability 名不从 change-id 派生**：它由 proposal 的 `### New Capabilities` / `### Modified Capabilities` 段决定，specs 阶段严格照抄。所以控制点在 proposal，不在 specs 生成那一刻。
- **官方 `openspec archive` 是忠实搬运工**：change 里 `specs/<capability>/spec.md` 的 delta 会 merge 到 `openspec/specs/<capability>/spec.md`。声明成什么 capability 名，主 specs 就建/merge 什么目录。
- **capability 名不进 Go 代码**：代码 import 的是 plugin module path，不是 capability 名。所以晚校验（归档前）不污染实现，代价近乎零。
- **主 specs 被污染的唯一时刻是 `openspec archive`**：change 活跃期 specs 脏在私有空间，不外溢；归档那一刻才写入顶层 specs。闸门放这里最准。

## 校验规则

解析 `openspec/changes/<name>/proposal.md` 得：
- `N` = `### New Capabilities` 列表里的 capability 名集合
- `M` = `### Modified Capabilities` 列表里的 capability 名集合

读 `openspec/specs/` 得 `E`（既有顶层目录名集合）。
读 `openspec/changes/<name>/specs/` 得 `S`（change 实际 specs 子目录名集合）。

### 硬规则（任一不过 → skip 归档，报原因，不调用 openspec archive）

| 规则 | 条件 | 失败含义 |
|---|---|---|
| H1 | `N ∩ E = ∅` | New 里出现了已存在于 `openspec/specs/` 的名字 → 该归 Modified，不是 New |
| H2 | `M ⊆ E` | Modified 里的名字在 `openspec/specs/` 不存在 → 该归 New 或改对名字 |
| H3 | `S = N ∪ M` | change 实际 specs 子目录 ≠ proposal 声明集合 → specs 没严格 follow proposal（可能手改过 specs 没改 proposal，或反之） |

H1/H2/H3 均为纯集合运算，零语义判断。

### 软规则（warn，不阻塞归档，但在报告里标黄提示）

| 规则 | 条件 | 提示 |
|---|---|---|
| S1 | `cap ∈ N` 且 `cap` 匹配 `<既有-plugin-id>-<method>` 模式，且 `<既有-plugin-id>` 本身 `∈ E` | 疑似 per-change 临时名，可能本应复用 `<plugin-id>` 进 Modified Capabilities。请人工确认该能力是否真该独立 |

S1 卡的就是 `linapro-moka-hcm-list-employees` 这种形态——`<plugin-id>`（`linapro-moka-hcm`）已在 specs 顶层存在，却 New 了一个 `<plugin-id>-<method>` 临时名。但 S1 只 warn 不阻塞，因为 `<plugin>-<method>` 有时是真正独立的新能力（如 `linapro-moka-hcm-oauth` 确实该独立），是否独立是语义判断，交还人。

### 不在本技能校验的（交给官方）

- delta header（ADDED/MODIFIED/REMOVED）的合法性：官方 `specs-apply.js` 已有硬校验（对不存在的 spec 用 MODIFIED 会 throw），本技能不重复。
- 任务完成度、artifact 状态、tasks.md 勾选：这些是 `openspec archive` 自带的门禁，本技能不管。

## 输入

- change 名：可选。未提供则 `openspec list --json` 列活跃变更让用户选。
- `--check-only`：只跑校验，不调用 `openspec archive`。用于创建 change 后或活跃期内做卫生检查。
- `--all`：对所有活跃变更逐个校验（默认只校验指定/选中的一个）。仅 check-only 模式有意义；归档模式（非 check-only）一次只处理一个 change。

## 流程

### 1. 环境

```bash
pwd && test -d openspec/changes && openspec --version
```

CLI 不可用、非仓库根或无 `openspec/changes` → 停止并说明。

### 2. 确定 change

- 未给 change 名 → `openspec list --json` + AskUserQuestion 让用户选一个（**禁止自动选择**）。
- 给了 change 名 → 验证 `openspec/changes/<name>` 存在且非 `archive/`。

### 3. 采集数据

```
proposal = openspec/changes/<name>/proposal.md
N, M  ← 解析 proposal 的 Capabilities 段（### New Capabilities / ### Modified Capabilities）
E     ← openspec/specs/ 顶层目录名集合
S     ← openspec/changes/<name>/specs/ 子目录名集合
```

proposal 解析失败（无 Capabilities 段）→ skip，提示「proposal 缺 Capabilities 段，无法校验，请补全 proposal 后再归档」。

### 4. 跑规则

- H1/H2/H3 任一失败 → 记 HARD_FAIL，不归档。
- S1 命中 → 记 SOFT_WARN。
- 全硬规则过 → 记 PASS。

### 5. 归档或 skip

- `--check-only` 模式：**不调用 openspec archive**，直接出报告（第 6 步）。
- 非 check-only：
  - PASS（无硬规则失败）→ 调用 `openspec archive -y "<name>"`，确认目录迁至 `openspec/changes/archive/YYYY-MM-DD-<name>/`。
  - HARD_FAIL → **不调用 openspec archive**，出报告指明该改 proposal 哪一段。
  - SOFT_WARN 但无 HARD_FAIL → 提示后**询问用户**是否继续归档（warn 不自动阻塞，但归档是不可逆写主 specs，需人确认）。

### 6. 报告

```markdown
**my-archive-gate 校验结果**

变更：<name>
模式：归档 / --check-only

校验数据：
- New Capabilities (N)：<列表或空>
- Modified Capabilities (M)：<列表或空>
- 既有 specs 顶层 (E)：<数量> 个
- change specs 子目录 (S)：<列表>

硬规则：
- H1 New 不与 E 重叠：通过 / 失败（列出冲突项）
- H2 Modified ⊆ E：通过 / 失败（列出缺失项）
- H3 S = N∪M：通过 / 失败（列出差异）

软规则：
- S1 疑似 per-change 临时名：无 / 命中（列出疑似项 + 复用建议）

结论：
- 归档 / --check-only 通过 → 已透传 `openspec archive -y "<name>"`（归档模式）/ 仅校验完成（check-only）
- 跳过归档 → 原因：H<n> 失败，请改 proposal 的 <段名> 段：<修复方向>
- 待用户确认 → S1 warn，问是否继续归档
```

## 修复指引（HARD_FAIL 时输出，但本技能不改文档）

| 失败 | 修复方向（交给用户去做） |
|---|---|
| H1 冲突 | 把冲突的 capability 从 proposal 的 `### New Capabilities` 删除，加到 `### Modified Capabilities`，写「新增 <方法> Requirement」。然后重跑 specs 生成（specs 严格 follow proposal） |
| H2 缺失 | 确认该 capability 名拼写，或它确实是新能力 → 从 Modified 挪到 New |
| H3 差异 | proposal 的 Capabilities 段与 specs 子目录不一致：以 proposal 为准补齐 specs 子目录名，或以实际 specs 为准补 proposal。两边对齐后再归档 |

## 硬性规则

- **只校验，不改文档** — 禁止修改 proposal / specs / tasks / design / 主 specs 任何文件；禁止 `--no-validate`、手动 `mv`、合并/删除归档目录。
- **校验通过才透传官方 archive** — 透传的是官方 `openspec archive -y`，不是自己实现归档逻辑。
- **HARD_FAIL 不归档** — 硬规则不过绝对不调用 openspec archive，避免污染主 specs。
- **SOFT_WARN 询问** — S1 命中时不自动归档，问用户确认（语义判断交还人）。
- **零语义判断** — H1/H2/H3 是集合运算；只有 S1 是模式匹配 + 人工确认，不做「该能力该不该独立」的自动判断。
- **不重复官方校验** — delta header 合法性、任务完成度、artifact 状态交给官方 archive 的门禁，本技能只管 capability 命名一致性。
- **仅手动触发** — 禁止被其他技能、CI、钩子或模糊意图自动调用。

## 边界速查

| 情况 | 处理 |
|---|---|
| 无活跃变更 | 报告即可，不报错 |
| proposal 缺 Capabilities 段 | skip，提示补全 proposal |
| change 无 specs/ 目录 | skip，提示先生成 specs |
| 校验全过 + 无 warn | 透传 `openspec archive -y` |
| 校验全过 + S1 warn | 询问用户是否继续归档 |
| 硬规则失败 | skip 归档，出修复指引，不改文档 |
| --check-only | 只校验不归档，适用创建后/活跃期卫生检查 |
| 归档产生 diff | 官方 archive 的预期结果，不自动 commit |
