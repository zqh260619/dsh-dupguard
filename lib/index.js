'use strict'

// ============================================================================
// dupguard —— DSH (DeepSeek Harness) 插件（npm / 组合常驻形式，CJS 入口）
//
// 实时检测大模型流式输出中的重复内容：当最新的输出中同一字符串连续重复
// CONFIG.threshold 次及以上时，立即停止本次生成。
//
// 本文件是 package.json 的 main 入口，导出 Cordis 插件对象
// { name, apply }，供 DSH 组合（cordis.yml / preset）挂载；
// 与 plugin/host.js（动态 cordis_define 形式）行为完全一致，
// tests/detector.test.js 会对两者同时跑同一套用例，防止两份代码漂移。
//
// 设置集成（仅本常驻版）：通过 DSH 的 settings 服务注册命名空间
// "dsh-dupguard"，白名单（ignoredChars）可在 Web 设置页修改并持久化
// （见 lib/client.js），修改即时热生效。
// ============================================================================

const name = 'dupguard'

/** 设置命名空间：小写 kebab-case（dsh-settings 的命名规范）。 */
const SETTINGS_NS = 'dsh-dupguard'

/**
 * 可在设置页动态调整的数值参数及其边界。
 * 客户端 UI 会镜像这些边界与默认值（lib/client.js 的 NUMERIC_FIELDS / DEFAULTS），
 * 两处必须保持一致；范围外的写入由 schema 直接拒绝。
 */
const LIMITS = {
  threshold: { min: 2, max: 1000 },
  minUnitLength: { min: 1, max: 4096 },
  maxUnitLength: { min: 1, max: 8192 },
  detectionWindow: { min: 64, max: 1048576 },
  // 0 是哨兵值：表示代码块内完全不检测（见 CONFIG.codeBlockMultiplier 注释）。
  codeBlockMultiplier: { min: 0, max: 100 },
}

/**
 * 片段白名单（ignoredSubstrings）的上限。
 *
 * 两者同时界定「跨增量保留的尾巴长度（≤ 最长片段 - 1 码点）」与单增量匹配成本，
 * 因此是代码常量而非可调设置。
 */
const IGNORED_SUBSTRINGS_MAX_COUNT = 64
const IGNORED_SUBSTRING_MAX_LENGTH = 64

/**
 * 把字段标记为 volatile（DSH 的「可热改」约定）。
 *
 * dsh-settings 的 volatileForm() 只投影 meta.volatile 为真的字段（或其下含 volatile
 * 字段的对象）；一个 entry 若没有任何 volatile 字段，其表单为空、describe() 会**整个
 * 跳过**它，设置页因此拿不到命名空间（0.1.7 上表现为「设置服务不可用」）。同时只有
 * volatile 字段才会被 cordis 的 resolveConfig 包装成带 get() 的响应式单元格——本插件
 * 实时读取参数正依赖这一点。
 *
 * schemastery ≥ 3.18.4 提供 schema.volatile()（内部即 extra('volatile', true)）；
 * 本插件自带副本可能更旧（无该方法），此时直接写 meta 等价。
 */
function markVolatile(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile()
  if (typeof schema.extra === 'function') {
    try {
      return schema.extra('volatile', true)
    } catch (_error) {
      // 退化到 meta 直写
    }
  }
  if (schema.meta !== undefined) schema.meta.volatile = true
  return schema
}

/**
 * 构建设置 schema（默认值取自 CONFIG；全部检测参数均可在设置页动态调整）。
 *
 * 同一份 schema 服务两种 DSH 设置模型：
 *   - DSH ≤ 0.1.6：ctx.settings.register(ns, schema, { base, validate }) 注册命名空间；
 *   - DSH ≥ 0.1.7：作为模块导出的插件 Config，命名空间由 loader entry id 决定。
 * 全部字段都必须 volatile，否则 0.1.7 上不会出现在设置文档里（见 markVolatile）。
 */
