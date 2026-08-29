# dupguard · DSH 大模型重复输出守卫

> **dupguard** — a real-time repetition guard for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): stops model generation as soon as the same string repeats **≥ 10 times** (configurable) in the streamed output.
>
> **dupguard** 是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的实时重复输出守卫插件：当最新输出中同一字符串连续重复 **10 次及以上**（可配置）时，立即停止本次生成。

[![npm version](https://img.shields.io/npm/v/dsh-dupguard)](https://www.npmjs.com/package/dsh-dupguard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/zqh260619/dsh-dupguard/actions/workflows/ci.yml/badge.svg)](https://github.com/zqh260619/dsh-dupguard/actions/workflows/ci.yml)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0969da)](https://github.com/topics/dsh-plugin)

触发后，已生成的内容会**正常提交为助手消息**，本轮对话干净结束——不会报错、不会丢弃输出、不会污染会话日志。

When triggered, the already-generated text is committed as a normal assistant message and the turn ends cleanly — no errors, no lost output, no session-log pollution.

---

## 特性 / Features

- **实时检测**：逐 token（`text-delta`）检测，复读出现即停，延迟为单个增量。
- **多种复读形态**：单字符循环、词语循环、带空格/换行分隔的复读均能识别（默认去空白后检测）。
- **思考守卫**：默认同时检测 reasoning（思考）文本，思考中的复读同样会被截停（可通过 `monitorReasoning` 关闭）。
- **真正的服务端停止**：提前关闭流迭代 → 适配器 `consumer.abort()` → 中断 HTTP 连接，模型在服务端停止生成。
- **安全停止**：绝不 `abort()` agent 步骤信号；补发协议合规的 `block-end` + `finish(stop)`，消息正常提交。
- **Markdown 表格友好**：默认忽略连字符与竖线（`ignoredChars` 白名单，可配置），表格分隔行与长分隔线不会被误判为复读。
- **零依赖 / 零配置**：纯 JavaScript，无运行时依赖；默认配置开箱即用。
- **双入口交付**：动态插件（`plugin/host.js`）+ npm 组合挂载（`lib/index.js`），行为一致、CI 防漂移。
- **内置 DSH 兼容补丁**（`fixStandingMountConflict`，默认开启）：幂等化 `cordisInspect.register`，
  修复 DSH ≤ 0.1.1-rc.1 的 preset standing-mount 多代并存冲突（见下文"已知限制"）。

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

**1. 在 DSH profile 目录安装依赖**（例如 web GUI 的 `$DSH_HOME/profiles/web`）：

```bash
pnpm add dsh-dupguard      # 或 npm install dsh-dupguard
```

**2. 在 profile 的用户补丁层 `cordis.patch.yml` 插入组合行**：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: dupguard
      name: dsh-dupguard
```

- 用户补丁层在 bundle 层之后、`--patch` 之前应用；运行中的 DSH 通过 `watchUserPatches`
  **热重载**它——保存即生效，无需重启；加载失败会事务性回滚，不影响应用。
- 验证：`dsh --profile web --dump-config` 末尾应出现 `dupguard` 行；loader 日志会出现
  `apply plugin dupguard`。
- **撤销**：删掉该 `insert` 项即可热卸载。

**本机当前状态**：`profiles/web` 的组合行仍以 `file:` URL 直连仓库 `lib/index.js`
（发布前的过渡形态）。切换到 npm 包只需两步：在 `$DSH_HOME/profiles/web` 下执行
`pnpm add dsh-dupguard`，再把 `cordis.patch.yml` 中该行的 `name` 改为 `dsh-dupguard`。

**本地开发替代**：未发布/调试时，`name` 也可直接用 `file:` URL 指向仓库内的
[`lib/index.js`](lib/index.js)（CJS 导出 `{ name, apply }`，与 loader 的
`unwrapExports` 兼容，零构建）。

The plugin is published on npm as [`dsh-dupguard`](https://www.npmjs.com/package/dsh-dupguard).
Install it inside the DSH profile (e.g. `pnpm add dsh-dupguard` under
`$DSH_HOME/profiles/web`), then insert the row `{ id: dupguard, name: dsh-dupguard }` into the
profile's user patch layer `cordis.patch.yml`. The running DSH hot-reloads that file
(`watchUserPatches`) — no restart needed; a failed reload rolls back transactionally. Verify with
`dsh --profile web --dump-config` or the loader log line `apply plugin dupguard`; remove the
`insert` entry to uninstall.

**Current state on this machine**: the `profiles/web` row still points at the repo's
`lib/index.js` via a `file:` URL (pre-publish transitional form). To switch to the npm package,
run `pnpm add dsh-dupguard` in `$DSH_HOME/profiles/web` and change that row's `name` to
`dsh-dupguard`. The `file:` URL form also remains handy for local development against
[`lib/index.js`](lib/index.js) (CJS, `module.exports = { name, apply }`, compatible with the
loader's `unwrapExports`, no build step).

---

## 配置 / Configuration

修改 `plugin/host.js` 或 `lib/index.js` 顶部 `CONFIG` 常量（两个入口需保持同步，CI 会校验一致性）：

Edit the `CONFIG` block at the top of `plugin/host.js` / `lib/index.js` (both entries must stay in sync; CI verifies behavioral parity).

| 配置项 / Option | 默认 / Default | 说明 / Description |
| --- | --- | --- |
| `threshold` | `10` | 触发阈值：同一字符串连续重复 ≥ 该值时停止 / stop when the same string repeats ≥ this many times |
| `minUnitLength` | `1` | 最小重复单元长度 / minimum repeating-unit length (`1` also catches single-char loops like `aaaaaaaaaa`) |
| `maxUnitLength` | `80` | 最大重复单元长度 / maximum repeating-unit length |
| `detectionWindow` | `8192` | 检测滚动窗口（字符，去空白后）/ rolling detection window in chars (after whitespace removal) |
| `stripWhitespace` | `true` | 检测前移除空白/换行，识别带分隔符的复读 / strip whitespace so `"x x x"` and `"x\nx\nx"` are caught |
| `ignoredChars` | `['-', '\|']` | 检测时忽略的字符白名单：Markdown 表格分隔行（连字符与竖线）不参与重复统计；需更严格检测时置 `[]` / whitelist of characters ignored during detection: Markdown table separators don't count as repetition; set `[]` for stricter detection |
| `monitorReasoning` | `true` | 是否检测思考文本（思考中的复读同样消耗 token，默认截停；只检测可见输出时置 `false`）/ also guard reasoning (thinking) text — on by default; set `false` to guard visible output only |
| `monitorToolArguments` | `false` | 是否检测工具调用参数 / also guard tool-call JSON args — off by default (base64/JSON repeats are common) |
| `fixStandingMountConflict` | `true` | DSH ≤ 0.1.1-rc.1 兼容补丁：幂等化 `cordisInspect.register`，修复 preset standing-mount 多代并存冲突 / idempotent `cordisInspect.register` patch for the DSH ≤ 0.1.1-rc.1 standing-mount conflict |

---

## 工作原理 / How it works

### 1. 拦截流式输出 / Intercept the stream

监听 `llm/stream` 瀑布事件（包裹每次流式模型调用），返回包装后的 `AsyncIterable`。与 DSH 自带
`@deepseek-ai/dsh-llm` invariant 插件、`dsh-session-checkpoint-policy` 同款接入方式。

Listens to the `llm/stream` waterfall (wraps every streaming model call) and returns a wrapped `AsyncIterable`.

### 2. 检测算法 / Detection

- 按块索引（`chunk.index`）分别累积文本，多块交替输出互不干扰；
- 去空白后做**尾部连续重复检测**：文本以某个单元（长度 1..80）连续重复 ≥ 阈值结尾即触发。
  模型一旦复读，重复必然在尾部，因此尾部检测即可实时捕获所有循环，同时避免全窗口词频的误报
  （如正常中文里高频的"的"）。

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
│   └── index.js                # npm/组合常驻形式（package.json main 入口）
├── tests/
│   ├── detector.test.js        # 端到端测试：15 项 × 2 入口（防漂移）
│   └── experiment-cancel.mjs   # 诊断实验（不进 CI）：验证截停不阻塞于底层流取消
├── .github/workflows/ci.yml    # GitHub Actions：Node 18/20/22
├── package.json
├── CHANGELOG.md
├── LICENSE                     # MIT
└── README.md
```

## 测试 / Tests

```bash
node tests/detector.test.js   # 或 npm test
```

同一套 15 项用例分别驱动两个入口（`plugin/host.js` 经 `new Function` 求值、`lib/index.js` 经
`require` 加载），覆盖：透传完整性、各类复读形态、阈值边界、协议闭合、上游 `return()` 调用、
默认不检测 reasoning/工具参数、未闭合工具调用块的闭合、多次调用状态隔离等。CI 在 Node 18/20/22
上运行。

The same 15-test suite drives both entries, guarding against drift between the two forms. CI runs on
Node 18/20/22.

---

## 已知限制 / Limitations

- 停止时若恰有未闭合的工具调用块（顺序输出块的适配器几乎不可能），该块会按已累积参数闭合并可能被执行。
- 服务端停止依赖适配器在流关闭时中止底层请求的语义（已验证 `dsh-llm-deepseek`；自定义适配器需自查）。
- 阈值语义为 `>= threshold`：第 10 次重复出现时即停止。

### DSH 运行期间编辑 preset 后的 standing-mount 冲突（DSH ≤ 0.1.1-rc.1 缺陷，本插件已内置补丁）

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
（rc.6 / rc.7 / 0.1.1-rc.1 实测如此）；DSH 升级修复后可将 `CONFIG.fixStandingMountConflict` 置为 `false` 关闭。

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
set `CONFIG.fixStandingMountConflict` to `false` once a fixed DSH ships.

## License

[MIT](LICENSE)
