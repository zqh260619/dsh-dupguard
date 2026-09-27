'use strict'

const nodeFs = require('fs')
const nodePath = require('path')

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
 * 重复次数策略模式：
 *   - simple：固定使用 threshold（默认，与未引入本功能时逐字节一致：不建表、不查表）；
 *   - table ：按分段表 `"<maxLen>:<count>[, …][, *:<count>]"` 决定各单元长度所需次数；
 *   - module：由用户提供的模块文件导出 `repeatCount(length) -> count` 决定。
 * 回退链：module 加载失败 ⇒ 基础 threshold（不静默回落到 table）；table 未覆盖 ⇒ `*` ⇒ threshold。
 */
const THRESHOLD_MODES = ['simple', 'table', 'module']

/** 高级模块缓存：仅在文件变化时重新加载（每次新流开始时 statSync 一次，成本可忽略）。 */
const advancedModuleCache = { path: '', mtimeMs: -1, fn: null, error: null }

/**
 * 策略告警去重：块外与块内各构建一次策略，同一问题可能被解析两次，
 * 因此按「签名集合」去重（数量有界，超出后清空重来）。
 */
const policyWarningsSeen = new Set()

function warnPolicyOnce(signature, message) {
  if (policyWarningsSeen.has(signature)) return
  if (policyWarningsSeen.size > 64) policyWarningsSeen.clear()
  policyWarningsSeen.add(signature)
  console.warn(message)
}

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
    thresholdMode: markVolatile(z.union([...THRESHOLD_MODES]).default(CONFIG.thresholdMode)),
    thresholdByLength: markVolatile(z.string().default(CONFIG.thresholdByLength)),
    advancedThresholdFile: markVolatile(z.string().default(CONFIG.advancedThresholdFile)),
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
 * 加载高级模块（`repeatCount(length) -> count`）。带 mtime 缓存：仅在文件变化时重载。
 * 该文件在 DSH 宿主进程中执行（用户显式选择），请只指向自己信任的文件。
 */
function loadAdvancedModule(file) {
  if (typeof file !== 'string' || file.trim().length === 0) {
    return { fn: null, error: '未设置模块文件路径' }
  }
  const resolved = nodePath.resolve(file.trim())
  let stat
  try {
    stat = nodeFs.statSync(resolved)
  } catch (error) {
    advancedModuleCache.path = resolved
    advancedModuleCache.mtimeMs = -1
    advancedModuleCache.fn = null
    advancedModuleCache.error = '无法读取模块文件：' + (error && error.message ? error.message : String(error))
    return { fn: null, error: advancedModuleCache.error }
  }
  if (!stat.isFile()) {
    return { fn: null, error: '模块路径不是文件：' + resolved }
  }
  if (advancedModuleCache.path === resolved && advancedModuleCache.mtimeMs === stat.mtimeMs) {
    return { fn: advancedModuleCache.fn, error: advancedModuleCache.error }
  }
  advancedModuleCache.path = resolved
  advancedModuleCache.mtimeMs = stat.mtimeMs
  advancedModuleCache.fn = null
  advancedModuleCache.error = null
  try {
    // 支持 .js/.cjs/.mjs：Node ≥ 22 的 require(esm) 可直接加载 ESM。
    delete require.cache[resolved]
    const loaded = require(resolved)
    const candidate = typeof loaded === 'function'
      ? loaded
      : (loaded !== null && typeof loaded === 'object'
        ? (typeof loaded.repeatCount === 'function' ? loaded.repeatCount : loaded.default)
        : undefined)
    if (typeof candidate !== 'function') {
      advancedModuleCache.error = '模块未导出函数（期望 module.exports = fn 或 exports.repeatCount = fn）'
      return { fn: null, error: advancedModuleCache.error }
    }
    advancedModuleCache.fn = candidate
    return { fn: candidate, error: null }
  } catch (error) {
    advancedModuleCache.error = '模块加载失败：' + (error && error.message ? error.message : String(error))
    return { fn: null, error: advancedModuleCache.error }
  }
}

