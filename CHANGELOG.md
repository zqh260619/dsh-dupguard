# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.6.3] - 2026-09-24

### Fixed

- **写入成功却被判为「保存失败」**：`remote.settings.mutate()` 返回的命名空间视图是**写入前**的快照
  （配置由 loader 异步重载后才更新），此前的实现拿它与本地期望值做回读比对，于是每次写入都
  必然不一致——面板报错、看起来「没保存」，而宿主其实已经落盘。现改为**只以宿主应答为准**
  （`response.ok === false` 才算失败），与官方 `ConfigForm.mutate` 的语义一致；恢复默认同样按
  「全部 unset 是否未被拒绝」判定。

### Added

- 设置页底部常驻诊断行 `设置通道：<状态>｜<诊断>｜构建 <标记>`，并在写入失败时附带宿主原始原因
  与构建标记；浏览器控制台同步打印 `[dupguard] mutate → …` / `mutate 被拒…`，用于快速区分
  「宿主拒绝」「通道未就绪」「回读不一致」三类问题。

## [1.6.2] - 2026-09-24

### Fixed

- **插件 Config 的全部字段标记为 volatile（设置页拿不到命名空间的真正根因）**：
  `dsh-settings` 的 `volatileForm()` 只投影 `meta.volatile` 为真的字段，一个 entry 若没有任何
  volatile 字段，其表单为空、`describe()` 会**整个跳过**它——正是宿主日志显示已走 Config 模型、
  Config 目录也有 `status: schema`，但 `describe()` 返回的 16 个命名空间里没有本插件的原因。
  另外只有 volatile 字段才会被 `resolveConfig` 包装成带 `get()` 的响应式单元格，本插件实时
  读取参数正依赖这一点。schemastery ≥ 3.18.4 的 `schema.volatile()` 内部即 `extra('volatile', true)`；
  本插件自带副本可能更旧（无该方法），实现里已按 `volatile()` → `extra()` → 直写 `meta` 退化。
- **命名空间匹配覆盖组合前缀**：0.1.7 的 entry id 实为 `include:dupguard`（bundle 插入的行 id 是
  `dupguard`，组合层会加 `include:` 前缀），而设置命名空间取自 entry id。此前只匹配
  `dsh-dupguard` / `dupguard` 两个精确名；现按 精确名 → 名称包含 `dupguard` → 字段签名 三级匹配。

### Added

- **面板级通道诊断**：不可用态也显示 `设置通道：<状态>｜<诊断>`，诊断内容包含
  `describe 返回 N 个命名空间 [ns…]` 或 `describe 未成功`；浏览器控制台同步打印
  `[dupguard] remote.settings.describe 返回命名空间：…`，便于一次截图定位问题环节。

## [1.6.1] - 2026-09-24

### Fixed

- **0.1.7 上设置页停在「加载中」**：动态注入必须**同时声明父服务与点号服务**
  （`ctx.inject(['remote', 'remote.settings'], …)`）。只声明 `'remote.settings'` 时，
  cordis 的注入作用域里没有 `scope.remote`（父服务未声明），1.6.0 的回调因此静默返回、
  既未接入通道也未发布状态，面板永远停在 loading/idle。

### Added

- 设置通道探测改为多路兜底：注入回调（父+点号）→ 服务面多形态解析
  （`scope.remote.settings` / `scope['remote.settings']`）→ `ctx.get('remote.settings')`
  有界轮询（400ms × 40）；旧版 `settingsScope` 接上后立即停止新版探测。
- 面板加载态显示通道诊断（`设置通道：<状态>｜<诊断>`）并在浏览器控制台打印
  `[dupguard] client apply：…`，下次若再异常可直接从截图/控制台定位。

## [1.6.0] - 2026-09-24

### Added

- **DSH 0.1.7-rc.1 支持**（0.1.7 移除了客户端 `settingsScope` 与 `ctx.settings.register`）：
  - 宿主导出插件 `Config`：0.1.7 起设置命名空间由 loader entry 决定（本 bundle 插入的行 →
    `dupguard`），用户层写入后 loader 实时把新 `config` 下发给 `apply(ctx, config)`；
  - 宿主在 ≥ 0.1.7 上调用 `settings.configure({ auto: false })`，避免与自定义设置页重复出现两个页面；
  - 客户端改用 typert remote 通道：`ctx.remote.settings.describe()` / `mutate(ns, ops, revision)`，
    并兼容 `mutate` 直接返回命名空间行（与 `describe` 的 `{ writable, namespaces }` 形状不同）；
  - 命名空间解析顺序：`dsh-dupguard`（旧注册名）→ `dupguard`（bundle 行 id）→ 字段签名兜底。

