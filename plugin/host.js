// ============================================================================
// dupguard —— DSH 动态 Cordis 插件（Host 端）
//
// 实时检测大模型流式输出中的重复内容：当最新的输出中同一字符串连续重复
// CONFIG.threshold 次及以上时，立即停止本次生成。
//
// 用法：把整个文件内容作为 cordis_define 的 code.host 传入即可，
//       不需要修改任何 DSH 组合（composition）文件。
// 需要随 DSH 常驻时，请改用 npm/组合形式 lib/index.js（与本文件行为一致，
// tests/detector.test.js 会对两个入口跑同一套用例防止漂移）。
// 安装/运行步骤与配置说明见仓库根目录的 README.md。
//
// 说明：动态插件代码体不能 require 依赖，因此本版本不集成 settings 服务，
// 全部检测参数固定取本文件顶部的 CONFIG。npm 常驻版（lib/index.js）会注册
// "dsh-dupguard" 设置命名空间并提供 Web 设置页（lib/client.js），
// 白名单与检测参数（阈值/单元长度/窗口/空白与 reasoning、工具参数开关）
// 均可在设置中动态调整并持久化；两版默认值保持一致。
// ============================================================================

/**
 * 片段白名单（ignoredSubstrings）的上限。
 *
 * 两者同时界定「跨增量保留的尾巴长度（≤ 最长片段 - 1 码点）」与单增量匹配成本，
 * 因此是代码常量而非可调设置。
 */
const IGNORED_SUBSTRINGS_MAX_COUNT = 64
const IGNORED_SUBSTRING_MAX_LENGTH = 64

const CONFIG = {
  // 触发阈值：同一字符串连续重复次数达到该值时停止输出（用户需求：重复十次以上）。
  // 语义为「>= threshold」，即第 10 次重复出现时就触发。
  threshold: 10,
  // 参与检测的重复单元的最小/最大长度（字符数）。
  // minUnitLength=1 意味着 "aaaaaaaaaa" 这类单字符循环也会触发。
  minUnitLength: 1,
  maxUnitLength: 80,
  // 检测用滚动窗口（字符数，去除空白后）。
  // 只需要容纳 threshold * maxUnitLength（默认 10 * 80 = 800），留足余量即可。
  detectionWindow: 8192,
  // 检测前先移除所有空白字符（含换行）：
  // 让 "重复 重复 重复"、"重复\n重复\n重复" 这类带分隔符的复读也能被识别。
  stripWhitespace: true,
  // 检测时忽略的字符（白名单）：Markdown 表格的分隔行由连字符与竖线组成
  // （如 "|---|---|"），正常表格输出会大量连续出现，不应视为复读。
  // 默认忽略连字符与竖线；需要更严格的检测时可改为空数组 []。
  ignoredChars: ['-', '|'],
  // 片段白名单：整段匹配的多字符串（字面量、区分大小写、不支持正则）。
  // 命中时先整段剔除，再做去空白与逐字符剔除 —— 用于 `|---|`、`------` 这类
  // 由多个字符组成的固定片段：逐字符白名单只能忽略单个字符，组合片段的重复
  // 仍会被计入。长片段优先匹配，避免 `---` 抢先破坏 `-----`。
  // 上限：每项 ≤ IGNORED_SUBSTRING_MAX_LENGTH 码点、数组 ≤ IGNORED_SUBSTRINGS_MAX_COUNT 项。
  // 代价：为跨增量匹配，每块最多保留（最长片段 - 1）个码点不参与检测（tail 延迟）。
  ignoredSubstrings: [],
  // 重复次数策略：simple（固定阈值，默认）/ table（分段表）。动态版无设置页且不加载外部
  // 模块，故 module 模式在此退化为 simple 并告警一次（该模式仅在 npm 常驻版可用）。
  thresholdMode: 'simple',
  // 分段表：`"<maxLen>:<count>[, …][, *:<count>]"`，例 "1:40, 2:30, 8:12, *:10"。
  thresholdByLength: '',
  // 围栏代码块（``` / ~~~）内的重复检测按倍数分三档：
  //   ≥2 → 放宽：块内改用 threshold × codeBlockMultiplier 判定（默认 3），
  //        既能放过正常代码，又能兜住真正的失控复读；
  //   1  → 不放宽：块内与块外同样严格；
  //   0  → 完全不检测：块内内容不参与重复统计（生成的代码再长也不会被截停），
  //        跨围栏边界会清空检测缓冲，避免把围栏两侧文本凑成人为重复。
  // 置 skipCodeBlocks=false 则整体关闭该机制（三档都不生效）。
  // 局限：只识别围栏代码块，行内代码（`x`）与缩进代码块（4 空格）仍按普通阈值判定；
  // 模型忘记闭合围栏时，其后内容都按代码块处理。
  // 动态版无设置页，此处为代码常量；npm 常驻版可在设置页动态调整同名参数。
  skipCodeBlocks: true,
  codeBlockMultiplier: 3,
  // 是否同时检测思考（reasoning）文本。默认开启：思考中的复读同样消耗 token，
  // 应立即截停。注意：正常思考中若连续重复同一字符串 10 次以上（如"等等等等"），
  // 也会被截停，属预期行为；需要只检测可见输出时可置为 false。
  monitorReasoning: true,
  // 是否同时检测工具调用参数（JSON 片段）。默认关闭：JSON / base64 中重复字符很常见。
  monitorToolArguments: false,
  // DSH ≤ 0.1.2-rc.1 兼容补丁（默认开启；实测 0.1.1-rc.1 / 0.1.2-rc.1 仍未修复）：preset 的 standing mount
  // 在 composition 文件变化后
  // 会新建一代而旧代永不销毁，tool-cordis 每次挂载都向进程全局的 cordisInspect 注册表
  // 注册 Service/Event/Builtin/Tool provider，两代并存即抛
  // "Host Cordis inspect provider ... is already registered"（表现为：截停后模型操作报
  // resume failed，且必须重启 DSH 才能恢复）。开启后本插件把 cordisInspect.register
  // 幂等化（同 id 已注册时共享注册），消除多代冲突。补丁进程内常驻（卸载本插件后
  // 依然生效，重启 DSH 后由本插件重新安装）；DSH 升级修复后可关闭。
  fixStandingMountConflict: true,
}