/**
 * 构建阈值策略。simple 模式返回 undefined（不建表、不查表，走原有快路径）；
 * table / module 失败时同样返回 undefined 并告警一次（回退基础阈值）。
 *
 * @param runtime - 运行时配置（已归一化 thresholdMode / thresholdByLength / advancedThresholdFile）。
 * @param multiplier - 代码块倍数（1 表示块外）。
 */
function createThresholdPolicy(runtime, multiplier) {
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
  const loaded = loadAdvancedModule(runtime.advancedThresholdFile)
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

/** 策略摘要（日志/设置页提示）：覆盖率与最长可识别跨度。 */
function describePolicy(policy, runtime) {
  if (policy === undefined) return '固定阈值 ' + String(runtime.threshold)
  let minNeed = 0
  let maxNeed = 0
  let covered = 0
  for (let p = runtime.minUnitLength; p <= runtime.maxUnitLength; p++) {
    const need = policy.counts[p]
    if (need < 2) continue
    covered++
    if (minNeed === 0 || need < minNeed) minNeed = need
    if (need > maxNeed) maxNeed = need
  }
  return '模式=' + policy.source + '｜覆盖长度 ' + String(covered) + ' 种｜次数区间 ' +
    String(minNeed) + '–' + String(maxNeed) + '｜最长跨度 ' + String(policy.worstSpan) + ' 字符'
}

/** 上一次打印的生效参数摘要，用于去重（旧版设置通道每次变更都会回调）。 */
let lastRuntimeSummary = ''

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
      const policy = run.code ? runtime.codeThresholdPolicy : runtime.thresholdPolicy
      const hit = findRepeatedTail(b.stripped, threshold, runtime.minUnitLength, runtime.maxUnitLength, policy)
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
    const policy = b.lastRunCode === true ? runtime.codeThresholdPolicy : runtime.thresholdPolicy
    return findRepeatedTail(b.stripped, threshold, runtime.minUnitLength, runtime.maxUnitLength, policy)
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
          const hit = findRepeatedTail(b.stripped, runtime.threshold, runtime.minUnitLength, runtime.maxUnitLength, runtime.thresholdPolicy)
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

// ============================================================================
// DSH ≥ 0.1.7 的「组合补丁层不回流」补偿
//
// 现象：设置页写入的是组合补丁层（<profile>/cordis.patch.yml），但该层的改动不会被重新解析
// 进正在运行的 entry fiber —— 设置页仍显示旧值、检测也仍用旧参数，必须重启 DSH 才生效。
//
// 补偿：
//   1. 自行读取该文件、取出本 entry 的 config 块（YAML 子集解析），叠加到 Config 之上，
//      保证每次流式调用都拿到最新参数（不依赖 DSH 是否回流）；
//   2. 文件变化时（轮询 + settings/document-updated 事件）尽力把合并结果推回自身 fiber，
//      让 fiber 自身的 config 也刷新，这样设置页读回也能看到新值。
// 解析失败/文件缺失一律退回 Config 值，绝不影响检测。
// ============================================================================

/** 组合补丁层文件路径：优先 DSH_PROFILE_DIR，其次由本插件安装位置反推 profile 目录。 */
function profileConfigFile() {
  const dir = typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.trim().length > 0
    ? process.env.DSH_PROFILE_DIR.trim()
    : nodePath.resolve(__dirname, '..', '..', '..')
  return nodePath.join(dir, 'cordis.patch.yml')
}

/** YAML 标量子集：布尔 / 整数 / 引号字符串 / 空集合；其余按纯字符串处理。 */
function parseYamlScalar(raw) {
  const text = String(raw).trim()
  if (text.length === 0) return undefined
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) return Number(text)
  const quoted = (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))
  if (quoted && text.length >= 2) return text.slice(1, -1)
  if (text === '[]') return []
  return text
}

/**
 * 从组合补丁层文本中取出目标 entry 的 config 映射（只支持本插件字段的形态：
 * 标量与块序列）。解析不到任何字段时返回 null。
 */
