'use strict'

// ============================================================================
// dupguard 设置集成（schema / 读写 / 派生回写 / 旧版设置通道）
//
// 由 lib/index.js 注入 engine 与 config 后创建（不直接 require('./engine')）：
// detector 的变体测试会用改写后的引擎重新求值入口，注入保证设置默认值同样来自
// 被改写的那份引擎，避免「设置用真实引擎、守卫用变体引擎」的错配。
// ============================================================================

const nodeFs = require('fs')
const nodePath = require('path')

/**
 * 创建设置集成 API。
 * @param engine - lib/engine.js 的导出（设置所需的默认值/派生函数）。
 * @param config - 入口的 CONFIG（当前等于 { ...DEFAULT_CONFIG }）。
 */
function createSettingsApi(engine, config) {
  const {
    LIMITS,
    THRESHOLD_MODES,
    CONTINUE_PROMPT_MAX,
    normalizeIgnoredSubstrings,
    createThresholdPolicy,
    deriveMaxUnitLength,
    deriveWindow,
    warnShortWindow,
  } = engine

  /** 带高级模块加载器的策略构建（module 模式的加载逻辑留在本模块）。 */
  const createPolicy = (runtime, multiplier) => createThresholdPolicy(runtime, multiplier, loadAdvancedModule)
/** 设置命名空间：小写 kebab-case（dsh-settings 的命名规范）。 */
const SETTINGS_NS = 'dsh-dupguard'

/** 高级模块缓存：仅在文件变化时重新加载（每次新流开始时 statSync 一次，成本可忽略）。 */
const advancedModuleCache = { path: '', mtimeMs: -1, fn: null, error: null }

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
    ignoredChars: markVolatile(z.array(z.string()).default([...config.ignoredChars])),
    ignoredSubstrings: markVolatile(z.array(z.string()).default([...config.ignoredSubstrings])),
    thresholdMode: markVolatile(z.union([...THRESHOLD_MODES]).default(config.thresholdMode)),
    thresholdByLength: markVolatile(z.string().default(config.thresholdByLength)),
    advancedThresholdFile: markVolatile(z.string().default(config.advancedThresholdFile)),
    threshold: markVolatile(z.number().min(LIMITS.threshold.min).max(LIMITS.threshold.max).step(1).default(config.threshold)),
    minUnitLength: markVolatile(z.number().min(LIMITS.minUnitLength.min).max(LIMITS.minUnitLength.max).step(1).default(config.minUnitLength)),
    maxUnitLength: markVolatile(z.number().min(LIMITS.maxUnitLength.min).max(LIMITS.maxUnitLength.max).step(1).default(config.maxUnitLength)),
    detectionWindow: markVolatile(z.number().min(LIMITS.detectionWindow.min).max(LIMITS.detectionWindow.max).step(1).default(config.detectionWindow)),
    codeBlockMultiplier: markVolatile(z.number().min(LIMITS.codeBlockMultiplier.min).max(LIMITS.codeBlockMultiplier.max).step(1).default(config.codeBlockMultiplier)),
    stripWhitespace: markVolatile(z.boolean().default(config.stripWhitespace)),
    skipCodeBlocks: markVolatile(z.boolean().default(config.skipCodeBlocks)),
    monitorReasoning: markVolatile(z.boolean().default(config.monitorReasoning)),
    monitorToolArguments: markVolatile(z.boolean().default(config.monitorToolArguments)),
    notifyOnStop: markVolatile(z.boolean().default(config.notifyOnStop)),
    systemNotify: markVolatile(z.boolean().default(config.systemNotify)),
    persistStopLog: markVolatile(z.boolean().default(config.persistStopLog)),
    stopDecision: markVolatile(z.boolean().default(config.stopDecision)),
    decisionTimeoutMs: markVolatile(z.number().min(LIMITS.decisionTimeoutMs.min).max(LIMITS.decisionTimeoutMs.max).step(500).default(config.decisionTimeoutMs)),
    stopAtMultiplier: markVolatile(z.number().min(LIMITS.stopAtMultiplier.min).max(LIMITS.stopAtMultiplier.max).step(1).default(config.stopAtMultiplier)),
    continuePrompt: markVolatile(z.string().default(config.continuePrompt)),
  })
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
 * 未知块类型只会在 DSH 协议新增 ContentBlock 类型时出现：此时没有合法的合成
 * block-end，只能按 tool-call 兜底并告警一次，便于定位协议漂移。
 *//**
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
    // 支持 .js/.cjs/.mjs：运行时支持 require(esm)（Node ≥ 20.19 / ≥ 22.12）时可直接加载 ESM。
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