/**
 * 尾部连续重复检测：text 是否以某个 unit（长度 minUnitLength..maxUnitLength）
 * 连续重复 >= threshold 次结尾。是则返回 { unit, count, span }，否则返回 null。
 *
 * 说明：由于本插件对每个增量实时调用本函数，模型一旦陷入复读循环，
 * 循环必然发生在文本尾部，因此尾部检测即可覆盖所有循环场景；
 * 不做全窗口词频统计，是为了避免正常文本（例如中文里高频出现的"的"）
 * 被误判为重复。
 */
function findRepeatedTail(text, threshold, minUnitLength, maxUnitLength, policy) {
  const n = text.length
  if (policy === undefined) {
    if (n < threshold * minUnitLength) return null
    const maxP = Math.min(maxUnitLength, Math.floor(n / threshold))
    for (let p = minUnitLength; p <= maxP; p++) {
      const unit = text.slice(n - p) // 最后一个候选单元
      let ok = true
      for (let k = 1; k < threshold; k++) {
        // 向前逐段比较前 threshold-1 个副本
        if (text.slice(n - p * (k + 1), n - p * k) !== unit) {
          ok = false
          break
        }
      }
      if (ok) return { unit, count: threshold, span: p * threshold }
    }
    return null
  }
  // 策略模式：每个候选长度用各自的 need 判定（0 = 该长度不判定）。
  if (policy.minNeed < 2 || n < policy.minNeed * minUnitLength) return null
  const maxP = Math.min(maxUnitLength, Math.floor(n / policy.minNeed))
  for (let p = minUnitLength; p <= maxP; p++) {
    const need = policy.counts[p]
    if (need < 2 || n < need * p) continue
    const unit = text.slice(n - p)
    let ok = true
    for (let k = 1; k < need; k++) {
      if (text.slice(n - p * (k + 1), n - p * k) !== unit) {
        ok = false
        break
      }
    }
    if (ok) return { unit, count: need, span: p * need }
  }
  return null
}

/** 策略次数是否可用（整数 2–1000）。 */
function isValidNeed(value) {
  return Number.isSafeInteger(value) && value >= 2 && value <= 1000
}

/** 解析分段表字符串 → 升序条目数组（maxLength === null 表示 `*`）。 */
function parseThresholdByLength(raw) {
  const entries = []
  for (const part of String(raw === undefined || raw === null ? '' : raw).split(',')) {
    const text = part.trim()
    if (text.length === 0) continue
    const match = /^(\*|\d+)\s*:\s*(\d+)$/.exec(text)
    if (match === null) continue
    const count = Number(match[2])
    if (!isValidNeed(count)) continue
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

/** 构建阈值策略：simple 返回 undefined（快路径）；table 生成 counts 表。 */
function createThresholdPolicy(config, multiplier) {
  if (config.thresholdMode === 'module') {
    console.warn('[dupguard] 动态版不支持高级模式（module），已回退固定阈值 ' + String(config.threshold) + '；如需该模式请使用 npm 常驻版。')
    return undefined
  }
  if (config.thresholdMode !== 'table') return undefined
  const entries = parseThresholdByLength(config.thresholdByLength)
  if (entries.length === 0) {
    console.warn('[dupguard] 分段表模式已启用但分段表为空，回退固定阈值 ' + String(config.threshold) + '。')
    return undefined
  }
  const scale = multiplier === undefined ? 1 : multiplier
  const counts = new Int32Array(config.maxUnitLength + 1)
  for (let p = config.minUnitLength; p <= config.maxUnitLength; p++) {
    let need = config.threshold
    for (const entry of entries) {
      if (entry.maxLength === null || p <= entry.maxLength) {
        need = entry.count
        break
      }
    }
    counts[p] = scale === 1 ? need : need * scale
  }
  let minNeed = Number.MAX_SAFE_INTEGER
  let worstSpan = 0
  for (let p = config.minUnitLength; p <= config.maxUnitLength; p++) {
    if (counts[p] < 2) continue
    if (counts[p] < minNeed) minNeed = counts[p]
    if (p * counts[p] > worstSpan) worstSpan = p * counts[p]
  }
  return {
    counts,
    minNeed: minNeed === Number.MAX_SAFE_INTEGER ? 0 : minNeed,
    worstSpan,
    source: 'table',
  }
}

/** 移除所有空白字符（与 CONFIG.stripWhitespace 配合）。 */
function stripWhitespace(text) {
  return text.replace(/\s+/g, '')
}

/** 移除白名单字符（与 CONFIG.ignoredChars 配合）。 */
function stripIgnoredChars(text, ignored) {
  if (ignored.length === 0) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ignored.indexOf(ch) === -1) out += ch
  }
  return out
}

