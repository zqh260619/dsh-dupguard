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
//
// 检测引擎（检测算法本体）在 lib/engine.js（单源实现）：
// plugin/host.js 由 tools/build-host.mjs 从同一份引擎生成，改检测逻辑请只改引擎文件。
// ============================================================================

// 检测引擎（单源实现；动态入口 plugin/host.js 由同一份引擎生成）。
const engine = require('./engine')
const {
  DEFAULT_CONFIG,
  LIMITS,
  THRESHOLD_MODES,
  CONTINUE_PROMPT_MAX,
  normalizeIgnoredSubstrings,
  isValidNeed,
  parseThresholdByLength,
  createThresholdPolicy,
  createStreamGuard,
  installStandingMountPatch,
  deriveMaxUnitLength,
  deriveWindow,
  warnShortWindow,
  codeBlockMode,
  effectiveCodeThreshold,
} = engine

/** 带高级模块加载器的策略构建（module 模式的加载逻辑留在本入口）。 */
const createPolicy = (runtime, multiplier) => createThresholdPolicy(runtime, multiplier, loadAdvancedModule)

const name = 'dupguard'

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
    notifyOnStop: markVolatile(z.boolean().default(CONFIG.notifyOnStop)),
    systemNotify: markVolatile(z.boolean().default(CONFIG.systemNotify)),
    continuePrompt: markVolatile(z.string().default(CONFIG.continuePrompt)),
  })
}

const CONFIG = { ...DEFAULT_CONFIG }

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
    notifyOnStop: CONFIG.notifyOnStop,
    systemNotify: CONFIG.systemNotify,
    continuePrompt: CONFIG.continuePrompt,
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
    'notifyOnStop', 'systemNotify', 'continuePrompt',
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
    '｜系统通知 ' + (runtime.systemNotify === true ? '开' : '关')
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

//#region 截停通知（全局弹窗 + 可选的继续指令）

/**
 * 截停通知通道（宿主 → 浏览器 → 宿主）：
 *
 * 1. 截停发生时，宿主把一条通知入队（工作区、会话名称、重复的字符串、次数、区域）；
 * 2. 浏览器端的 `shell.overlay` 组件（见 lib/client.js）轮询 `GET /dsh-dupguard/notifications`
 *    —— 该浮层是 **root 作用域**，因此无论用户当前打开的是哪个会话，通知都会显示；
 * 3. 用户选择「发送继续指令」或「不发送」，浏览器 `POST /dsh-dupguard/notifications/action`
 *    回传；宿主据此决定是否向该会话注入一条用户消息（`agent.followup`）。
 *
 * 通道不可用时（DSH 版本过旧、无 webServer / agents 服务）只打印告警：截停本身不受影响。
 */
const NOTIFY_PREFIX = '/dsh-dupguard/'
/**
 * 注册到 webServer 的**路由路径**：必须是**不带尾斜杠**的前缀。
 * DSH 的匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`
 * （见 dsh-host-webserver 的 `match()`）——若写成 '/dsh-dupguard/'，只有它自身与
 * '/dsh-dupguard//…' 能命中，'/dsh-dupguard/notifications' 会落到 SPA 兜底并返回空 404
 * （曾因此让"通道已注册"却永远 404、通知永不弹）。
 */
