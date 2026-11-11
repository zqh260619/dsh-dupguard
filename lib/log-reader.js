'use strict'

// ============================================================================
// 只读最近日志：设置页「最近记录」使用。
//
// 只读取 stop-log 已经解析出的固定路径（stops.jsonl / allows.jsonl / fillers.jsonl），
// 不接受调用方传路径；返回前按**当前生效的脱敏设置**再次清洗字段，
// 避免用户先记录完整内容、再关闭详细模式后仍从查看器读到旧完整内容。
// ============================================================================

const nodeFs = require('fs')
const { resolveLogFile, resolveAllowLogFile, resolveFillerLogFile, effectiveRedacted } = require('./stop-log')

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20
const FILLER_SCAN_LIMIT = 10000

function normalizeLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : DEFAULT_LIMIT
}

/**
 * 读取 JSONL 的尾部记录并返回解析健康信息。
 * 每行先移除 UTF-8 BOM；非法行计入 invalidLines，不再静默消失。
 * @returns {{ records: object[], invalidLines: number, readError: boolean }}
 */
function readTailReport(filePath, limit) {
  if (filePath === null || typeof filePath !== 'string' || filePath === '') {
    return { records: [], invalidLines: 0, readError: false }
  }
  let text
  try {
    text = nodeFs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return { records: [], invalidLines: 0, readError: error === null || error === undefined || error.code !== 'ENOENT' }
  }
  const lines = text.split(/\r?\n/)
  const parsed = []
  let invalidLines = 0
  for (const raw of lines) {
    const line = raw.replace(/^\uFEFF/, '').trim()
    if (line === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsed.push(value)
      else invalidLines += 1
    } catch (_parseError) {
      invalidLines += 1
    }
  }
  const wanted = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, parsed.length) : parsed.length
  return { records: parsed.slice(parsed.length - wanted).reverse(), invalidLines, readError: false }
}

/** 兼容旧接口：只返回尾部记录数组。 */
function readTail(filePath, limit) {
  return readTailReport(filePath, limit).records
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
    schemaVersion: safeInt(source.schemaVersion),
    eventId: safe(source.eventId),
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

/** 填充词提醒记录的公开字段；结果记录只用于给对应检测记录补充状态。 */
function normalizeFillerRecord(record, detailed, outcome) {
  const source = record === undefined || record === null ? {} : record
  const safe = (value) => (typeof value === 'string' && value !== '' ? value : null)
  const safeInt = (value) => (Number.isSafeInteger(value) ? value : null)
  const storedDetailed = source.redacted === false
  const showDetail = detailed === true && storedDetailed
  const hits = showDetail && Array.isArray(source.hits)
    ? source.hits
      .filter((hit) => hit !== null && typeof hit === 'object' &&
        typeof hit.pattern === 'string' && Number.isSafeInteger(hit.count))
      .slice(0, 16)
      .map((hit) => ({ pattern: hit.pattern, count: hit.count }))
    : null
  const action = outcome !== null && typeof outcome === 'object' &&
    (outcome.action === 'dismissed' || outcome.action === 'replaced') ? outcome.action : null
  return {
    time: safe(source.time),
    version: safe(source.version),
    schemaVersion: safeInt(source.schemaVersion),
    eventId: safe(source.eventId),
    kind: 'filler',
    sessionId: safe(source.sessionId),
    sessionTitle: showDetail ? safe(source.sessionTitle) : null,
    workspacePath: showDetail ? safe(source.workspacePath) : null,
    workspaceTitle: showDetail ? safe(source.workspaceTitle) : null,
    hits,
    hitsCount: safeInt(source.hitsCount),
    windowChars: safeInt(source.windowChars),
    observedChars: safeInt(source.observedChars),
    source: 'reasoning',
    status: action === null ? 'pending' : action,
    outcome: action === null ? null : {
      action,
      source: outcome !== null && outcome !== undefined && typeof outcome.source === 'string' ? outcome.source : null,
      elapsedMs: outcome !== null && outcome !== undefined && Number.isSafeInteger(outcome.elapsedMs) ? outcome.elapsedMs : null,
    },
    redacted: !showDetail,
  }
}

/**
 * 读取 fillers.jsonl：检测记录作为列表项，filler-outcome 记录按 eventId 合并为状态。
 * 文件最多 2MB；这里读取全量尾部以确保结果记录不会因为窗口截断而漏掉。
 */
function readFillerRecords(filePath, limit, detailed) {
  const report = readTailReport(filePath, FILLER_SCAN_LIMIT)
  const outcomeByEvent = new Map()
  for (const record of report.records) {
    if (record === null || typeof record !== 'object' || record.kind !== 'filler-outcome') continue
    if (typeof record.eventId !== 'string' || record.eventId === '') continue
    if (!outcomeByEvent.has(record.eventId)) outcomeByEvent.set(record.eventId, record)
  }
  const detections = report.records.filter((record) => {
    if (record === null || typeof record !== 'object') return false
    if (record.kind === 'filler-outcome') return false
    return record.kind === 'filler' || (record.kind === undefined && record.source === 'reasoning' && Array.isArray(record.hits))
  })
  return {
    records: detections.slice(0, limit).map((record) => normalizeFillerRecord(
      record,
      detailed,
      typeof record.eventId === 'string' ? outcomeByEvent.get(record.eventId) : null,
    )),
    invalidLines: report.invalidLines,
    readError: report.readError,
  }
}

/**
 * 读取最近截停、允许继续与填充词提醒记录。
 * @param options - { env, runtime, limit }；env 默认 process.env，runtime 用于读取 persistStopLog / stopLogFullContent。
 * @returns {{
 *   enabled: boolean, reason: string|null, detailed: boolean,
 *   health: { stops: object, allows: object, fillers: object },
 *   stops: object[], allows: object[], fillers: object[]
 * }}
 */
function readRecentLogs(options) {
  const opts = options === undefined || options === null ? {} : options
  const env = opts.env === undefined ? process.env : opts.env
  const runtime = opts.runtime === undefined || opts.runtime === null ? {} : opts.runtime
  const limit = normalizeLimit(opts.limit)
  const stopFile = resolveLogFile(env)
  const allowFile = resolveAllowLogFile(env)
  const fillerFile = resolveFillerLogFile(env)
  const settingsOff = runtime.persistStopLog === false
  const envOff = stopFile === null || allowFile === null || fillerFile === null
  const detailed = !effectiveRedacted(env, runtime)
  if (envOff || settingsOff) {
    return {
      enabled: false,
      reason: envOff ? 'env-off' : 'settings-off',
      detailed,
      health: null,
      stops: [],
      allows: [],
      fillers: [],
    }
  }
  const stopReport = readTailReport(stopFile, limit)
  const allowReport = readTailReport(allowFile, limit)
  const fillerReport = readFillerRecords(fillerFile, limit, detailed)
  return {
    enabled: true,
    reason: null,
    detailed,
    health: {
      stops: { invalidLines: stopReport.invalidLines, readError: stopReport.readError },
      allows: { invalidLines: allowReport.invalidLines, readError: allowReport.readError },
      fillers: { invalidLines: fillerReport.invalidLines, readError: fillerReport.readError },
    },
    stops: stopReport.records.map((record) => normalizeRecord(record, detailed)),
    allows: allowReport.records.map((record) => normalizeRecord(record, detailed)),
    fillers: fillerReport.records,
  }
}

module.exports = {
  readRecentLogs,
  normalizeRecord,
  normalizeFillerRecord,
  readTail,
  readTailReport,
  DEFAULT_LIMIT,
  MAX_LIMIT,
}