/** 供检测使用的增量清洗：去空白 + 移除白名单字符（片段剔除在此之前完成）。 */
function sanitizePiece(text, config) {
  let piece = config.stripWhitespace ? stripWhitespace(text) : text
  if (config.ignoredChars.length > 0) piece = stripIgnoredChars(piece, config.ignoredChars)
  return piece
}

/**
 * 增量片段剔除器（每个文本块一份）。
 *
 * 语义：把配置里的片段当**字面量子串**整段剔除，长片段优先（避免 `---` 抢先破坏 `-----`），
 * 剔除后再交给 sanitizePiece（去空白 → 逐字符白名单）。
 *
 * 跨增量：为避免片段被增量边界切断，末尾最多保留（最长片段 - 1）个**码点**不输出，
 * 等下一次增量拼回后再匹配；flush() 吐出尾巴（块结束/流结束时调用），保证尾部文本仍参与检测。
 * 代价：检测最多延迟（最长片段 - 1）个码点。
 *
 * 片段表为空时走零开销快路径（不缓冲、原样返回），因此默认行为与未启用该功能时完全一致。
 *
 * 与 lib/index.js 中的同名实现保持一致（两个入口行为必须相同）。
 *
 * @param getPatterns - 读取当前片段表（支持热更新）。
 * @param maxLength - 片段长度上限（决定保留的尾巴长度）。
 */
function createSubstringStripper(getPatterns, maxLength) {
  let buffer = ''
  let cachedSource = null
  let cachedSorted = []
  const keepLength = () => Math.max(1, maxLength) - 1

  /** 长片段优先的片段表（按数组引用缓存，热更新后自动重建）。 */
  const sortedPatterns = () => {
    const list = getPatterns()
    if (list !== cachedSource || list.length !== cachedSorted.length) {
      cachedSource = list
      cachedSorted = [...list].sort((left, right) => [...right].length - [...left].length)
    }
    return cachedSorted
  }

  /** 从 text 中移除所有片段出现（字面量，非正则）。 */
  const removePatterns = (text, patterns) => {
    let out = text
    for (const pattern of patterns) {
      if (pattern.length === 0) continue
      if (out.indexOf(pattern) !== -1) out = out.split(pattern).join('')
    }
    return out
  }

  return {
    /** 消费一段增量，返回可交给后续清洗的文本（可能为空串）。 */
    push(delta) {
      const patterns = sortedPatterns()
      if (patterns.length === 0) {
        // 快路径：未配置片段时不缓冲；若此前残留尾巴（刚被清空配置），先吐出。
        if (buffer.length === 0) return delta
        const carried = buffer
        buffer = ''
        return carried + delta
      }
      buffer += delta
      const cleaned = removePatterns(buffer, patterns)
      const codePoints = [...cleaned]
      // 保留长度按**实际最长片段**计算（而非配置上限），否则检测会被无谓地拖后。
      const longest = [...patterns[0]].length
      const keep = Math.min(Math.max(0, longest - 1), keepLength(), codePoints.length)
      if (keep === 0) {
        buffer = ''
        return cleaned
      }
      buffer = codePoints.slice(codePoints.length - keep).join('')
      return codePoints.slice(0, codePoints.length - keep).join('')
    },
    /** 吐出保留的尾巴（块结束/流结束）。 */
    flush() {
      const out = buffer
      buffer = ''
      return out
    },
  }
}

/**
 * 片段白名单归一化：丢弃空值/非字符串、超长（> 64 码点）与超量（> 64 项）条目，
 * 并去重。丢弃项只告警一次（同样内容），避免每次模型调用刷屏。
 */
function normalizeIgnoredSubstrings(raw, fallback) {
  if (!Array.isArray(raw)) return [...fallback]
  const kept = []
  const dropped = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      dropped.push(String(entry))
      continue
    }
    if ([...entry].length > IGNORED_SUBSTRING_MAX_LENGTH) {
      dropped.push(entry)
      continue
    }
    if (kept.indexOf(entry) !== -1) continue
    if (kept.length >= IGNORED_SUBSTRINGS_MAX_COUNT) {
      dropped.push(entry)
      continue
    }
    kept.push(entry)
  }
  if (dropped.length > 0) {
    const signature = JSON.stringify(dropped)
    if (signature !== lastSubstringWarning) {
      lastSubstringWarning = signature
      console.warn(
        '[dupguard] 片段白名单条目无效，已忽略：' + JSON.stringify(dropped) +
        '（要求非空字符串、每项 ≤ ' + String(IGNORED_SUBSTRING_MAX_LENGTH) +
        ' 码点、最多 ' + String(IGNORED_SUBSTRINGS_MAX_COUNT) + ' 项）。'
      )
    }
  }
  return kept
}

/** 上一次「无效片段白名单条目」告警的签名，用于去重。 */
let lastSubstringWarning = ''

