<!--
================================================================================
  实施方案 —— 存档件（plan of record）
================================================================================

这是 2026-09-16 经用户批准的实施方案。**正文逐字保留，未作修改**，以保证「当时批准了
什么」有据可查（原件与本文除去本头部外 byte-identical）。

正文中已知有若干处与最终实现不符 —— 那是探索的产物，不是疏忽。它们**不在此处更正**，
否则会连「批准的是一个含错的方案」这件事一起抹掉。每处的更正都落在仓库的相应位置：

  1. §1.7 与 §五-6  “注册表条目格式 = {url,name,category,description,owner,repo,
                       installable,reason,probedAt}”
     → 错。那是 smart-plugin-market 的 **probe 产物**，不是投稿格式。
       真实投稿格式是 awesome-dsh-plugin 的 data/plugins/<owner>__<repo>.yml，
       必填 url/name/category/description.en，分类取自 CAT_IDS 的 14 项。
       更正见：kit/guides/registry-entry.md
               kit/HARNESS.md §10
               notes/implemented/architecture/2026-09-16-reuse-the-existing-plugin-market.md

  2. §1.10 与 §五-5  “（含 CLI-Anything 已产出的 cli-anything-* Python CLI，两个仓库由此串联）”
                      “5. 与 CLI-Anything 串联 …… 验证「CLI-Anything 产出 → dsh 插件」这条链路成立”
     → 错。CLI-Anything 在本项目中是**设计参考**（同构映射的对象），不是运行时依赖，
       也不是集成目标。验证项 5 已作废：换成 git/ffmpeg/jq 任一非平凡 CLI，验证到的
       东西完全相同，它不检验本项目的任何特有性质。
       边界说明见：kit/HARNESS.md §1

  3. §二-354  guides/render-intent.md   → 未建；render intent 并入 guides/tool-contract.md
     §二-359  scripts/verify-plugin.sh   → 实为 verify-plugin.mjs（JS 生态，不用 bash）
     §六-440  同上

  4. §二 的仓库结构树把 SOP 工具包写作 `dsh-plugin-anything-plugin/`。
     → 过时。那是立项时的目录名，后更名为 `kit/`，同一棵树里的
       `guides/`、`commands/`、`templates/`、`scripts/verify-plugin.mjs` 则沿用至今。
       正文按原样保留；本头部各条更正中的路径已写成 `kit/`，否则「更正」指向一个
       不存在的目录，读者会以为整棵树都作废。

另有一处值得记录：§1.5 引用的 skill 挂载写法 `new URL('skills/', baseUrl)` 在 agent
preset 中正确，但在 **bundle patch 中会静默失效** —— baseUrl 由 app-boot 设为
dirname(absoluteConfigPath)，在 patch 里那是 profile 目录而非包目录。它保留在正文中
作为当初的认知快照；实际模板已改用 createRequire 按包解析。更正见：
  notes/implemented/bug-fix/2026-09-16-baseurl-is-not-the-package-directory.md

执行状态（截至 2026-09-16）：
  §六 的 7 步 —— 1–6 完成；第 7 步中「真实生成物」完成，「注册表条目」只写了指南、未提交。
  §五 的 6 项验证 —— 仅第 4 项（负例门禁）完成。1/2/3 需要真实 dsh 启动，5 已作废，
  6 未提交。详见仓库 README 与 guides/verification.md 的 “What is genuinely unverified”。
================================================================================
-->

# dsh-plugin-anything — 实施方案

## Context

**要解决什么。** CLI-Anything（`D:\Opencode\dsh-plugin\CLI-Anything`，HKUDS）把 GUI 软件变成 agent 可用的 CLI，
并围绕它建了一整套工程体系：方法论文档（`HARNESS.md` 八阶段 SOP）+ 生成器 + 注册表 + 多平台适配。
它解决的命题是「软件本来只给人用，现在要给 agent 用」。

DeepSeek Harness（`D:\Opencode\dsh-plugin\deepseek-harness-master`，`dsh`）的前提完全不同：
基于 vendored Cordis，**everything is a plugin** —— 模型适配器、工具注册表、session 日志、agent loop
本身都是插件，没有特权内核，一切可从 `cordis.yml` 替换。