const NOTIFY_ROUTE = '/dsh-dupguard'
/** 队列上限：只保留最近若干条，避免内存无界增长。 */
const NOTIFY_LIMIT = 20
/** 动作请求体上限（字节）：请求里只有一个 id 与动作名。 */
const NOTIFY_BODY_LIMIT = 4096
/** 展示用重复字符串上限（码点）：超出截断并标记，避免把整段复读塞进界面。 */
const NOTIFY_UNIT_MAX = 160
/** 截停通知队列（进程内存）。 */
function createStopNotifier() {
  let seq = 0
  let revision = 0
  const items = []
  return {
    /** 入队一条截停记录（字段全部来自宿主，未做展示层裁剪）。 */
    push(entry) {
      seq += 1
      const item = {
        id: 'dupguard-stop-' + String(seq),
        time: Date.now(),
        sessionId: entry.sessionId === undefined || entry.sessionId === null ? null : String(entry.sessionId),
        sessionTitle: typeof entry.sessionTitle === 'string' && entry.sessionTitle !== '' ? entry.sessionTitle : null,
        workspacePath: typeof entry.workspacePath === 'string' && entry.workspacePath !== '' ? entry.workspacePath : null,
        workspaceTitle: typeof entry.workspaceTitle === 'string' && entry.workspaceTitle !== '' ? entry.workspaceTitle : null,
        unit: typeof entry.unit === 'string' ? entry.unit : '',
        count: Number.isSafeInteger(entry.count) ? entry.count : null,
        span: Number.isSafeInteger(entry.span) ? entry.span : null,
        code: entry.code === true,
        source: typeof entry.source === 'string' ? entry.source : 'text',
        prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
        status: 'pending',
        detail: null,
      }
      items.unshift(item)
      while (items.length > NOTIFY_LIMIT) items.pop()
      revision += 1
      return item
    },
    list() {
      return items.map(publicNotice)
    },
    find(id) {
      return items.find((item) => item.id === id)
    },
    revision() {
      return revision
    },
    /** 状态变更后递增版本号，让客户端知道列表变了。 */
    touch() {
      revision += 1
    },
  }
}

/** 队列条目的公开视图（JSON 安全；重复字符串按码点截断）。 */
function publicNotice(item) {
  const chars = [...item.unit]
  const clipped = chars.length > NOTIFY_UNIT_MAX
  return {
    id: item.id,
    time: item.time,
    sessionId: item.sessionId,
    sessionTitle: item.sessionTitle,
    workspacePath: item.workspacePath,
    workspaceTitle: item.workspaceTitle,
    unit: clipped ? chars.slice(0, NOTIFY_UNIT_MAX).join('') : item.unit,
    unitLength: chars.length,
    unitTruncated: clipped,
    count: item.count,
    span: item.span,
    code: item.code,
    source: item.source,
    unitCodePoints: chars.slice(0, 24).map((ch) => ch.codePointAt(0)),
    prompt: item.prompt,
    status: item.status,
    detail: item.detail,
  }
}

/** 路径比较用归一化：Windows 大小写与分隔符差异不影响匹配。 */
function normalizePathForCompare(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 解析被截停会话的展示信息：工作区路径 / 工作区名称 / 会话标题。
 * 全部尽力而为——服务缺失或版本过旧时字段为 null，绝不影响截停与通知本身。
 *
 * @param services - 通过 `ctx.inject` 捕获的**服务对象**集合。**不能用 `ctx.get`**：
 *   loader entry 的 ctx 解析不到 root 服务（本插件第 2255 行附近的既有注释即为此约定），
 *   用 get 会静默拿到 undefined ⇒ 通知退化成"未知工作区/未命名会话"。
 * @param sessionId - 被截停会话的 id。
 */
function describeStoppedSession(services, sessionId) {
  const info = { sessionTitle: null, workspacePath: null, workspaceTitle: null }
  if (sessionId === undefined || sessionId === null || sessionId === '') return info
  const source = services === undefined || services === null ? {} : services
  let session
  try {
    const sessions = source.sessions
    if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
      session = sessions.get(sessionId)
    }
  } catch (_sessionsError) {
    session = undefined
  }
  if (session !== undefined && session !== null) {
    try {
      const header = session.header
      if (header !== undefined && header !== null && typeof header.cwd === 'string' && header.cwd !== '') {
        info.workspacePath = header.cwd
      }
    } catch (_headerError) {}
    try {
      const titles = source.sessionTitle
      if (titles !== undefined && titles !== null && typeof titles.get === 'function') {
        const snapshot = titles.get(session)
        if (snapshot !== undefined && snapshot !== null && typeof snapshot.title === 'string' && snapshot.title !== '') {
          info.sessionTitle = snapshot.title
        }
      }
    } catch (_titleError) {}
  }
  if (info.workspacePath !== null) {
    try {
      const registry = source.workspaceRegistry
      if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
        const wanted = normalizePathForCompare(info.workspacePath)
        const workspaces = registry.list()
        if (Array.isArray(workspaces)) {
          for (const workspace of workspaces) {
            if (workspace === null || typeof workspace !== 'object') continue
            if (typeof workspace.path !== 'string' || typeof workspace.title !== 'string') continue
            if (normalizePathForCompare(workspace.path) !== wanted) continue
            info.workspaceTitle = workspace.title
            break
          }
        }
      }
    } catch (_registryError) {}
  }
  return info
}

