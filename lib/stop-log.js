'use strict'

// ============================================================================
// dupguard 截停持久化日志（仅 npm / 常驻版可用）
//
// 每次截停追加一行 JSON（JSONL），默认位置：
//   $DSH_HOME/dupgard/stops.jsonl          （设置了 DSH_HOME 时）
//   ~/.dsh/dupgard/stops.jsonl             （默认；web / desktop profile 共用）
//
// 环境变量：
//   DSH_DUPGUARD_STOP_LOG=<路径>           自定义日志文件路径
//   DSH_DUPGUARD_STOP_LOG=off              关闭持久化（off / 0 / false / no）
//   DSH_DUPGUARD_STOP_LOG_REDACT=0         关闭脱敏，记录完整内容（默认脱敏）
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
const DISABLED_VALUES = new Set(['off', '0', 'false', 'no'])
const REDACT_VALUES = new Set(['1', 'on', 'true', 'yes'])
const FULL_VALUES = new Set(['0', 'off', 'false', 'no'])

/**
 * 脱敏模式开关（环境变量；测试可注入 env）。
 * 默认开启脱敏；显式 DSH_DUPGUARD_STOP_LOG_REDACT=0/off/false 才记录完整内容。
 */
function resolveRedacted(env) {
  const source = env === undefined || env === null ? process.env : env
  const raw = source.DSH_DUPGUARD_STOP_LOG_REDACT
  if (raw === undefined || raw === null) return true
  const value = String(raw).trim().toLowerCase()
  if (REDACT_VALUES.has(value)) return true
  if (FULL_VALUES.has(value)) return false
  return true
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
  }
  if (redacted === true) return snapshot
  // 完整模式才写可能含用户内容的参数（白名单、分段表、高级模块路径）。
  snapshot.thresholdByLength = source.thresholdByLength
  snapshot.advancedThresholdFile = source.advancedThresholdFile
  snapshot.ignoredChars = Array.isArray(source.ignoredChars) ? source.ignoredChars.slice(0) : []
  snapshot.ignoredSubstrings = Array.isArray(source.ignoredSubstrings) ? source.ignoredSubstrings.slice(0) : []
  return snapshot
}

/**
 * 创建截停日志记录器。
 * @param options - 可选：{ env, maxBytes, redact }（测试注入用；redact 未给时读环境变量）。
 */
function createStopLogger(options) {
  const opts = options === undefined || options === null ? {} : options
  const env = opts.env === undefined ? process.env : opts.env
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES
  const redacted = typeof opts.redact === 'boolean' ? opts.redact : resolveRedacted(env)
  const filePath = resolveLogFile(env)
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

  /**
   * 记录一次截停。
   * @param hit - 检测命中信息（unit / count / span / code / source）。
   * @param streamOptions - 本次 llm/stream 的 GenerateOptions（sessionId / provider / model）。
   * @param extra - 附加信息：{ runtime, sessionTitle, workspacePath, workspaceTitle }。
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
      const unit = typeof h.unit === 'string' ? h.unit : ''
      const line = JSON.stringify({
        time: new Date().toISOString(),
        version: VERSION,
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
        params: paramsSnapshot(x.runtime, redacted),
      }) + '\n'
      nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true, mode: 0o700 })
      rotateIfNeeded()
      nodeFs.appendFileSync(filePath, line, 'utf8')
      // POSIX 收紧权限（Windows 上 chmod 语义有限，交给用户 profile 的 ACL）。
      if (process.platform !== 'win32') {
        try { nodeFs.chmodSync(nodePath.dirname(filePath), 0o700) } catch (_dirModeError) {}
        try { nodeFs.chmodSync(filePath, 0o600) } catch (_fileModeError) {}
      }
      return true
    } catch (_error) {
      return false
    }
  }

  return { record, filePath, enabled }
}

module.exports = { createStopLogger, resolveLogFile, resolveRedacted, DEFAULT_MAX_BYTES, UNIT_MAX }
