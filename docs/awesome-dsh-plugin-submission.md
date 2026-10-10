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

## 四、PR 正文（可直接粘贴）

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

## 五、合并之后（可选后续）

1. 把 Awesome 徽章挂到本仓库 README（上游会提供准确片段）；
2. 若描述需要更新（例如以后改了默认阈值或能力范围），对同一 YAML 文件发一个小 PR 即可 —— 移动分类、修正描述同样欢迎。
