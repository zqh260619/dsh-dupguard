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
function findRepeatedTail(text, threshold, minUnitLength, maxUnitLength) {
  const n = text.length
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
 * 流式围栏代码块过滤器（每个文本块一份状态）。
 *
 * 目标：把增量切成「普通文本 / 代码块内文本」两段，供检测按不同阈值判定——
 * 代码块内的重复大多是正常内容（生成的测试夹具、表格、ASCII 图、内嵌数据），
 * 按普通阈值会误杀，故块内使用放宽阈值。
 *
 * 规则按 CommonMark 的围栏代码块：
 *   - 起始行：行首最多 3 个空格 + 连续 ≥3 个 ` 或 ~（其后为 info string）；
 *   - 结束行：行首最多 3 个空格 + 同字符且不短于起始长度的连续 run，其后仅允许空白；
 *   - 未闭合的围栏一直延续到该块结束。
 * 增量切分安全：围栏标记被切进多个 delta（如 "``" + "`js"）时靠行首缓冲继续判定。
 * 局限：不识别行内代码（`x`）与缩进代码块（4 空格），它们按普通文本处理。
 *
 * 与 lib/index.js 中的同名实现保持一致（两个入口行为必须相同）。
 */
function createFenceFilter() {
  // 围栏字符 run 的长度上限：超过即按上限记录并进入代码块，避免无界缓冲。
  const MAX_FENCE_RUN = 64
  let atLineStart = true
  let head = '' // 行首缓冲：最多 3 个空格 + 可能的围栏字符 run
  let headSpaces = 0
  let headChar = ''
  let fence = null // { char, len }：已进入代码块
  let closeLine = '' // 代码块内当前行（用于判定结束行）
  let closeTooLong = false

  const runLength = () => head.length - headSpaces
  const resetHead = () => {
    head = ''
    headSpaces = 0
    headChar = ''
  }

  /** 当前行是否为结束行（同字符、不短于起始长度、其后仅空白）。 */
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

  return {
    /** 当前是否处于围栏代码块内（诊断/测试用）。 */
    inside: () => fence !== null,
    /**
     * 消费一个增量，返回按「是否位于代码块内」切分的片段序列。
     * 片段按原始顺序首尾相接即为完整增量，调用方据此分别用普通/放宽阈值检测。
     * @param delta - 文本增量。
     * @returns {Array<{ text: string, code: boolean }>} 片段序列（可能为空数组）。
     */
    push(delta) {
      // 快路径：不含围栏字符与换行的增量不可能改变围栏状态。
      if (fence !== null && delta.indexOf(fence.char) === -1 && delta.indexOf('\n') === -1) {
        return [{ text: delta, code: true }]
      }
      if (fence === null && !atLineStart &&
        delta.indexOf('`') === -1 && delta.indexOf('~') === -1 && delta.indexOf('\n') === -1) {
        return [{ text: delta, code: false }]
      }
      const runs = []
      let buffer = ''
      let bufferCode = fence !== null
      const emit = (text, code) => {
        if (text.length === 0) return
        if (buffer.length > 0 && code !== bufferCode) {
          runs.push({ text: buffer, code: bufferCode })
          buffer = ''
        }
        bufferCode = code
        buffer += text
      }
      for (let i = 0; i < delta.length; i++) {
        const ch = delta[i]
        if (fence !== null) {
          // 代码块内：只判定结束行，内容整体按代码发射。
          if (ch === '\n') {
            const closing = isClosingLine(closeLine)
            emit(ch, true)
            closeLine = ''
            closeTooLong = false
            if (closing) {
              fence = null
              atLineStart = true
              resetHead()
              bufferCode = false
            }
            continue
          }
          if (!closeTooLong) {
            closeLine += ch
            if (closeLine.length > fence.len + 8) closeTooLong = true
          }
          emit(ch, true)
          continue
        }
        if (atLineStart) {
          if (ch === ' ' && headChar === '' && headSpaces < 3) {
            head += ch
            headSpaces++
            continue
          }
          if ((ch === '`' || ch === '~') && (headChar === '' || headChar === ch)) {
            headChar = ch
            head += ch
            // 不能一见 3 个就进入：起始行的完整 run 才是围栏长度（```` 不能被 ``` 关闭）。
            if (runLength() >= MAX_FENCE_RUN) {
              emit(head, true)
              fence = { char: ch, len: runLength() }
              closeLine = ''
              closeTooLong = false
              atLineStart = false
              resetHead()
            }
            continue
          }
          if (headChar !== '' && runLength() >= 3) {
            // 起始行（含行首空格与围栏符）整体属于代码块，长度取完整 run。
            emit(head, true)
            fence = { char: headChar, len: runLength() }
            closeLine = ''
            closeTooLong = false
            atLineStart = false
            resetHead()
            emit(ch, true)
            continue
          }
          // 判定不是围栏起始：行首缓冲按普通文本交还。
          emit(head, false)
          resetHead()
          atLineStart = ch === '\n'
          emit(ch, false)
          continue
        }
        emit(ch, false)
        if (ch === '\n') {
          atLineStart = true
          resetHead()
        }
      }
      if (buffer.length > 0) runs.push({ text: buffer, code: bufferCode })
      return runs
    },
  }
}

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
        fence: createFenceFilter(), // 围栏代码块状态（skipCodeBlocks 开启时使用）
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
   * 增量先按围栏代码块切成片段，块内按 CONFIG.codeBlockMultiplier 分三档处理：
   * ≥2 放宽（用 threshold × 倍数）、1 与块外同样严格、0 完全不检测。
   */
  function feedText(b, delta) {
    b.text += delta
    const codeBlocksOn = CONFIG.skipCodeBlocks === true
    const mode = codeBlocksOn ? CONFIG.codeBlockMultiplier : 1
    const skipInsideCode = mode === 0
    const codeThreshold = CONFIG.threshold * mode
    const runs = codeBlocksOn ? b.fence.push(delta) : [{ text: delta, code: false }]
    for (const run of runs) {
      // 倍数 0（完全不检测代码块）时，进入/离开代码块都清空检测缓冲，
      // 避免把围栏两侧的文本拼成人为重复。
      if (skipInsideCode && b.lastRunCode !== undefined && run.code !== b.lastRunCode) b.stripped = ''
      b.lastRunCode = run.code
      if (skipInsideCode && run.code) continue
      const piece = sanitizePiece(b.substrings.push(run.text), CONFIG)
      if (piece.length === 0) continue
      b.stripped = (b.stripped + piece).slice(-CONFIG.detectionWindow)
      const threshold = run.code ? codeThreshold : CONFIG.threshold
      const hit = findRepeatedTail(b.stripped, threshold, CONFIG.minUnitLength, CONFIG.maxUnitLength)
      if (hit !== null) return { unit: hit.unit, count: hit.count, span: hit.span, code: run.code }
    }
    return null
  }

  /**
   * 块结束时吐出片段剔除器保留的尾巴（≤ 最长片段 - 1 码点），
   * 让它仍参与检测；阈值沿用该块最后一次片段的代码块归属。
   */
  function flushSubstringTail(b) {
    if (b === undefined || b.substrings === undefined) return null
    const tail = sanitizePiece(b.substrings.flush(), CONFIG)
    if (tail.length === 0) return null
    b.stripped = (b.stripped + tail).slice(-CONFIG.detectionWindow)
    const threshold = b.lastRunCode === true
      ? CONFIG.threshold * (CONFIG.skipCodeBlocks === true ? CONFIG.codeBlockMultiplier : 1)
      : CONFIG.threshold
    return findRepeatedTail(b.stripped, threshold, CONFIG.minUnitLength, CONFIG.maxUnitLength)
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
          b.stripped = (b.stripped + piece).slice(-CONFIG.detectionWindow)
          const hit = findRepeatedTail(b.stripped, CONFIG.threshold, CONFIG.minUnitLength, CONFIG.maxUnitLength)
          if (hit !== null) stopped = hit
        }
        return
      }
      case 'block-end': {
        const b = blocks.get(chunk.index)
        const tailHit = flushSubstringTail(b)
        if (tailHit !== null) stopped = tailHit
        blocks.delete(chunk.index)
        return
      }
      case 'usage':
      case 'finish': {
        // 流结束时可能还有未收到 block-end 的块：把尾巴补上，避免尾部文本漏检。
        for (const b of blocks.values()) {
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
  apply(ctx) {
    if (CONFIG.fixStandingMountConflict) installStandingMountPatch(ctx)
    // llm/stream：包裹每次流式模型调用的瀑布事件。
    // 监听器返回包装后的 AsyncIterable，即成为本次调用对消费方可见的流。
    // （与 @deepseek-ai/dsh-llm 的 invariant、dsh-session-checkpoint-policy 同款接入方式）
    ctx.on('llm/stream', (options, next) => createStreamGuard(options)(next()))
  },
}