### Fixed

- **0.1.7 下客户端入口永久 pending**（页面报 `web boot: 1 entry did not activate`，诊断为
  `waiting for service: settingsScope`）：静态 `inject` 收敛为各版本都存在的 `slots` / `locale`，
  设置服务改用 `ctx.inject(...)` 动态接入；任一服务缺席时插件照常激活，仅设置页显示「设置服务不可用」。
- 设置页的本机/远程判断改为实时读取（`remote.$host.isLoopback` 与 `describe().writable`），
  不再停留在注册时的快照值。
- 参数每次模型调用重算时的重复告警去重（无效白名单条目、窗口偏小各只告警一次）。

## [1.5.0] - 2026-09-24

### Added

- **代码块内三档处理**：`codeBlockMultiplier` 现在同时承担「模式选择」——
  - `≥2`（默认 `3`）：块内按「阈值 × 倍数」判定（1.4.0 的放宽行为）；
  - `1`：块内与块外同样严格；
  - `0`：**完全不检测代码块内**——块内内容不参与重复统计，生成的代码再长也不会被截停；
    进入/离开代码块时清空检测缓冲，围栏两侧的重复不会被拼成一次命中。
  取值范围由 1–100 放宽到 **0–100**；`skipCodeBlocks=false` 仍可整体关闭该机制。

### Changed

- 窗口缺口提示与宿主告警在倍数为 `0` 时不再放大要求（块内完全不检测，窗口只需满足
  `阈值 × 最大单元长度`），设置页提示文本与 README 同步说明三档语义。

## [1.4.0] - 2026-09-23

### Added

- **围栏代码块内放宽检测**（`skipCodeBlocks` 默认开启 + `codeBlockMultiplier` 默认 `3`，均可在设置页调整）：
  代码块内的重复串（生成的测试夹具、表格、ASCII 图、内嵌数据）改用「阈值 × 倍数」判定，
  不再被误判为复读；块内的失控复读仍会被兜住（默认连续 30 次即截停）。倍数范围 1–100，
  设为 1 等价于不放宽；关闭开关则块内与块外同样严格；
- 围栏识别按 CommonMark：起始行为行首 ≤3 个空格 + 连续 ≥3 个 `` ` `` 或 `~`（其后为 info string），
  结束行需同字符且不短于起始长度、其后仅空白；未闭合围栏延续到该块结束；
  围栏标记被切进多个增量（如 `"``"` + ``"`js"``）时仍能识别；行内代码与缩进代码块不受影响；
- 截停日志新增 `code-block=true（放宽阈值命中）` 标记，便于区分命中来源。

### Changed

- 窗口缺口提示与宿主告警改为按「阈值 × 代码块倍数 × 最大单元长度」计算（关闭放宽时倍数按 1 计），
  设置页提示文本同步显示倍数。

### Fixed

