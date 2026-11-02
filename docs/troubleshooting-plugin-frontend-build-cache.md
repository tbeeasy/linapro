# 排查笔记：插件前端改动被 turbo 缓存吞掉，打包产物陈旧

> 症状一句话：改了 `apps/lina-plugins/*/frontend/**` 里的插件前端代码，`make build`
> 之后部署，运行时报错却指向**旧**代码（典型：后端已改名 `xxxNew`，前端仍在读
> `xxxOld`，得到 `undefined`，再展开/解构时报 `TypeError: ... is not iterable`）。
>
> 本文是该问题的完整结论、证据、根因与解决方案，供下次复现时直接作为上下文。
>
> 首次记录：2026-10-15（分支 `feat/eval360-role-cascade-delete`）。
> 具体触发案例：`linapro-eval-360` 前端字段 `excludedEvaluateeIds` → `excludedEvaluatorEmpIds`
> 改名后，外网加载的 `bootstrap-*.js` 仍是旧名。

---

## 1. 结论（TL;DR）

**`make build` 的前端这一步走 turbo，而 turbo 看不到 `apps/lina-plugins/**` 下的文件。**

- turbo 的哈希以其 workspace 根 `apps/lina-vben` 为基准，只覆盖「各包目录内的文件 +
  `turbo.json` 里声明的 `globalDependencies` / `globalEnv`」。
- 插件前端位于 **`apps/lina-plugins/`，是 `apps/lina-vben/` 的兄弟目录，在该根之外**，
  且**未**在 `turbo.json` 任何输入声明里。→ **插件前端的任何改动都不会改变 turbo 哈希。**
- 于是 turbo 判定缓存命中，**跳过 vite 编译**，直接还原上一次的 `dist`。产物里就是旧代码。

**关键澄清：缓存一直是命中的。** 之前没暴露，只是因为在「只改插件目录」这种情形下，
命中缓存与真编译的结果**曾经恰好一致**（或者你当时改的是包内文件，hash 被打散触发了真编）。
这不是"以前没缓存、现在才有缓存"，而是"缓存第一次产出了与源码不一致的结果"。

---

## 2. 为什么此前没有暴露

两条并存的路径要分清：

| 你的操作 | 编译路径 | 插件前端是否实时 |
| --- | --- | --- |
| 本地开发（访问 `:5666`） | Vite **dev server + HMR** | ✅ 直接读源码、每次存盘即时生效，**不经 turbo，无缓存问题** |
| `make build`（外网部署产物） | `turbo` → `vite build` | ⚠️ 受 turbo 缓存控制，**问题只存在于这条路径** |

过去 `make build` 没炸，靠的是一个巧合：

- 每当**同时**改动 `apps/lina-vben/apps/web-antd/src/**` **包内**文件（如
  `locales/**`、`views/**`、`api/**`），hash 就被打散 → 触发真编译 → 顺带把插件新代码也编进去；
- 只改插件目录、且改动足够小或与旧产物等价时，缓存产物与真编译产物**看不出差异**。

只有当「**只改插件目录、未碰任何包内文件**，且改动会破坏行为（如前后端字段契约改名）」时，
静默的缓存才第一次变成可见 bug。

---

## 3. 证据（可复现）

### 3.1 受控实验（最硬的证据）

在**原始** `turbo.json`（未打补丁）下，仅改一个插件前端文件，观察 turbo 哈希：

```bash
cd apps/lina-vben
# 基线
LINAPRO_SOURCE_PLUGINS=1 ./node_modules/.bin/turbo run build \
  --filter=@lina/web-antd --dry=json | \
  python -c "import json,sys;d=json.load(sys.stdin);[print(t['hash']) for t in d['tasks'] if t['taskId']=='@lina/web-antd#build']"
# → 0f31183e79ceccd2

# 只改插件前端(不碰 web-antd 包内任何文件)
echo '// probe' >> ../lina-plugins/linapro-eval-360/frontend/pages/eval-client.ts
# 再跑同一命令
# → 0f31183e79ceccd2   ← 完全相同：仅改插件,hash 不变 => 必然缓存命中
```

### 3.2 缓存条目内 bundle 的实际内容

解压 `.turbo/cache/*.tar.zst`（turbo 用 zstd；本机无 `zstd` 时可用
`pip install zstandard` 后 Python 解压），逐个读出缓存的 `bootstrap-*.js` 并 grep 字段名：

| 缓存条目 | 时间 | bundle | 旧名 `excludedEvaluateeIds` | 新名 `excludedEvaluatorEmpIds` |
| --- | --- | --- | --- | --- |
| 00cb81… | 08-07 | bootstrap-DkMzHskD.js | 0 | 0 |
| 187bd4… | 08-21 | bootstrap-Bpg6yzPX.js | 0 | 0 |
| 1c16d2… | 09-08 | bootstrap-C2lXHLGd.js | 0 | 0 |
| 4f4750… | 10-10 | bootstrap-ClClnCqk.js | **5** | 0 |
| 8394b7… | 10-13 | bootstrap-DbW01DvP.js | **5** | 0 |
| 0f3118… | 10-15（补丁后 `--force`） | bootstrap-Cq7k1tKX.js | 0 | **9** |