**本项目要做的**：`dsh-plugin-anything` —— 「一切皆插件」内核下的 CLI-Anything **同构版本**，
把**任意东西变成 dsh 插件（bundle）**。流水线逐级同构映射 CLI-Anything，但每一级的落点换成 dsh 原生概念。
用户已确认：交付形态 = **SOP 仓库 + 原生 bundle**；落点 = **全新独立仓库**
（`D:\Opencode\dsh-plugin\dsh-plugin-anything`，与另两个仓库平级）。

**为什么这个空白是真的存在。** dsh 里已经有一条"从请求生成插件"的闭环 ——
`apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md` 配 7 个 `cordis_*` 工具。
但它有硬边界（`packages/extensions/tool-cordis/README.md:19`，逐字）：

> Dynamic packages live only in the shared DSH process memory. […] They create no Plugin file,
> install no package, change no `cordis.yml` or personal/project configuration,
> **do not survive restart, and cannot be promoted automatically.**

且它只挂在 `cordis` 单个 preset 上（`standard`/`code`/`minimal` 拿不到面向模型的工具），
`cordis-host-runner` 只在 `dsh-web-app` 层。

→ **本项目的核心命题：把「动态、易失、仅内存」的插件生成，升级为「落盘、可分发、重启后仍在」的真 bundle。**
外加 CLI-Anything 那套 SOP / 命令 / 模板 / 注册表贡献 / CI 门禁。

---

## 一、同构映射（本方案主轴）

### 1.1 流水线阶段映射

| CLI-Anything | dsh-plugin-anything | dsh 依据 |
|---|---|---|
| **0 源码获取** — clone 仓库、确认路径有源码 | **0 目标获取** — 确认目标是 CLI 二进制 / HTTP API / MCP 端点之一，并实测其可调用 | 同构：都要"先证明有可操作面" |
| **1 代码库分析** — 找后端引擎、GUI 动作→API 映射、数据模型、现有 CLI、undo 系统 | **1 能力面分析** — 判定**缝（seam）还是消费者（Consumer）**；映射外部系统的能力→工具集；识别其数据模型与状态 | capability seam 三角：Service Definition / Provider / Consumer |
| **2 CLI 架构设计** — 交互模型（REPL/子命令/两者）、命令分组、状态模型、输出格式 | **2 插件架构设计** — 插件**形态**（函数插件 vs 服务类）、`Config` 字段、工具集、**render intent**、bundle patch 行、状态模型（session 事件 vs config） | 见 1.3 硬规则 |
| **3 实现** — 数据层→探测→变更→后端包装→渲染→会话→REPL | **3 实现** — `src/index.ts`（函数插件）→ `src/provider.ts`（唯一接触外部系统处）→ `defineTool` 工具 → 纯 presenter → `cordis.patch.yml` → `package.json` | 见 1.4 |
| **4 测试计划** — 先写 `TEST.md`，后写代码 | **4 测试计划** — 先定 **keyless snapshot 方案**（dsh 强制要求真实 example 的完整 transcript） | `docs/testing.md`，比 CLI-Anything 更严 |
| **5 测试实现** — `test_core.py`（合成）+ `test_full_e2e.py`（真后端） | **5 测试实现** — 单测（vitest，无后端）+ snapshot（真实 example）+ e2e（真后端，`DEEPSEEK_API_KEY` 门控） | `docs/testing.md` |
| **6 测试记录** — 追加 pytest 输出 | **6 测试记录** — 追加 snapshot 重放结果 | — |
| **6.5 SKILL.md 生成** | **6.5 SKILL.md 生成** + agent preset 挂载 | skill frontmatter 见 1.5 |
| **7 PyPI 发布** — 命名空间包 + console_scripts | **7 bundle 分发** — 三通道：npm 名 / `github:owner/repo#sha` / `pnpm pack` tarball | 见 1.6 |
| **registry.json + cli-hub** | **market 注册表条目**（`awesome-dsh-plugin` 格式） | **复用，不重建**，见 1.7 |
| **preview bundle 机制** | **render intent 卡片**（terminal / diff / generic + `locations`） | 呈现层的同构物 |

### 1.2 两条"铁律"的同构

CLI-Anything 的第一铁律是 **"Use the Real Software — Don't Reimplement It"**：
CLI 必须真的调起那个软件（`libreoffice --headless`、`blender --background --python`），软件是硬依赖，不做优雅降级。

