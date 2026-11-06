'use strict'

// ============================================================================
// 只读最近日志：设置页「最近记录」使用。
//
// 只读取 stop-log 已经解析出的固定路径（stops.jsonl / allows.jsonl），
// 不接受调用方传路径；返回前按**当前生效的脱敏设置**再次清洗字段，
// 避免用户先记录完整内容、再关闭详细模式后仍从查看器读到旧完整内容。
// ============================================================================

const nodeFs = require('fs')
const { resolveLogFile, resolveAllowLogFile, effectiveRedacted } = require('./stop-log')

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

function normalizeLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : DEFAULT_LIMIT
}

/** 读取 JSONL 的尾部记录；文件缺失、非法行或读失败一律降级为空数组。 */
function readTail(filePath, limit) {
  if (filePath === null || typeof filePath !== 'string' || filePath === '') return []
  let text
  try {
    text = nodeFs.readFileSync(filePath, 'utf8')
  } catch (_readError) {
    return []
  }
  const lines = text.split(/\r?\n/)
  const records = []
  for (let i = lines.length - 1; i >= 0 && records.length < limit; i -= 1) {
    const line = lines[i].trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed)
    } catch (_parseError) {}
  }
  return records
}

/** 统一公开字段；脱敏模式下隐藏可能含用户内容的字段。 */
function normalizeRecord(record, detailed) {
  const source = record === undefined || record === null ? {} : record
  const safe = (value) => (typeof value === 'string' && value !== '' ? value : null)
  const safeInt = (value) => (Number.isSafeInteger(value) ? value : null)
  const storedDetailed = source.redacted === false
  const showDetail = detailed === true && storedDetailed
  return {
    time: safe(source.time),
    version: safe(source.version),
    decision: safe(source.decision),
    heldMs: safeInt(source.heldMs),
    provider: safe(source.provider),
    model: safe(source.model),
    sessionId: safe(source.sessionId),
    sessionTitle: showDetail ? safe(source.sessionTitle) : null,
    workspacePath: showDetail ? safe(source.workspacePath) : null,
    workspaceTitle: showDetail ? safe(source.workspaceTitle) : null,
    unit: showDetail ? safe(source.unit) : null,
    unitLength: safeInt(source.unitLength),
    truncated: source.truncated === true,
    count: safeInt(source.count),
    span: safeInt(source.span),
    code: source.code === true,
    source: safe(source.source) || 'text',
    redacted: !showDetail,
  }
}

/**
 * 读取最近截停与允许继续记录。
 * @param options - { env, runtime, limit }；env 默认 process.env，runtime 用于读取 persistStopLog / stopLogFullContent。
 * @returns {{ enabled: boolean, reason: string|null, detailed: boolean, stops: object[], allows: object[] }}
 */
function readRecentLogs(options) {
  const opts = options === undefined || options === null ? {} : options
  const env = opts.env === undefined ? process.env : opts.env
  const runtime = opts.runtime === undefined || opts.runtime === null ? {} : opts.runtime
  const limit = normalizeLimit(opts.limit)
  const stopFile = resolveLogFile(env)
  const allowFile = resolveAllowLogFile(env)
  const settingsOff = runtime.persistStopLog === false
  const envOff = stopFile === null || allowFile === null
  const detailed = !effectiveRedacted(env, runtime)
  if (envOff || settingsOff) {
    return {
      enabled: false,
      reason: envOff ? 'env-off' : 'settings-off',
      detailed,
      stops: [],
      allows: [],
    }
  }
  return {
    enabled: true,
    reason: null,
    detailed,
    stops: readTail(stopFile, limit).map((record) => normalizeRecord(record, detailed)),
    allows: readTail(allowFile, limit).map((record) => normalizeRecord(record, detailed)),
  }
}

module.exports = {
  readRecentLogs,
  normalizeRecord,
  readTail,
  DEFAULT_LIMIT,
  MAX_LIMIT,
}
