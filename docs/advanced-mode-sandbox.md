# 高级模式（module）的隔离测试环境

高级模式会**在 DSH 宿主进程内执行你指定的 JavaScript 文件**——该文件与宿主同权限：可读写文件、发起网络请求、
执行任意代码（设置页选中时会弹风险确认）。因此在把它填进**真实 profile** 之前，先在下面三层里逐级验证。

> 一句话结论：**把"文件本身对不对/安全不安全"交给第 1 层（沙箱试运行，不碰宿主）；把"整条链路通不通"交给第 2 层
> （独立 profile + 一次性工作区）；只有在你要跑来源不明的文件时才需要第 3 层（真隔离）。**

---

## 第 1 层：沙箱试运行（推荐起点，不启动 DSH、不花 token）

在**受限子进程**里加载候选模块，复用插件的真实加载与判次代码（`lib/index.js` 的 `__advanced`），
因此打印出来的"生效次数"与宿主将来真正采用的值**同源**。

```powershell
npm run sandbox:module -- tools/sandbox-modules/ok-piecewise.cjs          # 自己的模块换成路径即可
npm run sandbox:module -- D:\ZQH260619\repos\dupguard-advtest\repeat-count.cjs --lengths 1,2,3,21,1000
npm run sandbox:module -- <模块> --multiplier 3 --json                     # 代码区域倍数 / 机器可读
```

**隔离能力（本机 Node v24.19.0 实测）**

| 项目 | 结果 |
| --- | --- |
| 文件写入 | ✅ 拒绝（`ERR_ACCESS_DENIED`） |
| 子进程 | ✅ 拒绝（`ERR_ACCESS_DENIED`） |
| 文件读取 | ✅ 默认全拒；仅放行「模块所在目录 + 插件目录 + `--allow-read` 指定目录」 |
| 死循环 / 超大内存 | ✅ 墙钟超时（默认 5 s，`--timeout` 可调）+ 堆上限 256 MB，整个子进程被杀 |
| **网络请求** | ⚠️ **不受限**（Node 权限模型不覆盖网络）——需要连网络也封住时用第 3 层 |
| 自证 | 工具每次都会打印"受控子进程写文件被拒 ✓"，沙箱没生效时会明说 |

**判定规则**（与宿主一致）：返回值必须是 **2–1000 的整数**才算有效次数；整数 **< 2 表示显式关闭该长度**（合法写法）；
其余（字符串 / 小数 / 超上限）视为非法 ⇒ 该长度不判定。全部长度都不可用时，模块等于没起作用（工具判 `FAIL`）。

内置样例（`tools/sandbox-modules/`）可直接用来校准预期：

| 样例 | 期望结论 | 说明 |
| --- | --- | --- |
| `ok-piecewise.cjs` | PASS | 分段函数，覆盖全长度 |
| `ok-object.cjs` | PASS | `exports.repeatCount` 导出形态 |
| `trap-invalid.cjs` | WARN | 字符串 / 小数 / 超上限被识别为非法 |
| `trap-throw-on-load.cjs` | FAIL | 加载期抛错（宿主会告警并回退基础阈值） |
| `trap-runaway.cjs` | 被杀 | 死循环 ⇒ 墙钟超时 |
| `trap-hostile.cjs` | PASS + 拒绝证据 | 试图写文件 / 起子进程 / 读 `C:/Windows`，全部 `ERR_ACCESS_DENIED` |

```powershell
npm run sandbox:selftest      # 六个样例的预期结论一次性核对（CI 也会跑）
```

---

## 第 1.5 层：确定性的端到端（假模型，无凭据、零 token）

`tools/e2e-mock-repetition.mjs`（`npm run e2e:mock`）在本地起一个**极小的 Anthropic Messages-SSE 假模型**，
它按脚本吐任意重复文本；再让**真实适配器 + 真实 agent loop + 真实 `llm/stream` 瀑布**去消费它 ⇒ 截停是否发生
一目了然，而且**不需要 API key、不花 token、不受"模型愿不愿意复读"影响**（真实模型会拒绝复读指令）。

```powershell
npm run e2e:mock -- --profile headless --count 400 --unit ·     # 简单模式
npm run e2e:mock -- --profile headless --json                    # 机器可读结果
```

实测（2026-10-15，本机 Node 24）：

| 场景 | 假模型准备 | 真实流里看到 | 最终助手消息 | 检测到的策略 | 回合结束 |
| --- | --- | --- | --- | --- | --- |
| 简单模式（默认阈值 10） | 400 份 `·` | 20 份 | **10 份** | 固定阈值 10 | `completed`（退出码 0） |
| 高级模式（`repeat-count.cjs`：长度 1 → 20 次） | 400 份 `·` | 40 份 | **20 份** | `module` | `completed`（退出码 0） |