/**
 * 构造一条用户消息（`user/message` 的完整形状）。
 * 优先复用 DSH 自己的 `createUserMessage`（id 生成与冻结语义与宿主完全一致）；
 * 找不到时按同一形状自行构造：id 用 `randomUUID()`，与宿主 `brandString(randomUUID())` 同形。
 */
function buildUserMessage(text) {
  const content = [{ type: 'text', text }]
  const factory = findUserMessageFactory()
  if (factory !== null) {
    try {
      return { message: factory({ content, source: { kind: 'user' } }), via: 'factory' }
    } catch (_factoryError) {}
  }
  const frozenContent = Object.freeze(content.map((block) => Object.freeze({ ...block })))
  return {
    message: Object.freeze({
      id: String(require('crypto').randomUUID()),
      role: 'user',
      content: frozenContent,
      source: Object.freeze({ kind: 'user' }),
    }),
    via: 'manual',
  }
}

/**
 * 从**已加载**的 DSH 模块里找 `createUserMessage`。
 * 我们的插件装在 profile 下，无法直接 `require('@deepseek-ai/dsh-session')`
 * （profile 的 node_modules 里没有 DSH 包）；但宿主进程必然加载过它，
 * 因此扫描 `require.cache` 是最稳的解析方式（找不到就用手工构造，功能不受影响）。
 */
function findUserMessageFactory() {
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.indexOf('@deepseek-ai') === -1) continue
      if (key.indexOf('dsh-session') === -1 && key.indexOf('dsh-llm') === -1) continue
      const cached = require.cache[key]
      const exports = cached === undefined ? undefined : cached.exports
      if (exports !== null && typeof exports === 'object' && typeof exports.createUserMessage === 'function') {
        return exports.createUserMessage
      }
    }
  } catch (_scanError) {}
  return null
}

/**
 * 把「继续指令」投递到被截停的会话（该会话必须仍然存活）。
 * @param services - 通过 `ctx.inject` 捕获的服务对象集合（同上：不用 ctx.get）。
 */
function deliverContinue(services, item) {
  const prompt = typeof item.prompt === 'string' && item.prompt.trim() !== '' ? item.prompt : CONFIG.continuePrompt
  if (item.sessionId === null) {
    return { ok: false, reason: 'no-session', message: '这次截停没有记录会话 id（DSH 未在请求里提供 sessionId）' }
  }
  const source = services === undefined || services === null ? {} : services
  const agents = source.agents
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    return { ok: false, reason: 'no-agents-service', message: '宿主没有 agents 服务，无法注入消息' }
  }
  const agent = agents.get(item.sessionId)
  if (agent === undefined || agent === null) {
    return { ok: false, reason: 'session-not-live', message: '该会话已不在运行（可能已关闭或归档），请打开它后手动继续' }
  }
  if (typeof agent.followup !== 'function') {
    return { ok: false, reason: 'no-followup', message: '该 agent 不支持注入消息（DSH 版本过旧）' }
  }
  const built = buildUserMessage(prompt)
  agent.followup(built.message)
  return {
    ok: true,
    reason: 'sent',
    via: built.via,
    message: '已向该会话发送继续指令（' + (built.via === 'factory' ? 'DSH 消息工厂' : '内置构造') + '）',
  }
}

/** 写出一个 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读取 JSON 请求体（超限或非法返回 null）。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > NOTIFY_BODY_LIMIT) return null
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (_parseError) {
    return null
  }
}

/** 同源校验：带 Origin 头的请求必须与 Host 一致，跨站请求直接拒绝。 */
function sameOrigin(req) {
  const origin = req.headers === undefined ? undefined : req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch (_urlError) {
    return false
  }
}