/**
 * 代码区域扫描器（每个文本块一份状态）：把增量切成「普通文本 / 代码」两类片段，
 * 调用方按 `threshold` 与 `threshold × codeBlockMultiplier` 分别判定。
 * **三类代码区域统一判定**（同一个倍数、同一个阈值）：
 *
 *   1. 围栏代码块：起始行为行首最多 3 个空格 + 连续 ≥3 个 ` 或 ~（其后为 info string）；
 *      结束行为同字符且不短于起始长度的 run（其后仅空白）；未闭合的围栏延续到块结束。
 *   2. 缩进代码块：行首缩进 ≥4（制表符按 4 计）、**上一行为空行**、且上一个非空行不是列表项 /
 *      引用起始（避免把「列表项之后的缩进内容」与「段落续行」误判为代码）；块内空行不终止，
 *      遇到首个「非空且缩进 <4」的行退出。
 *   3. 行内代码：1..64 个反引号开启，须在**同一行**内由等长 run 闭合；换行 / 超过
 *      INLINE_HOLD_LIMIT / 块结束仍未闭合时，开启符按普通文本处理，内容照常参与检测。
 *
 * 增量切分安全：围栏标记、行首缩进、行内定界符都可能被切进多个 delta，状态全部保存在实例里；
 * 行内区需要**有界 hold-back**（开启符之后的内容先不发射，闭合后整体按代码发射），
 * 因此调用方必须在块结束时调用 flush()，否则这部分文本会漏检。
 * 局限：不解析引用 / 表格 / 嵌套列表造成的缩进基线（见 README「代码区域判定」）。
 *
 * 与 lib/index.js 中的同名实现保持一致（两个入口行为必须相同）。
 */