- 长围栏不再被短围栏提前关闭：围栏长度取起始行的**完整** run，```` ```` ```` 开启的代码块不会被
  内部的 ``` 行关闭（此前一见 3 个反引号就进入并记长度为 3）。

## [1.3.1] - 2026-09-05

### Fixed

- **白名单按「单个字符」匹配的语义两端不一致**：设置页会把整串输入（如 `ab`）当成一个条目，
  而检测按单个字符比对，该条目永远不会生效。现在设置页把一次输入拆成单个字符逐个加入
  （忽略其中的空白），宿主对存量或手改的多字符、空、非字符串条目在运行时丢弃并打印告警；
  白名单比对同时改为按 Unicode 码点进行，emoji 等代理对字符可作为单个条目正常生效。
- **未改动的数值输入在失焦时也会写入**，把默认值写进用户层（`settings.yaml` 里因此出现
  `threshold: 10`、`maxUnitLength: 80`、`detectionWindow: 8192` 这类无意义条目）。现在值与
  宿主一致时跳过写入。
- **跨字段约束只在「最大单元」一行提示**：从「最小单元」一侧提交违规值时只能拿到宿主拒绝后的
  泛化「保存失败」。现在两行都给出具体错误并在本地拦截写入。
- 截停收尾遇到未知块类型（协议新增 `ContentBlock` 类型）时会静默按 tool-call 兜底，
  现补充一次性宿主告警，便于定位协议漂移。

## [1.3.0] - 2026-09-05

### Added

- 全部检测参数可在设置页动态调整（此前仅白名单可改）：`threshold`、`minUnitLength`、
  `maxUnitLength`、`detectionWindow`、`stripWhitespace`、`monitorReasoning`、
  `monitorToolArguments` 均注册进 `dsh-dupguard` 设置 schema（含上下界与非整数拒绝），
  改动即时热生效并持久化到 `settings.yaml`；
- 设置页参数表单：数值输入（失焦或回车提交、范围与整数校验、跨字段校验）与原生风格开关，
  写入仍走 `settingsScope` 控制器并回读快照校验；
- **窗口缺口提示**：`detectionWindow < threshold × maxUnitLength` 时，设置页显示
  「⚠ 检测窗口长度需要提高：至少 N（当前 M = 阈值 × 最大单元），超过 K 字符的重复单元无法识别」，
  宿主日志同时打印一条同义告警（只提示不拒绝写入）；
- 「恢复默认」改为清空本页全部用户设置（逐字段 unset），回到代码默认值。

### Changed

- 宿主 `settings.register` 增加 `validate` 跨字段约束（最大单元长度不得小于最小单元长度），
  违规写入被拒绝而非静默存入；
- 运行时设置同步改为逐字段归一化（类型/范围兜底，绝不抛错），非法外部编辑回落到代码默认值；
- 客户端组件改为全部 hook 前置，消除「加载中 → 就绪」状态切换时的 hook 数量变化风险。

## [1.2.1] - 2026-09-02

### Fixed

- 设置页写入在 DSH 0.1.2 上完全失效：0.1.2 的客户端 `connection` 服务不再暴露
  `api`（wire 面改为 `ctx.remote.<namespace>`），此前的直连 RPC 写法在 0.1.2 上
  同步抛错——表现为点击「添加」后列表乐观更新、底部停在「保存中…」，写入从未落盘、
  关闭重开不显示、白名单也不生效。现改为经 `settingsScope` 控制器写
  （`set` / `unset`：自动携带最新 revision、串行化并发写、把宿主应答折叠回共享镜像），
  写完回读快照校验后显示「已保存」或失败原因；该控制器接口在 0.1.1 与 0.1.2 一致，
  因此同时兼容两版。

### Added

- `tests/client.test.js`：用最小 React / DSH 客户端桩直接驱动设置页组件，覆盖写路径
  （控制器 `set`/`unset`）、「保存中…→已保存」回显、重开显示持久化白名单，并断言组件
  不再依赖 `connection.api`；`npm test` 与 CI 改为同时运行两个测试文件。

## [1.2.0] - 2026-09-02

### Added

- 适配 DSH 0.1.2 的 bundle 约定：本包自带补丁层 `cordis.patch.yml` 并声明
  `dsh.bundle.patch`，安装只需一条命令 `dsh plugin --profile web add dsh-dupguard`
  （`dsh plugin` 会自动把声明了 `dsh.bundle` 的依赖加入 `dsh.profile.bundles`，
  DSH 按层应用补丁插入宿主行 `{ id: dupguard, name: dsh-dupguard }`，无需手改 YAML）；
- package.json 增加 `dsh.compatibility`（`dsh >= 0.1.1-rc.1`）。

### Changed

- 与 DSH 0.1.2-rc.1 逐项核对：`llm/stream` 瀑布事件与 `StreamChunk` 协议、`settings.register`
  （`base` 选项）、客户端 `settingsScope.bind` / `decode(view.value)` / `describe`、
  `settings.section` 槽位契约、`--dsw-*` 主题变量均未变化，插件行为无需改动；
- standing-mount 缺陷在 0.1.2-rc.1 仍未修复（上游保留 reclaim 代际的 TODO），
  兼容补丁继续默认开启；
- README 安装章节改为以 bundle 方式为主、手工补丁层为辅，并说明两者不可同时使用
  （重复 entry id 会抛 `duplicate loader entry id: dupguard`）。

## [1.1.5] - 2026-09-02

### Changed

- 明确不支持 Node 18（与 DSH 一致）：`engines` 提升为 `>=20`，CI 矩阵调整为
  Node 20/22/24，README 同步说明。

## [1.1.4] - 2026-09-02

### Fixed

- Node 18 兼容性：不再顶层 `require('@deepseek-ai/schemastery')`（其 CJS shim 内部
  require 纯 ESM 的 cosmokit，Node < 20.19 抛 `ERR_REQUIRE_ESM`，导致插件整体无法加载），
  改为设置注册时惰性动态 `import`（ESM 入口在 Node 18 可用，且与 DSH 共享同一模块实例）；
  对应 CI 的 Node 18 测试恢复通过。

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
