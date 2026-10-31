'use strict'

// ============================================================================
// dupguard 检测引擎（单源实现）
//
// 本文件是「检测引擎」的唯一源码：npm/组合常驻入口（lib/index.js）与动态入口
// （plugin/host.js，由 tools/build-host.mjs 从本文件 + 模板生成）都使用这里的实现。
// 修改检测逻辑请只改本文件，然后运行 `npm run build:host` 重新生成动态入口；
// `npm test` 会校验生成产物是否过期（tools/build-host.mjs --check）。
// ============================================================================
/** 可调数值参数及其边界（客户端 UI 镜像这些边界；范围外的写入由 schema 拒绝）。 */
const LIMITS = {
  threshold: { min: 2, max: 1000 },
  minUnitLength: { min: 1, max: 4096 },
  maxUnitLength: { min: 1, max: 8192 },
  detectionWindow: { min: 64, max: 1048576 },
  // 0 是哨兵值：表示代码块内完全不检测（见 CONFIG.codeBlockMultiplier 注释）。
  codeBlockMultiplier: { min: 0, max: 100 },
  // 最短反应时间（毫秒）：命中后至少经过这么久才可能自动截停（输出不暂停）。
  decisionTimeoutMs: { min: 1000, max: 15000 },
  // 实际重复达到「阈值 × 该倍数」且已过最短反应时间后才强制截停。
  stopAtMultiplier: { min: 2, max: 10 },
}

/** 片段白名单（ignoredSubstrings）的上限。 */
const IGNORED_SUBSTRINGS_MAX_COUNT = 64
const IGNORED_SUBSTRING_MAX_LENGTH = 64

/** 重复次数策略模式：simple / table / module。 */
const THRESHOLD_MODES = ['simple', 'table', 'module']