→ dsh 同构铁律：**真实后端由 Provider/Consumer 单一模块承担，绝不重实现目标系统的逻辑。**
本项目据此规定：生成物中**有且仅有一个模块**接触外部系统（对应 CLI-Anything 的
`utils/<software>_backend.py`），其余全是纯逻辑。这条要写进 SOP 并做成可校验项。

CLI-Anything 的第二铁律是 **"The Rendering Gap"**（渲染优先级：原生引擎 → 转译 filtergraph → 脚本）。

→ dsh 同构铁律：**render intent 是设计的一部分，必须前置决定**
（`AGENTS.md` 逐字：*"A tool's UI render intent is part of its design, decided up front
(`generic`/`terminal`/`diff`, `locations`)"*）。包装 CLI 的插件默认 `terminal` 卡；
写文件的默认 `diff`；其余 `generic`。

### 1.3 硬规则与反直觉更正（**生成器必须遵守，逐条已从源码/gate 核实**）

1. **函数插件具名导出，服务插件 default 导出，不可混用。**
   `packages/AGENTS.md` 逐字：
   > 服务包 default-export 其服务类；函数插件**具名导出** `name`/`inject`/`Config`/`apply`
   > 且**没有 default export**。混用会让 Loader 丢弃函数插件的命名空间。
   （依据 `docs/postmortem/0001-acp-default-export-drops-inject.md`）

2. **`Config` 用 Schemastery，工具输入 schema 不用。** 这两者常被混淆：
   - 插件 `Config`：`export const Config: z<Config> = z.object({...})`，必填用 `.required()`。
   - **工具输入 schema：专用 DSL**（`ParameterSchemaSpec` / `ValueSchemaSpec`），
     支持 `string/number/integer/boolean/null/array/object/author-only json/exact-one oneOf`。
     原文：*"The unified schema DSL uses `ParameterSchemaSpec` for the implicit open parameter object and
     `ValueSchemaSpec` for any JSON-value root."* 每个显式 DSL 对象必须声明
     `additionalProperties: true | false`；隐式参数根与原生 JSON Schema 保持开放的默认。

3. **`execute(args, exec)` 没有 `ctx` 参数。** 工具体通过词法闭包使用 `apply(ctx, config)` 的 ctx；
   `exec` 是执行记录不是上下文：`{ token, callId, name, arguments, signal, agent?, parent? }`，
   加 `deferContext(context)`。**`exec.signal` 是必须遵守的 `AbortSignal`。**

4. **`execute` 只返回 `output.schema` 声明的规范 JSON 值，不返回内容块。**
   注册表快照并校验后调 `output.render(args, value)`，其 `ContentBlock[]` 才是模型看到的。
   原文：*"Do not return content blocks from the body or make callers parse prose for ids and fields."*

5. **presenter 必须是纯函数。** `presentCall`/`presentResult` **在实时流和 session 日志重放时都会跑**：
   无 I/O、不读 session 状态、无时钟/随机。原文：
   *"If you find yourself wanting the file's old content or the working directory inside `presentCall`,
   stop — that belongs in durable result metadata or the adapter, not the presenter."*
   返回 `undefined` 即回退 generic 卡；畸形参数**返回 undefined 而非抛错**（"display must never crash a replay"）。