/** 处理通知通道请求：GET 列表 / POST 动作。 */
async function handleNotifyRequest(services, notifier, req, res) {
  const method = req.method === undefined ? '' : String(req.method).toUpperCase()
  const url = req.url === undefined ? '' : String(req.url)
  const path = url.split('?')[0]
  if (sameOrigin(req) !== true) {
    sendJson(res, 403, { ok: false, error: 'cross-origin' })
    return
  }
  if (path === NOTIFY_PREFIX + 'notifications') {
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    sendJson(res, 200, { ok: true, revision: notifier.revision(), items: notifier.list() })
    return
  }
  if (path === NOTIFY_PREFIX + 'notifications/action') {
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: 'bad-json' })
      return
    }
    const item = typeof body.id === 'string' ? notifier.find(body.id) : undefined
    if (item === undefined) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    if (body.action === 'dismiss') {
      item.status = 'dismissed'
      item.detail = '用户选择不发送继续指令'
      notifier.touch()
      console.log('[dupguard] 截停通知 ' + item.id + '：用户选择不发送继续指令')
      sendJson(res, 200, { ok: true, status: item.status, message: item.detail })
      return
    }
    if (body.action !== 'continue') {
      sendJson(res, 400, { ok: false, error: 'bad-action' })
      return
    }
    if (item.status === 'sent') {
      sendJson(res, 200, { ok: true, status: item.status, message: '此前已发送过继续指令', already: true })
      return
    }
    const result = deliverContinue(services, item)
    item.status = result.ok ? 'sent' : 'failed'
    item.detail = result.message
    notifier.touch()
    if (result.ok) {
      console.log('[dupguard] 截停通知 ' + item.id + '：已发送继续指令（via=' + String(result.via) + '）')
    } else {
      console.warn('[dupguard] 截停通知 ' + item.id + '：继续指令投递失败（' + String(result.reason) + '）' + result.message)
    }
    sendJson(res, result.ok ? 200 : 409, {
      ok: result.ok,
      status: item.status,
      error: result.reason,
      message: result.message,
    })
    return
  }
  sendJson(res, 404, { ok: false, error: 'not-found' })
}

/** 注册通知通道；webServer 缺失时告警并返回 null（截停不受影响）。 */
function registerNotifyRoutes(server, notifier, services) {
  if (server === undefined || server === null || typeof server.register !== 'function') {
    console.warn('[dupguard] 宿主没有 webServer 服务：截停通知不可用（检测与截停不受影响）')
    return null
  }
  try {
    return server.register({
      kind: 'prefix',
      // 不带尾斜杠：见 NOTIFY_ROUTE 的说明（带尾斜杠会让子路径匹配不上）。
      path: NOTIFY_ROUTE,
      // 返回 Promise：webServer 接受 void | Promise<void>，测试也能确定性地等待处理完成。
      handler: (req, res) => handleNotifyRequest(services, notifier, req, res).catch((error) => {
        try {
          sendJson(res, 500, { ok: false, error: 'internal', message: error && error.message ? error.message : String(error) })
        } catch (_writeError) {}
      }),
    })
  } catch (error) {
    console.warn('[dupguard] 注册截停通知通道失败（检测与截停不受影响）：' + (error && error.message ? error.message : String(error)))
    return null
  }
}

//#endregion

