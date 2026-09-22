/**
 * dupguard 浏览器端 bundle（单文件，经 window.__ModuleLoader__ 加载）。
 *
 * 在 DSH 设置面板注册一个与「通用设置 / 模型 / 插件 / Agent 预设」并列的
 * 分节「重复守卫」：白名单（检测时忽略的字符）与全部检测参数的可视化编辑界面。
 * 数据经 settingsScope 绑定宿主 settings 服务的 "dsh-dupguard" 命名空间，
 * 修改即时生效并持久化（settings.yaml）。
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
    const SETTINGS_NS = 'dsh-dupguard'

    const zh = {
      nav: '重复守卫',
      title: '重复输出守卫',
      intro: '模型输出中同一字符串连续重复达到阈值次数时自动截停。以下参数修改后即时生效并持久化（settings.yaml）。',
      list: '忽略字符（白名单，按单个字符匹配）',
      empty: '白名单为空：所有字符都参与重复统计。',
      addPlaceholder: '输入要忽略的字符（可多个）',
      add: '添加',
      params: '检测参数',
      threshold: '触发阈值（连续重复次数）',
      thresholdHint: '同一字符串连续重复达到该次数即截停（≥ 语义）。范围 {min}–{max}。',
      minUnitLength: '最小重复单元长度',
      minUnitLengthHint: '参与检测的重复单元最小字符数。范围 {min}–{max}；设为 1 可捕获单字符循环。',
      maxUnitLength: '最大重复单元长度',
      maxUnitLengthHint: '可识别的最长重复单元（清洗后字符数，空白与白名单字符不计）。范围 {min}–{max}。',
      detectionWindow: '检测窗口（字符）',
      detectionWindowHint: '检测缓冲保留的字符数。范围 {min}–{max}；需 ≥ 阈值 × 最大单元长度，否则长单元凑不满重复次数。',
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
      windowWarn: '⚠ 检测窗口长度需要提高：至少 {need}（当前 {current} = 阈值 {threshold} × 最大单元 {maxUnit}）。当前窗口下超过 {effective} 字符的重复单元无法识别。',
      loading: '加载中…',
      remoteHint: '设置修改仅支持本机连接：请通过本机地址（127.0.0.1）打开 DSH 页面后重试。远程访问时 DSH 的设置通道被禁用，检测参数将使用默认值。',
      unavailable: '设置服务不可用：未读取到「重复守卫」的设置数据。请确认 DSH 为 npm 常驻版挂载（宿主日志应包含「已注册设置命名空间 dsh-dupguard」），并刷新页面重试。',
    }
    const en = {
      nav: 'Dupguard',
      title: 'Repetition Guard',
      intro: 'Generation stops when the same string repeats consecutively up to the threshold. Changes below take effect immediately and persist to settings.yaml.',
      list: 'Ignored characters (whitelist, matched per character)',
      empty: 'Whitelist is empty: every character counts.',
      addPlaceholder: 'Characters to ignore (one or more)',
      add: 'Add',
      params: 'Detection parameters',
      threshold: 'Threshold (consecutive repeats)',
      thresholdHint: 'Stop once a string repeats this many times in a row (>= semantics). Range {min}–{max}.',
      minUnitLength: 'Minimum repeating-unit length',
      minUnitLengthHint: 'Shortest repeating unit considered, in characters. Range {min}–{max}; 1 catches single-character loops.',
      maxUnitLength: 'Maximum repeating-unit length',
      maxUnitLengthHint: 'Longest repeating unit recognized, in characters after cleaning (whitespace and whitelisted characters are removed). Range {min}–{max}.',
      detectionWindow: 'Detection window (characters)',
      detectionWindowHint: 'Characters retained in the detection buffer. Range {min}–{max}; must be >= threshold x max unit length, otherwise long units never reach the repeat count.',
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
      windowWarn: '⚠ Detection window is too small: needs at least {need} (currently {current} = threshold {threshold} x max unit {maxUnit}). Units longer than {effective} characters cannot be detected with the current window.',
      loading: 'Loading…',
      remoteHint: 'Settings editing requires a local connection: open the DSH page through the local address (127.0.0.1) and retry. Remote browsers have the settings channel disabled and detection keeps its defaults.',
      unavailable: 'Settings unavailable: no data for the Dupguard section was received. Verify the npm build is mounted (the host log should contain "已注册设置命名空间 dsh-dupguard") and refresh the page.',
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

    const inject = ['slots', 'locale', 'connection', 'settingsScope']

    // ---------------------------------------------------------------------
    // 字段元数据：与宿主 lib/index.js 的 LIMITS / CONFIG 必须保持一致。
    // ---------------------------------------------------------------------
    const NUMERIC_FIELDS = [
      { key: 'threshold', min: 2, max: 1000 },
      { key: 'minUnitLength', min: 1, max: 4096 },
      { key: 'maxUnitLength', min: 1, max: 8192 },
      { key: 'detectionWindow', min: 64, max: 1048576 },
    ]
    const BOOL_FIELDS = ['stripWhitespace', 'monitorReasoning', 'monitorToolArguments']
    const DEFAULTS = {
      ignoredChars: ['-', '|'],
      threshold: 10,
      minUnitLength: 1,
      maxUnitLength: 80,
      detectionWindow: 8192,
      stripWhitespace: true,
      monitorReasoning: true,
      monitorToolArguments: false,
    }
    const ALL_FIELDS = ['ignoredChars'].concat(NUMERIC_FIELDS.map((field) => field.key), BOOL_FIELDS)

    /** 模板占位符替换：{name} → vars.name。 */
    const fmt = (text, vars) =>
      String(text).replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? match : String(vars[key])))

    /**
     * 把宿主设置值归一化为完整形态：缺失或越界的字段回落默认，
     * 保证任何异常形状到达视图时仍是 ready 且可渲染。
     */
    function normalizeValue(raw) {
      const out = { ignoredChars: [...DEFAULTS.ignoredChars] }
      for (const field of NUMERIC_FIELDS) out[field.key] = DEFAULTS[field.key]
      for (const key of BOOL_FIELDS) out[key] = DEFAULTS[key]
      try {
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          if (Array.isArray(raw.ignoredChars)) {
            out.ignoredChars = raw.ignoredChars.filter((ch) => typeof ch === 'string')
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
      const form = { ignoredChars: normalized.ignoredChars }
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

      if (props.isLoopback === false) {
        return React.createElement('div', { className: 'dg-section' },
          React.createElement('h2', { className: 'dg-title' }, t('title')),
          React.createElement('p', { className: 'dg-intro' }, t('remoteHint')))
      }
      if (snap.status === 'unavailable') {
        return React.createElement('div', { className: 'dg-section' },
          React.createElement('h2', { className: 'dg-title' }, t('title')),
          React.createElement('p', { className: 'dg-intro' }, t('unavailable')))
      }
      if (!ready || shown === null) {
        const mirrorError = mirrorSnap && mirrorSnap.error ? String(mirrorSnap.error) : null
        const mirrorStatus = mirrorSnap ? String(mirrorSnap.status) : 'unknown'
        return React.createElement('div', { className: 'dg-section' },
          React.createElement('p', { className: 'dg-empty' }, t('loading')),
          React.createElement('p', { className: 'dg-note' },
            'mirror=' + mirrorStatus + (mirrorError === null ? '' : ' error=' + mirrorError)))
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

      // 窗口缺口提示：窗口 < 阈值 × 最大单元长度时，更长的单元无法凑满重复次数。
      const shortfall = numericValid && !crossInvalid && parsed.detectionWindow < parsed.threshold * parsed.maxUnitLength
        ? {
            need: parsed.threshold * parsed.maxUnitLength,
            current: parsed.detectionWindow,
            threshold: parsed.threshold,
            maxUnit: parsed.maxUnitLength,
            effective: Math.floor(parsed.detectionWindow / parsed.threshold),
          }
        : null

      // ---- 写路径：settingsScope 控制器（DSH 自己的设置写通道，自动携带 revision、
      // 串行化并发写、把宿主应答折叠回镜像）。DSH 0.1.2 起客户端不再暴露
      // connection.api，控制器接口自 0.1.1 起稳定，故不直接触碰 wire 面。 ----
      const snapshotValue = () => {
        const current = controller.getSnapshot()
        return current !== undefined && current.value !== undefined ? current.value : {}
      }
      const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
        a.length === b.length && a.every((item, index) => item === b[index])
      const currentForm = () => (form === null ? remoteForm : form)
      const runWrite = (operation, verify) => {
        setWriteState('saving')
        Promise.resolve()
          .then(() => operation())
          .then(() => setWriteState(verify() ? 'saved' : 'error:' + t('saveFailed')), (error) => {
            setWriteState('error:' + String((error && error.message) || error))
          })
      }
      const commitList = (next) => {
        dirty.current.ignoredChars = true
        setForm({ ...currentForm(), ignoredChars: next })
        runWrite(() => controller.set('ignoredChars', next), () => sameList(snapshotValue().ignoredChars, next))
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
        // 污染 settings.yaml 并让「恢复默认」失去意义。
        if (snapshotValue()[field.key] === value) {
          dirty.current[field.key] = false
          setForm({ ...currentForm(), [field.key]: String(value) })
          return
        }
        dirty.current[field.key] = true
        setForm({ ...currentForm(), [field.key]: String(value) })
        runWrite(() => controller.set(field.key, value), () => snapshotValue()[field.key] === value)
      }
      const commitBool = (key) => {
        const value = shown[key] !== true
        dirty.current[key] = true
        setForm({ ...currentForm(), [key]: value })
        runWrite(() => controller.set(key, value), () => snapshotValue()[key] === value)
      }
      const resetAll = () => {
        dirty.current = {}
        setErrors({})
        runWrite(
          () => Promise.all(ALL_FIELDS.map((key) => controller.unset(key))),
          () => {
            setForm(toForm(snapshotValue()))
            const current = controller.getSnapshot()
            const user = current !== undefined ? current.user : undefined
            if (user === undefined || user === null) return true
            return ALL_FIELDS.every((key) => user[key] === undefined)
          },
        )
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
        if (changed) commitList(next)
      }
      const remove = (ch) => commitList(shown.ignoredChars.filter((item) => item !== ch))

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
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dupguard: dictionaries')
      const t = ctx.locale.bind(NS)
      const connection = ctx.get('connection')
      const isLoopback = connection !== undefined && connection.isLoopback === true
      // 自定义 decode：绕开客户端 schema 复水化与校验。DSH 的 SettingsScopeController
      // 以 spec.decode(view.value) 调用，即直接传入本命名空间的设置值
      // （{ignoredChars, threshold, ...}），而非 wire 视图。
      const controller = ctx.settingsScope.bind({
        namespace: SETTINGS_NS,
        decode: (value) => normalizeValue(value),
      })
      const mirror = ctx.settingsScope.describe()
      ctx.effect(() => () => {
        controller.dispose()
      }, 'dupguard: settings scope')
      const injected = () => ({ controller, t, isLoopback, mirror })
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