/** 记录并输出「热更新自身配置失败」告警（同样内容只告警一次）。 */
function warnLiveUpdateFailure(message) {
  if (message === lastLiveWarning) return
  lastLiveWarning = message
  console.warn('[dupguard] 热更新自身配置失败（检测仍按最新文件值运行）：' + message)
}

/** 去重打印「生效参数」摘要（旧版设置通道与 apply 热更新共用同一份去重状态）。 */
function logRuntimeSummary(runtime, label) {
  const summary = summarizeRuntime(runtime)
  if (summary === lastRuntimeSummary) return
  lastRuntimeSummary = summary
  console.log('[dupguard] ' + label + summary)
}


/**
 * 组合层默认值（= 代码 CONFIG）。设置页的用户层被清空（unset）时回落到这里，
 * 因此「恢复默认」等价于回到 CONFIG。
 */
function settingsBase() {
  return {
    ignoredChars: [...config.ignoredChars],
    ignoredSubstrings: [...config.ignoredSubstrings],
    thresholdMode: config.thresholdMode,
    thresholdByLength: config.thresholdByLength,
    advancedThresholdFile: config.advancedThresholdFile,
    threshold: config.threshold,
    minUnitLength: config.minUnitLength,
    maxUnitLength: config.maxUnitLength,
    detectionWindow: config.detectionWindow,
    codeBlockMultiplier: config.codeBlockMultiplier,
    stripWhitespace: config.stripWhitespace,
    skipCodeBlocks: config.skipCodeBlocks,
    monitorReasoning: config.monitorReasoning,
    monitorToolArguments: config.monitorToolArguments,
    notifyOnStop: config.notifyOnStop,
    systemNotify: config.systemNotify,
    persistStopLog: config.persistStopLog,
    stopDecision: config.stopDecision,
    decisionTimeoutMs: config.decisionTimeoutMs,
    stopAtMultiplier: config.stopAtMultiplier,
    continuePrompt: config.continuePrompt,
  }
}