function extractEntryConfig(text, identifiers) {
  const config = {}
  let inEntry = false
  let inConfig = false
  let configIndent = 0
  let listKey = null
  let listIndent = 0
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    if (line === '-' || line.startsWith('- ')) {
      const idMatch = /^-\s*id\s*:\s*(.+)$/.exec(line)
      if (idMatch !== null) {
        inEntry = identifiers.indexOf(String(parseYamlScalar(idMatch[1]))) !== -1
        inConfig = false
        listKey = null
        continue
      }
      if (inConfig && listKey !== null && indent > listIndent) {
        config[listKey].push(parseYamlScalar(line.replace(/^-\s*/, '')))
        continue
      }
      continue
    }
    if (!inEntry) continue
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]
    const rest = kv[2]
    if (listKey !== null && indent <= listIndent) listKey = null
    if (inConfig && indent <= configIndent) inConfig = false
    if (key === 'config' && rest.trim().length === 0) {
      inConfig = true
      configIndent = indent
      listKey = null
      continue
    }
    if (!inConfig) continue
    const value = parseYamlScalar(rest)
    if (value === undefined) {
      config[key] = []
      listKey = key
      listIndent = indent
      continue
    }
    config[key] = value
    listKey = null
  }
  return Object.keys(config).length === 0 ? null : config
}

/** 本地缓存：仅在文件 mtime 变化时重新读取解析。 */
const liveConfigCache = { file: '', mtimeMs: -1, values: null }

/** 读取持久化的用户层配置；文件缺失/解析失败返回 null（调用方退回 Config 值）。 */
function readLiveOverrides() {
  const file = profileConfigFile()
  let stat
  try {
    stat = nodeFs.statSync(file)
  } catch (_statError) {
    liveConfigCache.file = file
    liveConfigCache.mtimeMs = -1
    liveConfigCache.values = null
    return null
  }
  if (liveConfigCache.file === file && liveConfigCache.mtimeMs === stat.mtimeMs) return liveConfigCache.values
  let values = null
  try {
    values = extractEntryConfig(nodeFs.readFileSync(file, 'utf8'), ['dupguard', 'dsh-dupguard', SETTINGS_NS])
  } catch (_readError) {
    values = null
  }
  liveConfigCache.file = file
  liveConfigCache.mtimeMs = stat.mtimeMs
  liveConfigCache.values = values
  return values
}

/** 上一次「热更新/推回 fiber」告警的签名（同内容只告警一次）。 */
let lastLiveWarning = ''

/**
 * 组合层默认值（= 代码 CONFIG）。设置页的用户层被清空（unset）时回落到这里，
 * 因此「恢复默认」等价于回到 CONFIG。
 */