6. **UI 格式化绝不进模型结果。** fenced ` ```console `、diff、相对化路径，都不该为了让 UI 好看
   而进规范值或 Native 内容。

7. **`cordis.yml` 的 `!!js` 仅可用于 `config`（任意深度）与 `disabled`**，其余元数据保持字面量；
   `verify-cordis-config.ts` 会报 "`!!js` is not interpolated here"。
   作用域内可用 `process`、`ctx`（该行自己的上下文 → `ctx.<injected>`）、`dshHomePath(...)`。

8. **patch 行的 `name:` 必须是包名，不是路径** —— 这样 Node 解析才找得到已安装代码。
   原文：*"plugin rows reference the package by name instead of a relative source path
   so Node resolution finds the installed code."*

9. **文件名必须含 `cordis`**：gate 的发现 glob 是 `**/*cordis*.yml|yaml`
   （排除 `.claude/**`、`node_modules/**`、`vendor/**`、`*.i18n.yaml`）。否则 gate 看不见它。

10. **bare plugin 必须在其所属 bundle 的 `package.json` `dependencies` 里声明**，
    否则 `${files}: ${packageName} must be declared ${manifestPath} dependencies`。

11. **patch 语义：按 id 最后写者胜；行序不承载加载语义**（激活由服务可用性/inject 驱动）。
    原文：*"Row order carries no load semantics (activation is service-availability driven)."*
    → 生成器**不得**用声明顺序来编排插件，必须用 `inject`。

12. **patch 替换目标行的整个 `config`，不合并** —— 要保留的键必须全部重述。

### 1.4 落盘契约（已从 gate 源码核实，**以源码为准，不以 docs 为准**）

**两套插件契约，绝不可混淆：**

| | in-tree `packages/<group>/<pkg>` | **out-of-tree plugin（本项目目标）** |
|---|---|---|
| 命名 | 必须 `@deepseek-ai/dsh-<name>` | 任意（`dsh-plugin-<thing>`） |
| `private` | **必须不存在** | 可省略（发布时） |
| `publishConfig.access` | 必须 `"public"` | 不需要 |
| `repository` | 必须精确匹配 url + `directory` | 不需要 |
| `version` | 必须等于根版本 | 自由 |
| `@deepseek-ai/cordis` | peer **和** dev 同 range | 仅 import 时需要 |
| `./invariant` 导出 | 必需且须成对声明 | 不需要 |
| `files` | 必须与计算值**逐项相等** | 自由 |
| 逐文件 100% 覆盖 | 必需 | 不需要 |

> ⚠️ **文档滞后更正（重要）**：`docs/cookbook/adding-a-package.md` 称 in-tree 需要 `private: true`，
> **该说法已过期**。`scripts/check-workspace-constraints.ts:243-266` 现要求 `packages/*/*`、`apps/*`、
> `vendor/*` 必须是可发布形态（无 `private`、有 `publishConfig.access`、有精确 `repository.directory`）；
> `private: true` 只是三个前缀之外的回退分支。实测 `grep -rl '"private": true' packages/*/*/package.json`
> 返回 **0**。→ **本项目一律以 gate 源码为准。**（`private: true` 唯一该出现的地方是 profile manifest，见 1.6）

**out-of-tree 最小 `package.json`（逐字，`docs/user/develop/basic/publish.md`）** —— 全部要求就这六项：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**最小插件**（`docs/user/develop/basic/index.md`）—— `index.js` 只需两行导出：

```ts
import type { Context } from '@deepseek-ai/cordis'
export const name = 'my-plugin'
export function apply(ctx: Context) { /* Register capabilities here. */ }
```

**最小 bundle patch**（`dsh-context-compressor/cordis.patch.yml` 的骨架，逐字）：
```yaml
- id: <被取代的既有行>
  disabled: true

- insert:
    - id: <我们的行>
      name: '<包名>'
```

模块解析需要**成对**声明（缺一不可）：
```json
"dsh":     { "bundle": { "patch": "./cordis.patch.yml" } }
"exports": { "./cordis.patch.yml": "./cordis.patch.yml" }
"files":   [ "cordis.patch.yml" ]
```

**两个坑**：
- 空 patch 文件（或只有注释）**会抛错**（解析结果不是列表）；用 `[]` 禁用该层。
- patch 匹配不到任何行只是 stderr **warning**，不是 error —— 打错 `id` 会静默无效果。

### 1.5 skill 格式（已逐字核实）

frontmatter 必须首行恰为 `---`、由另一行 `---` 闭合（无 BOM、无前导空行）：
- **必填**：`name` 匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`、非空 `description`
- **可选**：`whenToUse`（字符串）、`metadata`（不透明对象）、`disable-model-invocation`、`user-invocable`
- **旧 camelCase 键会抛错**（`disableModelInvocation`/`modelInvocable`/`userInvocable`）
- 布尔接受 `true/false`、`1/0`、`true|yes|on`/`false|no|off`
- 两种形态：目录包 `<name>/SKILL.md` 或扁平 `<name>.md`；**不支持递归 `**/SKILL.md`**
- 非法 frontmatter 只记日志并跳过，**绝不致命**
- 发现顺序六个 ranked root：`.dsh/skills` → `.agents/skills` → `customSkillDirs` → `<dshHome>/skills`
  → `<agentsHome>/skills` → **`bundled`**；近层覆盖远层同名（rank 仅破平局）