function createCodeScanner() {
  // 围栏 / 行内 run 的长度上限：超过即不再视为定界符，避免无界缓冲。
  const MAX_FENCE_RUN = 64
  const MAX_INLINE_TICKS = 64
  // 行内区 hold-back 上限：超过即认定开启符是普通文本（换取检测不被长时间搁置）。
  const INLINE_HOLD_LIMIT = 256
  // 行首缓冲上限（缩进 + run）；缩进一旦 ≥4 就已决定行类别，不会长到这里。
  const MAX_HEAD = 16
  const LIST_MARKER = /^ {0,3}(?:[-*+]|\d+[.)])\s/
  const QUOTE_MARKER = /^ {0,3}>/

  // 行级状态
  let atLineStart = true
  let head = ''              // 行首缓冲：缩进 + 可能的围栏 / 行内 run
  let headIndent = 0         // 折算缩进（制表符 = 4）
  let headRun = ''           // 行首 run 的字符（` 或 ~）
  let lineHead = ''          // 本行起始若干字符（判定列表 / 引用）
  let lineBlank = true       // 本行是否只有空白
  let prevBlank = true       // 上一行是否为空行（块起始视为空行）
  let prevBlockStart = false // 上一非空行是否以列表标记 / 引用起始

  // 区域状态
  let fence = null           // { char, len }：已进入围栏代码块
  let closeLine = ''         // 围栏内当前行（判定结束行）
  let closeTooLong = false
  let inIndented = false     // 处于缩进代码块（可跨空行延续）
  let indented = false       // 当前行按缩进代码块处理
  let inline = null          // { ticks, held, closeRun }：行内区（held 未发射）
  let tickRun = ''           // 行中累积的反引号 run（尚未确定是否开启行内区）
  let warnedInline = false

  const isSpace = (ch) => ch === ' ' || ch === '\t'
  const resetHead = () => {
    head = ''
    headIndent = 0
    headRun = ''
  }
  /** 记录本行字符（用于列表 / 引用判定与空行判定）。 */
  const noteLine = (ch) => {
    if (lineHead.length < 16) lineHead += ch
    if (!isSpace(ch)) lineBlank = false
  }
  /** 行结束：更新「上一行」状态并回到行首。 */
  const endLine = () => {
    prevBlank = lineBlank
    if (!lineBlank) prevBlockStart = LIST_MARKER.test(lineHead) || QUOTE_MARKER.test(lineHead)
    lineHead = ''
    lineBlank = true
    atLineStart = true
    indented = false
    resetHead()
  }
  /** 当前行是否为围栏结束行（同字符、不短于起始长度、其后仅空白）。 */
  function isClosingLine(line) {
    const body = line.replace(/[ \t]+$/, '')
    const indent = body.length - body.replace(/^ {0,3}/, '').length
    const run = body.slice(indent)
    if (run.length < fence.len) return false
    for (let i = 0; i < run.length; i++) {
      if (run[i] !== fence.char) return false
    }
    return true
  }
  /** 行内区迟迟不闭合：把已保留的内容按普通文本吐出并告警一次。 */
  const giveUpInline = (emit) => {
    const held = inline.held + inline.closeRun + tickRun
    inline = null
    tickRun = ''
    if (held.length > 0) emit(held, false)
    if (!warnedInline) {
      warnedInline = true
      console.warn('[dupguard] 反引号未在同一行闭合：' + String(INLINE_HOLD_LIMIT) + ' 字符后按普通文本判定')
    }
  }

  return {
    /** 当前是否处于围栏代码块内（诊断用）。 */
    inside: () => fence !== null,
    /** 当前区域状态（诊断 / 测试用）。 */
    state: () => ({
      fence: fence !== null,
      indented: indented || inIndented,
      inline: inline !== null,
    }),
    /**
     * 消费一个增量，返回按「普通文本 / 代码」切分的片段序列。
     * 片段按原始顺序首尾相接（不含 hold-back 的部分）即为可检测文本。
     * @param delta - 文本增量。
     * @returns {Array<{ text: string, code: boolean }>} 片段序列（可能为空数组）。
     */
    push(delta) {
      // 快路径 1：围栏内且不含围栏字符与换行 ⇒ 仍是代码。
      if (fence !== null && delta.indexOf(fence.char) === -1 && delta.indexOf('\n') === -1) {
        return [{ text: delta, code: true }]
      }
      // 快路径 2：不含换行与反引号 ⇒ 区域状态不可能改变。
      if (delta.indexOf('\n') === -1 && delta.indexOf('`') === -1) {
        if (indented) return [{ text: delta, code: true }]
        if (fence === null && inline === null && tickRun === '' && !atLineStart) {
          return [{ text: delta, code: false }]
        }
      }
      const runs = []
      let buffer = ''
      let bufferCode = fence !== null || indented
      const emit = (text, code) => {
        if (text.length === 0) return
        if (buffer.length > 0 && code !== bufferCode) {
          runs.push({ text: buffer, code: bufferCode })
          buffer = ''
        }
        bufferCode = code
        buffer += text
      }
      let i = 0
      while (i < delta.length) {
        const ch = delta[i]

        // ---- 围栏代码块内：只判定结束行，内容整体按代码发射 ----
        if (fence !== null) {
          if (ch === '\n') {
            const closing = isClosingLine(closeLine)
            emit(ch, true)
            closeLine = ''
            closeTooLong = false
            if (closing) fence = null
            endLine()
            i++
            continue
          }
          if (!closeTooLong) {
            closeLine += ch
            if (closeLine.length > fence.len + 8) closeTooLong = true
          }
          emit(ch, true)
          lineBlank = false
          i++
          continue
        }

        // ---- 行内代码区（未闭合前内容 hold 住，闭合后整体按代码发射）----
        if (inline !== null) {
          if (ch === '\n') {
            // 同一行内未闭合 ⇒ 开启符按普通文本，内容照常参与检测
            giveUpInline(emit)
            emit(ch, false)
            endLine()
            i++
            continue
          }
          if (ch === '`') {
            inline.closeRun += ch
            i++
            continue
          }
          if (inline.closeRun.length > 0) {
            if (inline.closeRun.length === inline.ticks) {
              // 等长 run ⇒ 闭合。开启符 + 内容单独成段先发射：尾部检测必须落在重复内容上，
              // 若与闭合符合并成一段，缓冲区尾部就成了反引号，区域内的失控复读会被漏判。
              if (buffer.length > 0) {
                runs.push({ text: buffer, code: bufferCode })
                buffer = ''
              }
              runs.push({ text: inline.held, code: true })
              runs.push({ text: inline.closeRun, code: true })
              bufferCode = true
              inline = null
              // 当前字符属于闭合之后的内容，交给后续分支处理
              continue
            }
            inline.held += inline.closeRun
            inline.closeRun = ''
          }
          inline.held += ch
          noteLine(ch)
          if (inline.held.length > INLINE_HOLD_LIMIT) giveUpInline(emit)
          i++
          continue
        }

        // ---- 行首：累积缩进与 run，决定本行类别 ----
        if (atLineStart) {
          if (isSpace(ch)) {
            head += ch
            headIndent += ch === '\t' ? 4 : 1
            noteLine(ch)
            if (headIndent >= 4 && (inIndented || (prevBlank && !prevBlockStart))) {
              indented = true
              inIndented = true
              emit(head, true)
              resetHead()
              atLineStart = false
              i++
              continue
            }
            if (head.length >= MAX_HEAD) {
              emit(head, false)
              resetHead()
              atLineStart = false
              i++
              continue
            }
            i++
            continue
          }
          if (headRun !== '' && ch === headRun[0]) {
            head += ch
            headRun += ch
            noteLine(ch)
            if (headRun.length >= MAX_FENCE_RUN) {
              emit(head, true)
              fence = { char: headRun[0], len: headRun.length }
              closeLine = ''
              closeTooLong = false
              atLineStart = false
              resetHead()
            }
            i++
            continue
          }
          if (headRun === '' && headIndent <= 3 && (ch === '`' || ch === '~')) {
            head += ch
            headRun = ch
            noteLine(ch)
            i++
            continue
          }
          // run 结束（或本行不是围栏起始）：结算行首缓冲
          const runLen = headRun.length
          if (runLen >= 3) {
            // 起始行（含行首空格与围栏符）整体属于代码块
            emit(head, true)
            fence = { char: headRun[0], len: runLen }
            closeLine = ''
            closeTooLong = false
            atLineStart = false
            resetHead()
            continue // 当前字符按围栏内容处理
          }
          if (runLen >= 1 && headRun[0] === '`') {
            // 行首 1..2 个反引号 = 行内定界符（须在同一行闭合）
            inline = { ticks: runLen, held: head, closeRun: '' }
            resetHead()
            atLineStart = false
            continue // 当前字符按行内内容处理
          }
          emit(head, false)
          resetHead()
          atLineStart = false
          if (ch !== '\n') inIndented = false // 本行不是缩进代码行 ⇒ 结束缩进代码块
          continue // 当前字符按普通文本处理
        }

        // ---- 缩进代码行 ----
        if (indented) {
          emit(ch, true)
          if (ch === '\n') endLine()
          else lineBlank = false
          i++
          continue
        }

        // ---- 行中：普通文本 / 行内区开启 ----
        if (ch === '`') {
          tickRun += ch
          noteLine(ch)
          i++
          continue
        }
        if (tickRun !== '') {
          const ticks = tickRun.length
          if (ticks <= MAX_INLINE_TICKS) {
            inline = { ticks: ticks, held: tickRun, closeRun: '' }
            tickRun = ''
            continue // 当前字符按行内内容处理
          }
          emit(tickRun, false)
          tickRun = ''
          continue
        }
        emit(ch, false)
        if (ch === '\n') {
          endLine()
        } else {
          noteLine(ch)
          if (inIndented) inIndented = false // 非缩进行 ⇒ 缩进代码块结束（空行由上面的分支保留）
        }
        i++
      }
      if (buffer.length > 0) runs.push({ text: buffer, code: bufferCode })
      return runs
    },
    /**
     * 块结束：吐出 hold-back 中的待定文本（按普通文本）。
     * 调用方必须调用，否则未闭合行内区的内容会漏检。
     * @returns {Array<{ text: string, code: boolean }>} 片段序列（可能为空数组）。
     */
    flush() {
      const parts = []
      if (inline !== null) {
        // 结束前恰好等到等长 run ⇒ 行内区已闭合：拆成两段（内容在前、闭合符在后），
        // 保证尾部检测落在重复内容上；否则开启符按普通文本，内容照常参与检测。
        if (inline.closeRun.length === inline.ticks) {
          parts.push({ text: inline.held, code: true }, { text: inline.closeRun, code: true })
        } else {
          parts.push({ text: inline.held + inline.closeRun, code: false })
        }
        inline = null
      }
      if (tickRun !== '') {
        parts.push({ text: tickRun, code: false })
        tickRun = ''
      }
      if (head !== '') {
        parts.push({ text: head, code: false })
        resetHead()
      }
      return parts.filter((part) => part.text.length > 0)
    },
  }
}