/** 每次模型调用使用的运行时配置副本（字段均可被设置页热更新）。 */
function createRuntime() {
  return settingsBase()
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
  // 截停通知：开关取布尔；指令文本必须是非空字符串，过长时截断（避免注入超长内容）。
  runtime.notifyOnStop = pickBool('notifyOnStop')
  // 系统通知只由客户端读取（浏览器 Notification），宿主只负责把它存进设置文档。
  runtime.systemNotify = pickBool('systemNotify')
  // 截停持久化日志开关（仅常驻版生效；环境变量 DSH_DUPGUARD_STOP_LOG=off 优先级更高）。
  runtime.persistStopLog = pickBool('persistStopLog')
  // 阈值决策窗口：命中先暂停、等用户决定；超时后按倍数兜底。
  runtime.stopDecision = pickBool('stopDecision')
  runtime.decisionTimeoutMs = pickInt('decisionTimeoutMs')
  runtime.stopAtMultiplier = pickInt('stopAtMultiplier')
  runtime.continuePrompt = typeof source.continuePrompt === 'string' && source.continuePrompt.trim() !== ''
    ? [...source.continuePrompt].slice(0, CONTINUE_PROMPT_MAX).join('')
    : fallback.continuePrompt
  // 重复次数策略：模式非法回落 simple（等价于关闭策略）。
  const mode = source.thresholdMode
  runtime.thresholdMode = THRESHOLD_MODES.indexOf(mode) !== -1 ? mode : fallback.thresholdMode
  runtime.thresholdByLength = typeof source.thresholdByLength === 'string' ? source.thresholdByLength : fallback.thresholdByLength
  runtime.advancedThresholdFile = typeof source.advancedThresholdFile === 'string' ? source.advancedThresholdFile : fallback.advancedThresholdFile
  // 分段表模式：候选区间完全由表格给出——下界固定为 1（首行起始），上界为末行终止值。
  // 三个派生值（窗口 / 最大单元 / 最小单元）都在这里算好，必须在构建策略之前生效，
  // 这样策略覆盖范围与派生窗口都以它们为准。
  let derivedMaxUnit
  let derivedMinUnit
  if (runtime.thresholdMode === 'table') {
    derivedMinUnit = LIMITS.minUnitLength.min
    runtime.minUnitLength = derivedMinUnit
    derivedMaxUnit = deriveMaxUnitLength(runtime)
    if (derivedMaxUnit !== undefined) runtime.maxUnitLength = derivedMaxUnit
  }
  runtime.derivedMaxUnit = derivedMaxUnit
  // 块外策略 + 块内策略（乘代码块倍数）；simple 模式两者均为 undefined（走快路径）。
  const codeScale = runtime.skipCodeBlocks === true ? runtime.codeBlockMultiplier : 1
  runtime.thresholdPolicy = createPolicy(runtime, 1)
  runtime.codeThresholdPolicy = codeScale === 1 ? runtime.thresholdPolicy : createPolicy(runtime, codeScale)
  // 检测窗口：不读文档值，一律按当前参数派生（见 deriveWindow）。
  const derivedWindow = deriveWindow(runtime)
  runtime.detectionWindow = derivedWindow.value
  warnShortWindow(runtime)
  if (typeof onDerived === 'function') {
    try {
      onDerived({
        window: derivedWindow,
        documentWindow: Number.isSafeInteger(source.detectionWindow) ? source.detectionWindow : undefined,
        maxUnitLength: derivedMaxUnit,
        documentMaxUnit: Number.isSafeInteger(source.maxUnitLength) ? source.maxUnitLength : undefined,
        minUnitLength: derivedMinUnit,
        documentMinUnit: Number.isSafeInteger(source.minUnitLength) ? source.minUnitLength : undefined,
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
    'notifyOnStop', 'systemNotify', 'persistStopLog', 'stopDecision', 'decisionTimeoutMs', 'stopAtMultiplier', 'continuePrompt',
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
 * 依据 onDerived 上报的派生值拼出「需要写回」的补丁。两个写回路径
 * （DSH ≥ 0.1.7 的 settings.update 与 ≤ 0.1.6 的 scope.update）共用本函数。
 *
 * 跳过规则（避免写回循环与写风暴）：文档现值已等于派生值；或「我们写过同样的值，
 * 且文档自那次写入以来没有变化」——后者区分了两种情形：
 *   - fiber 不回流：读到的仍是写前值（与记录一致）⇒ 不重复写；
 *   - 用户随后把该字段改成了别的值（与记录不一致）⇒ 需要重新写回。
 */
function buildDerivedPatch(info) {
  const patch = {}
  const consider = (key, derived, documentValue) => {
    if (derived === undefined) return
    if (documentValue === derived) {
      delete lastDerivedWrite[key]
      return
    }
    const previous = lastDerivedWrite[key]
    if (previous !== undefined && previous.value === derived && previous.document === documentValue) return
    patch[key] = derived
    lastDerivedWrite[key] = { value: derived, document: documentValue }
  }
  consider('detectionWindow', info.window === undefined ? undefined : info.window.value, info.documentWindow)
  consider('maxUnitLength', info.maxUnitLength, info.documentMaxUnit)
  consider('minUnitLength', info.minUnitLength, info.documentMinUnit)
  return patch
}

/**
 * 把派生值（检测窗口、分段表模式下的最大/最小单元长度）写回设置文档，
 * 使设置页与配置文件显示真实生效值。
 *
 * 与文档现值一致、或刚写过同样的值（fiber 不回流时避免每次流式调用重复写）时跳过；
 * 多个字段若都需更新则合并为**一次** update；失败只告警一次，内存中的派生值照常生效。
 */
function pushDerived(settings, info) {
  if (settings === undefined || info === undefined) return
  const patch = buildDerivedPatch(info)
  if (Object.keys(patch).length === 0) return
  if (typeof settings.update !== 'function') return
  const ns = resolveSettingsNamespace(settings)
  if (ns === null) return
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
/** 每个派生字段的「上次写回值 + 当时读到的文档值」（防重复写，见 buildDerivedPatch）；写回告警签名防刷屏。 */
const lastDerivedWrite = {}
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
    '｜次数策略 ' + describePolicy(runtime.thresholdPolicy, runtime) +
    '｜截停通知 ' + (runtime.notifyOnStop === true ? '开' : '关') +
    '｜系统通知 ' + (runtime.systemNotify === true ? '开' : '关') +
    '｜阈值决策 ' + (runtime.stopDecision === true ? String(runtime.decisionTimeoutMs) + 'ms/×' + String(runtime.stopAtMultiplier) : '关')
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
        const patch = buildDerivedPatch(info)
        if (Object.keys(patch).length === 0) return
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

  return {
    Config,
    createSettingsSchema,
    loadSettingsSchema,
    settingsBase,
    createRuntime,
    applySettingsToRuntime,
    settingsValueFromConfig,
    readLiveOverrides,
    profileConfigFile,
    pushDerived,
    buildDerivedPatch,
    installSettings,
    summarizeRuntime,
    logRuntimeSummary,
    warnLiveUpdateFailure,
    loadAdvancedModule,
    describePolicy,
    createPolicy,
    SETTINGS_NS,
  }
}

module.exports = { createSettingsApi }