function createSettingsSchema(z) {
  return z.object({
    ignoredChars: markVolatile(z.array(z.string()).default([...CONFIG.ignoredChars])),
    ignoredSubstrings: markVolatile(z.array(z.string()).default([...CONFIG.ignoredSubstrings])),
    threshold: markVolatile(z.number().min(LIMITS.threshold.min).max(LIMITS.threshold.max).step(1).default(CONFIG.threshold)),
    minUnitLength: markVolatile(z.number().min(LIMITS.minUnitLength.min).max(LIMITS.minUnitLength.max).step(1).default(CONFIG.minUnitLength)),
    maxUnitLength: markVolatile(z.number().min(LIMITS.maxUnitLength.min).max(LIMITS.maxUnitLength.max).step(1).default(CONFIG.maxUnitLength)),
    detectionWindow: markVolatile(z.number().min(LIMITS.detectionWindow.min).max(LIMITS.detectionWindow.max).step(1).default(CONFIG.detectionWindow)),
    codeBlockMultiplier: markVolatile(z.number().min(LIMITS.codeBlockMultiplier.min).max(LIMITS.codeBlockMultiplier.max).step(1).default(CONFIG.codeBlockMultiplier)),
    stripWhitespace: markVolatile(z.boolean().default(CONFIG.stripWhitespace)),
    skipCodeBlocks: markVolatile(z.boolean().default(CONFIG.skipCodeBlocks)),
    monitorReasoning: markVolatile(z.boolean().default(CONFIG.monitorReasoning)),
    monitorToolArguments: markVolatile(z.boolean().default(CONFIG.monitorToolArguments)),
  })
}

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
  // 条目必须是单个字符（按 Unicode 码点匹配，emoji 也算一个）；
  // 多字符条目永远不会命中，运行时会丢弃并告警。
  ignoredChars: ['-', '|'],
  // 围栏代码块（``` / ~~~）内的重复检测按倍数分三档：
  //   ≥2 → 放宽：块内改用 threshold × codeBlockMultiplier 判定（默认 3），
  //        既能放过正常代码，又能兜住真正的失控复读；
  //   1  → 不放宽：块内与块外同样严格；
  //   0  → 完全不检测：块内内容不参与重复统计（生成的代码再长也不会被截停），
  //        跨围栏边界会清空检测缓冲，避免把围栏两侧文本凑成人为重复。
  // 置 skipCodeBlocks=false 则整体关闭该机制（三档都不生效）。
  // 局限：只识别围栏代码块，行内代码（`x`）与缩进代码块（4 空格）仍按普通阈值判定；
  // 模型忘记闭合围栏时，其后内容都按代码块处理。
  skipCodeBlocks: true,
  codeBlockMultiplier: 3,
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
 * 插件 Config schema（模块导出）：DSH ≥ 0.1.7 的插件设置模型要求它存在。
 *
 * 0.1.7 移除了客户端 settingsScope 与 ctx.settings.register，设置改为
 * 「插件 Config → 命名空间」：DSH 为每个带 Config 的 loader entry 建立命名空间
 * （ns = entry id，本项目 bundle 插入的行 id 为 dupguard），把 settings.yaml 的用户层
 * 合并进 config 注入 apply(ctx, config)，写入后实时下发新 config。没有 Config
 * 的 entry 不会出现在设置文档里（describe 直接跳过），设置页便无数据可读写。
 *
 * schemastery 是 ESM-only：支持 require(esm) 的 Node（≥ 20.19 / 22+）可同步 require，
 * 旧 Node 会抛 ERR_REQUIRE_ESM —— 此时 Config 置空，插件照常加载，只是 ≥ 0.1.7 的
 * 设置页缺少命名空间（DSH ≤ 0.1.6 仍走 ctx.settings.register，不受影响）。
 */
let Config
try {
  const loaded = require('@deepseek-ai/schemastery')
  const z = loaded !== null && typeof loaded === 'object' && loaded.default !== undefined ? loaded.default : loaded
  Config = createSettingsSchema(z)
} catch (error) {
  Config = undefined
  console.warn(
    '[dupguard] 无法同步加载 schemastery，插件 Config 不可用（DSH ≥ 0.1.7 的设置页将缺少命名空间）：' +
    (error && error.message ? error.message : String(error)),
  )
}

