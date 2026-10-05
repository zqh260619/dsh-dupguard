# dupguard · DSH 大模型重复输出守卫

[![npm version](https://img.shields.io/npm/v/dsh-dupguard)](https://www.npmjs.com/package/dsh-dupguard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/zqh260619/dsh-dupguard/actions/workflows/ci.yml/badge.svg)](https://github.com/zqh260619/dsh-dupguard/actions/workflows/ci.yml)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0969da)](https://github.com/topics/dsh-plugin)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/zqh260619/dsh-dupguard)
[![dsh.so risk](https://www.dsh.so/badge/dsh-dupguard.svg)](https://www.dsh.so/artifact/dsh-dupguard/)
[![dsh.so install · dsh 0.2.0-rc.1](https://www.dsh.so/badge/install/dsh-dupguard@0.2.0-rc.1.svg)](https://www.dsh.so/artifact/dsh-dupguard/)
[![dsh.so install · dsh 0.1.7-rc.2](https://www.dsh.so/badge/install/dsh-dupguard@0.1.7-rc.2.svg)](https://www.dsh.so/artifact/dsh-dupguard/)
[![dsh.so install · dsh 0.1.7-rc.1](https://www.dsh.so/badge/install/dsh-dupguard@0.1.7-rc.1.svg)](https://www.dsh.so/artifact/dsh-dupguard/)
[![dsh.so install · dsh 0.1.5-rc.2](https://www.dsh.so/badge/install/dsh-dupguard@0.1.5-rc.2.svg)](https://www.dsh.so/artifact/dsh-dupguard/)

> **dupguard** 是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的实时重复输出守卫插件：最新输出中同一字符串连续重复 **10 次及以上**（可配置）时立即停止本次生成，已生成内容正常提交为助手消息。
>
> **dupguard** — a real-time repetition guard for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): stops model generation as soon as the same string repeats **≥ 10 times** (configurable) in the streamed output.

## 快速开始 / Quick Start

```bash
dsh plugin --profile web add dsh-dupguard      # 把 web 换成你的 profile 名
```

**重启 DSH 即生效**（宿主代码只在进程启动时加载）。看到这两处就说明装好了：

1. 设置页多出「重复守卫」分节，底部显示 `设置通道：ready｜构建 1.8.1｜自动派生：检测窗口 …`；
2. 宿主日志出现 `[dupguard] 生效参数：…`（**判断设置是否真的生效，只认这一行**）。

默认值开箱可用：连续重复 **≥ 10 次**即截停（已生成内容照常提交为助手消息），思考文本一并检测，**代码区域**
（围栏代码块、行内代码、缩进代码块三类统一）内按 **3 倍**放宽。想调整就在设置页改——**改完无需重启**
（写回 `cordis.patch.yml`，宿主自行热读取）。

> 桌面版（Electron）：请在**应用内「设置 → 插件」**安装（`desktop` profile 由应用独占管理，CLI 会被拒绝）。
> 其它安装方式（本地仓库 `--patch` 挂载 / 动态插件 / 手工补丁层 / 临时禁用）见
> [备选安装方式](#备选安装方式--alternative-installs)。

## 兼容性 / Compatibility

| 项目 | 支持范围 |
| --- | --- |
| 宿主 API | ≥ `0.1.1-rc.1`；一条命令 bundle 安装需 ≥ `0.1.2-rc.1` |
| 已实测通过 | **DSH 0.2.0-rc.2（CLI / web profile）**、**DSH 0.2.0-rc.2 桌面版（Electron，运行时同版本，Node 24.21.0）**、`0.1.7-rc.2` / `0.1.7-rc.1` / `0.1.6-alpha.2` / `0.1.5-rc.2` / `0.1.2-rc.1` / `0.1.1-rc.1` |
| Node | ≥ 20（与 DSH 一致，不支持 Node 18）；`.mjs` 高级模块需 ≥ 22 |
| 设置命名空间 | 0.1.7 起 = loader entry id（本 bundle 为 `include:dupguard`）；≤ 0.1.6 为 `dsh-dupguard`。1.6.0 起运行时自动选路，**无需按 DSH 版本换插件版本** |
| 升级提示 | **0.1.7 起设置键从 `dsh-dupguard:` 变为 `dupguard:`**，升级后请在设置页重新保存一次（或把旧键内容手工挪到新键下） |

- 结论：**升级 0.2.0 无需改配置或换版本**；桌面版与 CLI 同版本，上述 API 结论全部适用。
- 客户端设置分节的静态依赖只有 `slots` / `locale`，设置服务用 `ctx.inject()` **动态接入**，因此某个 DSH 版本
  增删设置服务都不会让入口卡在 `pending`。
- 每次核对的证据清单与历史记录（含可直接复制到 DSH Discussions 的报告）：
  [docs/compatibility-report.md](docs/compatibility-report.md)。

## 特性 / Features

- **实时检测**：逐 token（`text-delta`）检测，复读出现即停，延迟为单个增量。
- **真正的服务端停止**：提前结束流 → 适配器 `consumer.abort()` 中断 HTTP → 服务端停止生成；**绝不 `abort()` agent
  步骤信号**，并补发协议合规的 `block-end` + `finish(stop)`，已生成内容正常提交为助手消息，不污染会话日志。
- **多种复读形态**：单字符、词语、带空格 / 换行分隔、逐行、前缀后循环（默认去空白后检测）。
- **思考守卫**：默认同时检测 reasoning（思考）文本，思考中的复读同样截停（`monitorReasoning: false` 可关）。
- **图形化设置页**（npm 常驻版）：与「通用设置 / 模型 / 插件 / Agent 预设」并列的「重复守卫」分节，可视化编辑
  白名单与全部检测参数，改完即时生效并持久化。
- **双入口交付**：动态插件 [plugin/host.js](plugin/host.js) + npm 常驻版 [lib/index.js](lib/index.js) /
  [lib/client.js](lib/client.js)，同一套用例驱动两个入口（CI 防漂移）。
- **内置 DSH 兼容补丁**（`fixStandingMountConflict`，默认开启；见「已知限制」）。

**会拦住什么 / 不会拦什么**

| 会拦住 | 不会拦住 |
| --- | --- |
| 单字符 / 词语 / 逐行复读达到阈值 | 正常文本里的高频词（只认**连续**重复） |
| 带空格或换行分隔的复读 | 重复次数不足（默认 9 次及以下） |
| 前缀之后的循环 | 工具调用参数（`monitorToolArguments` 默认关） |
| 思考中的复读（默认开启） | Markdown 表格分隔行与长分隔线（`-` `|` 默认白名单） |
| 代码区域（围栏 / 行内 / 缩进）内的失控复读（在「阈值 × 倍数」处兜底） | 区域内的正常代码 / 测试夹具 / ASCII 图（默认倍数 3 放宽） |

## 配置 / Configuration

默认值定义在两个入口顶部的 `CONFIG`（CI 校验行为一致）。**npm 常驻版**：除 `fixStandingMountConflict` 外全部可在
设置页「重复守卫」分节调整并持久化到 `<profile>/cordis.patch.yml`，改动即时生效；动态版固定取常量。

| 配置项 / Option | 默认 / Default | 说明 / Description |
| --- | --- | --- |
| `threshold` | `10` | 触发阈值，`>=` 语义（第 10 次重复出现即停）。范围 2–1000。**仅简单模式在设置页显示**；`table`/`module` 下只作兜底与回退值 |
| `thresholdMode` | `'simple'` | `simple` 固定阈值 / `table` 分段表 / `module` 高级模块（设置页下拉）。`simple` 不建表、走原有快路径 |
| `thresholdByLength` | `''` | `table` 模式的分段表：设置页为**三列表格**（起始只读 / 终止 / 次数，1–16 行；起始首行 1、其后 = 上一行终止 + 1），存储仍为 `"<终止>:<次数>[, …]"`，例 `1:40, 2:30, 8:12`。**末行终止 = 最大检测长度**；旧写法 `*:<次数>` 仍兼容（迁移为末行） |
| `advancedThresholdFile` | `''` | `module` 模式的 JavaScript 文件路径，导出 `repeatCount(length) -> count`（同步）。安全提示见「高级用法」 |
| `minUnitLength` | `1` | 最小重复单元长度，范围 1–4096。**表格模式下为派生值**：等于表格起始（固定 1），由插件写回文档、不可手填 |
| `maxUnitLength` | `80` | 最大重复单元长度，范围 1–8192。**表格模式下为派生值**：等于末行「终止」，由插件写回文档、不可手填 |
| `detectionWindow` | 自动 | **派生值（只读）**：由插件计算并写回文档，手填值被忽略；公式见「检测窗口（自动推导）」 |
| `skipCodeBlocks` | `true` | 代码区域分档总开关。**⚠ 设置页已隐藏：`false` ≡ `codeBlockMultiplier: 1`**，请改用倍数表达；老配置里的该键仍按原语义生效，**改动倍数时会自动清除它** |
| `codeBlockMultiplier` | `3` | **代码区域（围栏 / 行内 / 缩进）内统一**的阈值倍数，设置页标签为「代码内阈值倍数」。三档：**≥2** 按「阈值 × 倍数」判定（越大越不易误杀，也越晚兜住失控）；**1** 与区域外同样严格；**0** 完全不检测区域内（且区域两侧不拼接）。范围 0–100 |
| `stripWhitespace` | `true` | 检测前移除空白 / 换行，识别 `x x x`、`x\nx\nx` 这类带分隔符的复读 |
| `ignoredChars` | `['-', '\|']` | 逐字符白名单（Markdown 表格分隔行不计入）。条目必须**是单个字符**（按 Unicode 码点）；多字符 / 空条目运行时丢弃并告警 |
| `ignoredSubstrings` | `[]` | **片段白名单（多字符）**：整段字面量匹配（区分大小写、不支持正则），命中时**先整段剔除**，再走去空白与逐字符规则，长片段优先。每项 ≤ 64 码点、最多 64 项。**代价**：跨增量匹配需每块保留（最长片段 − 1）个字符不参与检测 |
| `monitorReasoning` | `true` | 同时检测思考（reasoning）文本；只检测可见输出时置 `false` |
| `monitorToolArguments` | `false` | 同时检测工具调用参数（JSON / base64 里重复字符常见，默认关） |
| `fixStandingMountConflict` | `true` | DSH ≤ 0.1.6-alpha.2 的 standing-mount 冲突补丁（仅代码常量，见「已知限制」） |

## 高级用法 / Advanced

**按长度定次数的语义**：检测对**每个候选周期 p** 分别取 `need(p)` 判定，而一段周期性文本在**其周期的整数倍**上
同样是合法重复。因此**只抬高长度 1 的次数通常无效**（同一段 `aaaa…` 会以 p=2、3… 命中），想真正放宽短串必须把
所有可能命中的小周期一起抬高，例如 `1:40, 2:40, 3:40, *:10`（39 个同字符不触发、40 个触发）；反过来，长单元只需
更少次数即可单独生效（模块返回「长度 ≥ 20 → 3 次」时，20 字符单元重复 3 次即截停）。

**优先级与回退链**：`module` 加载成功 ⇒ 用模块；`module` 失败 ⇒ **基础 `threshold`**（告警一次，不静默回落到分段表）；
`table` 逐项查表 ⇒ 未覆盖用 `*` ⇒ 否则 `threshold`。

**分段表模式**：候选区间完全由表格决定——**最小单元长度固定为 1、最大单元长度 = 末行终止**，两者都是派生值
（写回文档、只在设置页底部诊断行显示）；界面上唯一可编辑的数值是「代码块内阈值倍数」。需要更多台阶（> 16 行）、
非单调规则或按公式计算（如 `max(3, ceil(200/p))`）时才必须改用模块。

**模块模式**：入参是**清洗后**的单元长度（Unicode 码点），返回所需连续重复次数（整数 2–1000；< 2 或非整数 ⇒ 该长度
不判定）；必须同步返回。宿主启动与设置变更时会打印「次数策略」摘要（模式、覆盖长度数、次数区间、最长跨度），
据此确认是否真的生效。

> ⚠ **安全提示**：模块文件在 **DSH 宿主进程内执行**——只指向自己信任的文件。扩展名不限：`.js` / `.cjs` 最稳妥；
> `.mjs` 需 **Node ≥ 22**；**其它扩展名（如 `.txt`）Node 也按 CommonJS 加载**；`.json` 仅作数据、按 JSON 解析
> 因而无法导出函数。保持同步、廉价、无副作用：插件只夹取返回值，加载或调用失败时整体回退基础阈值。

**功能等价关系**（知道后就不必纠结用哪一个）：

| 等价关系 | 说明 |
| --- | --- |
| `skipCodeBlocks: false` ≡ `codeBlockMultiplier: 1` | 两者都表示「块内与块外同样严格」。开关已隐藏，统一用倍数表达（**0** = 不检测块内 / **1** = 关闭分档 / **≥2** = 放宽到「阈值 × 倍数」），且改倍数会自动清除旧键 |
| 单行表格 `N:C` ≡ 简单模式 `threshold: C` + `maxUnitLength: N` | 单行表格的候选区间就是 1..N、次数恒为 C，窗口派生值也相同 |
| 常量模块 `() => C` ≡ 简单模式（阈值 C） | 模块只是把次数表达成函数 |
| 阶梯模块 ≡ 分段表 | 表格最多 16 行且必须连续覆盖；需要更多台阶、非单调规则或按公式计算时才必须用模块 |
| 单字符 `ignoredSubstrings` 条目 ≡ `ignoredChars` 条目 | 片段表额外支持多字符片段，字符表是默认开启的便捷项 |
| `thresholdByLength` 里的 `*:<次数>` | 仅兼容手改配置：设置页只产生连续覆盖的表格（不会写 `*`） |
| `detectionWindow` 手填值 | 会被派生值覆盖（宿主不读它），设置页已不再提供输入 |

**该用哪个**：一个阈值就够 → **简单模式**；几条阶梯又不想写代码 → **分段表**；按公式 / 非单调 / 长平台期 → **模块**。

**代码区域判定（围栏 / 行内 / 缩进，三类统一）**：三类区域都用同一个
阈值 `threshold × codeBlockMultiplier`，优先级为 **围栏 > 缩进 > 行内**：

| 区域 | 进入 | 退出 / 边界 |
|---|---|---|
| **围栏代码块** | 行首 ≤3 空格 + 连续 ≥3 个 ` 或 ~（其后为 info string） | 同字符、不短于起始长度的 run 行（其后仅空白）；**未闭合则延续到块结束** |
| **缩进代码块** | 行首缩进 ≥4（制表符按 4 计，`\r` 不计入）**且上一行为空行**，且上一个非空行不是列表项 / 引用起始 | 遇到首个「非空且缩进 <4」的行；块内空行不终止。**列表项之后的缩进与段落续行不算代码**（保守规则，避免误判） |
| **行内代码** | 1..64 个反引号开启（`` `x` ``、`` ``a`b`` `` 均可） | 必须在**同一行**内由**等长**反引号 run 闭合；换行 / 保留超过 256 字符 / 块结束仍未闭合 ⇒ **开启符按普通文本**，内容照常参与检测 |

- 倍数为 `0` 时三类区域内部都不再判定，且**区域边界会清空检测缓冲**（区域两侧的文本不会被拼成人为重复）——
  这是「代码再长也不误杀」的代价，默认 `3` 会在「阈值 × 3」处兜底；
- 围栏内的反引号/缩进不会另开区域；4 空格缩进的 ```` ``` ```` 也不算围栏（仍留在缩进代码块内）；
- **行尾兼容 CRLF**：`\r` 视为空白（不计入缩进），因此 `\r\n` 文档里的围栏结束行、空行与缩进代码块都按行正确判定；
- 行内区需要**有界保留**（开启符之后最多 256 字符不发射），因此超过 256 字符的单行行内代码会被按普通文本判定
  （已知限制，见下文）；未闭合反引号会在宿主日志告警一次；
- 老配置若显式设过 `skipCodeBlocks: false`，设置页会在倍数行下方提示一次（等价于倍数 1）。

## 检测窗口（自动推导）

`detectionWindow` 由插件按当前参数自动计算，正好等于「最严格的重复跨度」（**公式只在本节出现**）：

```text
required   = max(plainSpan, policySpan)
plainSpan  = max(threshold, threshold × codeBlockMultiplier) × maxUnitLength
policySpan = max over p of ( p × need(p) × 代码块侧倍数 )
value      = clamp(required, 64, 1048576)
```

- 简单模式用 `plainSpan`；策略模式（`table` / `module`）用 `policySpan`——**不叠加基础阈值**（基础阈值只在表未覆盖
  且无 `*` 时才生效，其贡献已计入策略表）；
- 倍数为 `0`（块内完全不检测）时按 1 计；
- 策略模式示例：`1:20,2:15,10:10,20:5,*:3` + 最大单元 1000 + 倍数 0 → **3000**（`*:3 × 1000`），
  而不是 `10 × 1000 = 10000`；
- 结果夹到 **64–1048576**；被夹住时设置页单独显示「⚠ 自动窗口需要 N 字符，已达上限 …」，此时请降低阈值 / 代码块倍数 /
  最大单元长度（或策略跨度）——窗口本身不是可调项；
- 三个派生值是 `detectionWindow`、表格模式下的 `minUnitLength`（= 1）与 `maxUnitLength`（= 末行终止），每次生效都会
  **写回设置文档**，因此配置文件与界面显示的是一致的真实生效值；
- 设置页不提供输入框、也不单独占行（不可编辑的值占位只会让界面变吵），数值并入底部诊断行：`table` 模式显示
  「自动派生：检测窗口 9000 · 最大重复单元长度 1000（末行决定）」，`module` 模式显示宿主写回文档的窗口值。

## 工作原理 / How it works

1. **拦截**：监听 `llm/stream` 瀑布事件（包裹每次流式模型调用），返回包装后的 `AsyncIterable`；按 `chunk.index`
   分块累积，多块交替输出互不干扰。
2. **清洗 / 白名单**：先按片段白名单整段剔除（长片段优先，跨增量尾巴由块结束时的补投兜住）→ 再去空白（可关）→
   最后逐字符剔除。启用片段表时每块最多保留（最长片段 − 1）个字符不参与检测。
3. **尾串检测**：对清洗后的缓冲做**尾部连续重复检测**——文本以长度 `minUnitLength`..`maxUnitLength` 的单元连续重复
   ≥ `need(p)` 次结尾即触发。模型一旦复读，重复必然在尾部，因此尾部检测即可实时捕获所有循环，又避免全窗口词频
   的误报（如正常中文里高频的「的」）。
4. **协议合规收尾**：提前结束流 → 上游 `iterator.return()` → 适配器 `finally` 中 `consumer.abort()` 中断 HTTP 连接，
   服务端真正停止生成；同时补发所有打开块的 `block-end`（携带完整已生成文本）与 `finish{kind:'stop'}`，满足
   `llm-invariant` 校验，agent-loop 把已生成内容正常提交为助手消息。**绝不直接 `abort()` `options.signal`**
   （对 loop 请求它就是 agent 步骤信号）。

## 触发示例 / What gets stopped

| 形态 | 示例 |
| --- | --- |
| 单字符循环 | `aaaaaaaaaa` |
| 词语 / 带空格复读 | `哈哈` ×10、`hello hello hello …` ×10 |
| 逐行复读（含前缀后循环） | `好的，下面开始回答：` + `循环` ×10；`抱歉，我无法完成。` ×10 行 |

「思考中的复读」同样默认截停；「不会拦什么」的完整清单见上文「特性 / Features」的小表
（只认连续重复、9 次及以下不触发、工具参数默认关闭、表格分隔行默认白名单）。

## 设置不生效时的排查 / Troubleshooting

先看三处：① 设置页底部 `设置通道：…｜构建 1.8.1｜自动派生：…`（`unavailable` / `loading` 一直不变 ⇒ 通道没接上；
构建标记与刚安装的版本不一致 ⇒ 浏览器加载的是旧 bundle，刷新页面）；② 宿主日志 `[dupguard] 生效参数：…`
（**判断设置是否真的生效的唯一权威**，此时设置页显示的值不算）；③ 浏览器控制台
`[dupguard] remote.settings.describe 返回命名空间：…`（列表里没有本插件 ⇒ 命名空间未注册 / 未投影）。

七类根因（均已在对应版本修复，列出便于对照症状，详见 [CHANGELOG.md](CHANGELOG.md)）：

1. **宿主进程未重启**：`lib/index.js` 只在进程启动时载入 ⇒ 刷新页面能看到新 UI 并保存，但宿主仍跑旧逻辑；
   重启 `dsh web` 后以启动日志的「生效参数」行为准。
2. **entry id 拼错 / 重复**：命名空间取自 loader entry id（拼错时设置页拿不到本插件的 entry）；与手工 `insert`
   并存会抛 `duplicate loader entry id: dupguard`。
3. **命名空间 / 键名不符**：升级到 0.1.7 后旧键不再被读取（见上文「兼容性」的升级提示，重新保存一次即可）；
   字段未标 `volatile` 会让 `describe()` 整个跳过该 entry（表现为「设置服务不可用」）。
4. **改的是派生值**：`detectionWindow`、表格模式下的 `minUnitLength` / `maxUnitLength` 手填后会被覆盖 ⇒
   要改的是阈值 / 倍数 / 表格末行。
5. **被上限夹住**：`required > 1048576` 时夹到上限，超过该长度的重复单元无法识别（设置页有 ⚠ 告警）。
6. **`skipCodeBlocks` 与倍数互相覆盖**：老配置里显式 `skipCodeBlocks: false` 等价于倍数 1，未编辑前旧键照常生效；
   提交倍数会先清除该旧键（best-effort），避免「隐藏却仍覆盖倍数」。
7. **层间传播**：设置页写入 `<profile>/cordis.patch.yml`，该层变更不会自动重新解析进运行中的 entry fiber；
   插件现自行读取该文件并叠加到 Config 之上（每次流式调用即时生效），文件变化时把结果推回自身 fiber，
   失败仅告警、检测照常。

## 测试与开发 / Tests & development

```bash
npm test        # 功能 105 项（tests/detector.test.js）+ 客户端 32 项（tests/client.test.js）
npm run stress  # 四套压力测试，见下
```

同一套用例分别驱动两个入口（`plugin/host.js` 经 `new Function` 求值、`lib/index.js` 经 `require` 加载），覆盖透传
完整性、各类复读形态、阈值边界、协议闭合、上游 `return()` 调用、默认不检测 reasoning / 工具参数、未闭合工具调用块
的闭合、多次调用状态隔离、设置 schema 与热更新等。`client.test.js` 用最小 React 与 DSH 客户端桩驱动设置页组件。
**CI 在 Node 20 / 22 / 24 上运行 `npm test`**（与 DSH 一致，不支持 Node 18）。

压力四套（`npm run stress`）：

| 套件 | 覆盖 |
| --- | --- |
| `tests/stress-host-adversarial.js` | 边界 / 周期重叠 / 分块不变性 / 协议交错 / 代码区域（围栏 / 行内 / 缩进）与片段白名单 / 设置 churn / 畸形输入 |
| `tests/stress-host-throughput.js` | 吞吐、最坏情况扫描、命中延迟、内存、200 路并发、参数极值 |
| `tests/stress-client-ui.js` | 设置页 500 条白名单、1000 次混合操作、写应答乱序、churn、挂载泄漏 |
| `tests/stress-real-invariant.mjs` | 真实 DSH `llm-invariant` + `BlockAssembler` 端到端校验截停收尾（8 用例） |

最后一套使用本机安装的 `@deepseek-ai/dsh-llm`（依次探测 `$DSH_LLM_DIR`、`$DSH_INSTALL`、`$DSH_HOME`、全局 npm
安装），找不到时打印 SKIP 并跳过，因此可安全地在任意环境运行。

## 项目结构 / Project layout

```text
.
├── plugin/
│   └── host.js                 # 动态插件形式（cordis_define 的 code.host）
├── lib/
│   ├── index.js                # npm/组合常驻形式（package.json main 入口，含设置集成）
│   └── client.js               # 浏览器端设置页（ModuleLoader 格式，dsh.client 入口）
├── tests/
│   ├── detector.test.js        # 端到端测试：双入口防漂移 + reasoning 开关 + settings/Config 集成
│   ├── client.test.js          # 设置页组件测试：最小 React/DSH 桩（旧版 settingsScope + 新版 remote）
│   ├── stress-host-adversarial.js  # 压力：边界/协议交错/代码区域（围栏/行内/缩进）与片段白名单/热更新 churn/畸形输入
│   ├── stress-host-throughput.js   # 压力：吞吐/内存/200 路并发/参数极值（METRIC 指标）
│   ├── stress-client-ui.js         # 压力：设置页高频交互、乱序应答、挂载泄漏
│   ├── stress-real-invariant.mjs   # 压力：真实 DSH llm-invariant + BlockAssembler 端到端校验
│   ├── experiment-cancel.mjs       # 诊断实验（不进 CI）：验证截停不阻塞于底层流取消
│   └── experiment-inspect-patch.mjs # 诊断实验：standing-mount 补丁的多代并存行为
├── docs/
│   └── compatibility-report.md # 兼容性报告与证据清单（可直接贴到 DSH Discussions）
├── .github/workflows/          # ci.yml（Node 20/22/24 跑 npm test）+ publish.yml（v* 标签发布 npm）
├── cordis.patch.yml            # bundle 补丁层（dsh.bundle.patch：插入宿主行）
├── package.json
├── CHANGELOG.md
├── LICENSE                     # MIT
└── README.md
```

## 备选安装方式 / Alternative installs

除「快速开始」里的一条命令安装外，还有三种备选方式；**同一行只保留一种安装方式**——重复 entry id 会让 loader 抛
`duplicate loader entry id: dupguard`。

```bash
dsh plugin --profile web update dsh-dupguard   # 升级
dsh plugin --profile web remove dsh-dupguard   # 卸载（依赖与 bundles 条目一并移除）
```

一条命令安装为何不需要手改 YAML：本包自带 bundle 补丁层（`dsh.bundle.patch` → [cordis.patch.yml](cordis.patch.yml)），
`dsh plugin` 把参数转发给 profile 目录下的 pnpm，安装后自动把声明了 `dsh.bundle` 的依赖加入 `dsh.profile.bundles`，
并插入宿主行 `{ id: dupguard, name: dsh-dupguard }`（需 DSH ≥ 0.1.2-rc.1）。

**① `--patch` 挂载本地 / 仓库路径**（不改 profile，适合开发调试）：

```yaml
# dupguard.patch.yml —— 与 profile 的 cordis.patch.yml 同格式（补丁列表）
- insert:
    - id: dupguard
      name: file:///path/to/dupguard/lib/index.js   # Windows 形如 file:///D:/path/to/dupguard/lib/index.js
```

```bash
dsh --profile web --patch ./dupguard.patch.yml
```

`--patch` 是 `dsh` 自身的可重复参数，该覆盖层在 profile 用户层之后应用，因此不必写进任何 profile 文件；
`name` 用 `file:` URL 指向仓库内 [lib/index.js](lib/index.js)（CJS `module.exports = { name, apply }`，零构建，
loader 的 `unwrapExports` 兼容；相对路径以 profile 目录为基准）。

**② 动态插件**（无需安装，进程内生效，功能子集）：把 [plugin/host.js](plugin/host.js) 的全部内容作为 `code.host`
提交给 `cordis_define`，再用 `cordis_run` 激活返回的 `packageId` 即可；随 DSH 进程存在，重启后需重新 define + run。
**功能子集**：无设置页（参数固定取文件顶部 `CONFIG`）；不支持 `module` 模式（`table` 可用，`module` 回退固定阈值并告警）。

**③ 手工补丁层**：在 `<profile>/cordis.patch.yml` 里 `insert` 方式① 的那一行（用户层在 bundle 层之后应用，保存即
热重载）；临时停用则在该文件写 `- id: dupguard` + `disabled: true`（保存即卸载，无需重启）。

## 已知限制 / Limitations

- 阈值语义为 `>= threshold`：第 10 次重复出现时即停止；重复 9 次及以下不触发。
- 停止时若恰有未闭合的工具调用块（顺序输出块的适配器几乎不可能），该块会按已累积参数闭合并可能被执行；
  协议新增 `ContentBlock` 类型时，截停收尾对未知块类型只能按 tool-call 兜底并打印一次性告警
  （DSH 0.2.0 新增的 `tool-addition` / `tool-removal` 不携带增量，检测无法在其打开期间触发，因此不会走到该兜底路径）。
- 服务端停止依赖适配器在流关闭时中止底层请求的语义（已验证 `dsh-llm-deepseek`；自定义适配器需自查）。
- **代码区域（围栏 / 行内 / 缩进）统一按倍数放宽**：倍数为 `0` 时三类区域内的失控复读都不会被截停，且模型只要用
  反引号或 4 空格缩进「包住」复读即可绕过检测——这是该模式的显式代价；默认 `3` 会在「阈值 × 3」处兜底（详见「高级用法」）。
- **缩进代码块用保守启发式**：需「行首 ≥4 空格 + 前有空行 + 上个非空行不是列表项/引用」，不做完整 CommonMark
  块级解析（引用、嵌套列表、表格列宽等不参与判定）；因此列表项之后的缩进代码样例会被当作普通文本。
- **单行行内代码超过 256 字符**（保留上限）会回退为普通文本判定 ⇒ 这类超长行内代码内的复读将按普通阈值截停；
  换取的是「一个游离反引号不会让后面整段检测失效」。
- **片段白名单的代价**：为跨增量匹配，启用后每块最多保留（最长片段 − 1）个字符不参与检测，即检测最多延迟这么多
  字符；上限 64 项 × 64 字符，逐条字面量替换、不支持正则；片段表为空时走零开销快路径。
- 检测窗口上限 1,048,576 字符：每个增量都要重写一次缓冲，成本随窗口线性增长——缓冲填满后 1 MiB 窗口约
  0.13 ms/增量，默认 8192 无感（约 1.9 µs/增量，模型侧毫秒级的 token 间隔下可忽略）。
- 手工写入非法值（如 `minUnitLength > maxUnitLength`）时 DSH 会在注册时拒绝该命名空间，插件捕获后仅打印错误日志
  并整体回落到代码默认值（检测功能不受影响，设置页显示默认值）。

**standing-mount 冲突（DSH ≤ 0.1.6-alpha.2 缺陷，本插件已内置幂等补丁）**：运行期间编辑已挂载 preset 的 composition
文件后，下一次 resume 会新建一代 standing mount 而旧代永不销毁，`tool-cordis` 重复向进程全局 `cordisInspect`
注册 provider，报 `Host Cordis inspect provider "Service" is already registered`，且必须重启 DSH 才能恢复。插件默认把
`cordisInspect.register` **幂等化**（同 id 共享既有注册），消除该报错；补丁进程内常驻、HMR 重载不叠加，DSH 修复后
可将 `fixStandingMountConflict` 置为 `false`。完整机制、实测版本与「运行期间编辑 preset 后重启」的操作纪律见
[CHANGELOG.md](CHANGELOG.md)。

## English summary

- **Install (one command)**: `dsh plugin --profile web add dsh-dupguard` (DSH ≥ 0.1.2-rc.1) — the package ships its own
  bundle patch layer, so no YAML editing is needed. For a local checkout, boot with
  `dsh --profile web --patch ./dupguard.patch.yml` where the overlay inserts
  `{ id: dupguard, name: file:///…/lib/index.js }`; the dynamic form ([plugin/host.js](plugin/host.js) via
  `cordis_define` + `cordis_run`) needs no install but has no settings page and no `module` mode — see
  *Alternative installs*. On the desktop (Electron) build, install from the app's **Settings → Plugins**.
- **Default behaviour**: generation stops as soon as the same string repeats ≥ 10 times consecutively in the streamed
  text (reasoning included, tool-call arguments excluded), and at 3 × the threshold inside code regions — fenced
  blocks, inline code (same-line backticks) and 4-space indented blocks are all judged together; the partial answer is
  committed as a normal assistant message.
- **Main options**: `threshold`, `thresholdMode` (`simple` / `table` / `module`), `thresholdByLength`,
  `advancedThresholdFile`, `minUnitLength` / `maxUnitLength`, `codeBlockMultiplier` (0 = off inside code regions,
  1 = tiering off, ≥2 = relaxed), `ignoredChars` / `ignoredSubstrings`, `monitorReasoning`, `monitorToolArguments`.
  The detection window — and both unit lengths in table mode — are derived and written back by the plugin.
- **Compatibility**: host API ≥ `0.1.1-rc.1`, verified on DSH 0.2.0-rc.2 (CLI) and on the desktop build (same runtime
  version), Node ≥ 20; the settings namespace is the loader entry id (`include:dupguard`) since 0.1.7, where the
  settings key changed from `dsh-dupguard:` to `dupguard:` (re-save once after upgrading).
- Links: [npm](https://www.npmjs.com/package/dsh-dupguard) · [GitHub](https://github.com/zqh260619/dsh-dupguard) ·
  [compatibility report](docs/compatibility-report.md) · [CHANGELOG](CHANGELOG.md) · [LICENSE](LICENSE).

## License

[MIT](LICENSE)
