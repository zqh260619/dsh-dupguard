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

## 二、操作步骤（用你自己的 GitHub 账号，约 3 分钟）

1. 打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> → 右上角 **Fork**；
2. 在你 fork 的 `main` 上：**Add file → Create new file**；
   - 文件名（必须一字不差）：`data/plugins/zqh260619__dsh-dupguard.yml`
   - 内容：复制本仓库 `docs/awesome-dsh-plugin-entry.yml` 里 **从 `url:` 开始** 的部分（上面的注释可留可删，留注释不影响解析）；
   - 提交信息建议：`Add dsh-dupguard: repetition guard for streamed output`；
3. 回到上游仓库页面 → **Compare & pull request**（或 Pull requests → New pull request）；
4. 标题与正文用下面第三节的内容 → **Create pull request**；
5. CI 会自动跑：条目数 ≤ 3 → 你仓库的 `dsh.bundle` → 仓库年龄 → `awesome-lint` + 站点构建。
   失败会指明改什么，**在同一分支继续 push 即可**，不必重开 PR；
6. 维护者会读仓库源码，逐句核对描述是否属实 → 合并 → 网站自动重建。

> 合并后：条目会出现在 `dev`（开发与运行时）分类下；如需调整分类，维护者会自行改，选中不准不会被打回。

## 三、PR 正文（可直接粘贴）

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

## 四、合并之后（可选后续）

1. 把 Awesome 徽章挂到本仓库 README（上游会提供准确片段）；
2. 若描述需要更新（例如以后改了默认阈值或能力范围），对同一 YAML 文件发一个小 PR 即可 —— 移动分类、修正描述同样欢迎。