/** 惰性获取设置 schema：优先复用同步构建的 Config，旧 Node 上退回动态 import。 */
let settingsSchemaPromise
function loadSettingsSchema() {
  if (settingsSchemaPromise === undefined) {
    settingsSchemaPromise = (async () => {
      if (Config !== undefined) return Config
      const { default: z } = await import('@deepseek-ai/schemastery')
      return createSettingsSchema(z)
    })()
  }
  return settingsSchemaPromise
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
 * 未知块类型只会在 DSH 协议新增 ContentBlock 类型时出现：此时没有合法的合成
 * block-end，只能按 tool-call 兜底并告警一次，便于定位协议漂移。
 */
let warnedUnknownBlockType = false
function warnUnknownBlockType(blockType) {
  if (warnedUnknownBlockType) return
  warnedUnknownBlockType = true
  console.warn(
    '[dupguard] 遇到未知块类型 ' + JSON.stringify(blockType) +
    '：截停收尾只能按 tool-call 兜底，请升级插件以匹配新的 DSH 协议。'
  )
}

/**
 * 白名单按「单个字符」（Unicode 码点）匹配：多字符或空条目永远不会命中，
 * 属于无效配置。此处丢弃并告警，避免设置页显示了一个永远不生效的条目。
 */
function normalizeIgnoredChars(raw, fallback) {
  if (!Array.isArray(raw)) return [...fallback]
  const kept = []
  const dropped = []
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      dropped.push(String(entry))
      continue
    }
    // [...entry] 按码点拆分：emoji 等代理对字符算一个字符。
    if ([...entry].length === 1) kept.push(entry)
    else dropped.push(entry)
  }
  if (dropped.length > 0) {
    // 每次模型调用都会重算参数（DSH ≥ 0.1.7 的 Config 模型），同样的无效条目只告警一次。
    const signature = JSON.stringify(dropped)
    if (signature !== lastIgnoredCharsWarning) {
      lastIgnoredCharsWarning = signature
      console.warn(
        '[dupguard] 白名单条目必须是单个字符，已忽略无效条目：' + JSON.stringify(dropped) +
        '（白名单按字符匹配，多字符条目不会生效）。'
      )
    }
  }
  return kept
}

/** 上一次「无效白名单条目」告警的签名，用于去重（参数每次调用都会重算）。 */
let lastIgnoredCharsWarning = ''

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
 * 为一次 llm/stream 调用创建守卫。
 * 每次模型调用都会新建一份状态，互不干扰。
 * @param options - llm/stream 的 GenerateOptions。
 * @param runtime - 运行时配置（ignoredChars 可被设置页热更新）。
 */