10-10、10-13 的缓存 bundle **本就是旧名** —— 说明这些时点产出的产物一直是缓存还原的旧码。

### 3.3 turbo 缓存还原的特征

- 命中缓存时，`turbo run build` 输出 `Cached: N cached, N total` +
  `>>> FULL TURBO`，耗时**数百毫秒**（`400ms~1m` 之间若极短即可能未真编）。
- **还原会刷新文件 mtime，但内容照抄缓存** —— 所以「删除 `dist` 再编译」无效：
  turbo 看的是**输入哈希**，不是产物是否存在；删了它照样从 `.turbo/cache` 还原同一份。

### 3.4 关于「以前打包很多次都没事」

对账时发现文件 mtime 与「昨天改了前端」对不上：实际前端改动集中在 **10-13 傍晚**，
且改的是 **`apps/lina-vben/apps/web-antd/src/**`（包内）**，如：

```
10-13 17:52  web-antd/src/locales/langs/{zh-CN,en-US}/page.json
10-13 17:59  web-antd/src/api/eval-360/emp-model.ts
10-13 18:00  web-antd/src/views/eval-360/emp/{result,choice-grid,todo,answer}.vue
```

改包内文件 → hash 变 → 真编译 → 插件新码顺带进产物 → 安全。
这与「仅改插件目录才吃缓存」的规律**不矛盾**。

---

## 4. 解决方案

### 4.1 根治：在 `turbo.json` 显式声明插件前端为 `@lina/web-antd#build` 的输入

> **状态：已于 2026-10-16 应用到 `apps/lina-vben/turbo.json`。** 触发原因：`linapro-eval-360`
> 的 FB-14（评价人标签改为单行 + 横向滚动）只改了插件目录，`make build` 命中缓存，产物里仍是
> `break-all` 旧代码，表现为 1920 宽度下标签折行、2560 下不折。应用后实测：仅 `@lina/web-antd`
> 的哈希变化（其余 26 个包不变）；纳入 98 个插件前端文件（当时磁盘上的全部）；改一个插件文件
> 哈希即变、还原后回到原值；`--dry` 求哈希约 1.3s；无改动时重复构建 `FULL TURBO`，约 0.25s。

编辑 `apps/lina-vben/turbo.json`，新增以下**任务级覆盖**（与现有 `tasks.build` 平级）：

```json
"@lina/web-antd#build": {
  "dependsOn": ["^build"],
  "inputs": ["$TURBO_DEFAULT$", "../../../lina-plugins/*/frontend/**"],
  "outputs": [
    "dist/**",
    "dist.zip"
  ]
}
```

效果：把 702 个插件前端文件纳入 `@lina/web-antd#build` 的哈希指纹。此后仅改插件前端，
hash 即变化，`make build` / `pnpm build` 会自动真编，无需 `--force`。

**已验证**：打补丁后，仅改插件 → hash 由 `19dd50c2854436de` 变为 `dac1984649206fa8`；
且只有 `@lina/web-antd` 一个包受影响，其余 20+ 包哈希不变。

### 4.2 三个必须知道的坑

1. **不能用 `globalDependencies`**。插件目录在 workspace 根之外：
   - `"../lina-plugins/..."` 会让 **turbo 2.8.13 直接崩溃**（实测 crash）；
   - `"$TURBO_ROOT$/../..."` 被拒：`globalDependencies cannot contain an environment variable`。
   只有**任务级 `inputs`** 接受 `../` 逃逸。

2. **相对深度是 `../../../`，不是 `../../`**。`inputs` 相对**包目录**
   (`apps/lina-vben/apps/web-antd`) 解析，需上溯 3 级才到 `apps/` 下。
   写成 `../../` 指向不存在的 `apps/lina-vben/lina-plugins`，glob 空匹配、**静默失效**。

3. **任务级覆盖是"整体替换"，不是 merge**。只写 `inputs` 会让 `outputs` 变 `null`、
   `dependsOn` 丢失（前者使产物不再被缓存，后者使依赖包不先构建）。
   必须把 `dependsOn` 与 `outputs` 原样重述。**代价**：覆盖里重述了这两项，
   日后改基础 `build` 任务的这两项时需同步维护。

### 4.3 应急：不改配置，强制真编

改了插件前端、又不想动 `turbo.json` 时：

```bash
cd apps/lina-vben && npx turbo run build --filter=@lina/web-antd --force
```

`--force` 会用新产物**改写同一哈希的缓存条目**，此后即使普通 `turbo build` 也还原新产物
（已验证）。之后再跑完整的 `make build`（或 `make build binary_name=... platforms=...`）。

> 注意：`--force` 只解决**这一次**。根因不消除，下次仍会复现 —— 推荐采用 4.1。

### 4.4 同类问题：`@vben-core/design` 的 Tailwind 样式陈旧（2026-10-30）

