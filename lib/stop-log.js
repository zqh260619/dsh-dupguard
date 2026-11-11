'use strict'

// ============================================================================
// dupguard 持久化日志（仅 npm / 常驻版可用）
//
// 每次截停追加一行到 stops.jsonl；用户点「允许继续」也追加一行到 allows.jsonl
// （格式完全相同，仅 decision 字段为 allowed；两个文件共用同一开关）：
//   $DSH_HOME/dupgard/stops.jsonl / allows.jsonl   （设置了 DSH_HOME 时）
//   ~/.dsh/dupgard/stops.jsonl / allows.jsonl      （默认；web / desktop profile 共用）
//
// 环境变量：
//   DSH_DUPGUARD_STOP_LOG=<路径>           自定义截停日志路径（允许继续日志同名目录下的 allows.jsonl）
//   DSH_DUPGUARD_STOP_LOG=off              关闭三种持久化（off / 0 / false / no）
//   DSH_DUPGUARD_STOP_LOG_REDACT=0         关闭脱敏，记录完整内容（默认脱敏；三个文件一致）
//
// 隐私：
//   - 默认**脱敏**：不写重复内容、会话标题、工作区路径/名称（保留长度/次数/参数数值；
//     参数里的白名单与高级模块路径一并省略）；需要排查内容时才显式设 REDACT=0；
//   - 日志只写本机（用户 home 下的 .dsh），插件没有任何网络调用；内容与 DSH 会话日志同级敏感；
//   - POSIX 上目录按 0700、文件按 0600 创建；Windows 继承用户 profile 的 ACL；
//   - 分享日志前保持默认脱敏，或手动删除 stops.jsonl（DSH 会话日志里仍有原始对话）。
//
// 设计约束：
//   - 写入必须 best-effort：任何异常都不得影响截停收尾（catch 后返回 false）；
//   - 单文件超过 2MB 自动轮转为 stops.jsonl.1（只保留一份历史，避免无界增长）；
//   - 动态入口 plugin/host.js 是 `new Function` 求值的代码体、不能 require('fs')，
//     因此持久化只在 npm/常驻版生效（检测与截停本身两个入口一致）。
// ============================================================================

const nodeFs = require('fs')
const nodePath = require('path')
const os = require('os')

