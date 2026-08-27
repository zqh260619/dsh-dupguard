# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