/** 「继续指令」文本上限（码点）。 */
const CONTINUE_PROMPT_MAX = 500
/** 代码默认配置：两个入口共用同一份默认值。 */
const DEFAULT_CONFIG = {
  // 触发阈值：同一字符串连续重复次数达到该值时停止输出（用户需求：重复十次以上）。
  // 语义为「>= threshold」，即第 10 次重复出现时就触发。
  threshold: 10,
  // 重复次数策略：simple（固定阈值，默认）/ table（分段表）/ module（用户模块）。
  // simple 下不构造策略、走快路径；table/module 下每个单元长度 p 使用 need(p) 次判定。
  thresholdMode: 'simple',
  // 分段表模式：`"<maxLen>:<count>[, …][, *:<count>]"`，例 "1:40, 2:30, 8:12, *:10"。
  // 含义：长度 ≤ 1 的单元需 40 次、≤ 2 需 30 次、≤ 8 需 12 次，其余 10 次；未覆盖且无 * 时用 threshold。
  thresholdByLength: '',
  // 高级模式：模块文件路径，导出 repeatCount(length) -> count（同步函数）。
  // 该文件会在 DSH 宿主进程中执行，请只指向自己信任的文件。
  advancedThresholdFile: '',
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
  // 条目必须是单个字符（按 Unicode 码点匹配，emoji 也算一个）；
  // 多字符条目永远不会命中，运行时会丢弃并告警。
  ignoredChars: ['-', '|'],
  // 围栏代码块（``` / ~~~）内的重复检测按倍数分三档：
  //   ≥2 → 放宽：块内改用 threshold × codeBlockMultiplier 判定（默认 4；实测 260 个真实文件里
  //        默认 4 的代码块误杀为 0，见 tools/audit-code-false-positives.mjs），
  //        既能放过正常代码，又能兜住真正的失控复读；
  //   1  → 不放宽：块内与块外同样严格；
  //   0  → 完全不检测：块内内容不参与重复统计（生成的代码再长也不会被截停），
  //        跨围栏边界会清空检测缓冲，避免把围栏两侧文本凑成人为重复。
  // 置 skipCodeBlocks=false 则整体关闭该机制（三档都不生效）。
  // 局限：只识别围栏代码块，行内代码（`x`）与缩进代码块（4 空格）仍按普通阈值判定；
  // 模型忘记闭合围栏时，其后内容都按代码块处理。
  skipCodeBlocks: true,
  codeBlockMultiplier: 4,
  // 片段白名单：整段匹配的多字符串（字面量、区分大小写、不支持正则）。
  // 命中时先整段剔除，再做去空白与逐字符剔除 —— 用于 `|---|`、`------` 这类
  // 由多个字符组成的固定片段：逐字符白名单只能忽略单个字符，组合片段的重复
  // 仍会被计入。长片段优先匹配，避免 `---` 抢先破坏 `-----`。
  // 上限：每项 ≤ IGNORED_SUBSTRING_MAX_LENGTH 码点、数组 ≤ IGNORED_SUBSTRINGS_MAX_COUNT 项。
  // 代价：为跨增量匹配，每块最多保留（最长片段 - 1）个码点不参与检测（tail 延迟）。
  ignoredSubstrings: [],
  // 是否同时检测思考（reasoning）文本。默认开启：思考中的复读同样消耗 token，
  // 应立即截停。注意：正常思考中若连续重复同一字符串 10 次以上（如"等等等等"），
  // 也会被截停，属预期行为；需要只检测可见输出时可置为 false。
  monitorReasoning: true,
  // 是否同时检测工具调用参数（JSON 片段）。默认关闭：JSON / base64 中重复字符很常见。
  monitorToolArguments: false,
  // 截停时是否生成「全局截停通知」（浏览器里的弹窗）：
  // 通知与用户当前打开哪个会话无关——被截停的会话可能不在前台。
  // 通知上会显示工作区、会话名称、重复的字符串，并让用户选择是否发送继续指令。
  notifyOnStop: true,
  // 截停时是否**同时**发一条**系统通知**（浏览器 Notification → Windows 右下角 / macOS 通知中心）。
  // 与上面的应用内浮层互补：浮层只在 DSH 页面上可见，系统通知在页面不可见时才有意义。
  // 默认关闭：需要浏览器授权（设置页开关里请求），且只在页面不可见时才弹。
  systemNotify: false,
  // 是否把每次截停追加写入持久化日志（~/.dsh/dupgard/stops.jsonl，仅 npm/常驻版可用）。
  // 与 notifyOnStop / systemNotify 相互独立：通知可以全关，日志仍照记。
  // 环境变量 DSH_DUPGUARD_STOP_LOG=off 是更高优先级的总开关。
  persistStopLog: true,
  // 阈值决策卡片：检测到阈值时弹卡片、**不暂停输出**，可选择立即截停 / 允许继续。
  // 需要宿主通知通道（webServer）与 notifyOnStop；不满足时回退到「阈值即停」。
  stopDecision: true,
  // 命中时是否暂停「输出显示」（仅常驻版 + 通知通道；模型端计算不会真正暂停）。
  // 命中所在 chunk 先扣住，等用户决定或反应时间到期；用于本地大块/突发模型。
  pauseDecisionOutput: false,
  // 最短反应时间（毫秒）：命中后至少经过这么久才可能自动截停（输出不暂停）。
  decisionTimeoutMs: 4000,
  // 自动截停条件之一：实际重复达到「阈值 × 该倍数」，且同时已过最短反应时间才强制截停。
  stopAtMultiplier: 2,
  // 用户在通知里点「发送继续指令」时，注入被截停会话的用户消息文本。
  continuePrompt: '请从中断处继续，不要重复之前的内容。',
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
/** 策略告警去重（同一问题只告警一次；数量有界，超出后清空重来）。 */
const policyWarningsSeen = new Set()

/** 未知块类型告警只打一次。 */
let warnedUnknownBlockType = false

/** 上一次「无效片段白名单条目」告警的签名。 */
let lastSubstringWarning = ''

/** 上一次「窗口偏小」告警的签名。 */
let lastWindowWarning = ''
function warnPolicyOnce(signature, message) {
  if (policyWarningsSeen.has(signature)) return
  if (policyWarningsSeen.size > 64) policyWarningsSeen.clear()
  policyWarningsSeen.add(signature)
  console.warn(message)
}

/**
 * 尾部连续重复检测：text 是否以某个 unit（长度 minUnitLength..maxUnitLength）
 * 连续重复达标次数结尾。是则返回 { unit, count, span }，否则返回 null。
 *
 * 次数来源：policy === undefined 时用固定 threshold（simple 模式，走原有快路径）；
 * 否则对每个候选长度 p 取 policy.counts[p]（0 表示该长度不判定）。
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
  // 策略模式：先定位最松的候选上界，再对每个长度用各自的 need 判定。
  const minNeed = policy.minNeed
  if (minNeed < 2 || n < minNeed * minUnitLength) return null
  const maxP = Math.min(maxUnitLength, Math.floor(n / minNeed))
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

/** 移除所有空白字符（与 CONFIG.stripWhitespace 配合）。 */
function stripWhitespace(text) {
  return text.replace(/\s+/g, '')
}

/** 移除白名单字符（与 CONFIG.ignoredChars 配合）。按 Unicode 码点逐个比对。 */
function stripIgnoredChars(text, ignored) {
  if (ignored.length === 0) return text
  let out = ''
  for (const ch of text) {
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
 * 代码区域扫描器（每个文本块一份状态）：把增量切成「普通文本 / 代码」两类片段，
 * 调用方按 `threshold` 与 `threshold × codeBlockMultiplier` 分别判定。
 * **三类代码区域统一判定**（同一个倍数、同一个阈值）：
 *
 *   1. 围栏代码块：起始行为行首最多 3 个空格 + 连续 ≥3 个 ` 或 ~（其后为 info string）；
 *      结束行为同字符且不短于起始长度的 run（其后仅空白）；未闭合的围栏延续到块结束。
 *   2. 缩进代码块：行首缩进 ≥4（制表符按 4 计）、**上一行为空行**、且上一个非空行不是列表项 /
 *      引用起始（避免把「列表项之后的缩进内容」与「段落续行」误判为代码）；块内空行不终止，
 *      遇到首个「非空且缩进 <4」的行退出。
 *   3. 行内代码：1–64 个反引号开启，须在**同一行**内由等长 run 闭合；换行 / 超过
 *      INLINE_HOLD_LIMIT / 块结束仍未闭合时，开启符按普通文本处理，内容照常参与检测。
 *
 * 增量切分安全：围栏标记、行首缩进、行内定界符都可能被切进多个 delta，状态全部保存在实例里；
 * 行内区需要**有界 hold-back**（开启符之后的内容先不发射，闭合后整体按代码发射），
 * 因此调用方必须在块结束时调用 flush()，否则这部分文本会漏检。
 * 局限：不解析引用 / 表格 / 嵌套列表造成的缩进基线（见 README「代码区域判定」）。
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

  /** 空白字符（含 \r：CRLF 行尾不能把空行判定成非空行）。 */
  const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\r'
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
    const body = line.replace(/[ \t\r]+$/, '')
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
            // 只有空格与制表符计入缩进（\r 是 CRLF 行尾，不参与缩进计算）
            headIndent += ch === '\t' ? 4 : (ch === ' ' ? 1 : 0)
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
            // 行首 1–2 个反引号 = 行内定界符（须在同一行闭合）
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
          else if (!isSpace(ch)) lineBlank = false
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

function warnUnknownBlockType(blockType) {
  if (warnedUnknownBlockType) return
  warnedUnknownBlockType = true
  console.warn(
    '[dupguard] 遇到未知块类型 ' + JSON.stringify(blockType) +
    '：截停收尾只能按 tool-call 兜底，请升级插件以匹配新的 DSH 协议。'
  )
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

/** 策略次数是否可用：整数且落在 [2, threshold 上限] 内（其余视为「该长度不判定」）。 */
function isValidNeed(value) {
  return Number.isSafeInteger(value) && value >= 2 && value <= LIMITS.threshold.max
}

/**
 * 解析分段表字符串：`"<maxLen>:<count>[, …][, *:<count>]"`。
 * 返回按 maxLen 升序的条目数组（`maxLength === null` 表示 `*` 默认项）；
 * 非法项丢弃并只告警一次。
 */
function parseThresholdByLength(raw) {
  const entries = []
  const dropped = []
  const parts = String(raw === undefined || raw === null ? '' : raw).split(',')
  for (const part of parts) {
    const text = part.trim()
    if (text.length === 0) continue
    const match = /^(\*|\d+)\s*:\s*(\d+)$/.exec(text)
    if (match === null) {
      dropped.push(text)
      continue
    }
    const count = Number(match[2])
    if (!isValidNeed(count)) {
      dropped.push(text)
      continue
    }
    if (match[1] === '*') {
      entries.push({ maxLength: null, count })
      continue
    }
    const maxLength = Number(match[1])
    if (maxLength < 1) {
      dropped.push(text)
      continue
    }
    const existing = entries.findIndex((entry) => entry.maxLength === maxLength)
    if (existing !== -1) entries[existing] = { maxLength, count }
    else entries.push({ maxLength, count })
  }
  if (dropped.length > 0) {
    warnPolicyOnce(
      'table:' + JSON.stringify(dropped),
      '[dupguard] 分段表条目无效，已忽略：' + JSON.stringify(dropped) +
      '（格式 "<最大长度>:<次数>" 或 "*:<次数>"，次数为 2–' + String(LIMITS.threshold.max) + ' 的整数）。'
    )
  }
  // 具名项按 maxLen 升序；`*` 永远排最后作为兜底。
  const named = entries.filter((entry) => entry.maxLength !== null).sort((a, b) => a.maxLength - b.maxLength)
  const fallback = entries.filter((entry) => entry.maxLength === null)
  return named.concat(fallback)
}

/** 从分段条目 + 基础阈值构建 counts 表（未覆盖长度用 `*`，无 `*` 用基础阈值）。 */
function countsFromEntries(entries, runtime, multiplier) {
  const counts = new Int32Array(runtime.maxUnitLength + 1)
  for (let p = runtime.minUnitLength; p <= runtime.maxUnitLength; p++) {
    let need = runtime.threshold
    for (const entry of entries) {
      if (entry.maxLength === null || p <= entry.maxLength) {
        need = entry.count
        break
      }
    }
    counts[p] = multiplier === 1 ? need : Math.min(need * multiplier, LIMITS.threshold.max * 100)
  }
  return counts
}

/** 从 counts 表汇总策略元信息（最松次数、最长跨度）。 */
function policyFromCounts(counts, source, runtime) {
  let minNeed = Number.MAX_SAFE_INTEGER
  let worstSpan = 0
  for (let p = runtime.minUnitLength; p <= runtime.maxUnitLength; p++) {
    const need = counts[p]
    if (need < 2) continue
    if (need < minNeed) minNeed = need
    if (p * need > worstSpan) worstSpan = p * need
  }
  return {
    counts,
    minNeed: minNeed === Number.MAX_SAFE_INTEGER ? 0 : minNeed,
    worstSpan,
    source,
  }
}

/**
 * 构建阈值策略。simple 模式返回 undefined（不建表、不查表，走原有快路径）；
 * table / module 失败时同样返回 undefined 并告警一次（回退基础阈值）。
 *
 * @param runtime - 运行时配置（已归一化 thresholdMode / thresholdByLength / advancedThresholdFile）。
 * @param multiplier - 代码块倍数（1 表示块外）。
 */
function createThresholdPolicy(runtime, multiplier, loader) {
  const mode = runtime.thresholdMode
  if (mode !== 'table' && mode !== 'module') return undefined
  const scale = multiplier === undefined ? 1 : multiplier
  if (mode === 'table') {
    const entries = parseThresholdByLength(runtime.thresholdByLength)
    if (entries.length === 0) {
      warnPolicyOnce(
        'table-empty',
        '[dupguard] 分段表模式已启用但分段表为空，回退基础阈值 ' + String(runtime.threshold) + '。'
      )
      return undefined
    }
    return policyFromCounts(countsFromEntries(entries, runtime, scale), 'table', runtime)
  }
  if (typeof loader !== 'function') {
    warnPolicyOnce(
      'module-unsupported',
      '[dupguard] 当前入口不支持高级模式（module），回退基础阈值 ' + String(runtime.threshold) + '。',
    )
    return undefined
  }
  const loaded = loader(runtime.advancedThresholdFile)
  if (loaded.fn === null) {
    warnPolicyOnce(
      'module:' + String(runtime.advancedThresholdFile) + ':' + String(loaded.error),
      '[dupguard] 高级模式不可用（' + String(loaded.error) + '），回退基础阈值 ' + String(runtime.threshold) + '。'
    )
    return undefined
  }
  const counts = new Int32Array(runtime.maxUnitLength + 1)
  for (let p = runtime.minUnitLength; p <= runtime.maxUnitLength; p++) {
    let value
    try {
      value = loaded.fn(p)
    } catch (error) {
      warnPolicyOnce(
        'module-throw:' + String(error && error.message ? error.message : error),
        '[dupguard] 高级模块在处理长度 ' + String(p) + ' 时抛错，回退基础阈值 ' + String(runtime.threshold) +
        '：' + String(error && error.message ? error.message : error),
      )
      return undefined
    }
    counts[p] = isValidNeed(value)
      ? (scale === 1 ? value : Math.min(value * scale, LIMITS.threshold.max * 100))
      : 0 // 非法返回值 → 该长度不判定（用户可用 < 2 显式关闭某个长度）
  }
  return policyFromCounts(counts, 'module', runtime)
}

/**
 * 为一次 llm/stream 调用创建守卫。
 * 每次模型调用都会新建一份状态，互不干扰。
 * @param options - llm/stream 的 GenerateOptions。
 * @param runtime - 运行时配置（ignoredChars 可被设置页热更新）。
 * @param hooks - 可选钩子：`onStop(hit)` 在命中收尾前触发一次（用于生成截停通知）。
 */
function createStreamGuard(options, runtime, hooks) {
  const hookOf = (name) => (hooks !== undefined && hooks !== null && typeof hooks[name] === 'function' ? hooks[name] : null)
  const onStop = hookOf('onStop')
  const onThreshold = hookOf('onThreshold')
  const onThresholdSettled = hookOf('onThresholdSettled')
  // index -> 块状态。用 Map 按块索引累积，避免多个文本块交替输出时互相打断检测。
  const blocks = new Map()
  /** 决策兜底倍数：达到「阈值 × 倍数」才强制截停（仅在决策模式生效）。 */
  const multiplierOf = () => (Number.isSafeInteger(runtime.stopAtMultiplier) && runtime.stopAtMultiplier >= 2 ? runtime.stopAtMultiplier : 2)

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
        substrings: createSubstringStripper(() => runtime.ignoredSubstrings, IGNORED_SUBSTRING_MAX_LENGTH),
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
   * 增量先经代码区域扫描器切成片段：普通片段按 threshold 判定，代码片段
   * （围栏 / 行内 / 缩进三类统一）按 threshold × codeBlockMultiplier 判定。
   */
  function feedText(b, delta) {
    b.text += delta
    const runs = runtime.skipCodeBlocks === true ? b.code.push(delta) : [{ text: delta, code: false }]
    return feedRuns(b, runs)
  }

  /**
   * 把片段序列喂给检测缓冲，返回命中结果（null 表示未命中）。
   * 代码片段用 threshold × codeBlockMultiplier 与 codeThresholdPolicy 判定，
   * 普通片段用 threshold 与 thresholdPolicy 判定。
   */
  function feedRuns(b, runs) {
    const codeBlocksOn = runtime.skipCodeBlocks === true
    const mode = codeBlocksOn ? runtime.codeBlockMultiplier : 1
    const skipInsideCode = mode === 0
    const codeThreshold = runtime.threshold * mode
    for (const run of runs) {
      // 倍数 0（完全不检测代码块）时，进入/离开代码块都清空检测缓冲，
      // 避免把围栏两侧的文本拼成人为重复。
      if (skipInsideCode && b.lastRunCode !== undefined && run.code !== b.lastRunCode) b.stripped = ''
      b.lastRunCode = run.code
      if (skipInsideCode && run.code) continue
      const piece = sanitizePiece(b.substrings.push(run.text), runtime)
      if (piece.length === 0) continue
      b.stripped = (b.stripped + piece).slice(-runtime.detectionWindow)
      const threshold = run.code ? codeThreshold : runtime.threshold
      const policy = run.code ? runtime.codeThresholdPolicy : runtime.thresholdPolicy
      const hit = findRepeatedTail(b.stripped, threshold, runtime.minUnitLength, runtime.maxUnitLength, policy)
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
    const tail = sanitizePiece(b.substrings.flush(), runtime)
    if (tail.length === 0) return null
    b.stripped = (b.stripped + tail).slice(-runtime.detectionWindow)
    const threshold = b.lastRunCode === true
      ? runtime.threshold * (runtime.skipCodeBlocks === true ? runtime.codeBlockMultiplier : 1)
      : runtime.threshold
    const policy = b.lastRunCode === true ? runtime.codeThresholdPolicy : runtime.thresholdPolicy
    return findRepeatedTail(b.stripped, threshold, runtime.minUnitLength, runtime.maxUnitLength, policy)
  }

  /** 命中所属通道：通知里要显示"重复出现在哪里"。 */
  function sourceOf(blockType) {
    if (blockType === 'reasoning') return 'reasoning'
    if (blockType === 'tool-call') return 'tool-arguments'
    return 'text'
  }

  /** 命中结果附带来源与块索引（供通知与「第二阶段」定位）。 */
  function withSource(hit, index, blockType) {
    if (hit === null) return null
    return { ...hit, index, source: sourceOf(blockType), blockType }
  }

  /**
   * 依据 StreamChunk 协议累积状态。
   * @returns 命中结果（含 unit/count/span/code/source/index/blockType）或 null；
   *   是否/何时截停由外层 guarded 决定（决策卡片默认不暂停输出；无决策时命中即截停）。
   */
  function feed(chunk) {
    switch (chunk.type) {
      case 'block-start': {
        ensure(chunk.index, chunk.blockType)
        return null
      }
      case 'text-delta': {
        const b = ensure(chunk.index, 'text')
        return withSource(feedText(b, chunk.text), chunk.index, 'text')
      }
      case 'reasoning-delta': {
        const b = ensure(chunk.index, 'reasoning')
        if (runtime.monitorReasoning) {
          // feedText 内部负责累积完整文本与检测缓冲，这里不得重复 +=
          return withSource(feedText(b, chunk.text), chunk.index, 'reasoning')
        }
        b.text += chunk.text // 不检测时仍须累积完整内容以便停止时闭合块
        return null
      }
      case 'tool-call-delta': {
        const b = ensure(chunk.index, 'tool-call')
        if (chunk.id !== undefined) b.toolCallId = chunk.id
        if (chunk.name !== undefined) b.toolCallName = chunk.name
        b.toolCallArguments += chunk.argumentsDelta
        if (runtime.monitorToolArguments) {
          const piece = sanitizePiece(b.substrings.push(chunk.argumentsDelta), runtime)
          b.stripped = (b.stripped + piece).slice(-runtime.detectionWindow)
          const hit = findRepeatedTail(b.stripped, runtime.threshold, runtime.minUnitLength, runtime.maxUnitLength, runtime.thresholdPolicy)
          return withSource(hit, chunk.index, 'tool-call')
        }
        return null
      }
      case 'block-end': {
        const b = blocks.get(chunk.index)
        const codeHit = flushCodeRegion(b)
        const tailHit = flushSubstringTail(b)
        blocks.delete(chunk.index)
        const hit = codeHit !== null ? codeHit : tailHit
        return withSource(hit, chunk.index, b === undefined ? undefined : b.blockType)
      }
      case 'usage':
      case 'finish': {
        // 流结束时可能还有未收到 block-end 的块：把尾巴补上，避免尾部文本漏检。
        let first = null
        for (const b of blocks.values()) {
          const codeHit = flushCodeRegion(b)
          if (first === null && codeHit !== null) first = { ...codeHit, source: sourceOf(b.blockType) }
          const tailHit = flushSubstringTail(b)
          if (first === null && tailHit !== null) first = { ...tailHit, source: sourceOf(b.blockType) }
        }
        return first
      }
      default:
        return null
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
      if (b.blockType !== 'tool-call') warnUnknownBlockType(b.blockType)
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

  /** 统计 text 尾部连续重复 unit 的次数（最多 max 次，避免无界循环）。 */
  function trailingRepeatCount(text, unit, max) {
    if (typeof text !== 'string' || unit.length === 0) return 0
    let count = 0
    let end = text.length
    while (count < max && end - unit.length >= 0 && text.slice(end - unit.length, end) === unit) {
      count += 1
      end -= unit.length
    }
    return count
  }

  /**
   * 统计 text 尾部一段窗口内 unit 的非重叠出现次数（最多 cap 次）。
   *
   * 决策阶段不能只数「尾部连续重复」：周期文本（例如无限字母表）每来一个字符，
   * 尾部单元的相位就会旋转，固定 unit 的尾部次数会瞬间掉到 0；用窗口出现次数
   * 才能判断同一次重复事件是否仍在继续（自动截停也用它计数）。
   */
  function countOccurrencesInWindow(text, unit, windowChars, cap) {
    if (typeof text !== 'string' || unit.length === 0 || windowChars <= 0) return 0
    const hay = windowChars >= text.length ? text : text.slice(-windowChars)
    let count = 0
    let index = 0
    while (count < cap) {
      const found = hay.indexOf(unit, index)
      if (found < 0) break
      count += 1
      index = found + unit.length
    }
    return count
  }

  /** 命中信息对外形状（不暴露内部块索引等实现细节）。 */
  function publicHit(hit) {
    return { unit: hit.unit, count: hit.count, span: hit.span, code: hit.code === true, source: hit.source }
  }

  /** 输出截停日志并调用 onStop（唯一收尾入口；失败只告警）。 */
  function emitStop(hit, meta) {
    const span = Number.isSafeInteger(hit.span) ? hit.span : hit.unit.length * (Number.isSafeInteger(hit.count) ? hit.count : 1)
    console.log(
      '[dupguard] 检测到重复输出，已停止生成：provider=' + provider + ' model=' + model +
      ' unit=' + JSON.stringify(hit.unit) +
      ' repeat>=' + String(hit.count) +
      ' span=' + String(span) + 'chars' +
      (hit.code === true ? ' code-block=true（放宽阈值命中）' : '') +
      ' decision=' + String(meta.decision) +
      (Number.isSafeInteger(meta.heldMs) && meta.heldMs > 0 ? ' held=' + String(meta.heldMs) + 'ms' : '')
    )
    if (onStop !== null) {
      try {
        onStop(publicHit(hit), meta)
      } catch (hookError) {
        console.warn('[dupguard] 截停通知钩子失败（截停本身不受影响）：' +
          (hookError && hookError.message ? hookError.message : String(hookError)))
      }
    }
  }

  /** 通知宿主「决策/第二阶段已结束」（供通知卡片状态流转；失败只告警）。 */
  function settleDecision(hit, outcome) {
    if (onThresholdSettled === null || hit === undefined || hit === null) return
    try {
      onThresholdSettled(publicHit(hit), outcome)
    } catch (hookError) {
      console.warn('[dupguard] 决策状态钩子失败（不影响检测）：' +
        (hookError && hookError.message ? hookError.message : String(hookError)))
    }
  }

  /**
   * 包装上游流：逐块透传 + 检测。
   *
   * 两种模式：
   * - 未提供 onThreshold（动态入口 / 测试桩 / 关闭决策）：命中即收尾（原有行为）；
   * - 提供 onThreshold（npm 常驻版 + 通知通道）：命中阈值后**不暂停输出**，只通过钩子发出决策卡片；
   *   输出继续，同时进入观察状态：
   *   · 用户 stop → 下一个 chunk 立即收尾（decision=user）；
   *   · 用户 allow → 本次调用不再检测；
   *   · 自动截停条件 = 实际重复 ≥ 阈值 × stopAtMultiplier **且** 距命中已过 decisionTimeoutMs
   *     （两者都满足才停，即“两个时刻中较晚的那个”）；
   *   · 重复中断 → 取消本次决策；流结束 → 不截停。
   *   onThreshold 第二个参数是控制句柄 `{ action }`：宿主写入 'stop' / 'allow'，
   *   引擎在下一个 chunk 生效。
   */
  async function* guarded(source) {
    let detectionEnabled = true
    let stage = null
    // 暂停显示模式（可选）：只有常驻版 + 通知通道 + pauseDecisionOutput=true 时生效。
    const pauseEnabled = runtime.pauseDecisionOutput === true && onThreshold !== null
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const pauseEligible = (chunk) => pauseEnabled && chunk !== null && typeof chunk === 'object' &&
      (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
      Number.isSafeInteger(chunk.index)
    /** 命中 chunk 在 feed 前的内容快照：暂停模式下若用户截停，用快照丢弃未显示的整块内容。 */
    const captureBlockSnapshot = (index) => {
      const b = blocks.get(index)
      if (b === undefined) return { index, exists: false }
      return { index, exists: true, text: b.text, toolCallArguments: b.toolCallArguments, toolCallName: b.toolCallName, toolCallId: b.toolCallId }
    }
    const restoreBlockSnapshot = (snapshot) => {
      if (snapshot === null) return
      if (!snapshot.exists) {
        blocks.delete(snapshot.index)
        return
      }
      const b = blocks.get(snapshot.index)
      if (b === undefined) return
      b.text = snapshot.text
      b.toolCallArguments = snapshot.toolCallArguments
      b.toolCallName = snapshot.toolCallName
      b.toolCallId = snapshot.toolCallId
    }
    const stageStats = (target) => {
      const b = blocks.get(target.index)
      const text = b === undefined ? '' : b.stripped
      const reps = trailingRepeatCount(text, target.unit, target.limit)
      const continuing = countOccurrencesInWindow(text, target.unit, target.continuationWindow, target.need + 3)
      const progressing = countOccurrencesInWindow(text, target.unit, target.autoWindow, target.limit + 2)
      return { reps, continuing, progressing, reported: Math.max(reps, progressing) }
    }
    /** 尝试开启一次决策；返回 stage，或 null 表示回退「阈值即停」。 */
    const openStage = (hit) => {
      const multiplier = multiplierOf()
      const need = Number.isSafeInteger(hit.count) && hit.count > 1 ? hit.count : runtime.threshold
      const limit = need * multiplier
      const spanNeeded = limit * hit.unit.length
      if (spanNeeded > runtime.detectionWindow) {
        warnPolicyOnce('decision-window-short',
          '[dupguard] 检测窗口不足以观察 ' + String(multiplier) + ' 倍重复（需要 ' + String(spanNeeded) +
          ' 字符，窗口 ' + String(runtime.detectionWindow) + '）：本条命中直接截停')
        return null
      }
      const startedAt = Date.now()
      const reactionMs = Number.isSafeInteger(runtime.decisionTimeoutMs) && runtime.decisionTimeoutMs >= 0
        ? Math.min(15000, runtime.decisionTimeoutMs)
        : 4000
      const control = { action: null }
      try {
        const maybePromise = onThreshold(publicHit(hit), control)
        // 宿主实现是同步的；若自定义实现返回 Promise，只挂错误处理，不等待（连续输出模式不暂停）。
        if (maybePromise !== null && typeof maybePromise === 'object' && typeof maybePromise.then === 'function') {
          maybePromise.catch((hookError) => {
            console.warn('[dupguard] 阈值决策钩子异步失败（不影响检测）：' +
              (hookError && hookError.message ? hookError.message : String(hookError)))
          })
        }
      } catch (hookError) {
        console.warn('[dupguard] 阈值决策钩子失败（回退为直接截停）：' +
          (hookError && hookError.message ? hookError.message : String(hookError)))
        return null
      }
      const unitLength = hit.unit.length
      return {
        hit,
        unit: hit.unit,
        need,
        limit,
        index: hit.index,
        startedAt,
        deadline: startedAt + reactionMs,
        control,
        // 出现次数窗口：留出相位余量，保证周期文本的固定 unit 在任意相位都能数到足够次数。
        continuationWindow: Math.min(runtime.detectionWindow, (need + 2) * unitLength),
        autoWindow: Math.min(runtime.detectionWindow, (limit + 1) * unitLength),
      }
    }
    try {
      for await (const chunk of source) {
        const chunkType = chunk !== null && typeof chunk === 'object' ? chunk.type : undefined
        const isFinalChunk = chunkType === 'finish' || chunkType === 'usage'
        const stageBlockEnded = stage !== null && chunkType === 'block-end' && chunk.index === stage.index
        // 先 feed 再决定是否 yield：暂停显示模式需要在内容显示前拦住命中块。
        const snapshot = stage === null && pauseEligible(chunk) ? captureBlockSnapshot(chunk.index) : null
        const hit = feed(chunk)
        if (!detectionEnabled) {
          yield chunk
          continue
        }
        if (stage !== null) {
          yield chunk
          const now = Date.now()
          const control = stage.control
          const stats = stageStats(stage)
          // 用户动作优先：立即截停 / 允许继续，下个 chunk 生效。
          if (control !== null && control.action === 'stop') {
            const count = stats.reported > 0 ? stats.reported : stage.need
            emitStop({ ...stage.hit, count, span: count * stage.unit.length }, { decision: 'user', heldMs: now - stage.startedAt })
            stage = null
            yield* closingChunks()
            return
          }
          if (control !== null && control.action === 'allow') {
            detectionEnabled = false
            settleDecision(stage.hit, 'allowed')
            stage = null
            continue
          }
          if (stageBlockEnded || isFinalChunk) {
            settleDecision(stage.hit, isFinalChunk ? 'expired' : 'recovered')
            stage = null
            continue
          }
          // 重复事件中断：窗口内该 unit 的出现次数低于阈值（窗口足够长，不受尾部相位旋转影响）。
          if (stats.continuing < stage.need) {
            settleDecision(stage.hit, 'recovered')
            stage = null
            continue
          }
          if (stats.progressing >= stage.limit && now >= stage.deadline) {
            emitStop({ ...stage.hit, count: stats.progressing, span: stats.progressing * stage.unit.length }, { decision: 'auto', heldMs: now - stage.startedAt })
            stage = null
            yield* closingChunks()
            return
          }
          continue
        }
        if (hit === null) {
          yield chunk
          continue
        }
        if (!isFinalChunk && onThreshold !== null) {
          const opened = openStage(hit)
          if (opened !== null) {
            stage = opened
            // 暂停显示（B）：命中块先扣住，等用户动作或反应时间到；模型端可能继续生成，可显示端暂停。
            if (snapshot !== null && pauseEligible(chunk)) {
              const control = stage.control
              while (control.action === null && Date.now() < stage.deadline) {
                await sleep(Math.max(5, Math.min(50, stage.deadline - Date.now())))
              }
              if (control.action === 'stop') {
                const stats = stageStats(stage)
                const count = stats.reported > 0 ? stats.reported : stage.need
                restoreBlockSnapshot(snapshot)
                emitStop({ ...stage.hit, count, span: count * stage.unit.length }, { decision: 'user', heldMs: Date.now() - stage.startedAt })
                stage = null
                yield* closingChunks()
                return
              }
              if (control.action === 'allow') {
                settleDecision(stage.hit, 'allowed')
                stage = null
                detectionEnabled = false
                yield chunk
                continue
              }
              const stats = stageStats(stage)
              if (stats.progressing >= stage.limit) {
                restoreBlockSnapshot(snapshot)
                emitStop({ ...stage.hit, count: stats.progressing, span: stats.progressing * stage.unit.length }, { decision: 'auto', heldMs: Date.now() - stage.startedAt })
                stage = null
                yield* closingChunks()
                return
              }
              // 未达到强制截停条件：恢复显示，之后按连续观察模式继续（卡片转为「输出继续」）。
              if (typeof control.onResume === 'function') {
                try {
                  control.onResume()
                } catch (_resumeError) {}
              }
              yield chunk
              continue
            }
            yield chunk
            continue
          }
          // 检测窗口不足 / 钩子异常：显示本块后回退为阈值即停。
          yield chunk
          emitStop(hit, { decision: 'threshold', heldMs: 0 })
          yield* closingChunks()
          return
        }
        // 无决策钩子 / 流尾命中：沿用「阈值即停」。
        yield chunk
        emitStop(hit, { decision: 'threshold', heldMs: 0 })
        yield* closingChunks()
        return
      }
    } finally {
      if (stage !== null) {
        settleDecision(stage.hit, 'expired')
        stage = null
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
function installStandingMountPatch(inspect) {
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

/** 代码块内的检测策略：0 = 完全不检测，1 = 与块外同样严格，≥2 = 放宽到 threshold × 倍数。 */
function codeBlockMode(runtime) {
  if (runtime.skipCodeBlocks !== true) return 1
  return runtime.codeBlockMultiplier
}

/** 代码块内实际使用的最严格阈值（跳过或未放宽时等于 threshold）。 */
function effectiveCodeThreshold(runtime) {
  const mode = codeBlockMode(runtime)
  if (mode === 0) return runtime.threshold
  return runtime.threshold * mode
}

/**
 * 分段表模式下的最大重复单元长度：由**最后一个具名条目的终止值**决定
 * （设置页表格的末行「终止」= 最大检测长度）。
 *
 * 旧写法里的 `*:<次数>` 表示「其后所有长度沿用该次数」：此时上界按**文档里的
 * maxUnitLength** 延伸（与设置页把 `*` 迁移成「终止 = 文档 maxUnitLength」的末行一致），
 * 避免旧配置突然丢掉长单元范围。空表或只有 `*` 时返回 undefined（无法派生，沿用文档值）。
 */
function deriveMaxUnitLength(runtime) {
  const entries = parseThresholdByLength(runtime.thresholdByLength)
  const ends = entries.filter((entry) => entry.maxLength !== null).map((entry) => entry.maxLength)
  if (ends.length === 0) return undefined
  const lastEnd = ends[ends.length - 1]
  const hasStar = entries.some((entry) => entry.maxLength === null)
  const documentMax = Number.isSafeInteger(runtime.maxUnitLength) ? runtime.maxUnitLength : lastEnd
  const bound = hasStar ? Math.max(lastEnd, documentMax) : lastEnd
  return Math.min(Math.max(bound, LIMITS.maxUnitLength.min), LIMITS.maxUnitLength.max)
}

/**
 * 派生检测窗口：**正好等于「最严格的重复跨度」**，用户无需填写。
 *
 * 窗口是清洗后保留的字符数：识别长度 p 的单元需要 p × need(p) 个字符，因此所需跨度取
 *   简单模式：max(threshold, threshold × 代码块倍数) × maxUnitLength
 *   策略模式（table/module）：各长度跨度 `p × need(p)` 的最大值（未覆盖长度已按 `*` 或基础阈值
 *                              写进 counts 表，代码块一侧也已乘过倍数）——**不再叠加固定阈值**，
 *                              否则 table `*:3` + 最大单元 1000 会被算成 10 × 1000 = 10000，
 *                              而实际只需 3 × 1000 = 3000。
 * 结果再夹到 LIMITS.detectionWindow 区间（夹住即 clamped，说明阈值/倍数/最大单元长度或策略跨度
 * 设得过大，需要调小其中之一）。
 *
 * @returns {{ value: number, required: number, clamped: boolean, threshold: number, policySpan: number }}
 */
function deriveWindow(runtime) {
  const threshold = Math.max(runtime.threshold, effectiveCodeThreshold(runtime))
  const plainSpan = threshold * runtime.maxUnitLength
  const policySpan = Math.max(
    runtime.thresholdPolicy === undefined ? 0 : runtime.thresholdPolicy.worstSpan,
    runtime.codeThresholdPolicy === undefined ? 0 : runtime.codeThresholdPolicy.worstSpan,
  )
  const hasPolicy = runtime.thresholdPolicy !== undefined || runtime.codeThresholdPolicy !== undefined
  const required = hasPolicy && policySpan > 0 ? policySpan : plainSpan
  const value = Math.min(Math.max(required, LIMITS.detectionWindow.min), LIMITS.detectionWindow.max)
  return { value: value, required: required, clamped: value < required, threshold: threshold, policySpan: policySpan }
}

/**
 * 检测窗口（自动派生）是否被上限夹住：被夹住时无法识别最长的重复单元，
 * 返回缺口描述供日志与设置页提示；正常情况下返回 null。
 */
function windowShortfall(runtime) {
  const derived = deriveWindow(runtime)
  if (!derived.clamped) return null
  return {
    needed: derived.required,
    current: derived.value,
    threshold: derived.threshold,
    effectiveMaxUnit: Math.floor(derived.value / derived.threshold),
    policySpan: derived.policySpan,
  }
}

/** 窗口偏小时打一条宿主日志（设置页另有同样的提示）；同样内容只告警一次。 */
function warnShortWindow(runtime) {
  const short = windowShortfall(runtime)
  if (short === null) {
    lastWindowWarning = ''
    return
  }
  const relaxed = short.threshold !== runtime.threshold
  const signature = [
    short.needed, short.current, runtime.threshold, runtime.maxUnitLength,
    relaxed ? runtime.codeBlockMultiplier : 1, short.policySpan,
  ].join('/')
  if (signature === lastWindowWarning) return
  lastWindowWarning = signature
  console.warn(
    '[dupguard] 检测窗口（自动派生）需要 ' + String(short.needed) + ' 字符，超过上限 ' + String(short.current) +
    '（= 阈值 ' + String(runtime.threshold) +
    (relaxed ? ' × 代码块倍数 ' + String(runtime.codeBlockMultiplier) : '') +
    ' × 最大单元长度 ' + String(runtime.maxUnitLength) +
    (short.policySpan > 0 ? '，或策略最长跨度 ' + String(short.policySpan) : '') +
    '）；超过 ' + String(short.effectiveMaxUnit) +
    ' 字符的重复单元将无法识别。请降低阈值 / 代码块倍数 / 最大单元长度（或策略跨度）。'
  )
}

module.exports = {
  DEFAULT_CONFIG,
  LIMITS,
  IGNORED_SUBSTRINGS_MAX_COUNT,
  IGNORED_SUBSTRING_MAX_LENGTH,
  THRESHOLD_MODES,
  CONTINUE_PROMPT_MAX,
  warnPolicyOnce,
  findRepeatedTail,
  stripWhitespace,
  stripIgnoredChars,
  sanitizePiece,
  createSubstringStripper,
  createCodeScanner,
  warnUnknownBlockType,
  normalizeIgnoredSubstrings,
  isValidNeed,
  parseThresholdByLength,
  countsFromEntries,
  policyFromCounts,
  createThresholdPolicy,
  createStreamGuard,
  installStandingMountPatch,
  codeBlockMode,
  effectiveCodeThreshold,
  deriveMaxUnitLength,
  deriveWindow,
  windowShortfall,
  warnShortWindow,
}