function apply(ctx, config) {
  // 启动自检：把关键服务可见性直接打到宿主日志，便于诊断挂载问题。
  console.log('[dupguard] 常驻插件 apply 开始')
  const runtime = createRuntime()
  // 每次模型调用用哪份参数：默认代码常量 + 旧版设置作用域（runtime 原地更新）；
  // DSH ≥ 0.1.7 改为按需读插件 Config（用户层写入后 loader 实时下发新 config）。
  let runtimeSource = () => runtime
  // 截停通知队列 + 通道：宿主记录，浏览器（全局浮层）读取并回传用户选择。
  const notifier = createStopNotifier()
  /**
   * 截停时生成通知：解析被截停会话的工作区与会话名称（与用户当前打开哪个会话无关），
   * 记下重复的字符串与命中参数。整段尽力而为——任何异常都不得影响截停收尾。
   * @param hit - 命中信息（unit / count / span / code）。
   * @param options - 本次 llm/stream 的 GenerateOptions（取其中的 sessionId）。
   */
  const notifyStop = (hit, options) => {
    let current
    try {
      current = runtimeSource()
    } catch (_runtimeError) {
      current = runtime
    }
    if (current === undefined || current === null || current.notifyOnStop !== true) return
    const sessionId = options !== undefined && options !== null && options.sessionId !== undefined && options.sessionId !== null
      ? String(options.sessionId)
      : null
    const info = describeStoppedSession(notifyServices, sessionId)
    const item = notifier.push({
      sessionId,
      sessionTitle: info.sessionTitle,
      workspacePath: info.workspacePath,
      workspaceTitle: info.workspaceTitle,
      unit: hit !== undefined && hit !== null && typeof hit.unit === 'string' ? hit.unit : '',
      count: hit !== undefined && hit !== null && Number.isSafeInteger(hit.count) ? hit.count : null,
      span: hit !== undefined && hit !== null && Number.isSafeInteger(hit.span) ? hit.span : null,
      code: hit !== undefined && hit !== null && hit.code === true,
      source: hit !== undefined && hit !== null && typeof hit.source === 'string' ? hit.source : 'text',
      prompt: current.continuePrompt,
    })
    console.log(
      '[dupguard] 截停通知 ' + item.id +
      '：工作区=' + (info.workspacePath === null ? '未知' : info.workspacePath) +
      (info.workspaceTitle === null ? '' : '（' + info.workspaceTitle + '）') +
      ' 会话=' + (info.sessionTitle === null ? String(sessionId) : info.sessionTitle) +
      ' 重复=' + JSON.stringify(hit !== undefined && hit !== null ? hit.unit : '') +
      ' ×' + String(hit !== undefined && hit !== null ? hit.count : '?') +
      '（通知已入队，浏览器端浮层会显示）'
    )
  }
  // 通知所需的宿主服务。**必须在 ctx.inject 回调里用属性访问**（`webCtx.webServer`）：
  // loader entry 的 ctx 用 `ctx.get()` 解析不到 root 服务，会静默拿到 undefined ——
  // 这正是「路由没注册、通知永远不弹、工作区显示未知」的根因（与 DSH 官方插件
  // dsh-client-modules / dsh-client-connection 的写法一致）。
  const notifyServices = {
    sessions: undefined,
    sessionTitle: undefined,
    workspaceRegistry: undefined,
    agents: undefined,
    webServer: undefined,
  }
  const captureService = (key) => (serviceCtx) => {
    notifyServices[key] = serviceCtx === undefined || serviceCtx === null ? undefined : serviceCtx[key]
    return () => {
      notifyServices[key] = undefined
    }
  }
  ctx.inject(['sessions'], captureService('sessions'))
  ctx.inject(['sessionTitle'], captureService('sessionTitle'))
  ctx.inject(['workspaceRegistry'], captureService('workspaceRegistry'))
  ctx.inject(['agents'], captureService('agents'))
  // 通知通道：webServer 就绪时注册同源 HTTP 路由（列表 + 动作）。
  ctx.inject(['webServer'], (webCtx) => {
    notifyServices.webServer = webCtx === undefined || webCtx === null ? undefined : webCtx.webServer
    const mount = () => {
      const dispose = registerNotifyRoutes(notifyServices.webServer, notifier, notifyServices)
      return () => {
        notifyServices.webServer = undefined
        if (typeof dispose === 'function') dispose()
      }
    }
    // 官方写法（dsh-client-modules）：把路由注册放进 effect，随作用域自动注销。
    // 极简 ctx（测试桩 / 宿主裁剪）没有 effect 时直接注册，只是缺少自动注销。
    if (webCtx !== undefined && webCtx !== null && typeof webCtx.effect === 'function') {
      webCtx.effect(mount, 'dupguard: notify routes')
    } else {
      mount()
    }
    console.log('[dupguard] 截停通知通道已注册：' + NOTIFY_ROUTE + '（列表 ' + NOTIFY_PREFIX + 'notifications）')
  })
  // 启动自检：把服务可见性打到宿主日志——"通知不弹 / 显示未知工作区"的第一现场就在这里。
  // 注意：这是**时刻快照**，而部分服务（如 workspaceRegistry）在启动期是异步激活的
  //   —— dsh-workspace 的服务描述：先等 sessionPersistence，再建 canonical-cwd 头索引，
  //   最后完成一次性历史 bootstrap 才 active。2 秒时未就绪属正常，故：
  //   ① 措辞用「未就绪」而不是「缺失」（后者容易被读成坏了）；
  //   ② 8 秒再查一次，只在状态发生变化时补一行，避免误报变成噪音。
  const serviceState = (value) => (value === undefined ? '未就绪' : '就绪')
  const selfCheckLine = () =>
    'webServer=' + serviceState(notifyServices.webServer) +
    '｜sessions=' + serviceState(notifyServices.sessions) +
    '｜sessionTitle=' + serviceState(notifyServices.sessionTitle) +
    '｜workspaceRegistry=' + serviceState(notifyServices.workspaceRegistry) +
    '｜agents=' + serviceState(notifyServices.agents)
  /** 自检用的定时器（含 8 秒复查），随作用域一并清理。 */
  const selfCheckTimers = []
  const notifySelfCheck = setTimeout(() => {
    const first = selfCheckLine()
    console.log('[dupguard] 截停通知自检：' + first + '（启动期快照；未就绪的异步服务会稍后注入，截停时按需读取）')
    const lateCheck = setTimeout(() => {
      const second = selfCheckLine()
      if (second !== first) console.log('[dupguard] 截停通知自检（+8s 复查）：' + second)
    }, 8000)
    if (lateCheck !== undefined && typeof lateCheck.unref === 'function') lateCheck.unref()
    selfCheckTimers.push(lateCheck)
  }, 2000)
  if (notifySelfCheck !== undefined && typeof notifySelfCheck.unref === 'function') notifySelfCheck.unref()
  ctx.effect(() => () => {
    clearTimeout(notifySelfCheck)
    for (const timer of selfCheckTimers) clearTimeout(timer)
  }, 'dupguard: notify self-check')
  // loader entry 的 ctx 无法用 ctx.get 直接解析 root 服务（DSH 宿主行的约定），
  // 必须经 ctx.inject 等待服务注入后在回调中访问 ctx.settings / ctx.cordisInspect。
  ctx.inject(['cordisInspect'], (inspectCtx) => {
    if (CONFIG.fixStandingMountConflict) installStandingMountPatch(inspectCtx.cordisInspect)
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
  ctx.on('llm/stream', (options, next) => createStreamGuard(options, runtimeSource(), {
    // 每次调用各自绑定自己的 options：通知里要记的是**这次**被截停的会话。
    onStop: (hit) => notifyStop(hit, options),
  })(next()))
}

// 测试钩子：截停通知的内部函数（与 plugin/host.js 的 __derived 同款做法）。
// 只读、无副作用；不在 README 中作为公开接口承诺。
module.exports = {
  name,
  apply,
  Config,
  __notify: {
    NOTIFY_PREFIX,
    NOTIFY_ROUTE,
    NOTIFY_LIMIT,
    NOTIFY_UNIT_MAX,
    CONTINUE_PROMPT_MAX,
    createStopNotifier,
    publicNotice,
    describeStoppedSession,
    normalizePathForCompare,
    buildUserMessage,
    deliverContinue,
    registerNotifyRoutes,
    handleNotifyRequest,
    createStreamGuard,
  },
  /**
   * 高级模式（module）的加载与判次路径——沙箱试运行工具（tools/sandbox-threshold-module.mjs）
   * 用的就是这几个函数，保证"试运行结果"与"宿主真实生效结果"同源；同时供测试断言。
   */
  __advanced: {
    loadAdvancedModule,
    createThresholdPolicy: createPolicy,
    describePolicy,
    isValidNeed,
    parseThresholdByLength,
  },
  /**
   * 派生逻辑的只读测试钩子：客户端设置页有一份镜像实现（浏览器 bundle 不能 require 宿主模块），
   * tests/client.test.js 用这里与客户端 __derive 做跨实现等价比较，防止两侧公式漂移。
   */
  __derive: {
    deriveWindow,
    deriveMaxUnitLength,
    parseThresholdByLength,
    createThresholdPolicy,
    codeBlockMode,
    effectiveCodeThreshold,
  },
}