const VERSION = (() => {
  try {
    const pkg = require('../package.json')
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch (_error) {
    return 'unknown'
  }
})()

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const UNIT_MAX = 200
const LOG_SCHEMA_VERSION = 2
const DISABLED_VALUES = new Set(['off', '0', 'false', 'no'])
const REDACT_VALUES = new Set(['1', 'on', 'true', 'yes'])
const FULL_VALUES = new Set(['0', 'off', 'false', 'no'])

/**
 * 脱敏模式的环境变量覆盖值：
 *   - 未设置 → null（由 stopLogFullContent 设置决定）；
 *   - 显式脱敏值 → true；
 *   - 显式完整值 → false；
 *   - 非法值按隐私优先返回 true。
 */
function resolveRedactedOverride(env) {
  const source = env === undefined || env === null ? process.env : env
  const raw = source.DSH_DUPGUARD_STOP_LOG_REDACT
  if (raw === undefined || raw === null) return null
  const value = String(raw).trim().toLowerCase()
  if (REDACT_VALUES.has(value)) return true
  if (FULL_VALUES.has(value)) return false
  return true
}

/**
 * 脱敏模式开关（环境变量；测试可注入 env）。
 * 默认开启脱敏；显式 DSH_DUPGUARD_STOP_LOG_REDACT=0/off/false 才记录完整内容。
 */
function resolveRedacted(env) {
  const override = resolveRedactedOverride(env)
  return override === null ? true : override
}

/** 当前生效的脱敏模式：环境变量优先，其次 stopLogFullContent 设置。 */
function effectiveRedacted(env, runtime) {
  const override = resolveRedactedOverride(env)
  if (override !== null) return override
  return !(runtime !== undefined && runtime !== null && runtime.stopLogFullContent === true)
}

/**
 * 解析日志文件路径。
 * @param env - 环境变量对象（默认 process.env；测试可注入）。
 * @returns 文件绝对路径；返回 null 表示已关闭持久化。
 */
function resolveLogFile(env) {
  const source = env === undefined || env === null ? process.env : env
  const configured = source.DSH_DUPGUARD_STOP_LOG
  if (configured !== undefined) {
    const value = String(configured).trim()
    if (DISABLED_VALUES.has(value.toLowerCase())) return null
    if (value !== '') return nodePath.resolve(value)
  }
  const rawHome = source.DSH_HOME
  const dshHome = rawHome !== undefined && String(rawHome).trim() !== '' ? String(rawHome).trim() : null
  const base = dshHome !== null ? nodePath.resolve(dshHome) : nodePath.join(os.homedir(), '.dsh')
  return nodePath.join(base, 'dupgard', 'stops.jsonl')
}

/**
 * 解析「允许继续」日志文件路径：与截停日志同目录、文件名固定为 allows.jsonl。
 * 共用 DSH_DUPGUARD_STOP_LOG 的开关（off 时返回 null）。
 */
function resolveAllowLogFile(env) {
  const stopFile = resolveLogFile(env)
  if (stopFile === null) return null
  return nodePath.join(nodePath.dirname(stopFile), 'allows.jsonl')
}

/** 填充词提醒日志：同样与截停日志同目录、文件名固定为 fillers.jsonl，共用总开关。 */
function resolveFillerLogFile(env) {
  const stopFile = resolveLogFile(env)
  if (stopFile === null) return null
  return nodePath.join(nodePath.dirname(stopFile), 'fillers.jsonl')
}

function truncate(value, max) {
  const text = typeof value === 'string' ? value : ''
  return text.length > max ? text.slice(0, max) : text
}

function safeString(value) {
  return value !== undefined && value !== null && String(value).length > 0 ? String(value) : null
}

function paramsSnapshot(runtime, redacted) {
  const source = runtime !== undefined && runtime !== null ? runtime : {}
  const snapshot = {
    threshold: source.threshold,
    thresholdMode: source.thresholdMode,
    minUnitLength: source.minUnitLength,
    maxUnitLength: source.maxUnitLength,
    detectionWindow: source.detectionWindow,
    codeBlockMultiplier: source.codeBlockMultiplier,
    stripWhitespace: source.stripWhitespace,
    skipCodeBlocks: source.skipCodeBlocks,
    monitorReasoning: source.monitorReasoning,
    monitorToolArguments: source.monitorToolArguments,
    ignoredCharsCount: Array.isArray(source.ignoredChars) ? source.ignoredChars.length : 0,
    ignoredSubstringsCount: Array.isArray(source.ignoredSubstrings) ? source.ignoredSubstrings.length : 0,
    reasoningFillerThresholdPerK: source.reasoningFillerThresholdPerK,
  }
  if (redacted === true) return snapshot
  // 完整模式才写可能含用户内容的参数（白名单、分段表、高级模块路径、填充词列表）。
  snapshot.thresholdByLength = source.thresholdByLength
  snapshot.advancedThresholdFile = source.advancedThresholdFile
  snapshot.ignoredChars = Array.isArray(source.ignoredChars) ? source.ignoredChars.slice(0) : []
  snapshot.ignoredSubstrings = Array.isArray(source.ignoredSubstrings) ? source.ignoredSubstrings.slice(0) : []
  snapshot.reasoningFillerPatterns = source.reasoningFillerPatterns
  return snapshot
}

/**
 * 创建某个 JSONL 文件的日志记录器（截停 / 允许继续共用）。
 * @param filePath - 目标文件；null 表示关闭。
 * @param options - 可选：{ env, maxBytes, redact }（测试注入用；redact 未给时读环境变量）。
 */
function createJsonlLogger(filePath, options) {
  const opts = options === undefined || options === null ? {} : options
  const env = opts.env === undefined ? process.env : opts.env
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES
  const enabled = filePath !== null

  function rotateIfNeeded() {
    let size
    try {
      size = nodeFs.statSync(filePath).size
    } catch (_statError) {
      return
    }
    if (size <= maxBytes) return
    try {
      nodeFs.rmSync(filePath + '.1', { force: true })
    } catch (_removeError) {}
    try {
      nodeFs.renameSync(filePath, filePath + '.1')
    } catch (_renameError) {}
  }

  /** 追加一行并收紧权限；只在 enabled 时调用，返回是否成功。 */
  function appendLine(line) {
    nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true, mode: 0o700 })
    rotateIfNeeded()
    nodeFs.appendFileSync(filePath, line, 'utf8')
    // POSIX 收紧权限（Windows 上 chmod 语义有限，交给用户 profile 的 ACL）。
    if (process.platform !== 'win32') {
      try { nodeFs.chmodSync(nodePath.dirname(filePath), 0o700) } catch (_dirModeError) {}
      try { nodeFs.chmodSync(filePath, 0o600) } catch (_fileModeError) {}
    }
    return true
  }

  /**
   * 记录一条事件（截停或允许继续；格式完全相同）。
   * @param hit - 检测命中信息（unit / count / span / code / source）。
   * @param streamOptions - 本次 llm/stream 的 GenerateOptions（sessionId / provider / model）。
   * @param extra - 附加信息：{ runtime, sessionTitle, workspacePath, workspaceTitle, decision, heldMs }。
   *   runtime.persistStopLog === false 时视为设置页关闭（环境变量 off 已经是更早的总开关）。
   * @returns 是否成功写入（关闭或写失败时返回 false，不抛异常）。
   */
  function record(hit, streamOptions, extra) {
    if (!enabled) return false
    try {
      const h = hit === undefined || hit === null ? {} : hit
      const o = streamOptions === undefined || streamOptions === null ? {} : streamOptions
      const x = extra === undefined || extra === null ? {} : extra
      if (x.runtime !== undefined && x.runtime !== null && x.runtime.persistStopLog === false) return false
      // 环境变量优先；否则跟随设置页的 stopLogFullContent（默认脱敏）。
      const redacted = typeof opts.redact === 'function'
        ? opts.redact(x.runtime) === true
        : (typeof opts.redact === 'boolean' ? opts.redact : effectiveRedacted(env, x.runtime))
      const unit = typeof h.unit === 'string' ? h.unit : ''
      const line = JSON.stringify({
        time: new Date().toISOString(),
        version: VERSION,
        schemaVersion: LOG_SCHEMA_VERSION,
        eventId: typeof x.eventId === 'string' && x.eventId !== '' ? x.eventId : null,
        redacted,
        sessionId: safeString(o.sessionId),
        provider: typeof o.provider === 'string' ? o.provider : null,
        model: typeof o.model === 'string' ? o.model : null,
        sessionTitle: redacted ? null : safeString(x.sessionTitle),
        workspacePath: redacted ? null : safeString(x.workspacePath),
        workspaceTitle: redacted ? null : safeString(x.workspaceTitle),
        unit: redacted ? null : truncate(unit, UNIT_MAX),
        unitLength: unit.length,
        truncated: redacted ? false : unit.length > UNIT_MAX,
        count: Number.isSafeInteger(h.count) ? h.count : null,
        span: Number.isSafeInteger(h.span) ? h.span : null,
        code: h.code === true,
        source: typeof h.source === 'string' ? h.source : 'text',
        // 决策来源：user（用户在决策卡片点立即截停）/ auto（达到倍数且已过最短反应时间自动截停）/
        // threshold（无决策通道的旧路径）/ allowed（用户选择允许继续；写入 allows.jsonl）。
        decision: typeof x.decision === 'string' ? x.decision : null,
        heldMs: Number.isSafeInteger(x.heldMs) ? x.heldMs : null,
        params: paramsSnapshot(x.runtime, redacted),
      }) + '\n'
      return appendLine(line)
    } catch (_error) {
      return false
    }
  }

  /**
   * 记录一条思维链填充词提醒（fillers.jsonl）。
   * 脱敏模式只记录命中数量与窗口，不写 pattern / 会话标题 / 工作区。
   * @param payload - { hits:[{pattern,count}], windowChars, observedChars }。
   * @param streamOptions - 本次 llm/stream 的 GenerateOptions。
   * @param extra - { runtime, sessionTitle, workspacePath, workspaceTitle }。
   */
  function recordFiller(payload, streamOptions, extra) {
    if (!enabled) return false
    try {
      const p = payload === undefined || payload === null ? {} : payload
      const o = streamOptions === undefined || streamOptions === null ? {} : streamOptions
      const x = extra === undefined || extra === null ? {} : extra
      if (x.runtime !== undefined && x.runtime !== null && x.runtime.persistStopLog === false) return false
      const redacted = typeof opts.redact === 'function'
        ? opts.redact(x.runtime) === true
        : (typeof opts.redact === 'boolean' ? opts.redact : effectiveRedacted(env, x.runtime))
      const hits = Array.isArray(p.hits)
        ? p.hits.filter((hit) => hit !== null && typeof hit === 'object' &&
          typeof hit.pattern === 'string' && Number.isSafeInteger(hit.count)).slice(0, 16)
        : []
      const line = JSON.stringify({
        time: new Date().toISOString(),
        version: VERSION,
        schemaVersion: LOG_SCHEMA_VERSION,
        eventId: typeof x.eventId === 'string' && x.eventId !== '' ? x.eventId : null,
        redacted,
        kind: 'filler',
        status: 'pending',
        sessionId: safeString(o.sessionId),
        provider: typeof o.provider === 'string' ? o.provider : null,
        model: typeof o.model === 'string' ? o.model : null,
        sessionTitle: redacted ? null : safeString(x.sessionTitle),
        workspacePath: redacted ? null : safeString(x.workspacePath),
        workspaceTitle: redacted ? null : safeString(x.workspaceTitle),
        hits: redacted ? null : hits.map((hit) => ({ pattern: truncate(hit.pattern, 64), count: hit.count })),
        hitsCount: hits.length,
        windowChars: Number.isSafeInteger(p.windowChars) ? p.windowChars : null,
        observedChars: Number.isSafeInteger(p.observedChars) ? p.observedChars : null,
        source: 'reasoning',
        params: paramsSnapshot(x.runtime, redacted),
      }) + '\n'
      return appendLine(line)
    } catch (_error) {
      return false
    }
  }

  /**
   * 追加一条填充词提醒的结果（仍写 fillers.jsonl，不修改原检测记录）。
   * @param payload - { eventId, action, source, elapsedMs, sessionId }。
   * @param extra - { runtime }。
   */
  function recordFillerOutcome(payload, extra) {
    if (!enabled) return false
    try {
      const p = payload === undefined || payload === null ? {} : payload
      const x = extra === undefined || extra === null ? {} : extra
      if (x.runtime !== undefined && x.runtime !== null && x.runtime.persistStopLog === false) return false
      if (typeof p.eventId !== 'string' || p.eventId === '') return false
      if (p.action !== 'dismissed' && p.action !== 'replaced') return false
      const line = JSON.stringify({
        time: new Date().toISOString(),
        version: VERSION,
        schemaVersion: LOG_SCHEMA_VERSION,
        kind: 'filler-outcome',
        eventId: p.eventId,
        sessionId: safeString(p.sessionId),
        action: p.action,
        source: typeof p.source === 'string' && p.source !== '' ? p.source : null,
        elapsedMs: Number.isSafeInteger(p.elapsedMs) ? p.elapsedMs : null,
      }) + '\n'
      return appendLine(line)
    } catch (_error) {
      return false
    }
  }

  return { record, recordFiller, recordFillerOutcome, filePath, enabled }
}