/**
 * 分段表模式下的最大重复单元长度：由表格末行终止值派生（与常驻版同规则）。
 * 空表或只有 `*` 时沿用 CONFIG.maxUnitLength。
 */
const MAX_UNIT_LENGTH = (() => {
  if (CONFIG.thresholdMode !== 'table') return CONFIG.maxUnitLength
  const entries = parseThresholdByLength(CONFIG.thresholdByLength)
  const ends = entries.filter((entry) => entry.maxLength !== null).map((entry) => entry.maxLength)
  if (ends.length === 0) return CONFIG.maxUnitLength
  const lastEnd = ends[ends.length - 1]
  // 旧写法 `*:<次数>`：上界按文档的 maxUnitLength 延伸（与设置页迁移显示一致）。
  const hasStar = entries.some((entry) => entry.maxLength === null)
  return Math.max(1, hasStar ? Math.max(lastEnd, CONFIG.maxUnitLength) : lastEnd)
})()

/** 生效配置：把派生的最大单元长度体现在策略、窗口与检测三处。 */
const EFFECTIVE = { ...CONFIG, maxUnitLength: MAX_UNIT_LENGTH }

/** 每次 llm/stream 调用使用的策略（动态版 CONFIG 固定，模块加载时构建一次）。 */
const THRESHOLD_POLICY = createThresholdPolicy(EFFECTIVE, 1)
const CODE_THRESHOLD_POLICY = CONFIG.skipCodeBlocks === true && CONFIG.codeBlockMultiplier !== 1
  ? createThresholdPolicy(EFFECTIVE, CONFIG.codeBlockMultiplier)
  : THRESHOLD_POLICY

/**
 * 检测窗口（与常驻版同公式，自动派生）：正好等于「最严格的重复跨度」——
 * 简单模式取 `max(threshold, threshold × 倍数) × maxUnitLength`；策略模式取各长度 `p × need(p)`
 * 的最大值（**不再叠加固定阈值**，否则窗口会被算大）；结果夹到 [64, 1048576]。
 * 动态版没有设置页，因此仍取 `CONFIG.detectionWindow` 与派生值的**较大者**作为代码级下限。
 */
const DETECTION_WINDOW = (() => {
  const mode = CONFIG.skipCodeBlocks === true ? CONFIG.codeBlockMultiplier : 1
  const strict = mode === 0 ? CONFIG.threshold : CONFIG.threshold * mode
  const policySpan = Math.max(
    THRESHOLD_POLICY === undefined ? 0 : THRESHOLD_POLICY.worstSpan,
    CODE_THRESHOLD_POLICY === undefined ? 0 : CODE_THRESHOLD_POLICY.worstSpan,
  )
  const hasPolicy = THRESHOLD_POLICY !== undefined || CODE_THRESHOLD_POLICY !== undefined
  const required = hasPolicy && policySpan > 0 ? policySpan : strict * MAX_UNIT_LENGTH
  const derived = Math.min(Math.max(required, 64), 1048576)
  return Math.max(CONFIG.detectionWindow, derived)
})()

/**
 * 为一次 llm/stream 调用创建守卫。
 * 每次模型调用都会新建一份状态，互不干扰。
 */