- 面向模型的工具**只有一个**：`skill({name})`

**bundle 能否随包带 skill？** 机制上可以（把 `skills/` 加进 `files`，再挂一个 `skill-filesystem` 行指向它），
但 **in-repo 没有任何包这么做**。参考 `apps/cli/config/agent-presets/cordis/agent.cordis.yml` 的挂法：

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```

> ⚠️ 注意 wiring 陷阱：`dsh-base` 插入 `skill-filesystem` + `tool-skill`，随后
> `dsh-web-app/cordis.patch.yml:339-344` **把两者都 disable**（*"presets own local discovery"*）；
> `standard`/`code` 重挂 `skill-filesystem`，**只有 `cordis` 挂 `tool-skill`**
> （即只有 `cordis` agent 才拿得到 catalog + loader），`minimal` 两者都不挂。
> → **本项目生成物必须自带 skill 挂载行，不能假设宿主已提供。**

### 1.6 分发（已核实；dsh **没有**插件注册表）

```sh
dsh plugin --profile demo add ./hello-plugin           # 本地 checkout（link:）
dsh plugin --profile demo add dsh-hello-plugin         # npm 名
dsh plugin --profile demo add github:you/hello-plugin  # git（可 #<sha> 固定）
dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz # pnpm pack 产物
dsh plugin --profile demo remove dsh-hello-plugin
dsh --profile demo --dump-config                       # 验证：会打印 "# == <bundle>" 层标记
```

`dsh plugin` **就是 pnpm 转发器**（`apps/cli/src/plugin.ts`）：`spawnSync('pnpm', args, { cwd: profileDir })`，
之后 `reconcilePlugins` 把已安装依赖与 `dsh.profile.bundles` 对账并改写 manifest。任何 pnpm 动词可用。

profile 落盘于 `$DSH_HOME/profiles/<name>/`（`resolveDshHome()` = `$DSH_HOME` 否则 `~/.dsh`），含
`package.json` + `cordis.patch.yml` + `pnpm-workspace.yaml`。profile manifest 逐字：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": { "dsh-hello-plugin": "link:/path/to/hello-plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"] } }
}
```

层序（逐字）：① `dsh.profile.bundles` 各 bundle patch 按序 → ② profile 自己的 `cordis.patch.yml`
→ ③ home 级 `$DSH_HOME/cordis.patch.yml`（**压过** per-profile）→ ④ 各 `--patch` overlay 按 argv 序。

**git 通道的两个代价（必须写进 SOP 的坑位）**：
- git 安装抓**源码不是构建产物**，作者必须提供自包含 `prepare` 脚本（不得假设有同级 monorepo）；
- pnpm ≥10 默认拒绝跑 git 依赖的 `prepare`，用户须在 profile 的 `pnpm-workspace.yaml` 加
  `allowBuilds: { <pkg>: true }`。原文定性：**这是在装机上、agent sandbox 之外执行包代码的许可**。
- 规避：发 npm（带构建产物）或发 `pnpm pack` tarball，两者都不需要构建许可。
→ **本项目默认推荐 npm / tarball 通道，git 通道在 SOP 里标注为需显式风险确认。**

### 1.7 注册表层：**复用 market，不重建 cli-hub**

dsh **已有**完整可用的插件注册表（这是本次探索最重要的转向）：

- `packages/market/smart-plugin-market/`（+ `-client`）是**真的，不是桩**：自然语言需求 → LLM 提 3 个插件组合
  → 一键安装。租户面命令 `market`，子命令 `recommend | list | search | install | remove`（均支持 `--json`）。
- 它读 `data/registry.json`（821 KB，**1186 条**，`"source": "awesome-dsh-plugin"`），由
  `scripts/probe.mjs --deep` 生成。条目逐字：

  ```json
  { "url": "https://github.com/01Virex/dsh-status-rotator", "name": "01Virex/dsh-status-rotator",
    "category": "ui", "description": { "en": "...", "zh": "..." },
    "owner": "01Virex", "repo": "dsh-status-rotator", "installable": true,
    "reason": "root-bundle", "probedAt": "2026-08-17T15:07:43.325Z" }
  ```
