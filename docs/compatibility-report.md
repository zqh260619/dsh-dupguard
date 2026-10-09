# DSH 兼容性报告 / Compatibility reports

本文件是**可直接复制到 [DSH Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 的兼容性报告**
（模板取自 [dsh.so 提交页](https://www.dsh.so/zh/submit/)），以及每次核对的证据清单。
仓库内的核对结论同步写在 [README 兼容性段落](../README.md#兼容性--compatibility) 与 [CHANGELOG](../CHANGELOG.md)。

> 说明：报告是**作者自测**结果，不是 dsh.so 的独立验证。dsh.so 的 L4/L5 由该站沙盒流水线单独执行。

---

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
| 1.9.0 | 0.2.0-rc.2 | CLI（web profile，装机核验 + 通知通道实机验证；用户实测截停通知与继续指令） | 通过 |
| 1.8.3 | 0.2.0-rc.2 | CLI（web profile，装机核验 12/12；npm 发布 2026-10-07） | 通过 |
| 1.8.2 | 0.2.0-rc.2 | CLI（web profile，装机核验 12/12；npm 发布 2026-10-06） | 通过 |
| 1.8.1 | 0.2.0-rc.2 | CLI（web profile，装机核验 12/12） | 通过 |
| 1.8.0 | 0.2.0-rc.2 | CLI（web profile） | 通过 |
| 1.8.0 | 0.2.0-rc.2 | 桌面版（Electron） | 通过 |
| 1.8.0 | 0.1.7-rc.2 | CLI（web profile） | 通过 |
| 1.6.3 / 1.8.0 | 0.1.7-rc.1 | CLI | 通过 |
| 1.3.1 / 1.3.0 | 0.1.7-rc.1 / 0.1.7-alpha.2 | CLI | 通过（dsh.so L5 记录） |
| 1.6.3 | 0.1.7-rc.2 | dsh.so 沙盒 | L5 运行验证通过 |