两行"最终消息"恰好等于两种策略规定的次数 ⇒ **截停由真实链路执行，且高级模式确实由模块决定次数**。
（切 module 模式时脚本会临时改写目标 profile 的 `cordis.patch.yml`，并在 `finally` 里**逐字节还原**。）

> 为什么不用官方的 `@deepseek-ai/dsh-llm-mock-server`：它只服务 OpenAI 的 `/chat/completions`，而本版 DSH 的
> DeepSeek 适配器走 **Anthropic Messages 协议**（`<base>/v1/messages`，且 `protocol` 不可配置）⇒ 实测直接 404。
> 该包已从 devDependencies 移除，避免留下用不上的依赖。

**注意**：这条链路需要本机有 `dsh` CLI 与一个装了插件的 profile（默认 `headless`），因此它是**本机工具**，不进 CI。

### 完全隔离运行（一键，推荐）

把上面这条链路放进**独立 `DSH_HOME`**，就是"完整的高级模式隔离测试"——真实 profile 的设置、会话、日志一概不碰：

```powershell
npm run e2e:isolated                                  # 默认 home: D:\ZQH260619\repos\dupguard-advtest-home
npm run e2e:isolated -- --dsh-home <path> --profile advtest
```

它依次跑三个用例（每个用例都由脚本临时把该 profile 切到高级模式，并在 `finally` 里**逐字节还原**）：

| 用例 | 模块 | 期望 | 实测（2026-10-15） |
| --- | --- | --- | --- |
| ① 模块生效 | `repeat-count.cjs`（长度 1 → 20 次） | 策略＝`module`，最终消息 20 份 | PASS：流 40 → 最终 **20**，模块生效 ✓ |
| ② 加载期抛错 | `trap-throw-on-load.cjs` | 打印「高级模式不可用」并回退基础阈值 10 | PASS：策略＝10，最终 **10** ✓ |
| ③ 导出非函数 | `trap-not-a-function.cjs` | 同上 | PASS：策略＝10，最终 **10** ✓ |

**隔离 home 的一次性运行能力怎么来的**：`@deepseek-ai/dsh-headless` 在 npm 上的 `latest` 是 `0.0.1-rc.1`，
与当前 `dsh 0.2.x` 不兼容（安装会被版本风险门拦住，需要显式接受风险）。**不需要**装它：
bundle 是从全局 DSH 安装解析的，只要把 `@deepseek-ai/dsh-headless` 写进该 profile 的
`dsh.profile.bundles` 就够了（`profiles/<name>/package.json`）。本环境的 `advtest`（独立 home）已如此配置。

**两个危险用例故意不在这套件里**：死循环模块会在真实宿主里卡死事件循环，越权模块在真实宿主里**真的会得手**
（与宿主同权限）。它们由第 1 层的沙箱工具覆盖（`npm run sandbox:selftest`，越权三连一律 `ERR_ACCESS_DENIED`）。

---

## 第 2 层：独立 profile + 一次性工作区（验证整条链路）

**已为你建好**：