- 分类闭集：`tools ui dev workflow notify session usage memory skill vision theme fun market model`
- 安装**复用官方命令**：`src/install/dsh-plugin.ts` 子进程调 `dsh plugin`；
  README 逐字：*"装/卸：复用官方 `dsh plugin` 命令（子进程转发 pnpm + reconcile），不重造依赖管理"*。

→ **本项目不写 `cli-hub` 的对应物。** 注册表层的工作收敛为两件：
1. 生成物产出符合该格式的条目，提交到 `awesome-dsh-plugin`（本地已有 `D:\Opencode\dsh-plugin\awesome-dsh-plugin`）；
2. **补上该格式缺失的字段**（见第三节：CLI-Anything 有 `requires`/`entry_point`/`skill_md`/`version`
   等运行时元信息，dsh 注册表条目目前是纯探测结果，没有"这个包暴露哪些工具、需要什么环境"）。

### 1.8 工具实现模板（生成器要照抄的五件事）

最小真实 tool 插件是 `packages/fs/tool-fs/src/index.ts`（79 行，其四个工具定义在兄弟模块
`read.ts`/`write.ts`/`edit.ts`/`read-image.ts` —— **在-repo 惯例是：一个插件包从一个 `apply` 注册多个工具，
定义分文件放**）。从它抄五件事：

1. **只有具名导出，无 default export**；
2. **`Config` 用 schemastery 且每个字段都有默认值**；
3. **`const resolved = config as Required<Config>`** —— 注释原文："schemastery (Config) has already filled
   every defaulted field"；
4. **fail-loud 的 `assert*` 助手从 `apply` 里抛**（如 `assertPositiveInteger`，因为非正整数会让窗口算术静默出错）；
5. **能力可能缺席时用 `ctx.inject([...], (scopedCtx) => ...)` 做条件注册**
   （tool-fs 里 `read_image` 就只在 `attachments` 挂载时才注册）。

导出形状：
```ts
export const name = 'tool-fs'                          // loader 诊断用
export const inject = ['tools', 'fs', 'systemPrompt']  // 要求的服务
export interface Config { /* ... */ }
export const Config: z<Config> = z.object({ /* 全部带 .default() */ })
export function apply(ctx: Context, config: Config): void { /* ... */ }
```

依赖：`@deepseek-ai/dsh-tools`（提供 `defineTool` 与类型）在 `peerDependencies`，加 `@deepseek-ai/cordis`。
需要给模型喂提示词指引时再加 `@deepseek-ai/dsh-system-prompt`。

**注册即 effect，无需手工清理**：`apply` 内拿到的 `ctx` 已经让该 fiber 拥有注册，
`ctx.tools.register()` 返回 disposer，随 fiber 卸载自动回收
（`AGENTS.md`：*"Registrations are effects"*）。
`docs/testing.md` 要求每个注册表配一个 **HMR 安全测试**（dispose 掉贡献 fiber，断言清理干净）。

**scope 的两条轴（生成器只需知道第一条）**：
- **Fiber 归属（生命周期）** —— 默认行为，自动生效。
- **Scope（可见性）** —— `agent.ctx` 注册只对该 agent 生效并遮蔽同名全局工具；
  `ctx.tools.restrict(filter)` 是**实时可见性组合，不是权限边界**（原文）；
  `presentAs`/`restrict` 从普通上下文调用会抛错。普通工具插件注册到全局，不碰这些。

### 1.9 三个注入点（本项目可选的高级用法）

`tools/*` 瀑布精确顺序（逐字）：
```
tools/pre-execute → 注册的 monotonic guards → tools/execute
  → tools/post-execute → definition 自有的 finalizeContent → tools/result
```
三个瀑布都**必须调 `next()`**，否则短路整条链。可插入的语义：

| 注入点 | 可改什么 | 对"插件生成器"的用途 |
|---|---|---|
| `tools/pre-execute` | 决定 `allow` / `deny` / `ask`（**不提供输入改写**）；`ask` 由 `ctx.approval` 服务，未挂载则降级为 deny | 真实后端可用性闸门（二进制不存在就别让它跑） |
| `ctx.tools.guard(guard)` | 返回字符串即 **monotonic 拒绝**，在瀑布之后求值；后续 listener 无法翻案 | 安全不变量（不可被配置覆盖） |
| `tools/execute` | 只能替换 **operational 的 `signal`**，不可删除；超时/重试/指标在此 | 给外部进程调用套超时预算 |
| `tools/post-execute` | accept 可替换 `content` **或** `value`（不可同时），可附 `additionalContexts` | 把原始输出转成结构化值 |

