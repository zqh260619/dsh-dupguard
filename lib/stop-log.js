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

function paramsSnapshot(runtime) {
  const source = runtime !== undefined && runtime !== null ? runtime : {}
  return {
    threshold: source.threshold,
    thresholdMode: source.thresholdMode,
    minUnitLength: source.minUnitLength,
    maxUnitLength: source.maxUnitLength,
    detectionWindow: source.detectionWindow,
    codeBlockMultiplier: source.codeBlockMultiplier,
    thresholdByLength: source.thresholdByLength,
    stripWhitespace: source.stripWhitespace,
    skipCodeBlocks: source.skipCodeBlocks,
    monitorReasoning: source.monitorReasoning,
    monitorToolArguments: source.monitorToolArguments,
    ignoredChars: Array.isArray(source.ignoredChars) ? source.ignoredChars.slice(0) : [],
    ignoredSubstrings: Array.isArray(source.ignoredSubstrings) ? source.ignoredSubstrings.slice(0) : [],
  }
}

/**
 * 创建截停日志记录器。
 * @param options - 可选：{ env, maxBytes }（测试注入用）。
 */
function createStopLogger(options) {
  const opts = options === undefined || options === null ? {} : options
  const env = opts.env === undefined ? process.env : opts.env
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES
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
   * @returns 是否成功写入（关闭或写失败时返回 false，不抛异常）。
   */
  function record(hit, streamOptions, extra) {
    if (!enabled) return false
    try {
      const h = hit === undefined || hit === null ? {} : hit
      const o = streamOptions === undefined || streamOptions === null ? {} : streamOptions
      const x = extra === undefined || extra === null ? {} : extra
      const unit = typeof h.unit === 'string' ? h.unit : ''
      const line = JSON.stringify({
        time: new Date().toISOString(),
        version: VERSION,
        sessionId: safeString(o.sessionId),
        provider: typeof o.provider === 'string' ? o.provider : null,
        model: typeof o.model === 'string' ? o.model : null,
        sessionTitle: safeString(x.sessionTitle),
        workspacePath: safeString(x.workspacePath),
        workspaceTitle: safeString(x.workspaceTitle),
        unit: truncate(unit, UNIT_MAX),
        unitLength: unit.length,
        truncated: unit.length > UNIT_MAX,
        count: Number.isSafeInteger(h.count) ? h.count : null,
        span: Number.isSafeInteger(h.span) ? h.span : null,
        code: h.code === true,
        source: typeof h.source === 'string' ? h.source : 'text',
        params: paramsSnapshot(x.runtime),
      }) + '\n'
      nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true })
      rotateIfNeeded()
      nodeFs.appendFileSync(filePath, line, 'utf8')
      return true
    } catch (_error) {
      return false
    }
  }

  return { record, filePath, enabled }
}

module.exports = { createStopLogger, resolveLogFile, DEFAULT_MAX_BYTES, UNIT_MAX }