4.1 只覆盖了 JS 产物。生产环境的 Tailwind 工具类**不是**在 `@lina/web-antd#build` 时现生成的，
而是来自 `@vben-core/design` 预构建的 `dist/design.css`（`global.css` 用 `@source` 扫描
`packages/@core`、`packages/effects`、`apps/web-antd/src`、`../lina-plugins/`）。
turbo 对 `@vben-core/design#build` 只按包内 13 个文件求哈希，改插件里的任意值类
（如 `w-[1280px]` → `w-[1100px]`）会命中缓存，产物缺新规则。

**症状**：元素上能看到 class，但 DevTools Styles 里没有对应规则；本地 dev 正常（Vite 实时生成）。
触发案例：`linapro-eval-360` FB-33，弹窗失去宽度类后铺满整屏。

**已应用的修复**（`apps/lina-vben/turbo.json`，深度相对 `packages/@core/base/design`）：

```json
"@vben-core/design#build": {
  "dependsOn": ["^build"],
  "inputs": [
    "$TURBO_DEFAULT$",
    "../../*/src/**",
    "../../*/*/src/**",
    "../../../effects/*/src/**",
    "../../../../apps/web-antd/src/**",
    "../../../../../lina-plugins/*/frontend/**"
  ],
  "outputs": ["dist/**"]
}
```

实测 inputs 13 → 1016 个（插件 104 个，不含 dist），无改动时仍命中缓存。
**维护提示**：`global.css` 的 `@source` 列表变化时须同步这里的 `inputs`。
诊断：`grep -o 'w-\\\[1100px\\\]' packages/@core/base/design/dist/design.css`。

---

## 5. 快速诊断清单（下次复现时照做）

1. **确认报错字段名是"新名还是旧名"**：报错里的字段（如 `excludedEvaluateeIds`）
   在源码里 grep 不到，只有旧 bundle 里有 → 基本可判定是陈旧产物。
   ```bash
   grep -rn "报错里的字段名" apps/lina-plugins apps/lina-vben/apps/web-antd/src   # 应无匹配
   grep -rIl "报错里的字段名" apps/lina-vben/apps/web-antd/dist                    # 应命中旧 bundle
   ```

2. **看产物 hash 文件名有没有变**：vite 用内容哈希命名 `bootstrap-<hash>.js`。
   若重新构建后文件名与之前**完全一致**，说明内容没变 —— 大概率没真编。

3. **看 `make build` 输出**：出现 `Cached: N cached` / `FULL TURBO` / 极短耗时 = 吃的缓存。

4. **看 turbo 哈希是否对插件文件敏感**（原始配置下应为"不敏感"，打了补丁后应"敏感"）：
   ```bash
   cd apps/lina-vben
   LINAPRO_SOURCE_PLUGINS=1 ./node_modules/.bin/turbo run build --filter=@lina/web-antd --dry=json \
     | python -c "import json,sys;d=json.load(sys.stdin);[print(t['hash']) for t in d['tasks'] if t['taskId']=='@lina/web-antd#build']"
   # 改一个插件前端文件后再跑一次，比较两次 hash
   ```

5. **确认产物已进后端嵌入目录**：`make build` 会把
   `apps/lina-vben/apps/web-antd/dist` 拷进 `apps/lina-core/internal/packed/public` 再被 Go embed。
   可校验二进制内不含旧字段名：
   ```bash
   grep -c "旧字段名" temp/output/<binary>   # 期望 0
   grep -c "新字段名" temp/output/<binary>   # 期望 >0
   ```

---

## 6. 涉及的代码位置

- 前端构建入口：`hack/tools/linactl/command_build.go` → `runHostFrontendBuild()`
  （执行 `apps/lina-vben` 的 `pnpm run build`，再拷贝 `dist` → `internal/packed/public`）。
- 前端构建脚本：`apps/lina-vben/package.json` 的 `build` = `cross-env ... turbo build`。
- 插件页面收集：`apps/lina-vben/apps/web-antd/vite.config.mts`
  （`lina-plugin-registry` 插件 + `virtual:lina-plugin-pages`；仅当
  `process.env.LINAPRO_SOURCE_PLUGINS === '1'` 时才扫描 `apps/lina-plugins/*/frontend/pages/**`）。
- turbo 配置：`apps/lina-vben/turbo.json`。
- turbo 缓存目录：`apps/lina-vben/.turbo/cache/`（zstd 压缩，条目按内容哈希命名）。

---

## 7. 待办 / 遗留

- [ ] 采用 4.1 的 `turbo.json` 补丁（本次已回退，待下次触发时再评估落地）。
- [ ] 若确认长期保留该补丁，考虑在团队内说明「任务级覆盖需同步维护 `dependsOn`/`outputs`」。
- [ ] 复现时补齐：确认「只改插件目录 + 未碰包内文件 + make build」这一最小复现路径，
      以最终敲定根因（当前证据链已很强，但缺一次与用户描述的完整对账）。