> ⚠️ 命名陷阱：**`tools/result`（实时事件）vs `tool/result`（agent loop 随后追加的持久化 session 事件）**。
> 两者名字相近但语义完全不同，生成器不要写错。

### 1.10 后端三通道（"anything" 的宾语）

统一收敛到一个 **Provider 单一模块**，三种后端按优先级：
1. **外部 CLI** —— 直接包二进制（含 CLI-Anything 已产出的 `cli-anything-*` Python CLI，
   两个仓库由此串联）；
2. **HTTP/REST API** —— 走 `fetch`，遵守 `exec.signal`；
3. **MCP server** —— 若已有 MCP 端点，**不生成新插件**，直接建议用户加一行 `mcp-client` 配置。
   已核实：`packages/mcp/mcp-client` 每个 server 一个插件实例，工具以
   `mcp__<serverName>__<rawName>` 注册为**普通 `ctx.tools` 条目**，且**不挂在任何 bundle/preset**，是 opt-in 行。
   → SOP 第 1 步必须显式排除这条路径，避免为已有的 MCP 服务造重复插件。

---

## 二、仓库结构（镜像 CLI-Anything）

```
dsh-plugin-anything/
├── dsh-plugin-anything-plugin/          # SOP 工具包（镜像 cli-anything-plugin/）
│   ├── HARNESS.md                       # 八阶段 SOP（见第一部分映射）
│   ├── commands/{plugin-anything,list,refine,test,validate}.md
│   ├── guides/                          # 渐进式披露；每篇一个深水区
│   │   ├── backend-cli.md  backend-http.md  backend-mcp.md
│   │   ├── seam-vs-consumer.md          # 何时建缝、何时只做 Consumer
│   │   ├── render-intent.md             # 呈现层设计
│   │   ├── snapshot-testing.md          # keyless snapshot 写法
│   │   ├── bundle-distribution.md       # 三通道 + allowBuilds 风险
│   │   └── static-promotion.md          # 动态包→磁盘 bundle 的固化
│   ├── templates/{package.json,cordis.patch.yml,index.ts,provider.ts,SKILL.md}.template
│   ├── scripts/  verify-plugin.sh
│   └── tests/
├── bundle/                              # 【原生 bundle】核心差异化
│   ├── package.json                     # dsh.bundle.patch
│   ├── cordis.patch.yml                 # insert 我们的工具行
│   └── src/index.ts                     # plugin_anything_* 工具
├── <thing>/                             # 生成物，每个目标一个
│   └── dsh-plugin-<thing>/
│       ├── package.json  cordis.patch.yml  README.md
│       ├── src/{index.ts, provider.ts}   # provider.ts 是唯一接触外部系统的模块
│       ├── skills/SKILL.md
│       └── tests/{unit, snapshot}
├── registry/                            # 提交到 awesome-dsh-plugin 的条目 + 扩展字段
├── skills/                              # 根 skill 汇总（镜像 CLI-Anything）
├── docs/
└── .github/workflows/                   # 同构 CI 门禁
```

---

## 三、原生 bundle 的工具集（差异化核心）

dsh 明确说动态包 *"cannot be promoted automatically"* —— 这正是我们要补的能力。
`bundle/src/index.ts` 注册（全部走 `defineTool`，render intent 前置决定）：

| 工具 | 作用 | render intent |
|---|---|---|
| `plugin_anything_probe` | 探测目标：是 CLI / HTTP / MCP 哪一类，实测可调用性，产出能力清单 | `generic` + `kind: 'execute'` |
| `plugin_anything_scaffold` | 按模板写盘生成 3 文件骨架 + `src/` + `tests/` | `diff`（会写文件，带 `locations`） |
| `plugin_anything_promote` | **把动态 cordis 包固化到磁盘成为真 bundle** —— 本项目存在的理由 | `diff` |
| `plugin_anything_verify` | 对生成物跑门禁：`cordis` 文件名、`dsh.bundle.patch` 成对声明、`name` 是包名而非路径、`dependencies` 声明、命名冲突 | `generic` |
| `plugin_anything_install` | `dsh plugin --profile <p> add <spec>` + reconcile，然后 `--dump-config` 验证 | `terminal` |