/** 截停日志（stops.jsonl）。 */
function createStopLogger(options) {
  const opts = options === undefined || options === null ? {} : options
  const env = opts.env === undefined ? process.env : opts.env
  return createJsonlLogger(resolveLogFile(env), options)
}

/** 「允许继续」日志（allows.jsonl）；与截停日志共用路径目录与同一个开关。 */
function createAllowLogger(options) {
  const opts = options === undefined || options === null ? {} : options
  const env = opts.env === undefined ? process.env : opts.env
  return createJsonlLogger(resolveAllowLogFile(env), options)
}

/** 思维链填充词提醒日志（fillers.jsonl）；同样共用目录与总开关。 */
function createFillerLogger(options) {
  const opts = options === undefined || options === null ? {} : options
  const env = opts.env === undefined ? process.env : opts.env
  return createJsonlLogger(resolveFillerLogFile(env), options)
}

/**
 * 删除 dupguard 的活动日志、轮转文件和同名备份。
 * 只处理已知的三个日志文件名及其后缀，不碰目录内其他文件；best-effort。
 * @returns {{ ok: boolean, removed: string[], errors: string[], error?: string }}
 */
function clearLogFiles(options) {
  const opts = options === undefined || options === null ? {} : options
  const env = opts.env === undefined ? process.env : opts.env
  const stopFile = resolveLogFile(env)
  if (stopFile === null) return { ok: false, error: 'logs-disabled', removed: [], errors: [] }
  const directory = nodePath.dirname(stopFile)
  const active = [stopFile, stopFile + '.1', resolveAllowLogFile(env), resolveAllowLogFile(env) + '.1', resolveFillerLogFile(env), resolveFillerLogFile(env) + '.1']
    .filter((file) => typeof file === 'string' && file !== '')
  let names = []
  try {
    names = nodeFs.readdirSync(directory)
  } catch (_readError) {}
  const bases = [nodePath.basename(stopFile), 'allows.jsonl', 'fillers.jsonl']
  for (const name of names) {
    if (bases.some((base) => name.startsWith(base + '.bak-'))) active.push(nodePath.join(directory, name))
  }
  const removed = []
  const errors = []
  for (const file of new Set(active)) {
    if (typeof file !== 'string' || file === '') continue
    try {
      nodeFs.rmSync(file, { force: true })
      removed.push(nodePath.basename(file))
    } catch (error) {
      errors.push(nodePath.basename(file) + ': ' + (error && error.message ? error.message : String(error)))
    }
  }
  return { ok: errors.length === 0, removed, errors }
}

module.exports = {
  createStopLogger,
  createAllowLogger,
  createFillerLogger,
  createJsonlLogger,
  clearLogFiles,
  resolveLogFile,
  resolveAllowLogFile,
  resolveFillerLogFile,
  resolveRedacted,
  resolveRedactedOverride,
  effectiveRedacted,
  DEFAULT_MAX_BYTES,
  UNIT_MAX,
  LOG_SCHEMA_VERSION,
}
