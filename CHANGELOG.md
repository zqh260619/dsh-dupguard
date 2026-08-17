# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