**`plugin_anything_promote` 是全部价值所在**：它读取 `cordis_define` 产出的 `code.host`/`code.client`
（已核实是**纯 JavaScript 函数体**，返回一个 Cordis Plugin；不用 `import`/`require`/TS 类型/JSX，
客户端 React 必须 `React.createElement`），转成合法的 TS/ES 源文件 + `package.json` + patch 行。
这条路径目前 dsh **完全没有**，且它把易失的探索变成可提交的产物。

---

## 四、必须遵守的 dsh 工程约束

生成物**目标形态是 out-of-tree**，因此以下 in-tree 门禁**不适用**（这大幅降低了生成器负担）：
逐文件 100% 覆盖、`./invariant` 导出、`files` 逐项相等、`tsconfig` aggregate、`knip`、`publint`。

但仍然必须自建等价门禁（镜像 CLI-Anything 的 `.github/workflows`）：

- **`verify-cordis-config` 等价检查** —— 文件名含 `cordis`、根是 entry 数组、`!!js` 位置合法、
  bare plugin 已在 bundle `dependencies` 声明、每个 name 能解析。
  （注意：dsh 的 gate 只在 monorepo 内跑，对本仓库的生成物不生效 —— **我们必须自己实现**。）
- **`verify-plugin.sh` 等价** —— 镜像 CLI-Anything 的文件存在性检查，并补上它漏掉的项
  （CLI-Anything 的版本漏检 `HARNESS.md`/`guides/`/`templates/`，我们不要重犯）。
- **snapshot 门禁** —— 任何模型可见行为变更必须附 keyless snapshot，且必须**通过真实可运行的 example**
  产出完整 transcript（package 测试与 mock fixture **不能替代**）。
- **Agent Note** —— dsh 规定非平凡改动必须附一条（格式：`# Agent Note: <title>` + `Status: <...>`，
  且 `## Alternatives considered` **必填**）。本项目采纳同样制度。
- **presenter 纯度静态检查** —— 因为 presenter 在重放时运行，值得加一条 lint 规则禁止
  `Date.now`/`Math.random`/`fs`/`process` 出现在 `presentCall`/`presentResult` 内。

---

## 五、验证方式

1. **端到端最小闭环**：用 SOP 生成一个包 `git` 的 bundle → `dsh plugin --profile dev add ./dsh-plugin-git`
   → `dsh --profile dev --dump-config` 输出中出现 `# == dsh-plugin-git` 层与我们的 insert 行
   → 启动后模型能列出并调用新工具 → 重启后工具仍在（这正是动态包做不到的）。
2. **同名冲突路径**：生成一个与既有行同 service 名的插件，验证 `disabled: true` 先行的写法生效。
3. **pure presenter 重放**：对生成的工具做一次真正重放，确认 `presentCall`/`presentResult` 在
   无 I/O 条件下产出相同卡片；故意传畸形历史参数，确认回退 generic 而非抛错。
4. **负例门禁**：把 `name:` 改成相对路径、把裸插件从 `dependencies` 删掉、把 `!!js` 挪到 `id` 上，
   确认 `verify` 工具各自报错（每个改动过的验收路径都要证明能拒绝一个非法输入）。
5. **与 CLI-Anything 串联**：取一个现存 `cli-anything-*` CLI（如 `cli-anything-blender`），
   用 SOP 包成 dsh bundle，验证「CLI-Anything 产出 → dsh 插件」这条链路成立。
6. **注册表贡献**：把上述产物写成 `awesome-dsh-plugin` 格式条目并本地校验字段完整；
   确认 `market search` 能检索到。

---

## 六、执行顺序

1. 建仓库骨架 + `HARNESS.md`（八阶段 SOP，带 1.3 全部硬规则与 1.4 落盘契约）
2. `templates/`（五个模板）+ `scripts/verify-plugin.sh`（含 dsh 侧检查项）
3. `bundle/`（原生 bundle：五个 `plugin_anything_*` 工具，先做 `probe` + `scaffold` + `verify`）
4. `plugin_anything_promote`（最难，依赖前三个稳定）
5. 五个 slash 命令
6. CI 门禁 + snapshot 门禁
7. 一个真实生成物作为样板 + 注册表条目