function createStreamGuard(options, runtime) {
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
   * 增量会先按围栏代码块切成片段：块外按 threshold 判定，块内按
   * threshold × codeBlockMultiplier 判定（放宽，避免误杀正常代码）。
   */
  function feedText(b, delta) {
    b.text += delta
    const codeBlocksOn = runtime.skipCodeBlocks === true
    const mode = codeBlocksOn ? runtime.codeBlockMultiplier : 1
    const skipInsideCode = mode === 0
    const codeThreshold = runtime.threshold * mode
    const runs = codeBlocksOn ? b.fence.push(delta) : [{ text: delta, code: false }]
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
      const hit = findRepeatedTail(b.stripped, threshold, runtime.minUnitLength, runtime.maxUnitLength)
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
    const tail = sanitizePiece(b.substrings.flush(), runtime)
    if (tail.length === 0) return null
    b.stripped = (b.stripped + tail).slice(-runtime.detectionWindow)
    const threshold = b.lastRunCode === true
      ? runtime.threshold * (runtime.skipCodeBlocks === true ? runtime.codeBlockMultiplier : 1)
      : runtime.threshold
    return findRepeatedTail(b.stripped, threshold, runtime.minUnitLength, runtime.maxUnitLength)
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
        if (runtime.monitorReasoning) {
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
        if (runtime.monitorToolArguments) {
          const piece = sanitizePiece(b.substrings.push(chunk.argumentsDelta), runtime)
          b.stripped = (b.stripped + piece).slice(-runtime.detectionWindow)
          const hit = findRepeatedTail(b.stripped, runtime.threshold, runtime.minUnitLength, runtime.maxUnitLength)
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
  const inspect = ctx.cordisInspect
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

/**
 * 组合层默认值（= 代码 CONFIG）。设置页的用户层被清空（unset）时回落到这里，
 * 因此「恢复默认」等价于回到 CONFIG。
 */
function settingsBase() {
  return {
    ignoredChars: [...CONFIG.ignoredChars],
    ignoredSubstrings: [...CONFIG.ignoredSubstrings],
    threshold: CONFIG.threshold,
    minUnitLength: CONFIG.minUnitLength,
    maxUnitLength: CONFIG.maxUnitLength,
    detectionWindow: CONFIG.detectionWindow,
    codeBlockMultiplier: CONFIG.codeBlockMultiplier,
    stripWhitespace: CONFIG.stripWhitespace,
    skipCodeBlocks: CONFIG.skipCodeBlocks,
    monitorReasoning: CONFIG.monitorReasoning,
    monitorToolArguments: CONFIG.monitorToolArguments,
  }
}

/** 每次模型调用使用的运行时配置副本（字段均可被设置页热更新）。 */
function createRuntime() {
  return settingsBase()
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
 * 检测窗口是否小于「最严格阈值 × 最大单元长度」。
 *
 * 窗口是清洗后保留的字符数：一个长度 p 的单元需要 p × threshold 个字符才可能
 * 凑满阈值，因此 p 超过 floor(窗口 / 阈值) 的重复单元无法被识别。代码块内使用
 * 放宽阈值（threshold × codeBlockMultiplier），窗口需按该更严格的一侧计算。
 * 返回缺口描述（含所需窗口）或 null。
 */
function windowShortfall(runtime) {
  const threshold = Math.max(runtime.threshold, effectiveCodeThreshold(runtime))
  const needed = threshold * runtime.maxUnitLength
  if (runtime.detectionWindow >= needed) return null
  return {
    needed: needed,
    current: runtime.detectionWindow,
    threshold: threshold,
    effectiveMaxUnit: Math.floor(runtime.detectionWindow / threshold),
  }
}

/** 上一次「窗口偏小」告警的签名，用于去重（参数每次调用都会重算）。 */
let lastWindowWarning = ''

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
    relaxed ? runtime.codeBlockMultiplier : 1,
  ].join('/')
  if (signature === lastWindowWarning) return
  lastWindowWarning = signature
  console.warn(
    '[dupguard] 检测窗口长度需要提高：至少 ' + String(short.needed) +
    '（= 阈值 ' + String(runtime.threshold) +
    (relaxed ? ' × 代码块倍数 ' + String(runtime.codeBlockMultiplier) : '') +
    ' × 最大单元长度 ' + String(runtime.maxUnitLength) +
    '），当前 ' + String(short.current) + '；超过 ' + String(short.effectiveMaxUnit) +
    ' 字符的重复单元将无法识别。请在设置页提高「检测窗口」，或降低阈值/代码块倍数/最大单元长度。'
  )
}

/**
 * 把设置值归一化进 runtime。外部编辑的设置文档可能带来非法值（schema 校验失败
 * 会保留上一份好值，但归一化仍以防万一），因此逐字段做类型与范围兜底，且绝不抛出：
 * 该方法运行在每次设置提交与插件注册路径上，不能影响检测主体。
 */
function applySettingsToRuntime(runtime, value) {
  const fallback = settingsBase()
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const pickInt = (key) => {
    const raw = source[key]
    const limit = LIMITS[key]
    if (Number.isSafeInteger(raw) && raw >= limit.min && raw <= limit.max) return raw
    return fallback[key]
  }
  const pickBool = (key) => (typeof source[key] === 'boolean' ? source[key] : fallback[key])
  runtime.ignoredChars = normalizeIgnoredChars(source.ignoredChars, fallback.ignoredChars)
  runtime.ignoredSubstrings = normalizeIgnoredSubstrings(source.ignoredSubstrings, fallback.ignoredSubstrings)
  runtime.threshold = pickInt('threshold')
  runtime.minUnitLength = pickInt('minUnitLength')
  runtime.maxUnitLength = pickInt('maxUnitLength')
  runtime.detectionWindow = pickInt('detectionWindow')
  runtime.codeBlockMultiplier = pickInt('codeBlockMultiplier')
  runtime.stripWhitespace = pickBool('stripWhitespace')
  runtime.skipCodeBlocks = pickBool('skipCodeBlocks')
  runtime.monitorReasoning = pickBool('monitorReasoning')
  runtime.monitorToolArguments = pickBool('monitorToolArguments')
  warnShortWindow(runtime)
}

/**
 * 读取 loader 注入的插件 Config 字段值。
 *
 * cordis 的 config 既可能是普通属性，也可能是带 get() 的响应式字段
 * （settings.yaml 用户层写入后由 loader 实时下发），两种形态都要兼容。
 */
function readConfigValue(config, key) {
  if (config === null || typeof config !== 'object') return undefined
  const raw = config[key]
  if (raw === undefined) return undefined
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      return raw.get()
    } catch (_error) {
      return undefined
    }
  }
  return raw
}

/** 把插件 Config 归一化成 applySettingsToRuntime 需要的设置值对象。 */
function settingsValueFromConfig(config) {
  const value = {
    ignoredChars: readConfigValue(config, 'ignoredChars'),
    ignoredSubstrings: readConfigValue(config, 'ignoredSubstrings'),
  }
  for (const key of Object.keys(LIMITS)) value[key] = readConfigValue(config, key)
  for (const key of ['stripWhitespace', 'skipCodeBlocks', 'monitorReasoning', 'monitorToolArguments']) {
    value[key] = readConfigValue(config, key)
  }
  return value
}

/**
 * 从 DSH 的 settings 服务注册检测参数（仅常驻版）；设置页可动态调整全部字段。
 * 返回注销器；settings 服务缺失（无头环境）时不做任何事。
 */
async function installSettings(ctx, runtime) {
  const settings = ctx.settings
  if (settings === undefined || typeof settings.register !== 'function') return
  try {
    const schema = await loadSettingsSchema()
    const scope = settings.register(SETTINGS_NS, schema, {
      base: settingsBase(),
      // schema 表达不了的跨字段约束：maxUnitLength 不得小于 minUnitLength，
      // 违规的写入在此被拒绝（调用方收到错误），不会存入文档。
      validate: (value) => {
        if (value.maxUnitLength < value.minUnitLength) {
          throw new TypeError(
            '最大重复单元长度（' + String(value.maxUnitLength) +
            '）不能小于最小重复单元长度（' + String(value.minUnitLength) + '）'
          )
        }
      },
    })
    const sync = () => {
      applySettingsToRuntime(runtime, scope.get())
    }
    sync()
    const stop = scope.watch(sync)
    ctx.effect(() => () => stop(), 'dupguard: settings watch')
    console.log('[dupguard] 已注册设置命名空间 ' + SETTINGS_NS + '（检测参数可在设置页动态调整）')
  } catch (error) {
    // 设置注册失败不得破坏检测主体：参数保持代码常量，仅损失设置页能力。
    console.error('[dupguard] 设置命名空间注册失败（检测参数将使用代码默认值）：' + (error && error.message ? error.message : String(error)))
  }
}

function apply(ctx, config) {
  // 启动自检：把关键服务可见性直接打到宿主日志，便于诊断挂载问题。
  console.log('[dupguard] 常驻插件 apply 开始')
  const runtime = createRuntime()
  // 每次模型调用用哪份参数：默认代码常量 + 旧版设置作用域（runtime 原地更新）；
  // DSH ≥ 0.1.7 改为按需读插件 Config（用户层写入后 loader 实时下发新 config）。
  let runtimeSource = () => runtime
  // loader entry 的 ctx 无法用 ctx.get 直接解析 root 服务（DSH 宿主行的约定），
  // 必须经 ctx.inject 等待服务注入后在回调中访问 ctx.settings / ctx.cordisInspect。
  ctx.inject(['cordisInspect'], (inspectCtx) => {
    if (CONFIG.fixStandingMountConflict) installStandingMountPatch(inspectCtx)
  })
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (settings === undefined) return
    // 自定义设置页由客户端注册；关闭 DSH 自动生成的通用页避免出现两个页面。
    // 必须显式传本插件的 fiber：configure(presentation, owner = this.ctx.fiber) 的
    // 默认 owner 是 settings 服务自己的 fiber，传错就等于没关。
    // configure 仅 ≥ 0.1.7 提供，旧版本静默跳过。
    if (typeof settings.configure === 'function') {
      try {
        settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'dupguard: settings presentation')
      } catch (error) {
        console.warn('[dupguard] 关闭自动设置页失败（不影响检测）：' + (error && error.message ? error.message : String(error)))
      }
    }
    if (typeof settings.register === 'function') {
      // DSH ≤ 0.1.6：注册独立命名空间（dsh-dupguard）并 watch 其取值。
      installSettings(settingsCtx, runtime)
      return
    }
    // DSH ≥ 0.1.7：设置值来自 loader 注入的插件 Config（命名空间 = entry id）。
    const fromConfig = () => {
      const next = createRuntime()
      applySettingsToRuntime(next, settingsValueFromConfig(config))
      return next
    }
    fromConfig() // 启动时先算一次：日志中暴露非法配置
    runtimeSource = fromConfig
    console.log('[dupguard] 设置参数取自插件 Config（DSH ≥ 0.1.7 模型；命名空间为 loader entry id）')
  })
  // llm/stream：包裹每次流式模型调用的瀑布事件。
  // 监听器返回包装后的 AsyncIterable，即成为本次调用对消费方可见的流。
  // （与 @deepseek-ai/dsh-llm 的 invariant、dsh-session-checkpoint-policy 同款接入方式）
  ctx.on('llm/stream', (options, next) => createStreamGuard(options, runtimeSource())(next()))
}

module.exports = { name, apply, Config }