function settingsBase() {
  return {
    ignoredChars: [...CONFIG.ignoredChars],
    ignoredSubstrings: [...CONFIG.ignoredSubstrings],
    thresholdMode: CONFIG.thresholdMode,
    thresholdByLength: CONFIG.thresholdByLength,
    advancedThresholdFile: CONFIG.advancedThresholdFile,
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
 * @returns {{ value: number, required: number, clamped: boolean, threshold: number, plainSpan: number, policySpan: number }}
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
  return { value: value, required: required, clamped: value < required, threshold: threshold, plainSpan: plainSpan, policySpan: policySpan }
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

/**
 * 把设置值归一化进 runtime。外部编辑的设置文档可能带来非法值（schema 校验失败
 * 会保留上一份好值，但归一化仍以防万一），因此逐字段做类型与范围兜底，且绝不抛出：
 * 该方法运行在每次设置提交与插件注册路径上，不能影响检测主体。
 *
 * 注意：`detectionWindow` 与分段表模式下的 `maxUnitLength` 都是**派生值**——文档里写什么都不作数，
 * 一律重算；传入的文档值只通过 onDerived 回调上报，供调用方写回文档（使其与生效值一致）。
 *
 * @param onDerived - 可选回调 (info) => void，info 含 window / maxUnitLength 及其文档现值。
 */
function applySettingsToRuntime(runtime, value, onDerived) {
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
  runtime.codeBlockMultiplier = pickInt('codeBlockMultiplier')
  runtime.stripWhitespace = pickBool('stripWhitespace')
  runtime.skipCodeBlocks = pickBool('skipCodeBlocks')
  runtime.monitorReasoning = pickBool('monitorReasoning')
  runtime.monitorToolArguments = pickBool('monitorToolArguments')
  // 重复次数策略：模式非法回落 simple（等价于关闭策略）。
  const mode = source.thresholdMode
  runtime.thresholdMode = THRESHOLD_MODES.indexOf(mode) !== -1 ? mode : fallback.thresholdMode
  runtime.thresholdByLength = typeof source.thresholdByLength === 'string' ? source.thresholdByLength : fallback.thresholdByLength
  runtime.advancedThresholdFile = typeof source.advancedThresholdFile === 'string' ? source.advancedThresholdFile : fallback.advancedThresholdFile
  // 分段表模式：最大单元长度由表格末行终止值派生（不再是输入项），必须在构建策略之前生效，
  // 这样策略覆盖范围与派生窗口都以它为准。
  let derivedMaxUnit
  if (runtime.thresholdMode === 'table') {
    derivedMaxUnit = deriveMaxUnitLength(runtime)
    if (derivedMaxUnit !== undefined) {
      runtime.maxUnitLength = derivedMaxUnit
      if (derivedMaxUnit < runtime.minUnitLength) {
        // 末行终止小于最小单元长度 ⇒ 候选区间为空、等于什么都不检测：本次生效下调下界并告警一次。
        warnPolicyOnce(
          'table-min:' + String(derivedMaxUnit),
          '[dupguard] 分段表末行终止值 ' + String(derivedMaxUnit) +
          ' 小于最小重复单元长度 ' + String(runtime.minUnitLength) +
          '，本次生效按 ' + String(derivedMaxUnit) + ' 处理。',
        )
        runtime.minUnitLength = derivedMaxUnit
      }
    }
  }
  runtime.derivedMaxUnit = derivedMaxUnit
  // 块外策略 + 块内策略（乘代码块倍数）；simple 模式两者均为 undefined（走快路径）。
  const codeScale = runtime.skipCodeBlocks === true ? runtime.codeBlockMultiplier : 1
  runtime.thresholdPolicy = createThresholdPolicy(runtime, 1)
  runtime.codeThresholdPolicy = codeScale === 1 ? runtime.thresholdPolicy : createThresholdPolicy(runtime, codeScale)
  // 检测窗口：不读文档值，一律按当前参数派生（见 deriveWindow）。
  const derivedWindow = deriveWindow(runtime)
  runtime.detectionWindow = derivedWindow.value
  runtime.derivedWindow = derivedWindow
  warnShortWindow(runtime)
  if (typeof onDerived === 'function') {
    try {
      onDerived({
        window: derivedWindow,
        documentWindow: Number.isSafeInteger(source.detectionWindow) ? source.detectionWindow : undefined,
        maxUnitLength: derivedMaxUnit,
        documentMaxUnit: Number.isSafeInteger(source.maxUnitLength) ? source.maxUnitLength : undefined,
      })
    } catch (_callbackError) {}
  }
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
  for (const key of [
    'stripWhitespace', 'skipCodeBlocks', 'monitorReasoning', 'monitorToolArguments',
    'thresholdMode', 'thresholdByLength', 'advancedThresholdFile',
  ]) {
    value[key] = readConfigValue(config, key)
  }
  return value
}

/**
 * 找出本插件的设置命名空间：describe() 中字段签名匹配（thresholdMode + ignoredSubstrings）
 * 的 descriptor；找不到时退回名字含 "dupguard" 的项。只解析一次。
 */
function resolveSettingsNamespace(settings) {
  if (settingsNsResolved) return cachedSettingsNs
  settingsNsResolved = true
  cachedSettingsNs = null
  try {
    const descriptors = typeof settings.describe === 'function' ? settings.describe() : []
    const list = Array.isArray(descriptors) ? descriptors : []
    for (const descriptor of list) {
      const schema = descriptor !== null && typeof descriptor === 'object' ? descriptor.schema : null
      const properties = schema !== null && typeof schema === 'object'
        ? (schema.properties !== undefined ? schema.properties : schema)
        : null
      const keys = properties !== null && typeof properties === 'object' ? Object.keys(properties) : []
      if (keys.indexOf('thresholdMode') !== -1 && keys.indexOf('ignoredSubstrings') !== -1) {
        cachedSettingsNs = descriptor.ns
        return cachedSettingsNs
      }
    }
    for (const descriptor of list) {
      const ns = descriptor !== null && typeof descriptor === 'object' ? descriptor.ns : undefined
      if (typeof ns === 'string' && ns.indexOf('dupguard') !== -1) {
        cachedSettingsNs = ns
        return cachedSettingsNs
      }
    }
  } catch (_describeError) {}
  return cachedSettingsNs
}

/**
 * 把派生值（检测窗口、分段表模式下的最大单元长度）写回设置文档，
 * 使设置页与配置文件显示真实生效值。
 *
 * 与文档现值一致、或刚写过同样的值（fiber 不回流时避免每次流式调用重复写）时跳过；
 * 两个字段若都需更新则合并为**一次** update；失败只告警一次，内存中的派生值照常生效。
 */
function pushDerived(settings, info) {
  if (settings === undefined || info === undefined) return
  const patch = {}
  if (info.window !== undefined) {
    if (info.documentWindow === info.window.value) lastDerivedWritten.detectionWindow = info.window.value
    else if (lastDerivedWritten.detectionWindow !== info.window.value) patch.detectionWindow = info.window.value
  }
  if (info.maxUnitLength !== undefined) {
    if (info.documentMaxUnit === info.maxUnitLength) lastDerivedWritten.maxUnitLength = info.maxUnitLength
    else if (lastDerivedWritten.maxUnitLength !== info.maxUnitLength) patch.maxUnitLength = info.maxUnitLength
  }
  if (Object.keys(patch).length === 0) return
  if (typeof settings.update !== 'function') return
  const ns = resolveSettingsNamespace(settings)
  if (ns === null) return
  if (patch.detectionWindow !== undefined) lastDerivedWritten.detectionWindow = patch.detectionWindow
  if (patch.maxUnitLength !== undefined) lastDerivedWritten.maxUnitLength = patch.maxUnitLength
  const notify = (error) => {
    const message = error && error.message ? error.message : String(error)
    const signature = ns + ':' + message
    if (signature === lastDerivedWriteWarning) return
    lastDerivedWriteWarning = signature
    console.warn('[dupguard] 写回派生设置失败（检测仍按派生值运行）：' + message)
  }
  try {
    const result = settings.update(ns, patch)
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') result.then(undefined, notify)
  } catch (error) {
    notify(error)
  }
}

/** 缓存的设置命名空间；解析失败保持 null。 */
let cachedSettingsNs = null
let settingsNsResolved = false
/** 上一次写回的派生值（按字段去重，防重复写）；上一次写回告警签名（防刷屏）。 */
const lastDerivedWritten = { detectionWindow: null, maxUnitLength: null }
let lastDerivedWriteWarning = ''

/**
 * 生效参数摘要（宿主日志）：确认宿主加载的版本与「设置是否真的进来了」。
 * 片段白名单是否被读到，从这里一眼可见。
 */
function summarizeRuntime(runtime) {
  return '阈值 ' + String(runtime.threshold) +
    '｜窗口 ' + String(runtime.detectionWindow) + '（自动）' +
    '｜最大单元 ' + String(runtime.maxUnitLength) +
    (runtime.thresholdMode === 'table' && runtime.derivedMaxUnit !== undefined ? '（末行决定）' : '') +
    '｜字符白名单 ' + String(runtime.ignoredChars.length) + ' 项' +
    '｜片段白名单 ' + String(runtime.ignoredSubstrings.length) + ' 项' +
    (runtime.ignoredSubstrings.length > 0 ? '（' + runtime.ignoredSubstrings.join('、') + '）' : '') +
    '｜次数策略 ' + describePolicy(runtime.thresholdPolicy, runtime)
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
      applySettingsToRuntime(runtime, scope.get(), (info) => {
        // 旧版设置作用域同样把派生值写回（接口不支持时静默跳过）。
        if (typeof scope.update !== 'function') return
        const patch = {}
        if (info.window !== undefined && info.documentWindow !== info.window.value &&
            lastDerivedWritten.detectionWindow !== info.window.value) {
          patch.detectionWindow = info.window.value
        }
        if (info.maxUnitLength !== undefined && info.documentMaxUnit !== info.maxUnitLength &&
            lastDerivedWritten.maxUnitLength !== info.maxUnitLength) {
          patch.maxUnitLength = info.maxUnitLength
        }
        if (Object.keys(patch).length === 0) return
        if (patch.detectionWindow !== undefined) lastDerivedWritten.detectionWindow = patch.detectionWindow
        if (patch.maxUnitLength !== undefined) lastDerivedWritten.maxUnitLength = patch.maxUnitLength
        try {
          scope.update(patch)
        } catch (_updateError) {}
      })
      // 生效参数清单（同内容只打印一次）：便于在宿主日志确认设置是否真的进来了。
      const summary = summarizeRuntime(runtime)
      if (summary !== lastRuntimeSummary) {
        lastRuntimeSummary = summary
        console.log('[dupguard] 生效参数：' + summary)
      }
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
    // 组合补丁层的写入不会回流到运行中的 fiber，因此这里把「文件里的用户层值」叠加在 Config 之上。
    const fromConfig = () => {
      const next = createRuntime()
      const base = settingsValueFromConfig(config)
      const live = readLiveOverrides()
      const merged = live === null ? base : { ...base, ...live }
      applySettingsToRuntime(next, merged, (info) => {
        pushDerived(settings, info)
      })
      return next
    }
    const startup = fromConfig() // 启动时先算一次：日志中暴露非法配置
    runtimeSource = fromConfig
    console.log('[dupguard] 设置参数取自插件 Config（DSH ≥ 0.1.7 模型；命名空间为 loader entry id）')
    // 生效参数清单：用于确认宿主加载的版本与「设置是否真的进来了」（片段白名单是否生效靠它判断）。
    console.log('[dupguard] 生效参数：' + summarizeRuntime(startup))

    /** 把最新持久化配置推回自身 fiber，让设置页读回也看到新值（失败只告警一次）。 */
    const pushLiveConfig = () => {
      const live = readLiveOverrides()
      if (live === null) return
      const merged = { ...settingsValueFromConfig(config), ...live }
      try {
        if (ctx.fiber !== undefined && typeof ctx.fiber.update === 'function') ctx.fiber.update(merged)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (message !== lastLiveWarning) {
          lastLiveWarning = message
          console.warn('[dupguard] 热更新自身配置失败（检测仍按最新文件值运行）：' + message)
        }
      }
      const summary = summarizeRuntime(fromConfig())
      if (summary !== lastRuntimeSummary) {
        lastRuntimeSummary = summary
        console.log('[dupguard] 生效参数（热更新）：' + summary)
      }
    }
    // 事件在 describe() 内同步发出：延后一拍执行，避免在描述符构建过程中改动 fiber。
    let pushScheduled = false
    const schedulePush = () => {
      if (pushScheduled) return
      pushScheduled = true
      setTimeout(() => {
        pushScheduled = false
        pushLiveConfig()
      }, 0)
      if (typeof pushScheduled.unref === 'function') pushScheduled.unref()
    }
    ctx.on('settings/document-updated', (ns) => {
      if (ns === undefined || String(ns).indexOf('dupgard') !== -1) schedulePush()
    })
    try {
      const watched = profileConfigFile()
      const statWatcher = nodeFs.watchFile(watched, { interval: 1000 }, () => schedulePush())
      // unref：轮询句柄不得阻止进程退出（宿主常驻无影响，测试/CLI 场景下很重要）。
      if (statWatcher !== undefined && typeof statWatcher.unref === 'function') statWatcher.unref()
      ctx.effect(() => () => {
        try {
          nodeFs.unwatchFile(watched)
        } catch (_unwatchError) {}
      }, 'dupgard: live config watch')
    } catch (_watchError) {}
  })
  // llm/stream：包裹每次流式模型调用的瀑布事件。
  // 监听器返回包装后的 AsyncIterable，即成为本次调用对消费方可见的流。
  // （与 @deepseek-ai/dsh-llm 的 invariant、dsh-session-checkpoint-policy 同款接入方式）
  ctx.on('llm/stream', (options, next) => createStreamGuard(options, runtimeSource())(next()))
}

module.exports = { name, apply, Config }
