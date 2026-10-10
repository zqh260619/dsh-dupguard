# 向 awesome-dsh-plugin 投稿 duplicguard：步骤与 PR 正文

上游仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
规则来源：其 `CONTRIBUTING.md`（本目录的草稿文件 `awesome-dsh-plugin-entry.yml` 已按其要求写好）。

## 一、为什么现在就能投（前置条件已逐条核对）

| 上游要求 | 本仓库状态 | 证据 |
| --- | --- | --- |
| `package.json` 声明 `dsh.bundle` | ✅ | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| 仓库根目录有 `cordis.patch.yml` | ✅ | `insert: [{ id: dupguard, name: dsh-dupguard }]` |
| 仓库 ≥ 1 天、≥ 10 个提交 | ✅ | 创建于 2026-08-16，103+ 提交 |
| 仓库带 `dsh-plugin` topic | ✅ | GitHub topics 已含 `dsh-plugin` |
| 建议发布 npm（免 `allowBuilds`） | ✅ | `dsh-dupguard@1.9.1`，`repository` 指回本仓库 |
| 是否与既有条目重复 | ✅ 无重复 | 4481 条中最近者仅部分重叠：`GooDAnDReaDY/dsh-agent-loop-guard`、`173787247/dsh-repeat-stop`（均为**工具调用**层面）、`ethanwong-hk/dsh-thinking-guard`（仅**思考**） |
| 商店截图 | ✅ | `screenshots.json` + `screenshots/`（6 张） |

## 二、分支与目标分支（回答"一定要提交到 main 吗"）

**结论：PR 的"目标分支"必须是上游的 `main`（那是它的默认分支）；而你自己的改动放在哪个分支都行。**

- 上游 `default_branch = main`，且它的守卫逻辑以 main 为基准：
  - `pr-check.yml` 触发条件是 `on: pull_request:`（**没有分支过滤**）⇒ 无论你从哪个 head 分支提 PR，检查都会跑；
  - `pr-gate.yml` 是 `workflow_run` 后续汇总；文档化的失败原因里明确提到「PR 与 `main` 冲突则没有 merge ref」；
  - `build-site.yml` 在合并到 `main` 后才重建站点。
- 你的 head 分支：
  - **最省事**：直接在 fork 的 `main` 上 `Add file`（GitHub 网页新建文件时默认就提交到当前分支）；
  - **更规范**：先建一个分支（例如 `add-dupguard`）再提交 —— 好处是以后要跟进维护者的修改意见时，不会把提交堆在你 fork 的 main 上。
  - 上游**没有**对分支名的任何要求（规则只针对文件路径、键、描述）。
- ⚠️ **必须先同步 fork（关键，容易踩）**：`pr-check.yml` 里有一条 **stale-fork guard**——如果 PR 看起来"删掉了超过 2 个既有条目"就直接失败。而"fork 落后于上游 main"正好会造成这种假象（你的分支缺少上游新加的条目文件，diff 就显示为删除）。
  ⇒ 流程应为：Fork → **Sync fork / Update branch**（网页上 fork 首页那个按钮）→ 再建分支、加文件、提 PR。

## 三、操作步骤（用你自己的 GitHub 账号，约 3 分钟）

1. 打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> → 右上角 **Fork**（该仓库 `allow_forking=true`，可正常 fork）；
2. **在你 fork 的首页点 `Sync fork` → `Update branch`**（先追平上游 `main`，避免上面的 stale-fork 守卫误判）；
3. 在你 fork 上：**Add file → Create new file**（提交到 `main` 或你新建的分支都行）；
   - 文件名（必须一字不差）：`data/plugins/zqh260619__dsh-dupguard.yml`
   - 内容：复制本仓库 `docs/awesome-dsh-plugin-entry.yml` 里 **从 `url:` 开始** 的部分（上面的注释可留可删，留注释不影响解析）；
   - 提交信息建议：`Add dsh-dupguard: repetition guard for streamed output`；
4. 回到上游仓库页面 → **Compare & pull request**（或 Pull requests → New pull request）；
   - **base 选 `awesome-dsh-plugin/awesome-dsh-plugin: main`**，head 选你的分支；
5. 标题与正文用下面第四节的内容 → **Create pull request**；
   - 建议勾上 **Allow edits by maintainers**：描述里的小改动他们可以直接改，不必来回一轮；
6. 检查会自动跑：`PR check`（stale-fork 守卫 → 文件名/键/描述格式 → 与既有条目的重复检查 → README 与 `data/plugins` 一致性），随后 `pr-gate` 汇总并回帖结果。
   失败会指明改什么，**在同一分支继续 push 即可**，不必重开 PR；
7. 维护者会读仓库源码，逐句核对描述是否属实 → 合并 → 网站自动重建。

> 合并后：条目会出现在 `dev`（开发与运行时）分类下；如需调整分类，维护者会自行改，选中不准不会被打回。

## 四、PR 正文（三层结构，照做即可）

上游有 PR 模板（`.github/pull_request_template.md`，**本身就是中英双语**）。新建 PR 时 GitHub 会把它**自动预填**进正文，
所以正确形态是三层，**不要删掉第一层**：

