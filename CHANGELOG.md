# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.1.3] - 2026-09-01

### Fixed

- 设置页白名单增删与持久化的完整修复：
  - **根因**：DSH 的 `SettingsScopeController` 以 `spec.decode(view.value)` 调用自定义
    decode，传入的是命名空间设置值本身（`{ignoredChars: [...]}`），而非 wire 视图；
    此前按视图解读导致永远回退默认白名单 `['-', '|']`，持久化值从不显示；
  - 写操作改为直连 settings RPC（models 页同款），界面提供保存中/已保存/失败原因反馈；
  - 列表本地自治，免疫镜像旧值回传导致的"闪现后回滚"；
  - 写成功后重新拉取镜像（`mirror.load()`），重开设置页即显示持久化的白名单；
  - 按钮显式 `type="button"` 防止默认提交行为。

## [1.1.2] - 2026-09-01

### Fixed

- 设置页「添加」按钮在亮/暗主题下的对比度问题：不再使用品牌主色做按钮背景，
  两个按钮统一为中性样式（次要表面色背景 + 主文字色），任何主题下文字都清晰可读。

## [1.1.1] - 2026-09-01

### Fixed

- 设置页「重复守卫」始终显示"加载中"的修复闭环：
  - host 端改为 DSH 宿主行约定的 `ctx.inject` 模式访问 root 服务（loader entry 的
    ctx 无法用 `ctx.get` 直接解析 `settings` / `cordisInspect`，此前两个服务均不可见，
    命名空间从未注册）；
  - 客户端 decode 兜底：wire 视图任何形状异常都回退默认白名单，保证视图到达即 ready；
  - 加载态补充镜像状态与错误详情，并区分远程访问与命名空间缺失提示。

## [1.1.0] - 2026-08-30

### Added

- 图形化设置页（npm 常驻版）：新增 `lib/client.js`（`dsh.client` 浏览器端入口），在 DSH
  设置面板注册与「通用设置 / 模型 / 插件 / Agent 预设」并列的「重复守卫」分节，可视化
  编辑白名单（增删字符、恢复默认），样式使用 `--dsw-*` 主题变量与原有设置页一致；
- 设置持久化与热更新：host 端通过 settings 服务注册 `dsh-dupguard` 命名空间
  （`ignoredChars` 字段，schemastery schema，新增 `@deepseek-ai/schemastery` 依赖），
  设置变更即时热生效（动态版保持零依赖，白名单固定取常量）；
- 测试新增 settings 集成套件（默认 base、热更新、清空、恢复默认），共 48 项。

## [1.0.3] - 2026-08-30

### Fixed

- 思考（reasoning）复读守卫：`monitorReasoning` 默认改为开启，思考中同一字符串连续重复
  10 次以上即截停；修复开启后暴露的 reasoning 文本双重累积缺陷（`b.text` 与 `feedText`
  各加一次，导致闭合块文本翻倍）；新增"关闭开关"变体套件验证 `monitorReasoning: false`
  时仍全量透传。测试套件双入口各 21 项，加变体共 44 项。

## [1.0.2] - 2026-08-27

### Fixed

- 修复 Markdown 表格误截停：新增 `ignoredChars` 白名单（默认 `['-', '|']`），
  表格分隔行（如 `|---|---|`）与长分隔线不再被误判为复读；夹带白名单字符的真实复读
  （如 `-ab-` ×10）仍会被识别。测试套件新增 4 项，双入口各 20 项。

### Changed

- 验证与 DSH `0.1.1-rc.1` 兼容：`llm/stream` 事件签名、`StreamChunk` 协议、适配器关闭语义
  （`consumer.abort`）、`llm-invariant` 校验、`BlockAssembler`、agent-loop 流消费、
  `CordisInspectRegistryService`（`providers` 字段与 `register` 语义）均无变化，插件无需改动；
  `dsh-agent-presets` 的 standing-mount 多代并存缺陷 `0.1.1-rc.1` 仍未修复，兼容补丁
  （`fixStandingMountConflict`）仍然必要（文档表述更新为"≤ 0.1.1-rc.1"）。
- 验证与 DSH `0.1.0-rc.7` 兼容：`llm/stream` 事件签名、`StreamChunk` 协议、适配器关闭语义
  （`consumer.abort`）、`llm-invariant` 校验、`BlockAssembler`、agent-loop 流消费、
  `CordisInspectRegistryService`（`providers` 字段与 `register` 语义）均与 rc.6 一致，
  插件无需改动；`dsh-agent-presets` 的 standing-mount 多代并存缺陷 rc.7 仍未修复，
  兼容补丁（`fixStandingMountConflict`）仍然必要（文档表述由"≤ rc.6"更新为"≤ rc.7"）。

## [1.0.1] - 2026-08-17

### Added

- DSH ≤ rc.6 兼容补丁（`fixStandingMountConflict`，默认开启）：幂等化 `cordisInspect.register`，
  修复 preset standing-mount 多代并存导致的 "Host Cordis inspect provider ... is already registered"
  （截停后模型操作报 resume failed、必须重启 DSH 才能恢复）问题。
- 测试套件新增第 16 项（幂等补丁行为），双入口各 16 项。

## [1.0.0] - 2026-08-16

### Added

- 首次发布：实时检测流式输出中的连续重复（默认同一字符串 ≥10 次）并立即停止生成。
- 双入口交付：`plugin/host.js`（动态插件）与 `lib/index.js`（npm/组合常驻），行为一致、同一测试套件防漂移。
- 端到端测试（15 项 × 2 入口）与 GitHub Actions CI（Node 18/20/22）。
