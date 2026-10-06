/**
 * dupguard 浏览器端 bundle（单文件，经 window.__ModuleLoader__ 加载）。
 *
 * 在 DSH 设置面板注册一个与「通用设置 / 模型 / 插件 / Agent 预设」并列的
 * 分节「重复守卫」：白名单（检测时忽略的字符）与全部检测参数的可视化编辑界面。
 *
 * 设置通道随 DSH 版本演进，本文件两条都支持（运行时自动选路）：
 *   - DSH ≥ 0.1.7：typert remote 机制，ctx.remote.settings.describe()/mutate(ns, ops, rev)，
 *     命名空间由 loader entry id 决定（本项目为 dupguard）；
 *   - DSH ≤ 0.1.6：ctx.settingsScope.bind({ namespace, decode }) 控制器。
 * 关键点：静态 inject 在 cordis 里没有「可选依赖」（Inject.resolve 把数组/映射全部
 * 视为必需），声明了某个版本不存在的服务会让整个客户端入口永久 pending
 * （表现为 "web boot: 1 entry did not activate / waiting for service"）。
 * 因此静态只依赖各版本都有的 slots/locale，设置服务用 ctx.inject(...) 动态接入；
 * 两者都缺席时插件照常激活，设置页显示「设置服务不可用」。
 *
 * 样式全部使用 --dsw-* 主题变量，跟随全局亮/暗主题，与原有设置页风格一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dupguard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const NS = 'dsh-dupguard'
    /** 构建标记：显示在设置页底部，用于判断浏览器实际加载的是哪一版（排查缓存/旧包问题）。 */
    const BUILD_MARK = '1.8.2'
    /** 旧版（≤ 0.1.6）register 出来的命名空间名。 */
    const SETTINGS_NS = 'dsh-dupguard'
    /** 新版（≥ 0.1.7）命名空间取自 loader entry id：本 bundle 插入的行 id 为 dupguard。 */
    const SETTINGS_NS_CANDIDATES = ['dsh-dupguard', 'dupguard']
    /** 命名空间兜底识别：值对象同时含这些字段即认为是本插件的命名空间。 */
    const SETTINGS_NS_SIGNATURE = ['threshold', 'codeBlockMultiplier', 'stripWhitespace', 'monitorReasoning']

    const zh = {
      nav: '重复守卫',
      title: '重复输出守卫',
      intro: '模型输出中同一字符串连续重复达到阈值次数时自动截停。以下参数修改后即时生效并持久化（settings.yaml）。',
      list: '忽略白名单（单个字符 / 多字符片段）',
      empty: '白名单为空：所有字符都参与重复统计。',
      addPlaceholder: '输入字符或片段（多个用空格 / 逗号分隔）',
      add: '添加',
      whitelistHint: '填单个字符（如 - | ·）或整段片段（如 |---|、<br>）都可以，**自动分类**：1 个码点且非空白 ⇒ 字符白名单（默认的 - | 就是），其余 ⇒ 片段白名单。对单个字符两者完全等价，所以不必纠结放哪边。多个条目用空格或逗号分隔（`- |` 会加两条，`-|` 会当成一个片段）。片段为整段字面量匹配（区分大小写、不支持正则），命中时先整段剔除再做去空白与逐字符剔除，长片段优先；每项 ≤ {maxLen} 码点、最多 {maxCount} 项，且每块保留（最长片段 − 1）个字符不参与检测（即检测延迟这么多字符）。空白字符无法在此输入：单字符空白只在关闭「忽略空白字符」时才有意义，需要时请直接改配置文件。',
      errSubstringEmpty: '请输入非空的字符或片段。',
      errSubstringTooLong: '片段过长：每项最多 {maxLen} 个码点。',
      errSubstringDuplicate: '该条目已在白名单中。',
      errSubstringLimit: '片段条目数量已达上限（{maxCount} 项）。',
      advanced: '高级重复设置（按单元长度决定次数）',
      thresholdMode: '模式',
      modeSimple: '简单模式（固定阈值）',
      modeTable: '分段表模式',
      modeModule: '高级模式（实验性）',
      thresholdModeHint: '简单模式用下方「触发阈值」；分段表按长度区间给不同次数；**高级模式（实验性）**会执行你指定的 JavaScript 文件（仅 npm 常驻版支持），选中时会弹出安全确认。',
      riskTitle: '确认启用高级模式（实验性）？',
      riskDescription: '高级模式会在 DSH 宿主进程内执行你指定的 JavaScript 文件：该文件与 DSH 同权限，可读写文件、发起网络请求或执行任意代码。请只使用你完全信任的来源——插件无法校验文件内容。此功能仍属实验性，接口与行为可能变化。',
      riskAcknowledge: '我已了解风险，并愿意继续',
      riskCancel: '取消',
      riskConfirm: '启用高级模式',
      experimentalBadge: '实验性',
      thresholdByLength: '分段表',
      thresholdByLengthHint: '格式「最大长度:次数」逗号分隔，可用「*:次数」兜底。例：1:40, 2:30, 8:12, *:10 —— 长度 ≤1 的单元需重复 40 次、≤2 需 30 次、其余 10 次。',
      advancedThresholdFile: '模块文件路径',
      advancedThresholdFileHint: '导出 repeatCount(length) -> count 的 JavaScript 文件（.js/.cjs 最稳妥；.mjs 依赖运行时的 require(ESM) 支持，Node ≥ 20.19 / ≥ 22.12 已内置；其它扩展名 Node 也按 CommonJS 加载；.json 不能导出函数）。⚠ 该文件会在 DSH 宿主进程中执行，请只指向自己信任的文件；加载结果会打印在宿主启动日志的「生效参数」行。',
      colStart: '起始',
      colEnd: '终止',
      colCount: '次数',
      colActions: '操作',
      addRow: '添加一行',
      tableHint: '起始值自动推导（首行 1，其后 = 上一行终止 + 1）；末行「终止」= 最大检测长度。最多 {max} 行。',
      tableMaxUnitHint: '分段表模式下最大重复单元长度由末行的「终止」值决定，无需单独填写。',
      errRowEndOrder: '终止值必须 ≥ 本行起始值（上一行终止 + 1）。',
      errRowOrder: '终止值必须小于下一行的终止值（分段需递增且不重叠）。',
      errRowEndRange: '终止值不能超过 {max}。',
      errRowCount: '次数需为 2–1000 的整数。',
      thresholdFallbackHint: '「触发阈值」仅在简单模式可编辑；当前模式下它只作兜底（分段表未覆盖且无 *、或模块不可用时），当前值 {threshold}。',
      derivedDiag: '自动派生：检测窗口 {window}',
      derivedDiagTable: '自动派生：检测窗口 {window} · 最大重复单元长度 {maxUnit}（末行决定）',
      errThresholdFile: '请填写模块文件路径（留空表示不启用模块）。',
      params: '检测参数',
      threshold: '触发阈值（连续重复次数）',
      thresholdHint: '同一字符串连续重复达到该次数即截停（≥ 语义）。范围 {min}–{max}。',
      minUnitLength: '最小重复单元长度',
      minUnitLengthHint: '参与检测的重复单元最小字符数。范围 {min}–{max}；设为 1 可捕获单字符循环。',
      maxUnitLength: '最大重复单元长度',
      maxUnitLengthHint: '可识别的最长重复单元（清洗后字符数，空白与白名单字符不计）。范围 {min}–{max}。',
      codeBlockMultiplier: '代码内阈值倍数（围栏 / 行内 / 缩进）',
      codeBlockMultiplierHint: '三类代码区域**统一判定**，都用「阈值 × 本倍数」：围栏代码块（``` / ~~~）、行内代码（`x`，须在同一行内闭合）、缩进代码块（行首 4 空格且前有空行）。三档：≥2 = 按倍数放宽（默认 3，避免误杀正常代码、测试夹具、表格、ASCII 图）；**1 = 关闭分档**（与区域外同样严格）；0 = 完全不检测区域内（代码再长也不会被截停）。范围 {min}–{max}。列表项 / 引用之后的缩进与段落续行不算代码区域；未闭合的反引号按普通文本判定（最多保留 256 字符）。',
      legacySkipCodeBlocksHint: '当前配置里关闭了代码分档（skipCodeBlocks=false，等价于倍数 1）；修改上面的倍数即自动接管并清除该旧键。',
      stripWhitespace: '忽略空白字符',
      stripWhitespaceHint: '检测前移除所有空白（含换行），使「重复 重复」「重复\\n重复」这类带分隔的复读也能识别。',
      monitorReasoning: '检测思考内容（reasoning）',
      monitorReasoningHint: '思考中的复读同样消耗 token，默认一并检测。',
      monitorToolArguments: '检测工具调用参数',
      monitorToolArgumentsHint: '默认关闭：JSON / base64 参数中重复字符很常见。',
      reset: '恢复默认',
      note: '「恢复默认」清空本页全部用户设置，回到代码默认值。',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败：宿主未接受该值，请检查取值或查看 DSH 宿主日志。',
      errInteger: '请输入整数。',
      errRange: '取值范围 {min}–{max}。',
      errCross: '不能小于最小重复单元长度（当前 {min}）。',
      errCrossMin: '不能大于最大重复单元长度（当前 {max}）。',
      windowWarn: '⚠ 自动窗口需要 {need} 字符，已达上限 {current}（阈值 {threshold} × 代码块倍数 {multiplier} × 最大单元 {maxUnit}）。超过 {effective} 字符的重复单元无法识别——请降低阈值 / 代码块倍数 / 最大单元长度（或策略跨度）。',
      loading: '加载中…',
      loadingDiag: '设置通道：{state}｜{diag}',
      remoteHint: '设置修改仅支持本机连接：请通过本机地址（127.0.0.1）打开 DSH 页面后重试。远程访问、或当前 DSH 版本禁用了设置写入时，检测参数将按宿主当前配置运行。',
      unavailable: '设置服务不可用：未读取到「重复守卫」的设置数据。请确认插件已挂载（宿主日志应含「[dupguard] 常驻插件 apply 开始」）且该版本提供设置通道（DSH ≥ 0.1.7 需插件导出 Config），然后刷新页面重试。',
    }
    const en = {
      nav: 'Dupguard',
      title: 'Repetition Guard',
      intro: 'Generation stops when the same string repeats consecutively up to the threshold. Changes below take effect immediately and persist to settings.yaml.',
      list: 'Ignore-list (single characters / multi-character substrings)',
      empty: 'The ignore-list is empty: every character counts.',
      addPlaceholder: 'Characters or substrings (separate with spaces / commas)',
      add: 'Add',
      whitelistHint: 'Enter single characters (like - | ·) or whole substrings (like |---|, <br>) — they are **classified automatically**: one non-whitespace code point goes to the character list (the default - | lives there), anything else goes to the substring list. For single characters the two are exactly equivalent, so it does not matter which side you pick. Separate several entries with spaces or commas (`- |` adds two, `-|` becomes one substring). Substrings are literal (case-sensitive, no regex), stripped first and longest-first, then whitespace and per-character rules apply; each entry ≤ {maxLen} code points, at most {maxCount} entries, and up to (longest entry − 1) characters per block are held back from detection (that much detection delay). Whitespace cannot be entered here: a single whitespace entry only matters while "Ignore whitespace" is off — edit the config file instead.',
      errSubstringEmpty: 'Enter a non-empty character or substring.',
      errSubstringTooLong: 'Entry too long: at most {maxLen} code points each.',
      errSubstringDuplicate: 'That entry is already in the ignore-list.',
      errSubstringLimit: 'Substring limit reached ({maxCount} entries).',
      advanced: 'Advanced repetition settings (per-length counts)',
      thresholdMode: 'Mode',
      modeSimple: 'Simple (fixed threshold)',
      modeTable: 'Piecewise table',
      modeModule: 'Advanced mode (experimental)',
      thresholdModeHint: 'Simple uses the threshold below; the table maps length ranges to counts; **advanced mode (experimental)** runs a JavaScript file you point at (npm build only) and asks for a security confirmation when selected.',
      riskTitle: 'Enable advanced mode (experimental)?',
      riskDescription: 'Advanced mode executes the JavaScript file you specify inside the DSH host process: that file has the same privileges as DSH and can read or write files, make network requests, or run arbitrary code. Only use a source you fully trust — the plugin cannot verify the file. This feature is still experimental and its interface or behaviour may change.',
      riskAcknowledge: 'I understand the risks and want to continue',
      riskCancel: 'Cancel',
      riskConfirm: 'Enable advanced mode',
      experimentalBadge: 'experimental',
      thresholdByLength: 'Piecewise table',
      thresholdByLengthHint: 'Entries "<maxLength>:<count>" comma-separated, optional "*:<count>" fallback. Example: 1:40, 2:30, 8:12, *:10 — units of length <=1 need 40 repeats, <=2 need 30, the rest 10.',
      advancedThresholdFile: 'Module file path',
      advancedThresholdFileHint: 'A JavaScript file exporting repeatCount(length) -> count (.js/.cjs are safest; .mjs needs Node >=22; other extensions are still loaded as CommonJS by Node; .json cannot export a function). ⚠ It runs inside the DSH host process — point it only at a file you trust; the load result is logged in the host "effective parameters" line.',
      colStart: 'From',
      colEnd: 'To',
      colCount: 'Repeats',
      colActions: '',
      addRow: 'Add row',
      tableHint: 'The "From" column is derived (first row 1, then previous "To" + 1); the last row\'s "To" is the maximum detected length. At most {max} rows.',
      tableMaxUnitHint: 'In table mode the maximum repeating-unit length comes from the last row\'s "To" — no separate field.',
      errRowEndOrder: '"To" must be >= this row\'s start (previous "To" + 1).',
      errRowOrder: '"To" must be smaller than the next row\'s "To" (ranges must increase and not overlap).',
      errRowEndRange: '"To" must not exceed {max}.',
      errRowCount: 'Repeats must be an integer between 2 and 1000.',
      thresholdFallbackHint: 'The base threshold is editable in simple mode only; in this mode it is just the fallback (uncovered lengths without "*", or when the module is unavailable). Current value: {threshold}.',
      derivedDiag: 'derived: window {window}',
      derivedDiagTable: 'derived: window {window} · max unit length {maxUnit} (from last row)',
      errThresholdFile: 'Enter the module file path (empty means the module is disabled).',
      params: 'Detection parameters',
      threshold: 'Threshold (consecutive repeats)',
      thresholdHint: 'Stop once a string repeats this many times in a row (>= semantics). Range {min}–{max}.',
      minUnitLength: 'Minimum repeating-unit length',
      minUnitLengthHint: 'Shortest repeating unit considered, in characters. Range {min}–{max}; 1 catches single-character loops.',
      maxUnitLength: 'Maximum repeating-unit length',
      maxUnitLengthHint: 'Longest repeating unit recognized, in characters after cleaning (whitespace and whitelisted characters are removed). Range {min}–{max}.',
      codeBlockMultiplier: 'Code threshold multiplier (fenced / inline / indented)',
      codeBlockMultiplierHint: 'All three code regions are judged **together** by threshold x this multiplier: fenced blocks (``` / ~~~), inline code (`x`, must close on the same line) and indented blocks (4-space indent preceded by a blank line). Tiers: >=2 = relaxed (default 3, fewer false stops on generated code, fixtures, tables, ASCII art); **1 = tiering off** (same strictness as outside); 0 = do not detect inside code regions at all. Range {min}-{max}. Indented text after a list item or quote, and paragraph continuations, are not code; an unclosed backtick is treated as plain text (at most 256 characters are held back).',
      legacySkipCodeBlocksHint: 'This config disables code tiering (skipCodeBlocks=false, equivalent to multiplier 1); editing the multiplier above takes over and clears that legacy key.',
      stripWhitespace: 'Ignore whitespace',
      stripWhitespaceHint: 'Remove all whitespace (newlines included) before detection, so separated repeats are still recognized.',
      monitorReasoning: 'Monitor reasoning text',
      monitorReasoningHint: 'Repeats inside reasoning burn tokens too, so they are monitored by default.',
      monitorToolArguments: 'Monitor tool-call arguments',
      monitorToolArgumentsHint: 'Off by default: repeated characters are common in JSON / base64 arguments.',
      reset: 'Reset to defaults',
      note: '"Reset to defaults" clears every user setting on this page and restores the code defaults.',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Save failed: the host did not accept the value; check the input or the DSH host log.',
      errInteger: 'Enter an integer.',
      errRange: 'Allowed range {min}–{max}.',
      errCross: 'Must not be smaller than the minimum unit length (currently {min}).',
      errCrossMin: 'Must not be larger than the maximum unit length (currently {max}).',
      windowWarn: '⚠ The derived window needs {need} characters but is capped at {current} (threshold {threshold} x code-block multiplier {multiplier} x max unit {maxUnit}). Units longer than {effective} characters cannot be detected — lower the threshold, code-block multiplier or max unit length (or the policy span).',
      loading: 'Loading…',
      loadingDiag: 'Settings channel: {state} | {diag}',
      remoteHint: 'Settings editing requires a local connection: open the DSH page through the local address (127.0.0.1) and retry. On remote browsers, or when this DSH build disables settings writes, detection keeps the host configuration.',
      unavailable: 'Settings unavailable: no data for the Dupguard section was received. Verify the plugin is mounted (the host log should contain "[dupguard] 常驻插件 apply 开始") and that this DSH build exposes a settings channel (0.1.7+ needs a plugin Config export), then refresh the page.',
    }

    const css = [
      '.dg-section{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dg-title{font-size:15px;font-weight:600;line-height:24px;margin:0}',
      '.dg-intro{color:var(--dsw-alias-label-secondary);margin:0}',
      '.dg-chips{display:flex;flex-wrap:wrap;gap:8px}',
      '.dg-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.dg-chip-remove{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:none;border-radius:5px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;padding:0}',
      '.dg-chip-remove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dg-add{display:flex;gap:8px}',
      '.dg-input{flex:1;max-width:240px;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;font-family:inherit}',
      '.dg-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dg-btn{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap;flex:0 0 auto}',
      '.dg-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.dg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dg-table-actions{display:flex;align-items:flex-start;gap:10px}',
      '.dg-table-actions .dg-field-hint{flex:1 1 auto;padding-top:8px}',
      '.dg-note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}',
      '.dg-empty{color:var(--dsw-alias-label-tertiary);margin:0}',
      '.dg-fields{display:flex;flex-direction:column;gap:12px}',
      '.dg-field{display:flex;flex-direction:column;gap:4px}',
      '.dg-field-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dg-field-label{color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dg-field-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}',
      '.dg-field-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:0}',
      '.dg-num{box-sizing:border-box;width:110px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;text-align:right;outline:none}',
      '.dg-select{box-sizing:border-box;width:100%;max-width:280px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;outline:none}',
      // 风险确认弹窗（与 DSH 的 RiskConfirmation 对齐：警示行 + 勾选 + 取消/主按钮）
      '.dg-modal-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}',
      '.dg-modal{box-sizing:border-box;width:min(440px,100%);max-height:calc(100dvh - 48px);overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 40px rgba(0,0,0,.28)}',
      '.dg-modal-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dg-modal-warning{display:flex;align-items:flex-start;gap:10px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}',
      '.dg-modal-warning p{margin:0}',
      '.dg-modal-icon{flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary)}',
      '.dg-modal-ack{display:flex;align-items:flex-start;gap:10px;margin-top:8px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;cursor:pointer}',
      '.dg-modal-ack input{flex:none;width:16px;height:16px;margin:3px 0 0;accent-color:var(--dsw-alias-button-primary-fill);cursor:pointer}',
      '.dg-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
      '.dg-modal-actions .dg-btn{min-width:72px;justify-content:center}',
      '.dg-modal-actions #dg-risk-confirm{min-width:136px}',
      // 主按钮：颜色取 DSH 自己的按钮 token（brand-primary 是开关/复选框的强调色，不能当填充用）；
      // 选择器必须比基础 .dg-btn 更具体——基础样式定义在后，同优先级会把背景覆盖成浅色（白底白字）。
      '.dg-btn.dg-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dg-btn.dg-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}',
      '.dg-table{display:flex;flex-direction:column;gap:6px;margin:8px 0}',
      '.dg-tr{display:grid;grid-template-columns:64px 110px 110px 40px;align-items:center;gap:8px}',
      '.dg-th{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dg-td{display:flex;align-items:center}',
      '.dg-ro{font-size:13px;color:var(--dsw-alias-label-secondary);padding-left:10px}',
      '.dg-cell{width:110px;text-align:left}',
      '.dg-num:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dg-switch{box-sizing:border-box;width:36px;height:20px;flex:none;padding:2px;border:0;border-radius:10px;background:var(--dsw-alias-border-l2);cursor:pointer}',
      '.dg-switch-on{background:var(--dsw-alias-brand-primary)}',
      '.dg-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s}',
      '.dg-switch-on .dg-switch-thumb{transform:translateX(16px)}',
      '.dg-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;margin:0}',
      '.dg-error{color:var(--dsw-alias-state-error-primary)}',
      '.dg-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
    ].join('\n')

    if (typeof document !== 'undefined') {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-dupguard'
      tag.dataset.pluginCss = 'dsh-dupguard/client.css'
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // 静态依赖只放各版本都有的服务：settingsScope 在 0.1.7 已被移除，
    // remote.settings 在更早版本不存在，二者都不能写进静态 inject（会永久 pending）。
    const inject = ['slots', 'locale']

    // ---------------------------------------------------------------------
    // 字段元数据：与宿主 lib/index.js 的 LIMITS / CONFIG 必须保持一致。
    // ---------------------------------------------------------------------
    const NUMERIC_FIELDS = [
      { key: 'threshold', min: 2, max: 1000 },
      { key: 'codeBlockMultiplier', min: 0, max: 100 },
      { key: 'minUnitLength', min: 1, max: 4096 },
      { key: 'maxUnitLength', min: 1, max: 8192 },
    ]
    const BOOL_FIELDS = ['stripWhitespace', 'skipCodeBlocks', 'monitorReasoning', 'monitorToolArguments']
    const DEFAULTS = {
      ignoredChars: ['-', '|'],
      ignoredSubstrings: [],
      thresholdMode: 'simple',
      thresholdByLength: '',
      advancedThresholdFile: '',
      threshold: 10,
      codeBlockMultiplier: 3,
      minUnitLength: 1,
      maxUnitLength: 80,
      detectionWindow: 8192,
      stripWhitespace: true,
      skipCodeBlocks: true,
      monitorReasoning: true,
      monitorToolArguments: false,
    }
    const ALL_FIELDS = ['ignoredChars', 'ignoredSubstrings', 'thresholdMode', 'thresholdByLength', 'advancedThresholdFile']
      .concat(NUMERIC_FIELDS.map((field) => field.key), BOOL_FIELDS)

    /** 与宿主 THRESHOLD_MODES 一致；非法值回落 simple。 */
    const THRESHOLD_MODES = ['simple', 'table', 'module']

    /** 与宿主 lib/index.js 的常量保持一致：片段上限（每项码点数 / 条目数）。 */
    const MAX_SUBSTRING_LENGTH = 64
    const MAX_SUBSTRINGS = 64

    /** 模板占位符替换：{name} → vars.name。 */
    const fmt = (text, vars) =>
      String(text).replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? match : String(vars[key])))

    /**
     * 把宿主设置值归一化为完整形态：缺失或越界的字段回落默认，
     * 保证任何异常形状到达视图时仍是 ready 且可渲染。
     */
    function normalizeValue(raw) {
      const out = {
        ignoredChars: [...DEFAULTS.ignoredChars],
        ignoredSubstrings: [...DEFAULTS.ignoredSubstrings],
        thresholdMode: DEFAULTS.thresholdMode,
        thresholdByLength: DEFAULTS.thresholdByLength,
        advancedThresholdFile: DEFAULTS.advancedThresholdFile,
      }
      for (const field of NUMERIC_FIELDS) out[field.key] = DEFAULTS[field.key]
      for (const key of BOOL_FIELDS) out[key] = DEFAULTS[key]
      try {
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          if (Array.isArray(raw.ignoredChars)) {
            out.ignoredChars = raw.ignoredChars.filter((ch) => typeof ch === 'string')
          }
          if (Array.isArray(raw.ignoredSubstrings)) {
            out.ignoredSubstrings = raw.ignoredSubstrings
              .filter((item) => typeof item === 'string' && item.length > 0)
              .slice(0, MAX_SUBSTRINGS)
          }
          if (THRESHOLD_MODES.indexOf(raw.thresholdMode) !== -1) out.thresholdMode = raw.thresholdMode
          if (typeof raw.thresholdByLength === 'string') out.thresholdByLength = raw.thresholdByLength
          if (typeof raw.advancedThresholdFile === 'string') out.advancedThresholdFile = raw.advancedThresholdFile
          for (const field of NUMERIC_FIELDS) {
            const value = raw[field.key]
            if (Number.isSafeInteger(value) && value >= field.min && value <= field.max) out[field.key] = value
          }
          for (const key of BOOL_FIELDS) {
            if (typeof raw[key] === 'boolean') out[key] = raw[key]
          }
        }
      } catch (_normalizeError) {}
      return out
    }

    /** 归一化值为编辑表单：数值字段存字符串，便于输入中途的状态。 */
    function toForm(value) {
      const normalized = normalizeValue(value)
      const form = {
        ignoredChars: normalized.ignoredChars,
        ignoredSubstrings: normalized.ignoredSubstrings,
        thresholdMode: normalized.thresholdMode,
        thresholdByLength: normalized.thresholdByLength,
        advancedThresholdFile: normalized.advancedThresholdFile,
      }
      for (const field of NUMERIC_FIELDS) form[field.key] = String(normalized[field.key])
      for (const key of BOOL_FIELDS) form[key] = normalized[key]
      return form
    }

    /** 从输入文本解析整数（仅接受纯整数，避免 1e3 / 3.5 这类写法）。 */
    function parseInt10(text) {
      const value = typeof text === 'string' ? text.trim() : String(text)
      return /^-?\d+$/.test(value) ? Number(value) : NaN
    }

    /** 解析分段表字符串 → 升序条目（与宿主同规则；非法项忽略，`*` 排最后）。 */
    function parseTableEntries(raw) {
      const entries = []
      for (const part of String(raw === undefined || raw === null ? '' : raw).split(',')) {
        const match = /^\s*(\*|\d+)\s*:\s*(\d+)\s*$/.exec(part)
        if (match === null) continue
        const count = Number(match[2])
        if (!Number.isSafeInteger(count) || count < 2 || count > 1000) continue
        if (match[1] === '*') {
          entries.push({ maxLength: null, count })
          continue
        }
        const maxLength = Number(match[1])
        if (maxLength < 1) continue
        const existing = entries.findIndex((entry) => entry.maxLength === maxLength)
        if (existing !== -1) entries[existing] = { maxLength, count }
        else entries.push({ maxLength, count })
      }
      const named = entries.filter((entry) => entry.maxLength !== null).sort((a, b) => a.maxLength - b.maxLength)
      return named.concat(entries.filter((entry) => entry.maxLength === null))
    }

    /** 表格行数上限/下限与最大单元长度上限（与宿主 LIMITS 一致）。 */
    const MAX_TABLE_ROWS = 16
    const MIN_TABLE_ROWS = 1
    const MAX_UNIT_LIMIT = 8192

    /**
     * 分段表字符串 → 表格行 `{ end, count }`（起始值由相邻行推导，不存储）。
     * 旧写法的 `*:<次数>` 映射为「终止 = 文档 maxUnitLength」的末行，便于平滑迁移。
     */
    function tableRowsOf(text, fallbackMax) {
      const rows = []
      for (const entry of parseTableEntries(text)) {
        if (entry.maxLength === null) {
          const previous = rows.length === 0 ? 0 : rows[rows.length - 1].end
          const end = Math.min(Math.max(fallbackMax, previous + 1), MAX_UNIT_LIMIT)
          if (rows.length === 0 || end > previous) rows.push({ end: end, count: entry.count })
          else rows[rows.length - 1] = { end: previous, count: entry.count }
          continue
        }
        rows.push({ end: entry.maxLength, count: entry.count })
      }
      return rows
    }

    function DupguardSection(props) {
      const controller = props.controller
      const t = props.t

      // 全部 hook 在早退之前调用，保证 loading → ready 的状态切换不改变 hook 数量。
      const snap = React.useSyncExternalStore(
        (cb) => controller.subscribe(cb),
        () => controller.getSnapshot(),
      )
      const mirrorSnap = React.useSyncExternalStore(
        (cb) => props.mirror.subscribe(cb),
        () => props.mirror.getSnapshot(),
      )
      const [draft, setDraft] = React.useState('')
      const [form, setForm] = React.useState(null)
      const [writeState, setWriteState] = React.useState(null)
      const [errors, setErrors] = React.useState({})
      /** 待确认的模式（目前只有高级模式）：非 null 时显示风险确认弹窗，确认后才写入。 */
      const [pendingMode, setPendingMode] = React.useState(null)
      /** 风险确认弹窗里的「我已了解风险」勾选（未勾选时确认按钮禁用，与 DSH 的完全权限弹窗一致）。 */
      const [riskAcknowledged, setRiskAcknowledged] = React.useState(false)
      // 分段表草稿：非 null 时表示用户正在编辑（保存原始输入文本，提交成功即清空回到派生行）。
      const [tableDraft, setTableDraft] = React.useState(null)
      const dirty = React.useRef({})
      const lastRemote = React.useRef(null)

      // 每次打开本页都强制重拉镜像：保证显示的是宿主持久化的最新值。
      React.useEffect(() => {
        if (props.mirror && typeof props.mirror.load === 'function') {
          props.mirror.load()
        }
      }, [])

      // 同步模型：手动修改过的字段本地自治（免疫旧值回传），其余字段跟随镜像快照。
      const ready = snap.status === 'ready' && snap.value !== undefined
      const remoteForm = ready ? toForm(snap.value) : null
      if (ready) {
        const signature = JSON.stringify(remoteForm)
        if (form === null) {
          lastRemote.current = signature
          setForm(remoteForm)
        } else if (lastRemote.current !== signature) {
          lastRemote.current = signature
          const next = {}
          for (const key of ALL_FIELDS) {
            next[key] = dirty.current[key] === true ? form[key] : remoteForm[key]
          }
          setForm(next)
        }
      }
      const shown = form === null ? remoteForm : form

      // 本机/远程判断：注册时取一次会停留在旧状态（例如 describe 才发现只读），
      // 因此这里接受函数形态并按渲染实时取值，布尔形态继续兼容。
      const loopback = typeof props.isLoopback === 'function' ? props.isLoopback() : props.isLoopback
      if (loopback === false) {
        return React.createElement('div', { className: 'dg-section' },
          React.createElement('h2', { className: 'dg-title' }, t('title')),
          React.createElement('p', { className: 'dg-intro' }, t('remoteHint')))
      }
      if (snap.status === 'unavailable') {
        const unavailableDiag = mirrorSnap && mirrorSnap.diag ? String(mirrorSnap.diag) : ''
        const unavailableError = mirrorSnap && mirrorSnap.error ? String(mirrorSnap.error) : null
        return React.createElement('div', { className: 'dg-section' },
          React.createElement('h2', { className: 'dg-title' }, t('title')),
          React.createElement('p', { className: 'dg-intro' }, t('unavailable')),
          React.createElement('p', { className: 'dg-note' },
            fmt(t('loadingDiag'), { state: mirrorSnap ? String(mirrorSnap.status) : 'unknown', diag: unavailableDiag })),
          unavailableError === null ? null : React.createElement('p', { className: 'dg-note dg-error' }, unavailableError))
      }
      if (!ready || shown === null) {
        const mirrorError = mirrorSnap && mirrorSnap.error ? String(mirrorSnap.error) : null
        const mirrorStatus = mirrorSnap ? String(mirrorSnap.status) : 'unknown'
        const mirrorDiag = mirrorSnap && mirrorSnap.diag ? String(mirrorSnap.diag) : ''
        return React.createElement('div', { className: 'dg-section' },
          React.createElement('h2', { className: 'dg-title' }, t('title')),
          React.createElement('p', { className: 'dg-empty' }, t('loading')),
          React.createElement('p', { className: 'dg-note' },
            fmt(t('loadingDiag'), { state: mirrorStatus, diag: mirrorDiag })),
          mirrorError === null ? null : React.createElement('p', { className: 'dg-note dg-error' }, mirrorError))
      }

      // ---- 取值校验：逐字段范围 + 跨字段（最大单元 ≥ 最小单元） ----
      // 分段表模式下候选区间完全由表格给出（起始 1、终止 = 末行），
      // 阈值 / 最小 / 最大单元长度三项在界面上不显示，其文档值也不参与校验。
      const tableMode = shown.thresholdMode === 'table'
      const hiddenInTable = (key) => key === 'threshold' || key === 'minUnitLength' || key === 'maxUnitLength'
      const parsed = {}
      let numericValid = true
      for (const field of NUMERIC_FIELDS) {
        const value = parseInt10(shown[field.key])
        parsed[field.key] = value
        if (tableMode && hiddenInTable(field.key)) continue
        if (!Number.isInteger(value) || value < field.min || value > field.max) numericValid = false
      }
      const crossInvalid = !tableMode && Number.isInteger(parsed.minUnitLength) && Number.isInteger(parsed.maxUnitLength) &&
        parsed.maxUnitLength < parsed.minUnitLength

      // ---- 分段表：表格行（起始列由相邻行推导）+ 校验 + 序列化 ----
      // 草稿非 null 表示正在编辑：保留用户原始输入，提交成功后才回到「按设置值派生」。
      // 空表在界面上展示为 1 行（终止 = 当前最大单元长度、次数 = 基础阈值），仅供填写起点，
      // 未编辑前不写入——与宿主「空表回退基础阈值」的行为一致。
      const storedRows = tableDraft !== null
        ? tableDraft
        : tableRowsOf(shown.thresholdByLength, Number.isInteger(parsed.maxUnitLength) ? parsed.maxUnitLength : MAX_UNIT_LIMIT)
      const tableRows = storedRows.length > 0
        ? storedRows
        : [{
            end: String(Number.isInteger(parsed.maxUnitLength) ? parsed.maxUnitLength : MAX_UNIT_LIMIT),
            count: String(Number.isInteger(parsed.threshold) ? parsed.threshold : 10),
          }]
      const rowStart = (index) => (index === 0 ? 1 : parseInt10(tableRows[index - 1].end) + 1)
      const serializedRows = (rows) => rows
        .map((row) => String(parseInt10(row.end)) + ':' + String(parseInt10(row.count)))
        .join(', ')
      const validateRows = (rows) => {
        let previousEnd = 0
        for (let index = 0; index < rows.length; index++) {
          const end = parseInt10(rows[index].end)
          const count = parseInt10(rows[index].count)
          const start = index === 0 ? 1 : previousEnd + 1
          if (!Number.isInteger(end) || end < start) return t('errRowEndOrder')
          if (end > MAX_UNIT_LIMIT) return fmt(t('errRowEndRange'), { max: MAX_UNIT_LIMIT })
          if (!Number.isInteger(count)) return t('errRowCount')
          if (count < 2 || count > 1000) return fmt(t('errRowCount'), {})
          if (index < rows.length - 1) {
            const nextEnd = parseInt10(rows[index + 1].end)
            if (Number.isInteger(nextEnd) && end >= nextEnd) return t('errRowOrder')
          }
          previousEnd = end
        }
        return null
      }
      /** 分段表模式下生效的最大单元长度 = 末行终止值（与宿主 deriveMaxUnitLength 一致）。 */
      const tableMaxUnit = tableRows.length === 0
        ? undefined
        : parseInt10(tableRows[tableRows.length - 1].end)

      /**
       * 宿主写回文档的检测窗口（只用于 module 模式展示——该模式浏览器无法求值，
       * 只能显示宿主算出的值；窗口已不在表单字段里，因此直接读控制器快照）。
       * 函数声明会提升，供下方 derivedWindow 提前使用。
       */
      function hostWindowFromSnapshot() {
        try {
          const snapshot = controller.getSnapshot()
          const raw = snapshot !== undefined && snapshot.value !== undefined
            ? snapshot.value.detectionWindow
            : undefined
          return Number.isSafeInteger(raw) && raw >= 64 && raw <= 1048576 ? raw : undefined
        } catch (_snapshotError) {
          return undefined
        }
      }

      /**
       * 老配置里**显式设过** skipCodeBlocks 时的值（用户层存在该键才算；默认值不算）。
       * 它与「倍数 = 1」等价，设置页已隐藏该开关：提交倍数时会顺带 unset 它，
       * 当前值还会在倍数行下方提示一次，避免「隐藏却仍在生效」的困惑。
       */
      function legacySkipCodeBlocks() {
        try {
          const snapshot = controller.getSnapshot()
          const user = snapshot !== undefined ? snapshot.user : undefined
          return user !== undefined && user !== null ? user.skipCodeBlocks : undefined
        } catch (_snapshotError) {
          return undefined
        }
      }

      const fieldError = (field) => {
        const value = parsed[field.key]
        if (!Number.isInteger(value)) return t('errInteger')
        if (value < field.min || value > field.max) return fmt(t('errRange'), { min: field.min, max: field.max })
        // 跨字段约束在两侧都提示：否则从「最小单元」一侧提交违规值时，
        // 只能拿到宿主拒绝后的泛化「保存失败」。
        if (crossInvalid && field.key === 'maxUnitLength') return fmt(t('errCross'), { min: parsed.minUnitLength })
        if (crossInvalid && field.key === 'minUnitLength') return fmt(t('errCrossMin'), { max: parsed.maxUnitLength })
        return null
      }

      // 检测窗口是**派生值**（用户不填写）：正好等于最严格的重复跨度，夹到 [64, 1048576]。
      // 与宿主 deriveWindow 同公式；module 模式无法在浏览器求值用户函数，改为显示宿主写回的快照值。
      const codeMode = shown.skipCodeBlocks === true ? parsed.codeBlockMultiplier : 1
      const strictThreshold = codeMode === 0 ? parsed.threshold : parsed.threshold * codeMode
      const derivedWindow = (() => {
        if (!numericValid || crossInvalid) return null
        // 分段表模式下最大单元长度由末行终止值决定（不再是输入项）。
        const effectiveMaxUnit = shown.thresholdMode === 'table' && Number.isInteger(tableMaxUnit)
          ? tableMaxUnit
          : parsed.maxUnitLength
        const loopMin = shown.thresholdMode === 'table' ? 1 : parsed.minUnitLength
        const plainSpan = strictThreshold * effectiveMaxUnit
        let policySpan = 0
        let hasPolicy = false
        if (shown.thresholdMode === 'table') {
          const entries = parseTableEntries(shown.thresholdByLength)
          hasPolicy = entries.length > 0
          for (let p = loopMin; p <= effectiveMaxUnit; p++) {
            let need = parsed.threshold
            for (const entry of entries) {
              if (entry.maxLength === null || p <= entry.maxLength) {
                need = entry.count
                break
              }
            }
            // 块外一侧 = p × need(p)；块内一侧 = p × need(p) × 倍数（倍数 0 时块内不检测，不贡献）
            const outsideSpan = p * need
            const codeSpan = codeMode === 0 ? 0 : p * need * codeMode
            const span = Math.max(outsideSpan, codeSpan)
            if (span > policySpan) policySpan = span
          }
        }
        // 策略模式：次数完全由策略给出（含 `*` 兜底），不再叠加固定阈值，否则窗口会被算大。
        const required = hasPolicy && policySpan > 0 ? policySpan : plainSpan
        return {
          required: required,
          value: Math.min(Math.max(required, 64), 1048576),
          isModule: shown.thresholdMode === 'module',
          // module 模式无法在浏览器求值：显示宿主写回文档的窗口值（窗口已不在表单字段里，直接读快照）。
          hostValue: hostWindowFromSnapshot(),
        }
      })()
      const windowClamped = derivedWindow !== null && !derivedWindow.isModule && derivedWindow.value < derivedWindow.required
      const shortfall = windowClamped
        ? {
            need: derivedWindow.required,
            current: derivedWindow.value,
            threshold: parsed.threshold,
            multiplier: codeMode === 0 ? 1 : codeMode,
            maxUnit: shown.thresholdMode === 'table' && Number.isInteger(tableMaxUnit)
              ? tableMaxUnit
              : parsed.maxUnitLength,
            effective: Math.floor(derivedWindow.value / strictThreshold),
          }
        : null
      // 派生值不单独占行（不可编辑，占位只会让界面变吵）：并进底部已有的诊断行。
      const derivedDiagText = (() => {
        const windowValue = derivedWindow === null
          ? '—'
          : String(derivedWindow.isModule
            ? (derivedWindow.hostValue === undefined ? '—' : derivedWindow.hostValue)
            : derivedWindow.value)
        if (shown.thresholdMode === 'table' && Number.isInteger(tableMaxUnit)) {
          return fmt(t('derivedDiagTable'), { window: windowValue, maxUnit: tableMaxUnit })
        }
        return fmt(t('derivedDiag'), { window: windowValue })
      })()

      // ---- 写路径：设置控制器（新版 remote.settings，旧版 settingsScope）。 ----
      // 写成功与否**只以宿主应答为准**：宿主返回的视图是写入前的快照（配置由 loader
      // 异步重载），拿它跟本地期望值比对必然不一致——这正是此前「明明保存成功却报
      // 保存失败、重开后新值不见了」的原因。官方实现同样是信任 response.ok。
      const snapshotValue = () => {
        const current = controller.getSnapshot()
        return current !== undefined && current.value !== undefined ? current.value : {}
      }
      const currentForm = () => (form === null ? remoteForm : form)
      const runWrite = (operation) => {
        setWriteState('saving')
        // 失败时带上宿主返回的原始原因（writeReason）与构建标记：
        // 标记同时用于判断浏览器加载的是哪一版（排查旧包/缓存）。
        const failureText = () => {
          const reason = typeof props.writeReason === 'function' ? props.writeReason() : null
          const suffix = reason === null || reason === undefined ? '（宿主未给出原因）' : String(reason)
          return t('saveFailed') + ' [diag ' + BUILD_MARK + '] ' + suffix
        }
        Promise.resolve()
          .then(() => operation())
          .then((accepted) => setWriteState(accepted === false ? 'error:' + failureText() : 'saved'), (error) => {
            setWriteState('error:' + String((error && error.message) || error))
          })
      }
      /** 通用列表字段写入（字符白名单 / 片段白名单共用）。 */
      const commitFieldList = (field, next) => {
        dirty.current[field] = true
        setForm({ ...currentForm(), [field]: next })
        runWrite(() => controller.set(field, next))
      }

      /**
       * 白名单合并视图：字符表条目在前、片段表条目在后（同值去重）。
       * 设置页只显示这一个列表，写入时再按规则拆回两个字段。
       */
      const whitelistEntries = () => {
        const out = []
        for (const ch of shown.ignoredChars) if (out.indexOf(ch) === -1) out.push(ch)
        for (const item of shown.ignoredSubstrings) if (out.indexOf(item) === -1) out.push(item)
        return out
      }
      /**
       * 自动分类：恰好 1 个码点且非空白 ⇒ 字符白名单；其余（多字符片段、以及只在
       * 「忽略空白字符」关闭时才有意义的单字符空白）⇒ 片段白名单。
       * 对单个非空白字符两者**完全等价**（剔除以字符为单位，先后顺序不影响结果）。
       */
      const isCharEntry = (text) => [...text].length === 1 && !/\s/.test(text)
      /** 只写入真正变化的字段（两个都变时各写一次，界面状态只更新一次）。 */
      const commitWhitelists = (nextChars, nextSubs) => {
        const charsChanged = nextChars.length !== shown.ignoredChars.length ||
          nextChars.some((ch, index) => ch !== shown.ignoredChars[index])
        const subsChanged = nextSubs.length !== shown.ignoredSubstrings.length ||
          nextSubs.some((item, index) => item !== shown.ignoredSubstrings[index])
        if (!charsChanged && !subsChanged) return
        if (charsChanged) dirty.current.ignoredChars = true
        if (subsChanged) dirty.current.ignoredSubstrings = true
        setForm({ ...currentForm(), ignoredChars: nextChars, ignoredSubstrings: nextSubs })
        runWrite(async () => {
          if (charsChanged) await controller.set('ignoredChars', nextChars)
          if (subsChanged) await controller.set('ignoredSubstrings', nextSubs)
        })
      }
      const commitNumber = (field) => {
        const message = fieldError(field)
        if (message !== null) {
          setErrors((prev) => ({ ...prev, [field.key]: message }))
          return
        }
        const value = parsed[field.key]
        setErrors((prev) => ({ ...prev, [field.key]: null }))
        // 值未变化时不写入：避免仅仅聚焦/失焦就把默认值写进用户层，
        // 污染配置文件并让「恢复默认」失去意义。
        if (snapshotValue()[field.key] === value) {
          dirty.current[field.key] = false
          setForm({ ...currentForm(), [field.key]: String(value) })
          return
        }
        dirty.current[field.key] = true
        setForm({ ...currentForm(), [field.key]: String(value) })
        runWrite(() => {
          // 代码块分档的两个开关是等价的（skipCodeBlocks=false ≡ 倍数 1），设置页只保留倍数。
          // 老配置里显式设过 skipCodeBlocks 时顺带 unset，避免隐藏的开关继续覆盖倍数（best-effort）。
          const legacySkip = field.key === 'codeBlockMultiplier' && legacySkipCodeBlocks() !== undefined
          if (legacySkip) {
            try {
              const result = controller.unset('skipCodeBlocks')
              if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
                result.then(undefined, () => {})
              }
            } catch (_unsetError) {}
          }
          return controller.set(field.key, value)
        })
      }
      const commitBool = (key) => {
        const value = shown[key] !== true
        dirty.current[key] = true
        setForm({ ...currentForm(), [key]: value })
        runWrite(() => controller.set(key, value))
      }
      const resetAll = () => {
        dirty.current = {}
        setErrors({})
        // 恢复默认 = 逐字段 unset；接受与否同样只看宿主应答。
        runWrite(() => Promise.all(ALL_FIELDS.map((key) => controller.unset(key)))
          .then((results) => results.every((item) => item !== false)))
      }

      /**
       * 白名单添加：输入里的每个**条目**（按空白 / 逗号切分）自动分类后落到对应字段——
       * 1 码点且非空白 ⇒ `ignoredChars`，其余（片段、单字符空白）⇒ `ignoredSubstrings`。
       * 校验空值/超长/重复/超量，错误就地显示且不写入。
       */
      const add = () => {
        const fail = (message) => setErrors((prev) => ({ ...prev, whitelist: message }))
        const tokens = draft.split(/[\s,，]+/).filter((token) => token.length > 0)
        if (tokens.length === 0) {
          fail(t('errSubstringEmpty'))
          return
        }
        const nextChars = [...shown.ignoredChars]
        const nextSubs = [...shown.ignoredSubstrings]
        const known = () => nextChars.concat(nextSubs)
        for (const token of tokens) {
          if (isCharEntry(token)) {
            if (known().indexOf(token) === -1) nextChars.push(token)
            continue
          }
          if ([...token].length > MAX_SUBSTRING_LENGTH) {
            fail(fmt(t('errSubstringTooLong'), { maxLen: MAX_SUBSTRING_LENGTH }))
            return
          }
          if (known().indexOf(token) !== -1) {
            fail(t('errSubstringDuplicate'))
            return
          }
          if (nextSubs.length >= MAX_SUBSTRINGS) {
            fail(fmt(t('errSubstringLimit'), { maxCount: MAX_SUBSTRINGS }))
            return
          }
          nextSubs.push(token)
        }
        setDraft('')
        setErrors((prev) => ({ ...prev, whitelist: null }))
        commitWhitelists(nextChars, nextSubs)
      }
      const remove = (entry) => commitWhitelists(
        shown.ignoredChars.filter((ch) => ch !== entry),
        shown.ignoredSubstrings.filter((item) => item !== entry),
      )

      /**
       * 高级重复设置：模式下拉 + 按模式条件显示的分段表 / 模块路径。
       * 切换模式与填写文本都走同一写通道；校验失败只就地提示、不写入。
       */
      /** 真正写入模式（不弹窗）；高级模式的入口一律经过 commitMode 的风险确认。 */
      const applyMode = (mode) => {
        dirty.current.thresholdMode = true
        setForm({ ...currentForm(), thresholdMode: mode })
        runWrite(() => controller.set('thresholdMode', mode))
      }
      /**
       * 模式下拉：切到**高级模式（实验性）**时先弹风险确认（与 DSH 的「完全权限」弹窗同一模式：
       * 勾选「我已了解风险」后才可确认；取消则保持原模式、不写入）。其余模式直接写入。
       */
      const commitMode = (mode) => {
        // 下拉只有三个合法值，非法值直接忽略（无需错误状态：模式行没有错误展示位）。
        if (THRESHOLD_MODES.indexOf(mode) === -1) return
        if (mode === 'module' && currentForm().thresholdMode !== 'module') {
          setRiskAcknowledged(false)
          setPendingMode('module')
          return
        }
        setPendingMode(null)
        applyMode(mode)
      }
      const cancelRisk = () => {
        setRiskAcknowledged(false)
        setPendingMode(null)
      }
      const confirmRisk = () => {
        const mode = pendingMode
        setRiskAcknowledged(false)
        setPendingMode(null)
        if (mode !== null) applyMode(mode)
      }
      const commitText = (field, next, message) => {
        if (message !== null) {
          setErrors((prev) => ({ ...prev, [field]: message }))
          return
        }
        setErrors((prev) => ({ ...prev, [field]: null }))
        dirty.current[field] = true
        setForm({ ...currentForm(), [field]: next })
        runWrite(() => controller.set(field, next))
      }
      /** 分段表：提交整表（校验通过才写入；成功即清空草稿、回到按设置值派生）。 */
      const commitRows = (rows) => {
        const message = validateRows(rows)
        if (message !== null) {
          setErrors((prev) => ({ ...prev, thresholdByLength: message }))
          setTableDraft(rows) // 保留用户输入，便于就地修正
          return
        }
        setTableDraft(null)
        commitText('thresholdByLength', serializedRows(rows), null)
      }
      const changeCell = (index, column, value) => {
        const next = tableRows.map((row, position) => (position === index ? { ...row, [column]: value } : row))
        setTableDraft(next)
        setErrors((prev) => ({ ...prev, thresholdByLength: null }))
      }
      const addRow = () => {
        if (tableRows.length >= MAX_TABLE_ROWS) return
        const last = tableRows[tableRows.length - 1]
        const lastEnd = last === undefined ? 0 : parseInt10(last.end)
        const base = Number.isInteger(lastEnd) && lastEnd > 0 ? lastEnd : 1
        const end = Math.min(MAX_UNIT_LIMIT, Math.max(base + 1, base * 2))
        const count = last === undefined ? parsed.threshold : parseInt10(last.count)
        commitRows(tableRows.concat([{
          end: String(end),
          count: String(Number.isInteger(count) ? count : parsed.threshold),
        }]))
      }
      const removeRow = (index) => {
        if (tableRows.length <= MIN_TABLE_ROWS) return
        commitRows(tableRows.filter((_row, position) => position !== index))
      }
      /**
       * 模块路径不再限定扩展名：宿主用 require() 加载，Node 对**未注册扩展名**同样按 CommonJS JS 加载，
       * 因此 .txt 之类也能用；.json 会按 JSON 解析（无法导出函数）、.mjs 需 Node ≥22。
       * 浏览器读不到磁盘，这里只做非空校验，加载结果以宿主日志为准。
       */
      const validateFile = (text) => (text.trim().length === 0 ? t('errThresholdFile') : null)
      const textRow = (key, placeholderKey) => React.createElement('div', { className: 'dg-field', key: key },
        React.createElement('div', { className: 'dg-field-head' },
          React.createElement('label', { className: 'dg-field-label', htmlFor: 'dg-' + key }, t(key))),
        React.createElement('input', {
          id: 'dg-' + key,
          className: 'dg-input',
          type: 'text',
          value: shown[key],
          placeholder: placeholderKey === undefined ? '' : t(placeholderKey),
          onChange: (event) => setForm({ ...currentForm(), [key]: event.target.value }),
          onBlur: () => commitText(key, shown[key], validateFile(shown[key])),
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            commitText(key, shown[key], validateFile(shown[key]))
          },
        }),
        React.createElement('p', { className: 'dg-field-hint' }, t(key + 'Hint')),
        errors[key] === undefined || errors[key] === null
          ? null
          : React.createElement('p', { className: 'dg-field-error' }, errors[key]),
      )
      /**
       * 分段表控件：三列（起始只读 / 终止 / 次数）+ 增删行。
       * 起始值由相邻行推导：首行 1，第 N 行 = 上一行终止 + 1；末行终止 = 最大检测长度。
       */
      const tableControl = () => {
        const rows = tableRows
        const cellInput = (index, column, value, extraProps) => React.createElement('input', {
          className: 'dg-num dg-cell',
          type: 'text',
          inputMode: 'numeric',
          value: String(value === undefined ? '' : value),
          onChange: (event) => changeCell(index, column, event.target.value),
          onBlur: () => commitRows(rows),
          onKeyDown: (event) => {
            if (event.key === 'Enter') commitRows(rows)
          },
          ...extraProps,
        })
        return React.createElement('div', { className: 'dg-field', key: 'thresholdByLength' },
          React.createElement('label', { className: 'dg-field-label' }, t('thresholdByLength')),
          React.createElement('div', { className: 'dg-table' },
            React.createElement('div', { className: 'dg-tr dg-th' },
              React.createElement('span', { className: 'dg-td' }, t('colStart')),
              React.createElement('span', { className: 'dg-td' }, t('colEnd')),
              React.createElement('span', { className: 'dg-td' }, t('colCount')),
              React.createElement('span', { className: 'dg-td' }, t('colActions'))),
            rows.map((row, index) => React.createElement('div', { className: 'dg-tr', key: index },
              React.createElement('span', { className: 'dg-td dg-ro' }, String(rowStart(index))),
              React.createElement('span', { className: 'dg-td' }, cellInput(index, 'end', row.end, { id: 'dg-row-end-' + index })),
              React.createElement('span', { className: 'dg-td' }, cellInput(index, 'count', row.count, { id: 'dg-row-count-' + index })),
              React.createElement('span', { className: 'dg-td' },
                React.createElement('button', {
                  className: 'dg-chip-remove',
                  type: 'button',
                  id: 'dg-row-remove-' + index,
                  disabled: rows.length <= MIN_TABLE_ROWS,
                  onClick: () => removeRow(index),
                  'aria-label': 'remove row',
                }, '\u00d7')))),
          ),
          React.createElement('div', { className: 'dg-table-actions' },
            React.createElement('button', {
              className: 'dg-btn',
              type: 'button',
              id: 'dg-row-add',
              disabled: rows.length >= MAX_TABLE_ROWS,
              onClick: addRow,
            }, t('addRow')),
            React.createElement('p', { className: 'dg-field-hint' },
              fmt(t('tableHint'), { max: MAX_TABLE_ROWS }))),
          React.createElement('p', { className: 'dg-field-hint' }, t('tableMaxUnitHint')),
          errors.thresholdByLength === undefined || errors.thresholdByLength === null
            ? null
            : React.createElement('p', { className: 'dg-field-error' }, errors.thresholdByLength),
        )
      }
      /** 高级模式（实验性）的风险确认弹窗：与 DSH「完全权限」弹窗同一模式（勾选后才可确认）。 */
      const riskDialog = () => pendingMode === null
        ? null
        : React.createElement('div', { className: 'dg-modal-mask' },
          React.createElement('div', {
            className: 'dg-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('riskTitle'),
          },
            React.createElement('h3', { className: 'dg-modal-title' }, t('riskTitle')),
            React.createElement('div', { className: 'dg-modal-warning' },
              React.createElement('span', { className: 'dg-modal-icon', 'aria-hidden': 'true' }, '\u26a0'),
              React.createElement('p', null, t('riskDescription'))),
            React.createElement('label', { className: 'dg-modal-ack', htmlFor: 'dg-risk-ack' },
              React.createElement('input', {
                id: 'dg-risk-ack',
                type: 'checkbox',
                checked: riskAcknowledged,
                onChange: (event) => setRiskAcknowledged(event.target.checked === true),
              }),
              React.createElement('span', null, t('riskAcknowledge'))),
            React.createElement('div', { className: 'dg-modal-actions' },
              React.createElement('button', {
                className: 'dg-btn', type: 'button', id: 'dg-risk-cancel', onClick: cancelRisk,
              }, t('riskCancel')),
              React.createElement('button', {
                className: 'dg-btn dg-btn-primary',
                type: 'button',
                id: 'dg-risk-confirm',
                disabled: !riskAcknowledged,
                onClick: confirmRisk,
              }, t('riskConfirm')))))

      const modeRow = () => React.createElement('div', { className: 'dg-field', key: 'thresholdMode' },
        React.createElement('div', { className: 'dg-field-head' },
          React.createElement('label', { className: 'dg-field-label', htmlFor: 'dg-thresholdMode' }, t('thresholdMode')),
          React.createElement('select', {
            id: 'dg-thresholdMode',
            className: 'dg-input dg-select',
            // 待确认期间显示用户选中的「高级模式」；取消后自动回到原模式（不写入任何值）。
            value: pendingMode !== null ? pendingMode : shown.thresholdMode,
            onChange: (event) => commitMode(event.target.value),
          },
            THRESHOLD_MODES.map((mode) => React.createElement('option', { key: mode, value: mode },
              t(mode === 'simple' ? 'modeSimple' : (mode === 'table' ? 'modeTable' : 'modeModule')))))),
        React.createElement('p', { className: 'dg-field-hint' }, t('thresholdModeHint')),
        riskDialog(),
      )

      const fieldRow = (field) => {
        const message = errors[field.key] !== undefined && errors[field.key] !== null
          ? errors[field.key]
          : fieldError(field)
        return React.createElement('div', { className: 'dg-field', key: field.key },
          React.createElement('div', { className: 'dg-field-head' },
            React.createElement('label', { className: 'dg-field-label', htmlFor: 'dg-' + field.key }, t(field.key)),
            React.createElement('input', {
              id: 'dg-' + field.key,
              className: 'dg-num',
              type: 'number',
              min: field.min,
              max: field.max,
              step: 1,
              value: shown[field.key],
              onChange: (event) => {
                const value = event.target.value
                setForm({ ...currentForm(), [field.key]: value })
                setErrors((prev) => ({ ...prev, [field.key]: null }))
              },
              onBlur: () => commitNumber(field),
              onKeyDown: (event) => {
                if (event.key === 'Enter') commitNumber(field)
              },
            })),
          React.createElement('p', { className: 'dg-field-hint' },
            fmt(t(field.key + 'Hint'), { min: field.min, max: field.max })),
          message === null ? null : React.createElement('p', { className: 'dg-field-error' }, message),
        )
      }
      const switchRow = (key) => React.createElement('div', { className: 'dg-field', key: key },
        React.createElement('div', { className: 'dg-field-head' },
          React.createElement('span', { className: 'dg-field-label' }, t(key)),
          React.createElement('button', {
            className: 'dg-switch' + (shown[key] === true ? ' dg-switch-on' : ''),
            type: 'button',
            role: 'switch',
            'aria-checked': shown[key] === true,
            onClick: () => commitBool(key),
          }, React.createElement('span', { className: 'dg-switch-thumb' }))),
        React.createElement('p', { className: 'dg-field-hint' }, t(key + 'Hint')),
      )

      return React.createElement('div', { className: 'dg-section' },
        React.createElement('h2', { className: 'dg-title' }, t('title')),
        React.createElement('p', { className: 'dg-intro' }, t('intro')),

        React.createElement('p', { className: 'dg-note' }, t('list')),
        whitelistEntries().length === 0
          ? React.createElement('p', { className: 'dg-empty' }, t('empty'))
          : React.createElement('div', { className: 'dg-chips' },
            whitelistEntries().map((entry) => React.createElement('span', { className: 'dg-chip', key: entry },
              entry,
              React.createElement('button', {
                className: 'dg-chip-remove',
                type: 'button',
                onClick: () => remove(entry),
                'aria-label': 'remove',
              }, '\u00d7')))),
        React.createElement('div', { className: 'dg-add' },
          React.createElement('input', {
            id: 'dg-whitelist-input',
            className: 'dg-input',
            placeholder: t('addPlaceholder'),
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') add()
            },
          }),
          React.createElement('button', { className: 'dg-btn', type: 'button', onClick: add }, t('add')),
        ),
        React.createElement('p', { className: 'dg-field-hint' },
          fmt(t('whitelistHint'), { maxLen: MAX_SUBSTRING_LENGTH, maxCount: MAX_SUBSTRINGS })),
        errors.whitelist === undefined || errors.whitelist === null
          ? null
          : React.createElement('p', { className: 'dg-field-error' }, errors.whitelist),

        React.createElement('p', { className: 'dg-note' }, t('advanced')),
        React.createElement('div', { className: 'dg-fields' }, modeRow()),
        shown.thresholdMode === 'table' ? tableControl() : null,
        shown.thresholdMode === 'module'
          ? React.createElement('div', { className: 'dg-fields' }, textRow('advancedThresholdFile', 'advancedThresholdFile'))
          : null,
        shown.thresholdMode === 'simple'
          ? null
          : React.createElement('p', { className: 'dg-field-hint' },
            fmt(t('thresholdFallbackHint'), { threshold: shown.threshold })),

        React.createElement('p', { className: 'dg-note' }, t('params')),
        React.createElement('div', { className: 'dg-fields' },
          // 简单模式显示基础阈值；表格模式下阈值 / 最小 / 最大单元长度都由表格决定，一律不显示。
          NUMERIC_FIELDS
            .filter((field) => shown.thresholdMode === 'simple' || field.key !== 'threshold')
            .filter((field) => !tableMode || !hiddenInTable(field.key))
            .map((field) => fieldRow(field)),
          BOOL_FIELDS
            // skipCodeBlocks 与「倍数 = 1」完全等价，属冗余开关：设置页只保留倍数（字段本身保留，
            // 「恢复默认」照常 unset 它，老配置继续按原语义生效）。
            .filter((key) => key !== 'skipCodeBlocks')
            .map((key) => switchRow(key)),
        ),
        // 老配置显式关掉了分档（= 倍数 1）：提示一次，改倍数即自动接管。
        legacySkipCodeBlocks() === false
          ? React.createElement('p', { className: 'dg-field-hint' }, t('legacySkipCodeBlocksHint'))
          : null,
        shortfall === null ? null : React.createElement('p', { className: 'dg-warn' }, fmt(t('windowWarn'), shortfall)),

        React.createElement('div', { className: 'dg-footer' },
          React.createElement('button', { className: 'dg-btn', type: 'button', onClick: resetAll }, t('reset')),
          writeState === null
            ? React.createElement('p', { className: 'dg-note' }, t('note'))
            : writeState === 'saving'
              ? React.createElement('p', { className: 'dg-note' }, t('saving'))
              : writeState === 'saved'
                ? React.createElement('p', { className: 'dg-note' }, t('saved'))
                : React.createElement('p', { className: 'dg-note dg-error' }, writeState),
          React.createElement('p', { className: 'dg-note' },
            fmt(t('loadingDiag'), {
              state: mirrorSnap ? String(mirrorSnap.status) : 'unknown',
              diag: (mirrorSnap && mirrorSnap.diag ? String(mirrorSnap.diag) : '') + '｜构建 ' + BUILD_MARK,
            }) + '｜' + derivedDiagText),
        ),
      )
    }

    /** 取错误消息文本（remote 应答错误对象 / 异常都归一化成字符串）。 */
    function errorText(error) {
      if (error === null || error === undefined) return 'unknown error'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string') return error.message
      return String(error)
    }

    /** 从 remote 应答里取错误消息（{ ok:false, error:{ message } } 形状）。 */
    function responseError(response, fallback) {
      if (response !== null && typeof response === 'object' && response.error !== null &&
        typeof response.error === 'object' && typeof response.error.message === 'string') {
        return response.error.message
      }
      return fallback
    }

    /** 在 describe() 的命名空间列表里认出本插件的命名空间。 */
    function pickNamespace(view) {
      if (view === null || typeof view !== 'object' || !Array.isArray(view.namespaces)) return undefined
      for (const candidate of SETTINGS_NS_CANDIDATES) {
        const row = view.namespaces.find((item) => item !== null && typeof item === 'object' && item.ns === candidate)
        if (row !== undefined) return row
      }
      // 命名空间 = loader entry id：本 bundle 插入的行是 dupguard，但组合层会加前缀
      // （0.1.7 实测为 include:dupguard），故再按名称包含关系匹配一次。
      const byName = view.namespaces.find(
        (item) => item !== null && typeof item === 'object' &&
          typeof item.ns === 'string' && item.ns.indexOf('dupguard') !== -1,
      )
      if (byName !== undefined) return byName
      // 兜底：entry id 完全变样时按字段签名识别。
      return view.namespaces.find((row) => {
        if (row === null || typeof row !== 'object') return false
        const value = row.value
        if (value === null || typeof value !== 'object') return false
        return SETTINGS_NS_SIGNATURE.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      })
    }

    /**
     * 从应答里取出本插件的命名空间行。
     * describe() 返回 { writable, namespaces:[行…] }，mutate() 直接返回该行本身
     * （官方 SettingsDescribeMirror.acceptView 亦按行处理），两种形状都要认。
     */
    function rowOfView(view) {
      if (view === null || typeof view !== 'object') return undefined
      if (typeof view.ns === 'string') return view
      return pickNamespace(view)
    }

    /**
     * 设置服务桥接：把「新版 remote.settings」与「旧版 settingsScope」统一成组件使用的
     * controller / mirror 两个面。任一服务可用时自动接入（新版优先），都不可用时
     * 保持 loading 状态，设置页显示「设置服务不可用」，插件本身照常激活。
     */
    function createSettingsBridge() {
      const listeners = new Set()
      let snapshot = { status: 'loading', value: undefined, user: undefined }
      let mirror = { status: 'idle', error: null, diag: '正在探测设置通道…' }
      let loopback = null // null = 未知：不据此拦截编辑
      let channel = null
      let channelKind = null
      let disposed = false
      /** describe 里解析出的命名空间名（新版用 entry id，旧版固定 dsh-dupguard）。 */
      let resolvedNamespace = SETTINGS_NS

      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (_error) {}
        }
      }
      const publish = (nextSnapshot, nextMirror) => {
        if (nextSnapshot !== undefined) snapshot = nextSnapshot
        if (nextMirror !== undefined) mirror = nextMirror
        notify()
      }
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }

      /** 新版（DSH ≥ 0.1.7）：typert remote 的 settings 命名空间。 */
      function remoteChannel(remote) {
        const settings = remote.settings
        let revision
        let tail = Promise.resolve()
        let generation = 0
        let closed = false
        let loaded = false

        const acceptView = (view, describeDiag) => {
          if (view !== null && typeof view === 'object' && view.writable === false) loopback = false
          const row = rowOfView(view)
          if (row === undefined) {
            publish(
              { status: 'unavailable', value: undefined, user: undefined },
              { status: 'ready', error: null, diag: String(describeDiag || '') + '；未匹配到本插件命名空间' },
            )
            return
          }
          if (typeof row.ns === 'string') resolvedNamespace = row.ns
          if (typeof row.revision === 'number') revision = row.revision
          publish(
            { status: 'ready', value: normalizeValue(row.value), user: row.user, revision: row.revision },
            { status: 'ready', error: null, diag: '命名空间 ' + resolvedNamespace },
          )
        }
        const load = async () => {
          const mine = ++generation
          try {
            const response = await settings.describe()
            if (closed || mine !== generation) return
            if (response === null || typeof response !== 'object' || response.ok !== true) {
              const message = responseError(response, 'settings.describe failed')
              publish(
                { status: 'unavailable', value: undefined, user: undefined },
                { status: 'error', error: message, diag: 'describe 未成功' },
              )
              return
            }
            const namespaces = response.value !== null && typeof response.value === 'object' && Array.isArray(response.value.namespaces)
              ? response.value.namespaces.map((row) => (row !== null && typeof row === 'object' && typeof row.ns === 'string' ? row.ns : '?'))
              : []
            console.info('[dupguard] remote.settings.describe 返回命名空间：' + (namespaces.join(', ') || '（空）'))
            acceptView(response.value, 'describe 返回 ' + String(namespaces.length) + ' 个命名空间 [' + namespaces.join(', ') + ']')
          } catch (error) {
            if (closed || mine !== generation) return
            publish(
              { status: 'unavailable', value: undefined, user: undefined },
              { status: 'error', error: errorText(error), diag: 'describe 抛异常' },
            )
          } finally {
            if (!closed && mine === generation) loaded = true
          }
        }
        /** 写入失败时面板上展示的宿主原始原因（诊断用）。 */
        let lastWriteError = null

        /** 只尝试属于本插件的命名空间名：describe 报出的 ns 与其去掉组合前缀的形式。 */
        const namespaceCandidates = () => {
          const list = [resolvedNamespace]
          const cut = resolvedNamespace.lastIndexOf(':')
          if (cut !== -1 && cut + 1 < resolvedNamespace.length) {
            const stripped = resolvedNamespace.slice(cut + 1)
            if (list.indexOf(stripped) === -1) list.push(stripped)
          }
          return list
        }

        const attempt = async (namespace, owned, expected) => {
          let response
          try {
            response = await settings.mutate(namespace, owned, expected)
          } catch (error) {
            return { ok: false, error: errorText(error) }
          }
          if (response === null || typeof response !== 'object') return { ok: false, error: '宿主应答无效' }
          if (response.ok === true) return { ok: true, value: response.value }
          return { ok: false, error: responseError(response, '宿主拒绝了该写入') }
        }

        const mutate = (ops) => {
          const owned = ops.map((op) => (op.op === 'set'
            ? { op: 'set', path: [...op.path], value: op.value }
            : { op: 'unset', path: [...op.path] }))
          const task = tail.then(async () => {
            if (closed || channel === null) return false
            // 首次写入前先完成一次 describe：否则命名空间与 revision 都还是初始值。
            if (!loaded) await load()
            const failures = []
            for (const namespace of namespaceCandidates()) {
              console.info('[dupguard] mutate → ' + namespace + ' revision=' + String(revision) +
                ' paths=' + JSON.stringify(owned.map((op) => op.path)))
              let result = await attempt(namespace, owned, revision)
              if (!result.ok) {
                // 常见于并发写入导致的 revision 过期：回读后按新 revision 重试一次。
                console.warn('[dupguard] mutate 被拒（' + namespace + '）：' + result.error + '，回读后重试')
                await load()
                result = await attempt(namespace, owned, revision)
              }
              if (result.ok) {
                lastWriteError = null
                if (!closed) acceptView(result.value)
                publish(undefined, { status: mirror.status, error: null, diag: '已写入命名空间 ' + namespace })
                return true
              }
              failures.push(namespace + '：' + result.error)
            }
            lastWriteError = failures.join('；')
            // 写失败：回读宿主真实状态，避免界面停留在错误的本地值；并把原因显示到面板。
            await load()
            publish(undefined, { status: mirror.status, error: '写入被拒绝 —— ' + lastWriteError, diag: 'mutate 失败' })
            return false
          })
          tail = task.then(() => {}, () => {})
          return task
        }
        /** 供组件展示的最近一次写入失败原因。 */
        const writeError = () => lastWriteError
        return {
          load,
          mutate,
          writeError,
          close: () => {
            closed = true
          },
        }
      }

      /** 旧版（DSH ≤ 0.1.6）：客户端 settingsScope 控制器。 */
      function legacyChannel(settingsScope) {
        const legacy = settingsScope.bind({
          namespace: SETTINGS_NS,
          // 自定义 decode：DSH 以 spec.decode(view.value) 调用，即直接传入本命名空间的
          // 设置值（{ ignoredChars, threshold, ... }），而非 wire 视图。
          decode: (value) => normalizeValue(value),
        })
        const legacyMirror = settingsScope.describe()
        const accept = () => {
          const current = legacy.getSnapshot()
          if (current === undefined) return
          publish({ status: current.status, value: current.value, user: current.user, revision: current.revision })
        }
        const stopScope = legacy.subscribe(accept)
        const stopMirror = legacyMirror.subscribe(() => {
          const current = legacyMirror.getSnapshot()
          if (current !== undefined) publish(undefined, { status: current.status, error: current.error })
        })
        // 旧版控制器可同步取快照：先发一帧，避免设置页出现无谓的「加载中」闪烁。
        accept()
        return {
          load: async () => {
            await legacyMirror.load()
            accept()
          },
          mutate: async (ops) => {
            let accepted = true
            for (const op of ops) {
              const pending = op.op === 'set' ? legacy.set(op.path[0], op.value) : legacy.unset(op.path[0])
              const ok = await pending
              if (ok === false) accepted = false
            }
            accept()
            return accepted
          },
          close: () => {
            stopScope()
            stopMirror()
            legacy.dispose()
          },
        }
      }

      /** 当前命名空间名（新版按 describe 结果解析；旧版固定 dsh-dupguard）。 */
      let currentNamespace = () => SETTINGS_NS

      function attach(kind, factory, service) {
        if (disposed) return () => {}
        if (channel !== null) {
          // 新版优先：两者并存（过渡版本）时切到 remote。
          if (kind !== 'remote' || channelKind === 'remote') return () => {}
          channel.close()
          channel = null
          channelKind = null
        }
        channel = factory(service)
        channelKind = kind
        publish(undefined, { status: 'loading', error: null, diag: '已接入 ' + kind + ' 通道，正在读取…' })
        Promise.resolve(channel.load()).catch(() => {})
        return () => {
          if (channel !== null && typeof channel.close === 'function') channel.close()
          channel = null
          channelKind = null
          publish({ status: 'loading', value: undefined, user: undefined }, { status: 'idle', error: null, diag: '通道已断开' })
        }
      }

      return {
        controller: {
          subscribe,
          getSnapshot: () => snapshot,
          set: (field, value) => {
            if (channel === null) {
              lastWriteError = '设置通道未就绪（channel=null）'
              return Promise.resolve(false)
            }
            return channel.mutate([{ op: 'set', path: [field], value }])
          },
          unset: (field) => {
            if (channel === null) {
              lastWriteError = '设置通道未就绪（channel=null）'
              return Promise.resolve(false)
            }
            return channel.mutate([{ op: 'unset', path: [field] }])
          },
        },
        mirror: {
          subscribe,
          getSnapshot: () => mirror,
          load: () => (channel === null ? Promise.resolve() : channel.load()),
        },
        isLoopback: () => loopback !== false,
        setLoopback: (value) => {
          loopback = value
        },
        /** 更新面板上的通道诊断文本（不改变数据状态）。 */
        note: (text) => publish(undefined, { status: mirror.status, error: mirror.error, diag: text }),
        /** 最近一次写入失败的宿主原因（旧版通道不提供时返回 null）。 */
        writeReason: () => (channel !== null && typeof channel.writeError === 'function' ? channel.writeError() : null),
        disposed: () => disposed,
        /** 是否已有可用通道（旧版接上后即可停止新版探测）。 */
        hasChannel: () => channel !== null,
        attachRemote: (remote) => attach('remote', remoteChannel, remote),
        attachLegacy: (settingsScope) => attach('legacy', legacyChannel, settingsScope),
        dispose: () => {
          disposed = true
          if (channel !== null && typeof channel.close === 'function') channel.close()
          channel = null
          channelKind = null
        },
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dupguard: dictionaries')
      const t = ctx.locale.bind(NS)
      const bridge = createSettingsBridge()
      ctx.effect(() => () => bridge.dispose(), 'dupguard: settings bridge')
      console.info('[dupguard] client apply：开始探测设置通道（remote.settings / settingsScope）')

      // 旧版连接对象（仅用于本机/远程判断）；新版用 remote.$host.isLoopback 与
      // describe 的 writable 字段。都取不到时不拦截编辑（写失败会给出明确提示）。
      try {
        const connection = ctx.get('connection')
        if (connection !== undefined && typeof connection.isLoopback === 'boolean') bridge.setLoopback(connection.isLoopback)
      } catch (_error) {}

      /** 从注入作用域/服务对象里取出 remote.settings 面（不同版本暴露形态不同）。 */
      function remoteSettingsFace(scope) {
        const candidates = []
        try {
          if (scope !== undefined && scope !== null) {
            if (scope.remote !== undefined && scope.remote !== null) candidates.push(scope.remote.settings)
            candidates.push(scope['remote.settings'])
          }
        } catch (_error) {}
        return candidates.find((face) => face !== undefined && face !== null && typeof face.describe === 'function')
      }

      /** remote 服务本体（读 $host.isLoopback / $on 用）。 */
      function remoteService(scope) {
        try {
          if (scope !== undefined && scope !== null && scope.remote !== undefined && scope.remote !== null) return scope.remote
        } catch (_error) {}
        try {
          const viaGet = ctx.get('remote')
          if (viaGet !== undefined && viaGet !== null) return viaGet
        } catch (_error) {}
        return undefined
      }

      let remoteAttached = false
      let pollTimer = null
      let pollCount = 0

      const stopPolling = () => {
        if (pollTimer !== null) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }

      const attachRemote = (scope) => {
        if (remoteAttached || bridge.disposed()) return
        const settings = remoteSettingsFace(scope)
        if (settings === undefined) return
        const remote = remoteService(scope)
        const face = remote !== undefined && remote.settings !== undefined ? remote : { settings }
        if (remote !== undefined && remote.$host !== undefined && typeof remote.$host.isLoopback === 'boolean') {
          bridge.setLoopback(remote.$host.isLoopback)
        }
        remoteAttached = true
        stopPolling()
        bridge.attachRemote(face)
        console.info('[dupguard] client apply：已接入 remote.settings 通道')
      }

      // 新版：remote + remote.settings（DSH ≥ 0.1.7）。
      // 必须同时声明父服务与点号服务：注入作用域只暴露被声明的服务，
      // 只写 'remote.settings' 时 scope.remote 是 undefined（1.6.0 的故障根因）。
      ctx.inject(['remote', 'remote.settings'], (scope) => {
        attachRemote(scope)
        if (!remoteAttached) bridge.note('remote.settings 已注入但服务面不可用')
        const disposers = []
        const remote = remoteService(scope)
        if (remote !== undefined && typeof remote.$on === 'function') {
          disposers.push(remote.$on('settings/document-updated', () => bridge.mirror.load()))
        }
        if (typeof scope.on === 'function') {
          disposers.push(scope.on('connection/reset', () => bridge.mirror.load()))
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch (_error) {}
          }
        }
      })

      // 兜底：命名空间服务是逐个 mount 的，注入回调可能早于服务面成型；
      // 用 ctx.get('remote.settings') 有界轮询（该访问器在服务注册后即可取到）。
      bridge.note('等待 remote.settings 命名空间…')
      if (typeof setInterval !== 'function') {
        bridge.note('环境无定时器，跳过通道轮询')
      } else {
        pollTimer = setInterval(() => {
          pollCount += 1
          attachRemote(ctx)
          if (!remoteAttached) bridge.note('等待 remote.settings（第 ' + String(pollCount) + ' 次探测）')
          if (remoteAttached || bridge.hasChannel() || pollCount >= 40) {
            stopPolling()
            if (!remoteAttached && !bridge.hasChannel()) {
              console.warn('[dupguard] 未找到 remote.settings 命名空间，设置页将显示为不可用')
            }
          }
        }, 400)
      }
      ctx.effect(() => () => {
        if (pollTimer !== null) clearInterval(pollTimer)
        pollTimer = null
      }, 'dupguard: settings probe')

      // 旧版：settingsScope（DSH ≤ 0.1.6）。
      ctx.inject(['settingsScope'], (scope) => {
        const settingsScope = scope === undefined || scope === null ? undefined : scope.settingsScope
        if (settingsScope === undefined) return () => {}
        const detach = bridge.attachLegacy(settingsScope)
        stopPolling() // 旧版通道已可用，不必再探测新版服务
        return detach
      })

      const injected = () => ({
        controller: bridge.controller,
        mirror: bridge.mirror,
        t,
        // 传函数而非快照：远程/只读状态可能由 describe 的 writable 或
        // remote.$host.isLoopback 稍后确定，渲染时必须取最新值。
        isLoopback: () => bridge.isLoopback(),
        writeReason: () => bridge.writeReason(),
      })
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dupguard',
        order: 25,
        label: () => t('nav'),
        inject: injected,
      }, DupguardSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
