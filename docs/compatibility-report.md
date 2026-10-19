# DSH 兼容性报告 / Compatibility reports

本文件是**可直接复制到 [DSH Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 的兼容性报告**
（模板取自 [dsh.so 提交页](https://www.dsh.so/zh/submit/)），以及每次核对的证据清单。
仓库内的核对结论同步写在 [README 兼容性段落](../README.md#兼容性--compatibility) 与 [CHANGELOG](../CHANGELOG.md)。

> 说明：报告是**作者自测**结果，不是 dsh.so 的独立验证。dsh.so 的 L4/L5 由该站沙盒流水线单独执行。

---

## DSH 0.2.1-rc.2 兼容性复核（2026-10-20）

DSH 网页端与桌面版升级到 **0.2.1-rc.2** 后，对插件 **1.10.0** 做了复核：

- **上游变化面**：rc.1 → rc.2 为全包同步版本号（`dsh-llm`、`dsh-settings`、`dsh-web-app` 等均为 rc.2，`cordis` 仍为 4.0.5）；
  唯一结构变化是客户端“模型标签”插件更名，与本插件无接触。`dsh-llm` 仍不提供 `invariant`，`BlockAssembler` 仍存在。
- **真实宿主端到端**：`npm run e2e:mock`（假模型 → 真实 DSH 适配器 + agent loop + `llm/stream` 瀑布）PASS——
  400 份重复文本，流式只到 20 份、最终消息 10 份，回合 `completed`，子进程退出码 0。
- **测试套件**：功能 106 + 客户端 50 + 截停通知 20 全通过；压力四套 PASS（真实契约校验走 cordis 瀑布，`dsh-llm 0.2.1-rc.2`）；
  沙箱自检 6/6；`audit:markdown` 通过。
- **网页端**：宿主已加载插件并投影完整 17 个 volatile 字段（cordis Config inspect）；`/dsh-dupguard/notifications`
  返回 `{"ok":true,...}`。本轮本机浏览器未开调试端口，未重复 UI 交互实测（rc.1 已实测；客户端相关包仅版本号变化）。
- **桌面版**：`runtime.json` 的 `desktopVersion` = 0.2.1-rc.2；桌面 profile 的 `dsh-dupguard` = 1.10.0。
- **发布前门禁**：`DSH_GATE_VERSION` 同步升到 `0.2.1-rc.2`（真实契约校验在本地已用 rc.2 跑通）。

## DSH 0.2.1-rc.1 兼容性复核（2026-10-17）

DSH 网页端与桌面版升级到 **0.2.1-rc.1** 后，对已发布的插件 **1.10.0** 做了完整复核：

- **真实宿主端到端**：`npm run e2e:mock`（假模型 → 真实 DSH 适配器 + agent loop + `llm/stream` 瀑布）PASS——
  400 份重复文本，流式只到 20 份、最终消息 10 份，回合 `completed`，子进程退出码 0 ⇒ 截停链路不变。
- **网页端实测**（0.2.1-rc.1，web profile）：设置页「重复守卫」正常渲染（17 个字段、`设置通道：ready｜构建 1.10.0`）；
  settings 读写双向通过（切换 `notifyOnStop` / `systemNotify` 均显示「已保存」，随后已还原原值）；
  `/dsh-dupguard/notifications` 返回 `{"ok":true,...}`；「发送测试通知」在授权后成功发送。
- **桌面版**：`resources/runtime/primary-runtime/runtime.json` 的 `desktopVersion` = 0.2.1-rc.1；桌面 profile 的
  `dsh-dupguard` 为 1.10.0（与发布包一致）⇒ 与网页端共用同一份插件代码与 DSH 运行时。
- **测试套件**：功能 106 + 客户端 50 + 截停通知 20 全通过；压力四套 PASS；沙箱自检 6/6；`audit:markdown` 通过。

**上游变更点（不影响插件运行时）**：0.2.1-rc.1 移除了 `@deepseek-ai/dsh-llm` 的 `lib/invariant.js`
（包 `exports` 里也没有 `./invariant`），`invariants` 服务一并消失。插件只在 `llm/stream` 瀑布注册监听
（`dsh-llm` 内部仍为 `ctx.waterfall(this, "llm/stream", ...)`），不依赖该模块 ⇒ 运行时不受影响。
仓库里的 `tests/stress-real-invariant.mjs` 已适配：真实实现层按上游版本自动选择——有 `dsh-llm/invariant`
（0.2.0 时代）就用它，否则用**真实 cordis Context 的 `llm/stream` 瀑布**（0.2.1-rc.1 起），输出统一交给真实
BlockAssembler；两者都不可用时打印 SKIP。发布前门禁（`publish.yml`）同步升级为固定 `@deepseek-ai/dsh@0.2.1-rc.1`，
安装成功时要求真实实现层必须可用（`DSH_GATE_REQUIRE_REAL=1`），避免门禁静默失效。

## 版本说明（1.10.0）

1.10.0 在 1.9.2 基础上新增**可选系统通知**（minor；首个会调用浏览器通知 API 的能力）：

- **新增设置项 `systemNotify`**（默认关闭）：截停时额外发一条浏览器系统通知（Windows 右下角 toast / macOS 通知中心），
  点通知聚焦窗口并跳到被截停的会话。四条约束：只在**页面不可见**时才弹（`document.visibilityState === 'hidden'`）；
  正文只有固定文案、不含工作区路径/会话名/重复内容；同一会话按 `tag` 替换上一条；首次打开开关时在用户手势里请求授权，
  被拒或浏览器不支持时只是不弹，浮层不受影响。
- **新增「发送测试通知」自检按钮**（打开开关后出现）：不依赖真实截停，点击即弹，用于当场验证浏览器→系统通知这条链路。
- **实现面**：纯客户端（`Notification` API，**不改检测算法、无新依赖**）；宿主只多一个持久化字段
  ⇒ schema volatile 字段 16 → **17**（宿主与 client 的默认值同步新增 `systemNotify: false`）。
  settings 服务面与事件、`llm/stream` 瀑布、`/dsh-dupguard` 通知通道、组合补丁层路径均不变。
- **桌面版（Electron）**：界面以 `dsh-app://app` 特权 scheme 运行（安全上下文）；桌面端权限处理对非 media 权限直接批准，
  因此通知权限直接是「已授权」、不弹授权框；通知署名是应用本身。窗口最小化或被完全遮挡时才满足 hidden 条件。
- **测试**：新增 5 项客户端用例，客户端套件 45 → **50** 项；功能套件仍为 106 项、截停通知 20 项。

## 版本说明（1.9.2）

1.9.2 在 1.9.1 基础上是**默认值与文档/CI 工具**的补丁（**不改 schema、不改服务面、不改检测算法**，但**改了默认参数值**）：

- **默认「代码内阈值倍数」3 → 4**（`codeBlockMultiplier`）：代码区域内的判定阈值由「阈值 × 3」变为「阈值 × 4」（默认参数下 30 → 40 字符），
  派生检测窗口 2400 → **3200**。依据是**误杀审计**（`npm run audit:false-positives`，260 个真实源码文件包进围栏重放发布版检测器）：
  倍数 3 时 2 个文件被误判（`─` 框线、一段 `a`），倍数 4 时 **0 个**；而往全局白名单里加任何符号字符（`= * / . # _ ~ + 0 1`）
  **一处都没减少**。⇒ 结论：代码块的噪声应该调倍数，而不是扩白名单（白名单全局生效，会连带漏掉"模型刷符号空转"这类真实故障）。
  **影响面**：只影响**没有显式存过该值**的配置（设置按 profile 持久化，已保存的值优先）；代码区域**外**的阈值与行为完全不变。
- **文档渲染修复**：README 四处渲染缺陷（嵌套反引号示例、落单反引号吞行、表格单元格内未转义的 `|`、**CJK 粗体 flanking 导致粗体跨句泄漏**）
  ＋ CHANGELOG 两处历史条目里的字面反引号。
- **新增 `npm run audit:markdown` 并挂入 CI（`docs` job）**：围栏配对 / 表格列数 / 反引号 span / CJK 粗体 flanking / 编程式区间写法。
  该工具用修复前的 README 反向验证过（准确报出 `README.md:270` 并退出码 1）；CI 也已实际拦下过一版含 4 处问题的提交。

schema 仍为 16 个 volatile 字段、settings 服务面与事件、`llm/stream` 瀑布、`/dsh-dupguard` 通知通道、组合补丁层路径全部不变
⇒ 1.9.1 / 1.9.0 的核对结论对 1.9.2 同样成立（已用 1.9.2 重跑：功能 106 项 + 客户端 45 项 + 截停通知 20 项 + 压力四套 + 沙箱自检 6/6 + Markdown 体检）。

## 版本说明（1.9.1）

1.9.1 在 1.9.0 基础上是**设置页可用性**的补丁（纯客户端 UI 与文档，**不改宿主代码、不改 schema、不改检测行为**）：

- **按用户任务重新分组**（自上而下＝从最常改到最少改）：重复次数（何时截停）→ 检测范围与开关 → 忽略白名单 → 截停通知；
  把原先分居两组、需要用户自己拼装的「模式」与「次数来源」并到同一组；代码内阈值倍数与阈值同组；白名单不再占据首屏；
- 层级：主标题 18px、分组副标题 15px（大于设置项名称 13px），底部状态行不受影响；
- 文案：去掉设置页**无法渲染的字面 markdown**（`**强调**`、反引号）并整体压缩（最长一条 312 → 122 字）；
- 关闭截停通知时隐藏「继续指令内容」。

schema 仍为 16 个 volatile 字段、settings 服务面与事件、`llm/stream` 瀑布、`/dsh-dupguard` 通知通道、组合补丁层路径全部不变
⇒ 1.9.0 的核对结论对 1.9.1 同样成立（已用 1.9.1 重跑：功能 106 项 + 客户端 45 项 + 截停通知 20 项 + 压力四套全 PASS）。

## 版本说明（1.9.0）

1.9.0 在 1.8.3 基础上新增**截停通知 + 一键继续指令**（首个会向会话**写入**消息的能力，因此单独作为 minor）：

- **新增宿主侧 HTTP 通道**：`webServer.register({ kind: 'prefix', path: '/dsh-dupguard' })`
  （注意前缀**不带尾斜杠**——DSH 匹配规则为 `pathname === prefix || pathname.startsWith(prefix + '/')`）；
- **新增客户端浮层**：注册到 `shell.overlay`（root 作用域，与当前会话无关），轮询上述通道；
- **新增服务依赖（均为可选注入，缺失只降级）**：`webServer` / `sessions` / `sessionTitle` /
  `workspaceRegistry` / `agents`——**必须经 `ctx.inject` 回调的 scope 属性访问**（`ctx.get` 在 loader entry
  ctx 上解析不到 root 服务，1.9.0 发布前实测踩过该坑）；
- **新增会话写入**：`agents.get(sessionId).followup(createUserMessage(...))`，仅在用户于通知里点
  「发送继续指令」时发生；消息构造优先复用 DSH 的 `createUserMessage`，缺失时按同形构造（`randomUUID` + 冻结）；
- **schema 字段 14 → 16**（新增 `notifyOnStop`、`continuePrompt`，均为 volatile，键只增不减）；
- 其余接触面不变：settings 服务面与事件、`llm/stream` 瀑布形态、既有客户端槽位与写通道、组合补丁层路径。

⇒ 下方 1.8.0 的核对结论对 1.9.0 同样成立（已用 1.9.0 重跑：功能 106 项 + 客户端 42 项 + 截停通知 20 项 +
压力四套全 PASS）。**实机验证**：通知通道在运行中的 CLI 实例上返回 `{"ok":true,...}`、
`GET /dsh-dupguard/notifications` 命中处理器、截停后浏览器出现通知并可注入继续指令（用户实测确认）。

**CI 门禁（自 1.9.0 起加强）**：`ci.yml` 在 Node 20/22/24 的 `npm test` 之外新增 `stress` job
（Node 22，`npm run stress:ci` = 确定性三套：adversarial / throughput / client-ui，本机约 48s）；
`publish.yml` 在 `npm test` 之后增加**真实 dsh-llm 契约校验**（固定版本由 `DSH_GATE_VERSION` 指定，当前
`@deepseek-ai/dsh@0.2.1-rc.2`；真实实现层按上游版本自动选择：`invariant` 或真实 cordis `llm/stream` 瀑布，
输出交给真实 BlockAssembler；安装为 best-effort，装到了就必须过）⇒ "真实契约"成为**发布前门禁**，
日常 CI 不受上游版本波动影响。

## 版本说明（1.8.3）

1.8.3 在 1.8.2 基础上是**设置页体验 + 安全门控**的改动（同样不改宿主 API 接触面）：
白名单两个输入框**合并为一个并按条目自动分类**（1 码点非空白 ⇒ 字符表，其余 ⇒ 片段表）、
**高级模式标注为实验性并在切入时弹出风险确认**（对齐 DSH 完全权限弹窗的 `RiskConfirmation` 模式）、
插件页描述更新为最新功能并提供**本地化元数据** `locale/{en,zh}.json`，以及弹窗主按钮配色的修复。
schema 字段仍为 14 个、settings 服务面与事件、`llm/stream` 瀑布、客户端槽位与写通道、组合补丁层路径全部不变
⇒ 下方 1.8.0 的核对结论对 1.8.3 同样成立（已用 1.8.3 重跑：功能 106 项 + 客户端 33 项 + 压力四套全 PASS）。

## 版本说明（1.8.2）

1.8.2 在 1.8.1 基础上包含两项**行为增强/修复**（均不改宿主 API 接触面）：
**三类代码区域统一判定**（围栏 / 行内 / 缩进共用 `threshold × codeBlockMultiplier`）与
**CRLF 行尾修复**（围栏结束行 ```` ```\r ```` 无法闭合、CRLF 空行后的缩进代码块不被识别）。
schema 字段仍为 14 个、settings 服务面与事件、`llm/stream` 瀑布、客户端槽位与写通道、组合补丁层路径全部不变
⇒ 下方 1.8.0 的核对结论对 1.8.2 同样成立（已用 1.8.2 重跑：功能 105 项 + 客户端 32 项 + 压力四套全 PASS）。

## 版本说明（1.8.1）

1.8.1 是**纯清理版本**（删除死代码、隐藏与「倍数 1」等价的冗余开关、修复 module 模式诊断行显示），
**未改动任何宿主 API 接触面**：schema 字段仍为 14 个、settings 服务面与事件、`llm/stream` 瀑布、
客户端槽位与写通道、组合补丁层路径全部不变 ⇒ 下方 1.8.0 的核对结论对 1.8.1 同样成立
（已用 1.8.1 重跑：功能 90 项 + 客户端 32 项 + 压力四套全 PASS）。

## 报告 1 · CLI / web profile × DSH 0.2.0-rc.2（2026-09-29）

```text
插件兼容性报告 ---------------------------
插件：dsh-dupguard（https://github.com/zqh260619/dsh-dupguard）
dsh 版本：0.2.0-rc.2（CLI，Windows x64，Node 24.19.0）
安装方式：bundle add —— dsh plugin --profile web add dsh-dupguard@1.8.0
结果：通过
备注：
- 插件 1.8.0；宿主条目挂载正常（Config 目录显示 include:dupguard，patchId dupguard，schema 已投影）
- 设置页分节注册为 settings.section 的 dupguard（order 25，active）；写通道仍是 ctx.remote.settings
  （与官方 @deepseek-ai/dsh-client-ui-settings 相同：inject ["remote","remote.settings"]）
- host settings 服务面 configure/describe/update/replace/mutate 与 0.1.7 一致；
  settings/document-updated 事件签名一致；组合补丁层仍为 <profile>/cordis.patch.yml
- llm/stream 瀑布签名与 StreamChunk 联合类型未变；stress-real-invariant.mjs 以真实 dsh-llm 0.2.0-rc.2
  校验截停收尾（8/8 通过）
- 全量测试：功能 87 项 + 客户端 31 项 + 压力四套全 PASS
- 0.2.0 新增块类型 tool-addition / tool-removal 不携带增量，检测无法在其打开期间触发，故不涉及未闭合块兜底
```

## 报告 2 · 桌面版（Electron）× DSH 0.2.0-rc.2（2026-09-29）

```text
插件兼容性报告 ---------------------------
插件：dsh-dupguard（https://github.com/zqh260619/dsh-dupguard）
dsh 版本：0.2.0-rc.2（桌面版 Electron；运行时声明 desktopVersion 0.2.0-rc.2，Node 24.21.0，pnpm 11.7.0）
安装方式：桌面应用「设置 → 插件」安装（desktop profile 由应用独占管理：
          dsh plugin --profile desktop … 会被拒绝，报 "profile \"desktop\" is managed exclusively by the Electron application"）
结果：通过
备注：
- profile 位于 <DSH_HOME>/profiles/desktop，组合方式与 CLI 相同（bundle 层 → cordis.patch.yml）；
  package.json 的 bundles 含 dsh-dupguard，node_modules 内为 1.8.0
- 13 项工件核验通过：版本 1.8.0 / dsh.bundle 与 dsh.client.platform=web / engines node>=20 /
  14 个字段全 volatile 且默认值可解析 / 窗口与单元长度派生 / 三字段合并写回 / 组合补丁层热读取 /
  动态入口派生 / 表格控件 / 构建标记 1.8.0
- schemastery 解析差异（两者都正常）：web profile 用插件内嵌套副本 3.18.2，desktop 用 profile 级 3.18.4；
  3.18.4 下 volatile 字段解析为响应式单元格（{ get() }），本插件宿主正是以 .get() 取值，
  默认值为 'simple' / 10 / ["-","|"] / true 等，与预期一致
- 桌面版与 CLI 同版本，故报告中 1 的全部 API 结论同样适用；免重启热读取按插件自身安装路径反推
  profile 目录，不依赖环境变量，桌面版同样生效
```

## 历史核对

| 插件版本 | DSH | 方式 | 结果 |
|---|---|---|---|
| 1.10.0 | 0.2.1-rc.2 | CLI（web profile 装机 + 真实宿主 `e2e:mock` + 通知通道路由 + 宿主 17 字段投影；压力四套 PASS，真实契约校验走 cordis 瀑布，`dsh-llm 0.2.1-rc.2`）；桌面版 `desktopVersion` 同版本、插件 1.10.0 | 通过 |
| 1.10.0 | 0.2.1-rc.1 | CLI（web profile 装机 + 真实宿主 `e2e:mock` + 设置页读写与测试通知实测；压力四套 PASS；`dsh-llm` 的 invariant 层已被上游移除，校验降级为守卫 + 真实装配器）；桌面版运行时同版本、插件 1.10.0 | 通过 |
| 1.10.0 | 0.2.0-rc.2 | CLI（web profile，装机核验：安装版本 1.10.0、`BUILD_MARK` 1.10.0、宿主与 client 均含 `systemNotify` 且设置页显示「同时发送系统通知」与「发送测试通知」；npm 发布 2026-10-17 15:28 本地；发布流水线"真实 invariant 发布前门禁"通过）；桌面版（Electron）实测系统通知可弹、署名应用本身 | 通过 |
| 1.9.2 | 0.2.0-rc.2 | CLI（web profile，装机核验：安装版本 1.9.2、`BUILD_MARK` 1.9.2、宿主与 client 的默认倍数均为 4；npm 发布 2026-10-16 21:21 本地；发布流水线"真实 invariant 发布前门禁"通过） | 通过 |
| 1.9.1 | 0.2.0-rc.2 | CLI（web profile，装机核验 12/12；npm 发布 2026-10-10；发布流水线首次执行"真实 invariant 发布前门禁"并通过） | 通过 |
| 1.9.0 | 0.2.0-rc.2 | CLI（web profile，装机核验 13/13；npm 发布 2026-10-09；用户实测截停通知与继续指令） | 通过 |
| 1.8.3 | 0.2.0-rc.2 | CLI（web profile，装机核验 12/12；npm 发布 2026-10-07） | 通过 |
| 1.8.2 | 0.2.0-rc.2 | CLI（web profile，装机核验 12/12；npm 发布 2026-10-06） | 通过 |
| 1.8.1 | 0.2.0-rc.2 | CLI（web profile，装机核验 12/12） | 通过 |
| 1.8.0 | 0.2.0-rc.2 | CLI（web profile） | 通过 |
| 1.8.0 | 0.2.0-rc.2 | 桌面版（Electron） | 通过 |
| 1.8.0 | 0.1.7-rc.2 | CLI（web profile） | 通过 |
| 1.6.3 / 1.8.0 | 0.1.7-rc.1 | CLI | 通过 |
| 1.3.1 / 1.3.0 | 0.1.7-rc.1 / 0.1.7-alpha.2 | CLI | 通过（dsh.so L5 记录） |
| 1.6.3 | 0.1.7-rc.2 | dsh.so 沙盒 | L5 运行验证通过 |
