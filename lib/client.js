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
    const BUILD_MARK = '1.7.0'
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
      list: '忽略字符（白名单，按单个字符匹配）',
      empty: '白名单为空：所有字符都参与重复统计。',
      addPlaceholder: '输入要忽略的字符（可多个）',
      add: '添加',
      substrings: '忽略片段（多字符，按整段匹配）',
      substringsEmpty: '片段白名单为空：没有整段被忽略的字符串。',
      substringAddPlaceholder: '输入要整段忽略的字符串（如 |---|）',
      substringAdd: '添加片段',
      substringHint: '整段字面量匹配（区分大小写、不支持正则）：命中时先整段剔除，再做去空白与逐字符剔除。长片段优先。每项 ≤ {maxLen} 字符、最多 {maxCount} 项。',
      errSubstringEmpty: '请输入非空片段。',
      errSubstringTooLong: '片段过长：每项最多 {maxLen} 个字符。',
      errSubstringDuplicate: '该片段已在列表中。',
      errSubstringLimit: '片段数量已达上限（{maxCount} 项）。',
      params: '检测参数',
      threshold: '触发阈值（连续重复次数）',
      thresholdHint: '同一字符串连续重复达到该次数即截停（≥ 语义）。范围 {min}–{max}。',
      minUnitLength: '最小重复单元长度',
      minUnitLengthHint: '参与检测的重复单元最小字符数。范围 {min}–{max}；设为 1 可捕获单字符循环。',
      maxUnitLength: '最大重复单元长度',
      maxUnitLengthHint: '可识别的最长重复单元（清洗后字符数，空白与白名单字符不计）。范围 {min}–{max}。',
      detectionWindow: '检测窗口（字符）',
      detectionWindowHint: '检测缓冲保留的字符数。范围 {min}–{max}；需 ≥ 阈值 × 代码块倍数 × 最大单元长度，否则长单元凑不满重复次数。',
      codeBlockMultiplier: '代码块内阈值倍数',
      codeBlockMultiplierHint: '围栏代码块（``` / ~~~）内的处理分三档：≥2 = 块内按「阈值 × 本倍数」判定（默认 3，避免误杀正常代码）；1 = 块内与块外同样严格；0 = 完全不检测块内（生成的代码再长也不会被截停）。范围 {min}–{max}。',
      stripWhitespace: '忽略空白字符',
      stripWhitespaceHint: '检测前移除所有空白（含换行），使「重复 重复」「重复\\n重复」这类带分隔的复读也能识别。',
      skipCodeBlocks: '放宽代码块内的检测',
      skipCodeBlocksHint: '开启后围栏代码块（``` / ~~~）内改用放宽阈值，避免生成的代码、测试夹具、表格、ASCII 图被误判为复读；行内代码与缩进代码块不受影响。',
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
      windowWarn: '⚠ 检测窗口长度需要提高：至少 {need}（当前 {current} = 阈值 {threshold} × 代码块倍数 {multiplier} × 最大单元 {maxUnit}）。当前窗口下超过 {effective} 字符的重复单元无法识别。',
      loading: '加载中…',
      loadingDiag: '设置通道：{state}｜{diag}',
      remoteHint: '设置修改仅支持本机连接：请通过本机地址（127.0.0.1）打开 DSH 页面后重试。远程访问、或当前 DSH 版本禁用了设置写入时，检测参数将按宿主当前配置运行。',
      unavailable: '设置服务不可用：未读取到「重复守卫」的设置数据。请确认插件已挂载（宿主日志应含「[dupguard] 常驻插件 apply 开始」）且该版本提供设置通道（DSH ≥ 0.1.7 需插件导出 Config），然后刷新页面重试。',
    }
    const en = {
      nav: 'Dupguard',
      title: 'Repetition Guard',
      intro: 'Generation stops when the same string repeats consecutively up to the threshold. Changes below take effect immediately and persist to settings.yaml.',
      list: 'Ignored characters (whitelist, matched per character)',
      empty: 'Whitelist is empty: every character counts.',
      addPlaceholder: 'Characters to ignore (one or more)',
      add: 'Add',
      substrings: 'Ignored substrings (multi-character, matched whole)',
      substringsEmpty: 'No ignored substrings: nothing is stripped as a whole.',
      substringAddPlaceholder: 'String to ignore as a whole (e.g. |---|)',
      substringAdd: 'Add substring',
      substringHint: 'Literal match of the whole substring (case-sensitive, no regex): matches are stripped first, then whitespace and per-character rules apply. Longer substrings win. Each entry ≤ {maxLen} characters, at most {maxCount} entries.',
      errSubstringEmpty: 'Enter a non-empty substring.',
      errSubstringTooLong: 'Substring too long: at most {maxLen} characters each.',
      errSubstringDuplicate: 'That substring is already in the list.',
      errSubstringLimit: 'Substring limit reached ({maxCount} entries).',
      params: 'Detection parameters',
      threshold: 'Threshold (consecutive repeats)',
      thresholdHint: 'Stop once a string repeats this many times in a row (>= semantics). Range {min}–{max}.',
      minUnitLength: 'Minimum repeating-unit length',
      minUnitLengthHint: 'Shortest repeating unit considered, in characters. Range {min}–{max}; 1 catches single-character loops.',
      maxUnitLength: 'Maximum repeating-unit length',
      maxUnitLengthHint: 'Longest repeating unit recognized, in characters after cleaning (whitespace and whitelisted characters are removed). Range {min}–{max}.',
      detectionWindow: 'Detection window (characters)',
      detectionWindowHint: 'Characters retained in the detection buffer. Range {min}–{max}; must be >= threshold x code-block multiplier x max unit length, otherwise long units never reach the repeat count.',
      codeBlockMultiplier: 'Code-block threshold multiplier',
      codeBlockMultiplierHint: 'How fenced code blocks (``` / ~~~) are handled: >=2 = judge inside them by threshold x this multiplier (default 3, fewer false stops on generated code); 1 = same strictness as outside; 0 = do not detect inside code blocks at all. Range {min}-{max}.',
      stripWhitespace: 'Ignore whitespace',
      stripWhitespaceHint: 'Remove all whitespace (newlines included) before detection, so separated repeats are still recognized.',
      skipCodeBlocks: 'Relax detection inside code blocks',
      skipCodeBlocksHint: 'With this on, fenced code blocks (``` / ~~~) use the relaxed threshold, so generated code, fixtures, tables and ASCII art are not mistaken for repetition loops. Inline code and indented code blocks are unaffected.',
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
      windowWarn: '⚠ Detection window is too small: needs at least {need} (currently {current} = threshold {threshold} x code-block multiplier {multiplier} x max unit {maxUnit}). Units longer than {effective} characters cannot be detected with the current window.',
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
      '.dg-btn{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;font-family:inherit}',
      '.dg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dg-note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}',
      '.dg-empty{color:var(--dsw-alias-label-tertiary);margin:0}',
      '.dg-fields{display:flex;flex-direction:column;gap:12px}',
      '.dg-field{display:flex;flex-direction:column;gap:4px}',
      '.dg-field-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dg-field-label{color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dg-field-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}',
      '.dg-field-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:0}',
      '.dg-num{box-sizing:border-box;width:110px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;text-align:right;outline:none}',
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
      { key: 'detectionWindow', min: 64, max: 1048576 },
    ]
    const BOOL_FIELDS = ['stripWhitespace', 'skipCodeBlocks', 'monitorReasoning', 'monitorToolArguments']
    const DEFAULTS = {
      ignoredChars: ['-', '|'],
      ignoredSubstrings: [],
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
    const ALL_FIELDS = ['ignoredChars', 'ignoredSubstrings'].concat(NUMERIC_FIELDS.map((field) => field.key), BOOL_FIELDS)

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
      const [draftSub, setDraftSub] = React.useState('')
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
      const parsed = {}
      let numericValid = true
      for (const field of NUMERIC_FIELDS) {
        const value = parseInt10(shown[field.key])
        parsed[field.key] = value
        if (!Number.isInteger(value) || value < field.min || value > field.max) numericValid = false
      }
      const crossInvalid = Number.isInteger(parsed.minUnitLength) && Number.isInteger(parsed.maxUnitLength) &&
        parsed.maxUnitLength < parsed.minUnitLength

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

      // 窗口缺口提示：窗口 < 最严格阈值 × 最大单元长度时，更长的单元无法凑满重复次数。
      // 代码块内按倍数分档：0 = 完全不检测（不提高窗口要求）、1 = 与块外同严格、≥2 = 放宽。
      const codeMode = shown.skipCodeBlocks === true ? parsed.codeBlockMultiplier : 1
      const strictThreshold = codeMode === 0 ? parsed.threshold : parsed.threshold * codeMode
      const shortfall = numericValid && !crossInvalid && parsed.detectionWindow < strictThreshold * parsed.maxUnitLength
        ? {
            need: strictThreshold * parsed.maxUnitLength,
            current: parsed.detectionWindow,
            threshold: parsed.threshold,
            multiplier: codeMode === 0 ? 1 : codeMode,
            maxUnit: parsed.maxUnitLength,
            effective: Math.floor(parsed.detectionWindow / strictThreshold),
          }
        : null

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
        runWrite(() => controller.set(field.key, value))
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

      const add = () => {
        const text = draft.trim()
        if (text.length === 0) return
        setDraft('')
        // 白名单按单个字符匹配：一次输入多个字符时逐个加入（忽略输入中的空白），
        // 否则整串会被当成一个条目，永远不会命中。
        const next = [...shown.ignoredChars]
        let changed = false
        for (const ch of text) {
          if (/\s/.test(ch)) continue
          if (next.indexOf(ch) !== -1) continue
          next.push(ch)
          changed = true
        }
        if (changed) commitFieldList('ignoredChars', next)
      }
      const remove = (ch) => commitFieldList('ignoredChars', shown.ignoredChars.filter((item) => item !== ch))

      /**
       * 片段白名单：与字符白名单不同，**不按码点拆分**——整段就是一个条目。
       * 校验空值/超长/重复/超量，错误就地显示且不写入。
       */
      const addSubstring = () => {
        const text = draftSub.trim()
        const fail = (message) => setErrors((prev) => ({ ...prev, substrings: message }))
        if (text.length === 0) {
          fail(t('errSubstringEmpty'))
          return
        }
        const length = [...text].length
        if (length > MAX_SUBSTRING_LENGTH) {
          fail(fmt(t('errSubstringTooLong'), { maxLen: MAX_SUBSTRING_LENGTH }))
          return
        }
        if (shown.ignoredSubstrings.indexOf(text) !== -1) {
          fail(t('errSubstringDuplicate'))
          return
        }
        if (shown.ignoredSubstrings.length >= MAX_SUBSTRINGS) {
          fail(fmt(t('errSubstringLimit'), { maxCount: MAX_SUBSTRINGS }))
          return
        }
        setDraftSub('')
        setErrors((prev) => ({ ...prev, substrings: null }))
        commitFieldList('ignoredSubstrings', [...shown.ignoredSubstrings, text])
      }
      const removeSubstring = (item) =>
        commitFieldList('ignoredSubstrings', shown.ignoredSubstrings.filter((entry) => entry !== item))

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
        shown.ignoredChars.length === 0
          ? React.createElement('p', { className: 'dg-empty' }, t('empty'))
          : React.createElement('div', { className: 'dg-chips' },
            shown.ignoredChars.map((ch) => React.createElement('span', { className: 'dg-chip', key: ch },
              ch,
              React.createElement('button', {
                className: 'dg-chip-remove',
                type: 'button',
                onClick: () => remove(ch),
                'aria-label': 'remove',
              }, '\u00d7')))),
        React.createElement('div', { className: 'dg-add' },
          React.createElement('input', {
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

        React.createElement('p', { className: 'dg-note' }, t('substrings')),
        shown.ignoredSubstrings.length === 0
          ? React.createElement('p', { className: 'dg-empty' }, t('substringsEmpty'))
          : React.createElement('div', { className: 'dg-chips' },
            shown.ignoredSubstrings.map((item) => React.createElement('span', { className: 'dg-chip', key: item },
              item,
              React.createElement('button', {
                className: 'dg-chip-remove',
                type: 'button',
                onClick: () => removeSubstring(item),
                'aria-label': 'remove',
              }, '\u00d7')))),
        React.createElement('div', { className: 'dg-add' },
          React.createElement('input', {
            className: 'dg-input',
            placeholder: t('substringAddPlaceholder'),
            value: draftSub,
            onChange: (event) => setDraftSub(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') addSubstring()
            },
          }),
          React.createElement('button', { className: 'dg-btn', type: 'button', onClick: addSubstring }, t('substringAdd')),
        ),
        React.createElement('p', { className: 'dg-field-hint' },
          fmt(t('substringHint'), { maxLen: MAX_SUBSTRING_LENGTH, maxCount: MAX_SUBSTRINGS })),
        errors.substrings === undefined || errors.substrings === null
          ? null
          : React.createElement('p', { className: 'dg-field-error' }, errors.substrings),

        React.createElement('p', { className: 'dg-note' }, t('params')),
        React.createElement('div', { className: 'dg-fields' },
          NUMERIC_FIELDS.map((field) => fieldRow(field)),
          BOOL_FIELDS.map((key) => switchRow(key)),
        ),
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
            })),
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