function createStreamGuard(options) {
  // index -> 块状态。用 Map 按块索引累积，避免多个文本块交替输出时互相打断检测。
  const blocks = new Map()
  let stopped = null

  const provider = typeof options === 'object' && options !== null ? String(options.provider ?? '?') : '?'
  const model = typeof options === 'object' && options !== null ? String(options.model ?? '?') : '?'

  function ensure(index, blockType) {
    let b = blocks.get(index)
    if (b === undefined) {
      b = {
        blockType,
        text: '',            // 完整文本：停止时需要用它闭合块，不能只保留窗口
        stripped: '',        // 去空白后的滚动窗口：仅用于检测
        code: createCodeScanner(), // 代码区域状态（围栏 / 行内 / 缩进；skipCodeBlocks 开启时使用）
        lastRunCode: undefined,     // 上一片段的代码块归属（用于跨围栏边界清空缓冲）
        substrings: createSubstringStripper(() => CONFIG.ignoredSubstrings, IGNORED_SUBSTRING_MAX_LENGTH),
        toolCallId: undefined,
        toolCallName: undefined,
        toolCallArguments: '',
      }
      blocks.set(index, b)
    }
    return b
  }

  /**
   * 把一段文本增量喂给检测缓冲，返回命中结果（null 表示未命中）。
   *
   * 增量先经代码区域扫描器切成片段：普通片段按 CONFIG.threshold 判定，代码片段
   * （围栏 / 行内 / 缩进三类统一）按 CONFIG.codeBlockMultiplier 分三档处理：
   * ≥2 放宽（用 threshold × 倍数）、1 与块外同样严格、0 完全不检测。
   */
  function feedText(b, delta) {
    b.text += delta
    const runs = CONFIG.skipCodeBlocks === true ? b.code.push(delta) : [{ text: delta, code: false }]
    return feedRuns(b, runs)
  }

  /** 把片段序列喂给检测缓冲（阈值/策略按片段类别选择），返回命中结果。 */
  function feedRuns(b, runs) {
    const codeBlocksOn = CONFIG.skipCodeBlocks === true
    const mode = codeBlocksOn ? CONFIG.codeBlockMultiplier : 1
    const skipInsideCode = mode === 0
    const codeThreshold = CONFIG.threshold * mode
    for (const run of runs) {
      // 倍数 0（完全不检测代码块）时，进入/离开代码块都清空检测缓冲，
      // 避免把围栏两侧的文本拼成人为重复。
      if (skipInsideCode && b.lastRunCode !== undefined && run.code !== b.lastRunCode) b.stripped = ''
      b.lastRunCode = run.code
      if (skipInsideCode && run.code) continue
      const piece = sanitizePiece(b.substrings.push(run.text), CONFIG)
      if (piece.length === 0) continue
      b.stripped = (b.stripped + piece).slice(-DETECTION_WINDOW)
      const threshold = run.code ? codeThreshold : CONFIG.threshold
      const hit = findRepeatedTail(b.stripped, threshold, CONFIG.minUnitLength, MAX_UNIT_LENGTH,
        run.code ? CODE_THRESHOLD_POLICY : THRESHOLD_POLICY)
      if (hit !== null) return { unit: hit.unit, count: hit.count, span: hit.span, code: run.code }
    }
    return null
  }

  /**
   * 块结束时吐出代码区域扫描器 hold-back 的文本（未闭合行内区等，按普通文本判定），
   * 避免这部分文本逃过检测；必须在块结束与流结束时调用。
   */
  function flushCodeRegion(b) {
    if (b === undefined || b.code === undefined || typeof b.code.flush !== 'function') return null
    return feedRuns(b, b.code.flush())
  }

  /**
   * 块结束时吐出片段剔除器保留的尾巴（≤ 最长片段 - 1 码点），
   * 让它仍参与检测；阈值沿用该块最后一次片段的代码块归属。
   */
  function flushSubstringTail(b) {
    if (b === undefined || b.substrings === undefined) return null
    const tail = sanitizePiece(b.substrings.flush(), CONFIG)
    if (tail.length === 0) return null
    b.stripped = (b.stripped + tail).slice(-DETECTION_WINDOW)
    const threshold = b.lastRunCode === true
      ? CONFIG.threshold * (CONFIG.skipCodeBlocks === true ? CONFIG.codeBlockMultiplier : 1)
      : CONFIG.threshold
    return findRepeatedTail(b.stripped, threshold, CONFIG.minUnitLength, MAX_UNIT_LENGTH,
      b.lastRunCode === true ? CODE_THRESHOLD_POLICY : THRESHOLD_POLICY)
  }

  /** 依据 StreamChunk 协议累积状态；命中时置 stopped。 */
  function feed(chunk) {
    switch (chunk.type) {
      case 'block-start': {
        ensure(chunk.index, chunk.blockType)
        return
      }
      case 'text-delta': {
        const b = ensure(chunk.index, 'text')
        const hit = feedText(b, chunk.text)
        if (hit !== null) stopped = hit
        return
      }
      case 'reasoning-delta': {
        const b = ensure(chunk.index, 'reasoning')
        if (CONFIG.monitorReasoning) {
          // feedText 内部负责累积完整文本与检测缓冲，这里不得重复 +=
          const hit = feedText(b, chunk.text)
          if (hit !== null) stopped = hit
        } else {
          b.text += chunk.text // 不检测时仍须累积完整内容以便停止时闭合块
        }
        return
      }
      case 'tool-call-delta': {
        const b = ensure(chunk.index, 'tool-call')
        if (chunk.id !== undefined) b.toolCallId = chunk.id
        if (chunk.name !== undefined) b.toolCallName = chunk.name
        b.toolCallArguments += chunk.argumentsDelta
        if (CONFIG.monitorToolArguments) {
          const piece = sanitizePiece(b.substrings.push(chunk.argumentsDelta), CONFIG)
          b.stripped = (b.stripped + piece).slice(-DETECTION_WINDOW)
          const hit = findRepeatedTail(b.stripped, CONFIG.threshold, CONFIG.minUnitLength, MAX_UNIT_LENGTH, THRESHOLD_POLICY)
          if (hit !== null) stopped = hit
        }
        return
      }
      case 'block-end': {
        const b = blocks.get(chunk.index)
        const codeHit = flushCodeRegion(b)
        if (codeHit !== null) stopped = codeHit
        const tailHit = flushSubstringTail(b)
        if (tailHit !== null) stopped = tailHit
        blocks.delete(chunk.index)
        return
      }
      case 'usage':
      case 'finish': {
        // 流结束时可能还有未收到 block-end 的块：把尾巴补上，避免尾部文本漏检。
        for (const b of blocks.values()) {
          const codeHit = flushCodeRegion(b)
          if (codeHit !== null) stopped = codeHit
          const tailHit = flushSubstringTail(b)
          if (tailHit !== null) stopped = tailHit
        }
        return
      }
      default:
        return
    }
  }

  /** 把块状态装配为 ContentBlock（与 BlockAssembler 的 open-block 装配规则一致）。 */
  function closeBlock(b, index) {
    let block
    if (b.blockType === 'text') {
      block = { type: 'text', text: b.text }
    } else if (b.blockType === 'reasoning') {
      block = { type: 'reasoning', text: b.text }
    } else {
      block = {
        type: 'tool-call',
        id: b.toolCallId !== undefined ? b.toolCallId : 'call-' + index,
        name: b.toolCallName !== undefined ? b.toolCallName : '',
        arguments: b.toolCallArguments,
      }
    }
    return { type: 'block-end', index, block }
  }

  /**
   * 满足 llm/stream 协议地收尾：
   * 1) 闭合所有仍打开的块（否则 llm-invariant 校验器会报
   *    "LLM stream finished with N open block(s)"）；
   * 2) 以 finish(stop) 结尾（否则报 "LLM stream ended without a terminal finish chunk"）。
   * agent-loop 因此把已生成内容正常提交为助手消息，本轮干净结束。
   */
  function* closingChunks() {
    for (const [index, b] of blocks) yield closeBlock(b, index)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** 包装上游流：逐块透传 + 检测；命中后补发闭合块并提前结束。 */
  async function* guarded(source) {
    for await (const chunk of source) {
      yield chunk
      feed(chunk)
      if (stopped !== null) {
        console.log(
          '[dupguard] 检测到重复输出，已停止生成：provider=' + provider + ' model=' + model +
          ' unit=' + JSON.stringify(stopped.unit) +
          ' repeat>=' + String(stopped.count) +
          ' span=' + String(stopped.span) + 'chars' +
          (stopped.code === true ? ' code-block=true（放宽阈值命中）' : '')
        )
        yield* closingChunks()
        // 提前 return：for-await 会调用上游 iterator.return()，
        // 适配器的 finally 随即 consumer.abort() 中断 HTTP 连接，
        // 从而在服务端真正停止生成。这里绝不调用 options.signal.abort()，
        // 因为 loop 请求的 options.signal 就是整个 agent 步骤的信号，
        // 直接中止会让本轮以 aborted 结束并丢弃已生成的消息。
        return
      }
    }
  }

  return guarded
}

/**
 * DSH ≤ 0.1.2-rc.1 standing-mount 兼容补丁：把 cordisInspect.register 幂等化。
 *
 * 背景：preset 的 standing mount 在 composition 文件变化后新建一代、旧代永不销毁；
 * tool-cordis 每次挂载都向进程全局的 cordisInspect 注册 Service/Event/Builtin/Tool
 * provider，两代并存即抛 "already registered"。幂等化后同 id 的后续注册共享已有
 * 注册（返回 no-op disposer），多代并存不再冲突。
 *
 * 说明：补丁有意不做撤销（常驻进程，重启后由本插件重新安装）；依赖
 * cordisInspect.providers 为可读 Map（实测 rc.6 / rc.7 / 0.1.1-rc.1 / 0.1.2-rc.1 如此）。
 * DSH 升级修复后可将 CONFIG.fixStandingMountConflict 置为 false。
 */
function installStandingMountPatch(ctx) {
  const inspect = ctx.get('cordisInspect')
  if (inspect === undefined || typeof inspect.register !== 'function') return
  if (inspect.register.__dupguardIdempotent === true) return
  const original = inspect.register.bind(inspect)
  const patched = (registration) => {
    const id = registration && typeof registration === 'object' ? registration.manifest?.id : undefined
    if (typeof id === 'string' && inspect.providers !== undefined && inspect.providers.has(id)) {
      // 同 id 已有注册（旧代仍活着）：共享它，返回 no-op disposer，
      // 新代卸载时不得注销共享注册。
      return () => {}
    }
    return original(registration)
  }
  patched.__dupguardIdempotent = true
  inspect.register = patched
  console.log('[dupguard] cordisInspect.register 已幂等化（DSH standing-mount 多代并存兼容补丁）')
}

return {
  // 测试钩子：暴露派生常量，供「跨实现一致性」用例与常驻版/客户端比对（运行时无副作用）。
  __derived: { detectionWindow: DETECTION_WINDOW, maxUnitLength: MAX_UNIT_LENGTH },
  apply(ctx) {
    if (CONFIG.fixStandingMountConflict) installStandingMountPatch(ctx)
    // llm/stream：包裹每次流式模型调用的瀑布事件。
    // 监听器返回包装后的 AsyncIterable，即成为本次调用对消费方可见的流。
    // （与 @deepseek-ai/dsh-llm 的 invariant、dsh-session-checkpoint-policy 同款接入方式）
    ctx.on('llm/stream', (options, next) => createStreamGuard(options)(next()))
  },
}