1. **第一层：模板的双语自查清单**（自动预填）——把 6 条 `- [ ]` 改成 `- [x]`（我们逐条已满足，见第一节的核对表；
   下面"推荐但不强制"的三条不必勾，其中 npm 发布与 `screenshots.json` 我们已做，只有 `peerDependencies` 那条尚未做）；
2. **第二层：英文正文**（粘贴在清单之后，即下面这一段）；
3. **第三层：折叠的中文摘要**（放在最后，见下）。

> 为什么这样做：最近 15 个已合并 PR 里 **8 个纯英文、7 个含中文**——两种都被接受，**没有"必须附中文"的规定**；
> 但模板与整个仓库的文档都是双语的，附一个**折叠的中文摘要**（而不是把英文正文整篇翻译一遍）成本最低、收益最大：
> 维护者读英文正文，中文读者也能扫到要点，而正文长度不翻倍（正文已约 1.5k 字符，翻倍只会稀释重点）。

### 第二层：英文正文（可直接粘贴）

```markdown
Adds one entry: `data/plugins/zqh260619__dsh-dupguard.yml`

**What it does** — watches the DSH `llm/stream` waterfall and stops the stream when the same string repeats `threshold`
times in a row (default 10), then closes open blocks with a protocol-compliant `finish(stop)` so the partial answer is
still committed as a normal assistant message. Code regions (fenced / inline / indented) are judged at
`threshold × codeBlockMultiplier`; repeat counts can be given per unit length by a piecewise table or a JS module.
1.9.0 adds a stop notice (workspace, session name, repeated string) with a user-chosen continue instruction.

**Installability** — `dsh.bundle` in `package.json` plus a root `cordis.patch.yml`; published on npm as
`dsh-dupguard@1.9.1` with `repository` pointing back here.

**Verification in the repo** — `npm test` = 171 cases (core 106 / settings UI 45 / stop notice 20);
`npm run stress` = four stress suites including a real `dsh-llm` end-to-end check; `docs/compatibility-report.md`
records per-version evidence. CI runs `npm test` on Node 20/22/24 and the deterministic stress suites on every push,
and the publish workflow gates releases on the real-invariant check.

**Nearest entries are partial neighbours, not duplicates** — `GooDAnDReaDY/dsh-agent-loop-guard` and
`173787247/dsh-repeat-stop` guard repeated *tool calls*, `ethanwong-hk/dsh-thinking-guard` targets reasoning-only
turns. This entry is the streamed-text repetition guard: one tail-repeat detector covering visible output and
reasoning, with per-unit-length thresholds and code-region relaxation.

**Screenshots** — declared in `screenshots.json` (six images: stop notice, a subagent stopped mid-loop, the settings
groups, per-length table mode, ignore-list/notice settings, experimental-mode risk confirmation).
```

### 第三层：折叠的中文摘要（粘贴在英文正文之后）

```markdown
<details>
<summary>中文摘要</summary>

- **用途**：DSH 流式输出的实时复读守卫。同一字符串连续重复达到阈值（默认 10 次）即截停本次生成，
  并补发协议合规的 `block-end` + `finish(stop)`，已生成内容照常提交为助手消息，不丢消息、不污染会话日志。
- **覆盖范围**：可见输出与思考文本（`monitorReasoning`），围栏 / 行内 / 缩进三类代码区域统一按
  `阈值 × 倍数` 放宽；重复次数可按单元长度用分段表或 JS 模块（实验性）决定。
- **截停之后**：弹出全局通知（无论当前打开哪个会话），显示工作区、会话名称与重复的字符串，
  由用户选择是否发送继续指令；子代理 / Agent Teams 成员的复读同样被截停。
- **验证方式**：`npm test` 共 171 项（功能 106 / 设置页 45 / 截停通知 20），`npm run stress` 四套压力；
  CI 在 Node 20/22/24 跑测试与确定性压力；发布流水线以真实 `dsh-llm` 端到端 invariant 校验作为发布前门禁。
- **与既有条目的区别**：`dsh-agent-loop-guard`、`dsh-repeat-stop` 针对**工具调用**层面的重复，
  `dsh-thinking-guard` 只针对**思考**；本条目是**流式文本**的复读守卫，一个尾巴重复检测器同时覆盖可见输出与思考。

</details>
```

## 五、合并之后（可选后续）

1. 把 Awesome 徽章挂到本仓库 README（上游会提供准确片段）；
2. 若描述需要更新（例如以后改了默认阈值或能力范围），对同一 YAML 文件发一个小 PR 即可 —— 移动分类、修正描述同样欢迎。

## 六、唯一"推荐但尚未满足"的一条（可选）

上游模板的推荐项里，**官方 `@deepseek-ai/*` 包建议用 `peerDependencies`**：本仓库目前把
`@deepseek-ai/schemastery` 写在 `dependencies` 里。这不影响收录（模板标注为"推荐但不强制"），
若要改：移到 `peerDependencies` 时**同时**加进 `devDependencies`（CI 的 `npm ci` 与本地测试都需要它），
并注意 peer 版本范围若涉及预发布版本必须写显式 `||` 分支（否则会静默排除预发布版）。建议与下一次功能发版一起做。