| 对象 | 位置 | 说明 |
| --- | --- | --- |
| 隔离 profile（主 home） | `<DSH_HOME>\profiles\advtest` | 只装 `@deepseek-ai/dsh-base` + `dsh-dupguard`（repo 文件链接） |
| 该 profile 的配置 | `…\profiles\advtest\cordis.patch.yml` | **已预置为高级模式**，模块指向下面的样例文件 |
| 独立 home（更强隔离，可选） | `D:\ZQH260619\repos\dupguard-advtest-home\` | 自带 `profiles\advtest`（同样是高级模式配置），设置/会话/日志都不碰主 home |
| 一次性工作区 | `D:\ZQH260619\repos\dupguard-advtest\` | 内含 `repeat-count.cjs` 与 `README.txt`，整个目录可随时删掉 |
| 启动脚本 | `tools/run-advtest.ps1` | 在**干净环境**里启动（见下面的"必须清环境"） |

**为什么设置能按 profile 隔离**：设置就持久化在各 profile 自己的 `cordis.patch.yml` 里
（真实 `web` profile 里也能看到同样的 `- id: dupguard` + `config:` 片段）⇒ advtest 怎么改都不会碰到 `web` / `desktop`。

### ⚠️ 必须"清环境"启动（否则会读到别的 profile 的设置）

插件的「免重启读设置」**优先读 `$DSH_PROFILE_DIR` 下的 `cordis.patch.yml`**。如果你从一个**正在运行的 DSH 会话的终端**里
直接 `dsh --profile advtest`，会继承该会话的 `DSH_PROFILE_DIR` / `DSH_PROFILE` / `DSH_SESSION_ID` / `DSH_WEB_URL`，
于是**读到的是那个 profile 的设置**。这不是猜测，是实测（2026-10-14）：

| 启动方式 | 日志里的生效参数 |
| --- | --- |
| 继承 `DSH_PROFILE_DIR=…\profiles\web` 直接启动 | 阈值 777（本 profile 的 patch 生效）＋ **模式=table、白名单 9 项**（来自 web）✗ |
| 再加 `--patch` 覆盖层强制 `thresholdMode: module` | 仍然 **模式=table** ✗（覆盖层也压不过被读到的设置文件） |
| **清掉继承变量后启动** | **模式=module｜覆盖长度 1000 种｜次数区间 3–20｜最长跨度 3000 字符｜白名单 2 项** ✓（次数区间正是 `repeat-count.cjs` 的返回值 ⇒ 模块确实被真实宿主加载并驱动了策略） |

```powershell
# 推荐：用脚本启动（自动清掉继承变量；$null 传 stdin ⇒ TUI 启动后即退出，便于只看日志）
powershell -File tools\run-advtest.ps1                    # 主 home + advtest profile
powershell -File tools\run-advtest.ps1 -WhatIfOnly        # 只显示会清掉哪些变量
powershell -File tools\run-advtest.ps1 -DshHome D:\ZQH260619\repos\dupguard-advtest-home
```

- 想换模块：编辑对应 `cordis.patch.yml` 的 `advancedThresholdFile`（**只指向测试工作区里的文件**）；
- 想恢复默认：把该文件里的条目删掉，只留一个 `[]`；
- 想删掉整个隔离环境：删 `profiles\advtest`（主 home 的）与 `D:\ZQH260619\repos\dupguard-advtest`；
  若用了独立 home，再删 `D:\ZQH260619\repos\dupguard-advtest-home`。

**这一层不隔离什么**：advtest 与 `web` 共用同一个 `DSH_HOME` ⇒ 会话、凭据、部分 storages 仍然共享；
模块一旦被加载，仍然以你的用户权限运行。要连这些也隔开，用下面的独立 home（第 3 层已实测可用）。

> 想在 advtest 里用**图形化设置页**？需要给它装 web 应用 bundle：`dsh plugin --profile advtest add @deepseek-ai/dsh-web-app`
> —— 该版本会被 DSH 的版本风险门拦住，需要显式接受风险（`dsh plugin --profile advtest allow-version … --accept-risk`）。
> 测试高级模式其实用不上界面（配置写在 patch 文件里就够了），是否接受这个风险由你决定。

---

## 第 3 层：真隔离（来源不明的文件、或要连网络一起封）

| 手段 | 本机可用性 | 隔离到什么程度 |
| --- | --- | --- |
| **独立 `DSH_HOME`** | ✅ 支持（`$DSH_HOME/profiles`、`$DSH_HOME/cordis.patch.yml`、`$DSH_HOME/logs`） | 配置 / 会话 / storages / 日志全独立；⚠ 凭据不跟着走（需在该 home 里重新登录或放 `.credentials.yaml`），文件系统与网络仍与宿主同权限 |
| **WSL** | ✅ 已安装（`wsl.exe`） | Linux 侧独立文件系统与进程空间；⚠ 仍可通过 `/mnt/c` 访问 Windows 盘、仍可联网（可在 WSL 里加防火墙规则） |
| **Windows Sandbox** | ❓ 需管理员查询/启用（`Containers-DisposableClientVM`） | 一次性虚拟机，最强；⚠ 重启即丢弃，装 DSH 与登录都要重来 |
| Docker / Podman | ❌ 未安装 | —— |

独立 home 的最小用法（**不要**指向现有 `~/.dsh`）：

```powershell
$env:DSH_HOME = 'D:\ZQH260619\repos\dupguard-advtest-home'
dsh plugin --profile advtest add file:D:/ZQH260619/repos/DuplicationPrevention
dsh --profile advtest          # 首次启动会把 bundle 装进这个新 home
```

---

## 三条不变的事实（无论用哪层）

1. **沙箱只保护"测试阶段"**：一旦在真实 profile 里启用高级模式，该文件就以宿主权限运行——没有中间地带。
   所以：只指向你自己写或逐行读过的文件。
2. **模块路径不要指向仓库/生产目录**：用一次性工作区里的副本（本环境已如此），改坏了删掉即可。
3. **改完配置看一行日志确认生效**：`[dupguard] 生效参数：… 模式=module｜覆盖长度 N 种｜次数区间 …`；
   模块加载失败会打印「高级模式不可用（原因），回退基础阈值 N」——**没有这行就等于没生效**。
