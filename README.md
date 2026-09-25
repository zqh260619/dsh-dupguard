# dupguard · DSH 大模型重复输出守卫

> **dupguard** — a real-time repetition guard for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): stops model generation as soon as the same string repeats **≥ 10 times** (configurable) in the streamed output.
>
> **dupguard** 是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的实时重复输出守卫插件：当最新输出中同一字符串连续重复 **10 次及以上**（可配置）时，立即停止本次生成。

[![npm version](https://img.shields.io/npm/v/dsh-dupguard)](https://www.npmjs.com/package/dsh-dupguard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/zqh260619/dsh-dupguard/actions/workflows/ci.yml/badge.svg)](https://github.com/zqh260619/dsh-dupguard/actions/workflows/ci.yml)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0969da)](https://github.com/topics/dsh-plugin)

**兼容性 / Compatibility**

- **DSH**：宿主 API 自 `0.1.1-rc.1` 起可用；当前版本在 **0.1.7-rc.1** 上实测通过，更早版本在
  `0.1.5-rc.2` / `0.1.6-alpha.2` / `0.1.1-rc.1` / `0.1.2-rc.1` 上实测通过。下面「一条命令的 bundle 安装」需要
  **DSH ≥ 0.1.2-rc.1**（bundle 自动纳管与 `dsh.bundle` 约定从该版本起提供）。
- **设置模型随版本切换，本插件两条都支持**（1.6.0 起运行时自动选路，无需按版本安装不同版本）：

  | | DSH ≤ 0.1.6 | DSH ≥ 0.1.7 |
  |---|---|---|
  | 命名空间来源 | `ctx.settings.register('dsh-dupguard', …)` | 插件 `Config` 导出，命名空间 = **loader entry id**（本 bundle 插入的行为 `dupguard`） |
  | 参数下发 | settings 作用域 watch | `apply(ctx, config)` 注入，读时实时取值 |
  | 客户端通道 | `settingsScope.bind({ namespace, decode })` | typert remote：`ctx.remote.settings.describe()/mutate(ns, ops, revision)` |

  伴随的行为变化：**0.1.7 起 `settings.yaml` 的用户键从 `dsh-dupguard:` 变为 `dupguard:`**，
  升级后请在设置页重新保存一次（或把旧键内容手工挪到新键下）。
- **Node**：≥ 20（与 DSH 一致，不支持 Node 18）。
- 客户端设置分节的静态依赖只有 `slots` / `locale`；设置服务用 `ctx.inject(…)` **动态接入**，
  因此某个 DSH 版本增删设置服务都不会让入口卡在 `pending`（这正是 1.5.0 在 0.1.7 上的故障）。

Host APIs work since DSH `0.1.1-rc.1`; the current release is verified on **0.1.7-rc.1**, and earlier
releases were verified on `0.1.5-rc.2` / `0.1.6-alpha.2` / `0.1.1-rc.1` / `0.1.2-rc.1`. The one-command
bundle install below needs **DSH ≥ 0.1.2-rc.1**. Since 1.6.0 both settings models are supported: on
DSH ≥ 0.1.7 the namespace comes from the plugin `Config` (id `dupguard`, i.e. the loader entry id) and
the Client reads/writes through `ctx.remote.settings`; on DSH ≤ 0.1.6 the plugin registers
`dsh-dupguard` and the Client uses `settingsScope`. Node ≥ 20.

触发后，已生成的内容会**正常提交为助手消息**，本轮对话干净结束——不会报错、不会丢弃输出、不会污染会话日志。

When triggered, the already-generated text is committed as a normal assistant message and the turn ends cleanly — no errors, no lost output, no session-log pollution.

---

## 特性 / Features

- **实时检测**：逐 token（`text-delta`）检测，复读出现即停，延迟为单个增量。
- **多种复读形态**：单字符循环、词语循环、带空格/换行分隔的复读均能识别（默认去空白后检测）。
- **思考守卫**：默认同时检测 reasoning（思考）文本，思考中的复读同样会被截停（可通过 `monitorReasoning` 关闭）。
- **真正的服务端停止**：提前关闭流迭代 → 适配器 `consumer.abort()` → 中断 HTTP 连接，模型在服务端停止生成。
- **安全停止**：绝不 `abort()` agent 步骤信号；补发协议合规的 `block-end` + `finish(stop)`，消息正常提交。
- **Markdown 表格友好**：默认忽略连字符与竖线（`ignoredChars` 白名单），表格分隔行与长分隔线不会被误判为复读。
- **图形化设置页**（npm 常驻版）：在 DSH 设置面板注册与「通用设置 / 模型 / 插件 / Agent 预设」并列的
  「重复守卫」分节，可视化编辑白名单与全部检测参数（阈值、最小/最大单元长度、检测窗口、空白与
  reasoning、工具参数开关）并持久化（`dsh-dupguard` 设置命名空间），修改即时生效；窗口小于
  阈值 × 最大单元长度时给出「窗口长度需要提高」提示。
- **代码块内三档处理**：围栏代码块（``` / ~~~）内按「代码块内阈值倍数」分档——默认 `3` 用
  「阈值 × 3」判定（生成的代码、测试夹具、表格、ASCII 图不会被误判，块内失控复读仍会被兜住）；
  `1` 与块外同样严格；`0` **完全不检测代码块内**（块内再长也不截停，且跨围栏不拼接）。
- **零配置开箱即用**：默认配置即可用；全部检测参数均可在设置页按需调整。
- **双入口交付**：动态插件（`plugin/host.js`）+ npm 组合挂载（`lib/index.js` + `lib/client.js`），行为一致、CI 防漂移。
- **内置 DSH 兼容补丁**（`fixStandingMountConflict`，默认开启）：幂等化 `cordisInspect.register`，
  修复 DSH ≤ 0.1.6-alpha.2 仍未修复的 preset standing-mount 多代并存冲突（见下文"已知限制"）。

---

## 快速开始 / Quick Start

### 方式一：动态插件（无需安装，进程内生效）/ Dynamic plugin (no install)

把 [`plugin/host.js`](plugin/host.js) 的全部内容作为 `code.host` 提交给 `cordis_define`，再 `cordis_run` 激活即可：

1. `cordis_define`：kind 选 `new`，idPrefix 例如 `dupguard`，`code.host` 填入 `plugin/host.js` 内容；
2. `cordis_run`：激活返回的 `packageId`（首次使用 mode `run`）。

动态插件随 DSH 进程存在；重启后需重新 define + run。

Paste the entire content of [`plugin/host.js`](plugin/host.js) as `code.host` in `cordis_define`, then activate the returned `packageId` with `cordis_run`.

### 方式二：npm 安装 + 组合挂载（常驻，随 DSH 启动）/ npm + composition (persistent)

插件已发布到 npm：[`dsh-dupguard`](https://www.npmjs.com/package/dsh-dupguard)。

**1. 安装（DSH ≥ 0.1.2-rc.1，一条命令）**：

```bash
dsh plugin --profile web add dsh-dupguard
```

本包自带 bundle 补丁层（`dsh.bundle.patch` → [`cordis.patch.yml`](cordis.patch.yml)）：
`dsh plugin` 把参数转发给 profile 目录下的 pnpm，安装后自动把声明了 `dsh.bundle` 的依赖
加入 `dsh.profile.bundles`；DSH 按 bundles 顺序应用各层补丁，本插件的层插入宿主行
`{ id: dupguard, name: dsh-dupguard }`。**无需手改任何 YAML。**

- 验证：`dsh --profile web --dump-config` 末尾应出现 `dupguard` 行；loader 日志出现
  `apply plugin dupguard`；宿主日志另有本插件的自检行
  `[dupguard] 常驻插件 apply 开始` 与 `[dupguard] 已注册设置命名空间 dsh-dupguard（检测参数可在设置页动态调整）`，
  出现后设置面板的「重复守卫」分节即可编辑白名单与全部参数。
- 升级：`dsh plugin --profile web update dsh-dupguard`；
  卸载：`dsh plugin --profile web remove dsh-dupguard`（依赖与 bundles 层一并移除）。

**2. 手工补丁层（旧版 DSH 或不想加入 bundles 时仍受支持）**：在 profile 的用户补丁层
`cordis.patch.yml` 自行插入同一行：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: dupguard
      name: dsh-dupguard
```

用户补丁层在 bundle 层之后应用；运行中的 DSH 通过 `watchUserPatches` **热重载**它——
保存即生效，无需重启，加载失败会事务性回滚。

⚠️ 两种方式**不要同时使用**：loader 对重复 entry id 直接抛
`duplicate loader entry id: dupguard`。从手工方式切换到 bundle 方式时，请删除手工 `insert` 项。

**3. 临时禁用（不卸载）**：在 profile 的用户补丁层里按 id 关掉该行即可：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: dupguard
  name: dsh-dupguard
  disabled: true
```

用户补丁层在 bundle 层之后应用，profile 的 `patchReload` 默认为 `live`——**保存即卸载该插件行，无需重启**；
改回 `disabled: false`（或删除该条）即恢复。这条 id 定位的补丁对两种安装方式都适用（bundle 层插入的行、
或你自己 insert 的行都会被它覆盖）。禁用后宿主半边（截停与 `dsh-dupguard` 设置命名空间）一并卸载，
全部检测参数回落到代码默认值（含白名单；`settings.yaml` 中的取值保留），重复输出不再被截停；由于 DSH 的
客户端模块图按**活动 loader 行**生成，**刷新页面**后设置面板里的「重复守卫」分节会消失。注意进程内的
standing-mount 兼容补丁不会随禁用撤销，要彻底干净需重启 DSH。彻底卸载请用上面的
`dsh plugin --profile web remove dsh-dupguard`（依赖与 bundles 条目一并移除）。

**Temporarily disable (without uninstalling)**: turn the row off by id in the profile's user patch layer:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: dupguard
  name: dsh-dupguard
  disabled: true
```

The user layer applies after every bundle layer and the profile's `patchReload` defaults to `live`, so
saving unloads the row **without a restart**; set it back to `false` (or delete the entry) to re-enable.
The id-targeted patch works for both install styles (a row inserted by the bundle layer or by your own
`insert` entry). The host half (guard + the `dsh-dupguard` settings namespace) unloads with it — every
detection parameter falls back to the code default (whitelist included) while `settings.yaml` keeps your
values, and nothing is stopped any more. DSH builds its Client module graph from **live loader rows**, so
the "Dupguard" settings section disappears after a page refresh. The process-resident standing-mount
patch is not undone by disabling; restart DSH if you need a completely clean process. To remove it
entirely, use `dsh plugin --profile web remove dsh-dupguard`.

**本地开发**：未发布/调试时，`name` 也可直接用 `file:` URL 指向仓库内的
[`lib/index.js`](lib/index.js)（CJS 导出 `{ name, apply }`，与 loader 的
`unwrapExports` 兼容，零构建）。

The plugin is published on npm as [`dsh-dupguard`](https://www.npmjs.com/package/dsh-dupguard)
and ships its own bundle patch layer (`dsh.bundle.patch` → [`cordis.patch.yml`](cordis.patch.yml)).
Install it with one command (DSH ≥ 0.1.2-rc.1):

```bash
dsh plugin --profile web add dsh-dupguard
```

`dsh plugin` forwards its arguments to pnpm in the profile directory and appends any dependency
declaring `dsh.bundle` to `dsh.profile.bundles`; DSH then applies each bundle layer's patch in
order, and this plugin's layer inserts the host row `{ id: dupguard, name: dsh-dupguard }`. No YAML
editing needed. Verify with `dsh --profile web --dump-config` or the loader log line
`apply plugin dupguard`; upgrade with `dsh plugin --profile web update dsh-dupguard` and uninstall
with `dsh plugin --profile web remove dsh-dupguard`.

**Manual layer (still supported)**: without a bundles entry, insert the same row into the profile's
user patch layer `cordis.patch.yml`; the running DSH hot-reloads that file (`watchUserPatches`) with
a transactional rollback on failure. Do **not** combine both — the loader throws
`duplicate loader entry id: dupguard`. The `file:` URL form also remains handy for local development
against [`lib/index.js`](lib/index.js) (CJS, `module.exports = { name, apply }`, compatible with the
loader's `unwrapExports`, no build step).

---

## 配置 / Configuration

检测参数的默认值定义在 `plugin/host.js` 与 `lib/index.js` 顶部的 `CONFIG`（两个入口需保持同步，
CI 会校验行为一致性）。**npm 常驻版**：下表参数除 `fixStandingMountConflict` 外全部可在设置页
「重复守卫」分节中动态调整并持久化到 `settings.yaml`，改动即时生效（动态版固定取常量）。

Defaults live in the `CONFIG` block of both entries (CI verifies behavioral parity). In the npm build
every option below except `fixStandingMountConflict` is editable from the "Dupguard" settings section
and persisted to `settings.yaml`; the dynamic build uses the constants.

| 配置项 / Option | 默认 / Default | 说明 / Description |
| --- | --- | --- |
| `threshold` | `10` | 触发阈值：同一字符串连续重复 ≥ 该值时停止 / stop when the same string repeats ≥ this many times |
| `minUnitLength` | `1` | 最小重复单元长度 / minimum repeating-unit length (`1` also catches single-char loops like `aaaaaaaaaa`) |
| `maxUnitLength` | `80` | 最大重复单元长度 / maximum repeating-unit length |
| `detectionWindow` | `8192` | 检测滚动窗口（字符，去空白后），需 ≥ 阈值 × 代码块倍数 × 最大单元长度（倍数 0 或关闭代码块分档时按 1 计）/ rolling detection window in chars (after whitespace removal); must be ≥ threshold × code-block multiplier × max unit length (multiplier counts as 1 when it is 0 or the tiering is off) |
| `skipCodeBlocks` | `true` | 是否启用围栏代码块的分档处理（配合 `codeBlockMultiplier`）；置 `false` 则块内与块外完全一致 / enables the tiered handling of fenced code blocks; set `false` to treat code exactly like surrounding text |
| `codeBlockMultiplier` | `3` | 代码块内处理分三档：**≥2** 按「阈值 × 本倍数」判定（越大越不易误杀正常代码，但也越晚兜住块内失控复读）；**1** 与块外同样严格；**0** 完全不检测代码块内。范围 0–100 / how code blocks are handled: >=2 = threshold x this multiplier, 1 = same as outside, 0 = do not detect inside code blocks at all. Range 0–100 |
| `stripWhitespace` | `true` | 检测前移除空白/换行，识别带分隔符的复读 / strip whitespace so `"x x x"` and `"x\nx\nx"` are caught |
| `ignoredChars` | `['-', '\|']` | 检测时忽略的字符白名单：Markdown 表格分隔行（连字符与竖线）不参与重复统计。条目必须**是单个字符**（按 Unicode 码点匹配，emoji 也算一个）；设置页一次输入多个字符会逐个加入，多字符/空条目在运行时被丢弃并告警 / whitelist of characters ignored during detection, so Markdown table separators don't count. Entries must be a **single character** (matched per Unicode code point); the settings page splits multi-character input into individual entries, and invalid entries are dropped at runtime with a warning |
| `monitorReasoning` | `true` | 是否检测思考文本（思考中的复读同样消耗 token，默认截停；只检测可见输出时置 `false`）/ also guard reasoning (thinking) text — on by default; set `false` to guard visible output only |
| `monitorToolArguments` | `false` | 是否检测工具调用参数 / also guard tool-call JSON args — off by default (base64/JSON repeats are common) |
| `fixStandingMountConflict` | `true` | DSH ≤ 0.1.6-alpha.2 兼容补丁：幂等化 `cordisInspect.register`，修复 preset standing-mount 多代并存冲突（仅代码常量）/ idempotent `cordisInspect.register` patch for the DSH ≤ 0.1.6-alpha.2 standing-mount conflict (code constant only) |

**窗口约束 / Window constraint**：`detectionWindow` 必须 ≥ `threshold × codeBlockMultiplier × maxUnitLength`
（倍数取 `0` 或关闭代码块分档时按 1 计）；否则长度超过 `floor(detectionWindow / 最严格阈值)` 的重复单元
凑不满重复次数，无法被识别（例如窗口 80、阈值 10、倍数 3 时，超过 2 字符的单元不再触发）。设置页在该约束
被违反时显示「⚠ 检测窗口长度需要提高：至少 N（当前 M = 阈值 × 倍数 × 最大单元）」的提示，宿主日志同时打印
一条告警；该约束**只提示不拒绝写入**，便于按需权衡内存占用与可识别单元长度。

The settings page shows a "detection window is too small" hint (and the host logs a matching warning)
whenever `detectionWindow < threshold × codeBlockMultiplier × maxUnitLength`; the write is still accepted.

---

## 工作原理 / How it works

### 1. 拦截流式输出 / Intercept the stream

监听 `llm/stream` 瀑布事件（包裹每次流式模型调用），返回包装后的 `AsyncIterable`。与 DSH 自带
`@deepseek-ai/dsh-llm` invariant 插件、`dsh-session-checkpoint-policy` 同款接入方式。

Listens to the `llm/stream` waterfall (wraps every streaming model call) and returns a wrapped `AsyncIterable`.

### 2. 检测算法 / Detection

- 按块索引（`chunk.index`）分别累积文本，多块交替输出互不干扰；
- 去空白后做**尾部连续重复检测**：文本以某个单元（长度 `minUnitLength`..`maxUnitLength`，默认 1..80）
  连续重复 ≥ `threshold` 次结尾即触发。模型一旦复读，重复必然在尾部，因此尾部检测即可实时捕获所有
  循环，同时避免全窗口词频的误报（如正常中文里高频的"的"）。

Tails-only consecutive-run detection on the whitespace-stripped buffer: catches every loop in real time
without the false positives of whole-window frequency counting.

### 3. 停止机制 / Stopping

守卫生成器提前结束 → `for await` 调用上游 `iterator.return()` → 适配器 `finally` 中
`consumer.abort()` 中断 HTTP 连接 → 服务端真正停止生成。**绝不直接 `abort()`
`options.signal`**（对 loop 请求它就是 agent 步骤信号，直接中止会以 `aborted` 结束并丢弃消息）。

Graceful early end: `iterator.return()` propagates to the adapter, whose `finally` aborts the HTTP
connection server-side. We never abort `options.signal` directly (for loop requests it *is* the agent
step signal).

### 4. 协议合规收尾 / Protocol-compliant closure

停止时补发所有打开块的 `block-end`（携带完整已生成文本）与 `finish{kind:'stop'}`，满足
`llm-invariant` 校验器要求；agent-loop 将已生成内容正常提交为助手消息。

Emits synthetic `block-end`s plus `finish(stop)` to satisfy the `llm-invariant` validator, so the
agent-loop commits the partial text as a normal assistant message.

---

## 触发示例 / What gets stopped

| 形态 / Pattern | 示例 / Example |
| --- | --- |
| 单字符循环 / single-char loop | `aaaaaaaaaa` |
| 词语循环 / word loop | `哈哈` ×10 |
| 带空格复读 / space-separated | `hello hello hello ...` ×10 |
| 逐行复读 / line repeats | `抱歉，我无法完成。` ×10 行 |
| 前缀后循环 / loop after prefix | `好的，下面开始回答：` + `循环` ×10 |
| 思考复读 / reasoning loop | 思考中 `想` ×10（默认截停） |

**不会触发 / Won't trigger**：正常文本中的高频词（检测只针对**连续**重复）、重复 9 次及以下、
工具参数（默认关闭）、Markdown 表格分隔行与长分隔线（连字符与竖线在白名单中，默认忽略）。
/ high-frequency words in normal prose (consecutive runs only), ≤9 repeats, tool args (off by
default), Markdown table separator rows and horizontal rules (whitelisted by default).

---

## 项目结构 / Project layout

```
.
├── plugin/
│   └── host.js                 # 动态插件形式（cordis_define 的 code.host）
├── lib/
│   ├── index.js                # npm/组合常驻形式（package.json main 入口，含设置集成）
│   └── client.js               # 浏览器端设置页（ModuleLoader 格式，dsh.client 入口）
├── tests/
│   ├── detector.test.js        # 端到端测试：双入口防漂移 + reasoning 开关 + settings/Config 集成（79 项）
│   ├── client.test.js          # 设置页组件测试：最小 React/DSH 桩（旧版 settingsScope + 新版 remote，23 项）
│   ├── stress-host-adversarial.js  # 压力：边界/协议交错/热更新 churn/畸形输入
│   ├── stress-host-throughput.js   # 压力：吞吐/内存/200 路并发/参数极值（METRIC 指标）
│   ├── stress-client-ui.js         # 压力：设置页高频交互、乱序应答、挂载泄漏
│   ├── stress-real-invariant.mjs   # 压力：真实 DSH llm-invariant + BlockAssembler 端到端校验
│   ├── experiment-cancel.mjs       # 诊断实验（不进 CI）：验证截停不阻塞于底层流取消
│   └── experiment-inspect-patch.mjs # 诊断实验：standing-mount 补丁的多代并存行为
├── .github/workflows/          # ci.yml（Node 20/22/24 跑 npm test）+ publish.yml（v* 标签发布 npm）
├── cordis.patch.yml            # bundle 补丁层（dsh.bundle.patch：插入宿主行）
├── package.json
├── CHANGELOG.md
├── LICENSE                     # MIT
└── README.md
```

## 测试 / Tests

```bash
npm test                      # 功能测试（两个文件）
node tests/detector.test.js   # 检测端到端（79 项）
node tests/client.test.js     # 设置页组件（25 项）
```

同一套用例分别驱动两个入口（`plugin/host.js` 经 `new Function` 求值、`lib/index.js` 经
`require` 加载），覆盖：透传完整性、各类复读形态、阈值边界、协议闭合、上游 `return()` 调用、
默认不检测 reasoning/工具参数、未闭合工具调用块的闭合、多次调用状态隔离、设置 schema 与热更新等。
`client.test.js` 用最小 React 与 DSH 客户端桩驱动设置页组件，断言写入走 `settingsScope` 控制器
（`set`/`unset`）而非已移除的 `connection.api`。CI 在 Node 20/22/24 上运行
（与 DSH 一致，不支持 Node 18）。

### 压力测试 / Stress suites

```bash
npm run stress                          # 依次运行下列四套
node tests/stress-host-adversarial.js   # 边界/周期重叠/分块不变性/协议交错/围栏代码块/设置 churn/畸形输入
node tests/stress-host-throughput.js    # 吞吐、最坏情况扫描、命中延迟、内存、200 路并发、参数极值
node tests/stress-client-ui.js          # 设置页 500 条白名单、1000 次混合操作、写应答乱序、churn、挂载泄漏
node tests/stress-real-invariant.mjs    # 用真实 DSH 的 llm-invariant 与 BlockAssembler 校验截停收尾
```

后一套使用本机安装的 `@deepseek-ai/dsh-llm`（依次探测 `$DSH_LLM_DIR`、`$DSH_INSTALL`、
`$DSH_HOME`、全局 npm 安装），找不到时打印 SKIP 并跳过，因此可安全地在任意环境运行。

实测参考（Windows / Node 24，默认参数除注明外）：

| 指标 | 实测 |
| --- | --- |
| 增量吞吐（窗口 8192） | 1 字符增量 1.9 µs/增量（533 chars/ms）；1KB 增量 11 µs/增量（92k chars/ms） |
| 增量吞吐（窗口 1 MiB） | 4 字符增量 33 µs/增量（118 chars/ms）——每增量重写整个窗口，大窗口显著变慢 |
| 最坏情况扫描（近失配周期文本） | 2.7 µs/增量 |
| 命中延迟 | 阈值 10 时消费 12 字符即截停（尾部即时判定） |
| 5,000,000 字符长流 | 堆增长约 32 MB（完整文本 + 检测窗口），无额外无界增长 |
| 200 路并发 | 136 ms；1 路复读被截停，其余 199 路完整透传 |
| 设置页 500 条白名单 | 渲染 0.3 ms；逐个删除 500 次 = 500 次写入 |
| 设置页 1000 次混合操作 | 24 ms、887 次写入，终态与控制器快照一致 |
| 500 次挂载/卸载 | subscribe 1000 / dispose 999（余 1 为当前挂载），无监听器泄漏 |

The same suite drives both entries. Stress suites cover host throughput/memory/concurrency, adversarial
protocol interleavings, client UI churn, and an end-to-end check against the installed DSH
`llm-invariant` validator plus the real `BlockAssembler`; `tests/stress-real-invariant.mjs` skips itself
when DSH is not installed. CI runs on Node 20/22/24 (matching DSH; Node 18 is not supported).

---

## 已知限制 / Limitations

- 停止时若恰有未闭合的工具调用块（顺序输出块的适配器几乎不可能），该块会按已累积参数闭合并可能被执行。
- 服务端停止依赖适配器在流关闭时中止底层请求的语义（已验证 `dsh-llm-deepseek`；自定义适配器需自查）。
- 阈值语义为 `>= threshold`：第 10 次重复出现时即停止。
- **代码块分档只覆盖围栏代码块**：行内代码（`` `x` ``）与缩进代码块（4 空格）仍按普通阈值判定；
  模型忘记闭合围栏时，其后内容一律按代码块处理。倍数为 `0`（完全不检测）时，代码块内的失控复读
  不会被截停——这是「代码再长也不误杀」的代价；默认倍数 `3` 则会在「阈值 × 3」处兜底。
- 检测窗口上限 1,048,576 字符：每个增量都要重写一次缓冲，成本随窗口线性增长——缓冲填满后
  1 MiB 窗口约 0.13 ms/增量，实测 4 字符增量的平均值为 33 µs/增量（含缓冲填充期）。默认 8192 无感
  （1.9 µs/增量，模型侧毫秒级的 token 间隔下可忽略）。
- 若手工编辑 `settings.yaml` 写入非法值（如 `minUnitLength > maxUnitLength`），DSH 会在注册时拒绝该
  命名空间，本插件捕获后仅打印错误日志并整体回落到代码默认值（检测功能不受影响，设置页显示默认值）。
- 协议新增 `ContentBlock` 类型时，截停收尾对未知块类型只能按 tool-call 兜底并打印一次性告警。

### DSH 运行期间编辑 preset 后的 standing-mount 冲突（DSH ≤ 0.1.6-alpha.2 缺陷，本插件已内置补丁）

**现象**：对某个会话执行模型选择等操作时报
`resume failed ... preset ... failed to mount ... Host Cordis inspect provider "Service" is already registered`，
此后该错误持续出现，只有**重启 DSH** 才能恢复。

**机制**：preset 以 standing mount 方式**每 preset 挂载一次**并常驻；当 preset 的 composition 文件在
DSH 运行期间被编辑过（mtime/size 变化），下一次对"无活跃 agent 的会话"的操作（模型切换、打开历史会话等）
会**新建一代 standing mount**，而**旧代从不销毁**（DSH 注释明示 "a superseded one is never disposed
while the process lives"）。`tool-cordis` 在每次挂载时向**进程全局**的 `cordisInspect` 注册表注册
`Service`/`Event`/`Builtin`/`Tool` 四个 provider，新旧两代并存即冲突；失败的新代回滚、旧代残留，
重试永远重复冲突——这正是报错后"必须重启才能恢复"的原因。

**本插件的修复（默认开启）**：`apply` 时把 `cordisInspect.register` **幂等化**——同 id 已有注册时
共享既有注册并返回 no-op disposer，多代并存不再冲突。补丁进程内常驻（卸载本插件后仍生效，
重启后由本插件重新安装；HMR 重载不会叠加）。依赖 `cordisInspect.providers` 为可读 Map
（rc.6 / rc.7 / 0.1.1-rc.1 / 0.1.2-rc.1 / 0.1.5-rc.2 / 0.1.6-alpha.2 实测如此）；0.1.6-alpha.2 上游
仍留有 "reclaim the superseded generation" 的 TODO，缺陷未修复，故默认开启。
DSH 升级修复后可将 `CONFIG.fixStandingMountConflict` 置为 `false` 关闭。

**仍建议的操作纪律**：运行期间编辑已挂载 preset 后重启 DSH（补丁消除的是报错，旧代残留的
组合仍占用资源，这是 DSH 的既有行为）；根治仍待上游修复。

If you edit a mounted preset's `agent.cordis.yml` while DSH is running, the next session resume
(triggered e.g. by the model picker on a session whose agent is gone) mounts a NEW standing-mount
generation of that preset while the old generation is never disposed — `tool-cordis` then registers
its process-global Host inspect providers (`Service` …) twice and every retry fails with
`Host Cordis inspect provider "Service" is already registered` until DSH restarts. **This plugin
patches it by default**: `cordisInspect.register` is made idempotent (a same-id registration shares
the existing one and gets a no-op disposer), so coexisting generations no longer collide. The patch
is process-resident (survives plugin unload, reinstalled on restart; HMR reload does not stack it);
set `CONFIG.fixStandingMountConflict` to `false` once a fixed DSH ships. Still open in 0.1.6-alpha.2:
upstream carries a TODO to reclaim superseded generations.

## License

[MIT](LICENSE)
