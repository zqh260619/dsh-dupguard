'use strict'

// ============================================================================
// dupguard 截停持久化日志测试
//
// 覆盖：路径解析（DSH_HOME / 显式路径 / 关闭）、JSONL 记录字段、unit 截断、
// 自动轮转、写失败静默降级，以及「apply 真实截停 → 落盘」的端到端接线。
//
// 注意：所有写盘都使用临时目录；套件默认把 DSH_DUPGUARD_STOP_LOG 置为 off，
// 避免污染真实 ~/.dsh/dupgard/stops.jsonl。
// ============================================================================

process.env.DSH_DUPGUARD_STOP_LOG = 'off'
// 避免开发机环境变量影响断言；脱敏模式在用例里显式注入。
process.env.DSH_DUPGUARD_STOP_LOG_REDACT = '0'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createStopLogger, createAllowLogger, resolveLogFile, resolveAllowLogFile, resolveRedacted } = require('../lib/stop-log.js')
const { readRecentLogs } = require('../lib/log-reader.js')
const plugin = require('../lib/index.js')
const { makeCtx, makeUpstream, textChunks } = require('./helpers/host-harness.cjs')
const { createReport } = require('./helpers/report.cjs')

const report = createReport()
const { test } = report
const pkg = require('../package.json')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dupguard-stoplog-'))
}
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_error) {}
}
function envWith(overrides) {
  return { ...process.env, ...overrides }
}
function readRecords(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}
async function callRoute(route, method, url, body) {
  const request = {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  const response = {
    status: null,
    body: '',
    writeHead(status) { response.status = status },
    end(text) { response.body = text === undefined ? '' : String(text) },
  }
  await route.handler(request, response)
  return { status: response.status, body: JSON.parse(response.body) }
}
async function listNotices(route) {
  return (await callRoute(route, 'GET', '/dsh-dupguard/notifications')).body.items
}
const sampleHit = { unit: 'ab', count: 10, span: 20, code: false, source: 'text' }
const sampleRuntime = {
  threshold: 10,
  thresholdMode: 'simple',
  minUnitLength: 1,
  maxUnitLength: 80,
  detectionWindow: 8192,
  codeBlockMultiplier: 4,
  thresholdByLength: '',
  stripWhitespace: true,
  skipCodeBlocks: true,
  monitorReasoning: true,
  monitorToolArguments: false,
  ignoredChars: ['-', '|'],
  ignoredSubstrings: [],
}

async function main() {
  console.log('dupguard 截停持久化日志测试')

  await test('路径解析：DSH_HOME 默认 / 显式路径 / off', () => {
    const home = path.join(tmpDir(), 'home')
    assert.strictEqual(resolveLogFile({ DSH_HOME: home }), path.join(home, 'dupgard', 'stops.jsonl'), 'DSH_HOME 下默认路径')
    assert.strictEqual(resolveAllowLogFile({ DSH_HOME: home }), path.join(home, 'dupgard', 'allows.jsonl'), '允许继续日志与截停日志同目录')
    const custom = path.join(tmpDir(), 'custom.jsonl')
    assert.strictEqual(resolveLogFile({ DSH_DUPGUARD_STOP_LOG: custom }), path.resolve(custom), '显式路径优先')
    assert.strictEqual(resolveAllowLogFile({ DSH_DUPGUARD_STOP_LOG: custom }), path.join(path.dirname(path.resolve(custom)), 'allows.jsonl'), '自定义截停路径时允许继续日志放同目录')
    assert.strictEqual(resolveLogFile({ DSH_DUPGUARD_STOP_LOG: 'off' }), null, 'off 关闭')
    assert.strictEqual(resolveAllowLogFile({ DSH_DUPGUARD_STOP_LOG: 'off' }), null, 'off 同时关闭允许继续日志')
    assert.strictEqual(resolveLogFile({ DSH_DUPGUARD_STOP_LOG: '0' }), null, '0 关闭')
    assert.strictEqual(resolveLogFile({ DSH_DUPGUARD_STOP_LOG: 'false' }), null, 'false 关闭')
    assert.strictEqual(resolveRedacted({ DSH_DUPGUARD_STOP_LOG_REDACT: '1' }), true, 'REDACT=1 开启脱敏')
    assert.strictEqual(resolveRedacted({ DSH_DUPGUARD_STOP_LOG_REDACT: 'on' }), true, 'REDACT=on 开启脱敏')
    assert.strictEqual(resolveRedacted({ DSH_DUPGUARD_STOP_LOG_REDACT: '0' }), false, 'REDACT=0 关闭脱敏（记录完整内容）')
    assert.strictEqual(resolveRedacted({ DSH_DUPGUARD_STOP_LOG_REDACT: 'off' }), false, 'REDACT=off 关闭脱敏')
    assert.strictEqual(resolveRedacted({}), true, '默认脱敏（隐私优先）')
  })

  await test('写入 JSONL：字段完整、params 为命中时快照', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'stops.jsonl')
    const logger = createStopLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: file }) })
    assert.strictEqual(logger.enabled, true)
    assert.strictEqual(logger.filePath, path.resolve(file))
    const wrote = logger.record(sampleHit, { sessionId: 12345, provider: 'deepseek-official', model: 'deepseek-flash' }, {
      runtime: sampleRuntime,
      sessionTitle: '测试会话',
      workspacePath: 'D:\\Work\\Demo',
      workspaceTitle: 'Demo 工作区',
      decision: 'auto',
      heldMs: 1216,
    })
    assert.strictEqual(wrote, true)
    const records = readRecords(file)
    assert.strictEqual(records.length, 1)
    const record = records[0]
    assert.match(record.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'time 应为 ISO 时间')
    assert.strictEqual(record.version, pkg.version)
    assert.strictEqual(record.sessionId, '12345', 'sessionId 统一转字符串')
    assert.strictEqual(record.provider, 'deepseek-official')
    assert.strictEqual(record.model, 'deepseek-flash')
    assert.strictEqual(record.sessionTitle, '测试会话')
    assert.strictEqual(record.workspacePath, 'D:\\Work\\Demo')
    assert.strictEqual(record.workspaceTitle, 'Demo 工作区')
    assert.strictEqual(record.unit, 'ab')
    assert.strictEqual(record.unitLength, 2)
    assert.strictEqual(record.count, 10)
    assert.strictEqual(record.span, 20)
    assert.strictEqual(record.code, false)
    assert.strictEqual(record.source, 'text')
    assert.strictEqual(record.decision, 'auto', '应记录决策来源（user/auto/threshold）')
    assert.strictEqual(record.heldMs, 1216, '应记录决策等待时长')
    assert.strictEqual(record.time !== undefined, true)
    assert.strictEqual(record.redacted, false, 'REDACT=0 时为完整内容模式')
    assert.strictEqual(record.params.threshold, 10)
    assert.deepStrictEqual(record.params.ignoredChars, ['-', '|'])
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'POSIX 上日志文件权限应为 0600')
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, 'POSIX 上日志目录权限应为 0700')
    }
    removeDir(dir)
  })

  await test('允许继续写入 allows.jsonl：字段与 stops.jsonl 相同，decision=allowed', () => {
    const dir = tmpDir()
    const stopsFile = path.join(dir, 'stops.jsonl')
    const logger = createAllowLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: stopsFile }) })
    assert.strictEqual(logger.enabled, true)
    assert.strictEqual(logger.filePath, path.join(dir, 'allows.jsonl'))
    assert.strictEqual(logger.record(sampleHit, { sessionId: 'allow-1', provider: 'ollama', model: 'gemma4:12b' }, {
      runtime: sampleRuntime,
      sessionTitle: '允许继续会话',
      workspacePath: 'D:\\Work\\Allow',
      workspaceTitle: 'Allow 工作区',
      decision: 'allowed',
      heldMs: 432,
    }), true)
    assert.strictEqual(fs.existsSync(stopsFile), false, '允许继续不应写 stops.jsonl')
    const records = readRecords(path.join(dir, 'allows.jsonl'))
    assert.strictEqual(records.length, 1)
    const record = records[0]
    assert.strictEqual(record.decision, 'allowed')
    assert.strictEqual(record.heldMs, 432)
    assert.strictEqual(record.sessionId, 'allow-1')
    assert.strictEqual(record.provider, 'ollama')
    assert.strictEqual(record.model, 'gemma4:12b')
    assert.strictEqual(record.unit, 'ab')
    assert.strictEqual(record.count, 10)
    assert.strictEqual(record.span, 20)
    assert.strictEqual(record.version, pkg.version)
    assert.strictEqual(record.redacted, false)
    removeDir(dir)
  })

  await test('允许继续日志同样受 persistStopLog 与 off 开关控制', () => {
    const dir = tmpDir()
    const stopsFile = path.join(dir, 'stops.jsonl')
    const logger = createAllowLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: stopsFile }) })
    assert.strictEqual(logger.record(sampleHit, {}, { runtime: { persistStopLog: false }, decision: 'allowed' }), false, '设置关闭时允许继续也不应写盘')
    assert.strictEqual(fs.existsSync(logger.filePath), false)
    const offLogger = createAllowLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: 'off' }) })
    assert.strictEqual(offLogger.enabled, false)
    assert.strictEqual(offLogger.record(sampleHit, {}, { decision: 'allowed' }), false)
    removeDir(dir)
  })

  await test('集成：点击允许继续 → 写 allows.jsonl，不写 stops.jsonl', async () => {
    const dir = tmpDir()
    const stopsFile = path.join(dir, 'stops.jsonl')
    const allowsFile = path.join(dir, 'allows.jsonl')
    const previous = process.env.DSH_DUPGUARD_STOP_LOG
    const previousProfileDir = process.env.DSH_PROFILE_DIR
    process.env.DSH_DUPGUARD_STOP_LOG = stopsFile
    process.env.DSH_PROFILE_DIR = path.join(dir, 'no-profile')
    try {
      let route = null
      const { ctx, listeners } = makeCtx({
        webServer: { register: (registered) => { route = registered; return () => {} } },
        settings: { configure: () => () => {} },
      })
      plugin.apply(ctx, {})
      const upstream = makeUpstream(textChunks(0, 'ab'.repeat(12)))
      const wrapped = listeners['llm/stream']({ sessionId: 'sess-allow-log', provider: 'test-provider', model: 'test-model' }, () => upstream.iterator)
      const iterator = wrapped[Symbol.asyncIterator]()
      let decision = null
      for (let i = 0; i < 40; i++) {
        const result = await iterator.next()
        if (result.done === true) throw new Error('流在触发决策前结束')
        const items = await listNotices(route)
        decision = items.find((item) => item.kind === 'decision')
        if (decision !== undefined) break
      }
      assert.ok(decision !== undefined && decision !== null, '应出现决策卡片')
      const action = await callRoute(route, 'POST', '/dsh-dupguard/notifications/action', { id: decision.id, action: 'allow-repeat' })
      assert.strictEqual(action.status, 200)
      for (;;) {
        const result = await iterator.next()
        if (result.done === true) break
      }
      assert.strictEqual(fs.existsSync(stopsFile), false, '允许继续不应写 stops.jsonl')
      const records = readRecords(allowsFile)
      assert.strictEqual(records.length, 1, '一次允许继续应写一条 allows 记录')
      assert.strictEqual(records[0].decision, 'allowed')
      assert.strictEqual(records[0].sessionId, 'sess-allow-log')
      assert.strictEqual(records[0].provider, 'test-provider')
      assert.strictEqual(records[0].model, 'test-model')
      assert.strictEqual(records[0].count, 10)
      assert.ok(Number.isSafeInteger(records[0].heldMs))
    } finally {
      process.env.DSH_DUPGUARD_STOP_LOG = previous
      if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
      else process.env.DSH_PROFILE_DIR = previousProfileDir
      removeDir(dir)
    }
  })

  await test('脱敏模式 REDACT=1：不写重复内容/会话标题/工作区路径', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'stops.jsonl')
    const logger = createStopLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: file, DSH_DUPGUARD_STOP_LOG_REDACT: '1' }) })
    assert.strictEqual(logger.record({ ...sampleHit, unit: '敏感片段' }, { sessionId: 's1', provider: 'p', model: 'm' }, {
      runtime: { ...sampleRuntime, advancedThresholdFile: 'D:\\private\\rule.js', ignoredSubstrings: ['内部代号'] },
      sessionTitle: '敏感会话',
      workspacePath: 'D:\\私密项目',
      workspaceTitle: '私密工作区',
    }), true)
    const record = readRecords(file)[0]
    assert.strictEqual(record.redacted, true)
    assert.strictEqual(record.unit, null, '脱敏模式不写重复内容')
    assert.strictEqual(record.unitLength, 4, '保留长度信息')
    assert.strictEqual(record.truncated, false)
    assert.strictEqual(record.sessionTitle, null)
    assert.strictEqual(record.workspacePath, null)
    assert.strictEqual(record.workspaceTitle, null)
    assert.strictEqual(record.params.advancedThresholdFile, undefined, '高级模块路径不写')
    assert.strictEqual(record.params.ignoredSubstrings, undefined, '白名单内容不写')
    assert.strictEqual(record.params.ignoredSubstringsCount, 1, '白名单只保留数量')
    assert.strictEqual(record.params.threshold, 10)
    assert.strictEqual(record.count, 10)
    removeDir(dir)
  })

  await test('未设置 REDACT 时默认脱敏（隐私优先）', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'stops.jsonl')
    // 只给日志路径、不给 REDACT：默认应脱敏。
    const logger = createStopLogger({ env: { DSH_DUPGUARD_STOP_LOG: file } })
    assert.strictEqual(logger.record({ ...sampleHit, unit: '默认应隐藏' }, { sessionId: 's1' }, {
      runtime: sampleRuntime,
      sessionTitle: '默认应隐藏的标题',
      workspacePath: 'D:\\默认应隐藏的路径',
    }), true)
    const record = readRecords(file)[0]
    assert.strictEqual(record.redacted, true)
    assert.strictEqual(record.unit, null)
    assert.strictEqual(record.sessionTitle, null)
    assert.strictEqual(record.workspacePath, null)
    assert.strictEqual(record.unitLength, 5)
    removeDir(dir)
  })

  await test('关闭时不创建文件、不写盘', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'off.jsonl')
    const logger = createStopLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: 'off' }) })
    assert.strictEqual(logger.enabled, false)
    assert.strictEqual(logger.record(sampleHit, {}, {}), false)
    assert.strictEqual(fs.existsSync(file), false)
    removeDir(dir)
  })

  await test('过长的 unit 截断到 200 字符并标记 truncated', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'stops.jsonl')
    const logger = createStopLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: file }) })
    const unit = 'x'.repeat(500)
    assert.strictEqual(logger.record({ unit, count: 10, span: 5000, source: 'text' }, {}, {}), true)
    const record = readRecords(file)[0]
    assert.strictEqual(record.unit.length, 200)
    assert.strictEqual(record.unitLength, 500)
    assert.strictEqual(record.truncated, true)
    removeDir(dir)
  })

  await test('超过 maxBytes 自动轮转为 stops.jsonl.1', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'stops.jsonl')
    const logger = createStopLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: file }), maxBytes: 2000 })
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(logger.record({ unit: 'y'.repeat(100), count: 10, span: 1000, source: 'text' }, {}, {}), true)
    }
    assert.strictEqual(fs.existsSync(file), true, '当前文件应存在')
    assert.strictEqual(fs.existsSync(file + '.1'), true, '应轮转出 .1 历史文件')
    const first = readRecords(file + '.1')
    const second = readRecords(file)
    assert.ok(first.length >= 1 && second.length >= 1, '两个文件都应包含记录')
    assert.strictEqual(first.length + second.length, 6, '轮转不应丢记录')
    assert.ok(first[0].unit.length === 100)
    removeDir(dir)
  })

  await test('设置项 persistStopLog=false 时不写盘（环境变量仍为总开关）', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'stops.jsonl')
    const logger = createStopLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: file }) })
    assert.strictEqual(logger.record(sampleHit, {}, { runtime: { persistStopLog: false } }), false, '设置关闭应返回 false')
    assert.strictEqual(fs.existsSync(file), false, '设置关闭时不应创建文件')
    assert.strictEqual(logger.record(sampleHit, {}, { runtime: { persistStopLog: true } }), true, '设置开启时应正常写入')
    assert.strictEqual(readRecords(file).length, 1)
    removeDir(dir)
  })

  await test('写盘失败静默降级：record 返回 false、不抛异常', () => {
    const dir = tmpDir()
    const logger = createStopLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: dir }) }) // 路径是目录 → append 必然失败
    assert.strictEqual(logger.enabled, true)
    assert.strictEqual(logger.record(sampleHit, {}, {}), false)
    removeDir(dir)
  })

  await test('集成：apply 真实截停 → 写入 JSONL；设置关闭时不新增', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'stops.jsonl')
    const previous = process.env.DSH_DUPGUARD_STOP_LOG
    const previousProfileDir = process.env.DSH_PROFILE_DIR
    process.env.DSH_DUPGUARD_STOP_LOG = file
    // 隔离真实 profile：避免 Config 分支读取开发机上的 cordis.patch.yml。
    process.env.DSH_PROFILE_DIR = path.join(dir, 'no-profile')
    try {
      const { ctx, listeners } = makeCtx({})
      plugin.apply(ctx, {})
      const streamOptions = { sessionId: 'sess-stoplog-1', provider: 'test-provider', model: 'test-model' }
      const upstream = makeUpstream(textChunks(0, 'ab'.repeat(12)))
      const wrapped = listeners['llm/stream'](streamOptions, () => upstream.iterator)
      for await (const _chunk of wrapped) void _chunk
      const records = readRecords(file)
      assert.strictEqual(records.length, 1, '一次截停应写一条记录')
      assert.strictEqual(records[0].sessionId, 'sess-stoplog-1')
      assert.strictEqual(records[0].provider, 'test-provider')
      assert.strictEqual(records[0].model, 'test-model')
      assert.strictEqual(records[0].unit, 'ab')
      assert.strictEqual(records[0].count, 10)
      assert.strictEqual(records[0].version, pkg.version)

      // 设置页关闭 persistStopLog（走插件 Config 分支）→ 不再新增记录。
      const second = makeCtx({ settings: {} })
      plugin.apply(second.ctx, { persistStopLog: false })
      const upstream2 = makeUpstream(textChunks(0, 'cd'.repeat(12)))
      const wrapped2 = second.listeners['llm/stream']({ sessionId: 'sess-stoplog-2', provider: 'p2', model: 'm2' }, () => upstream2.iterator)
      for await (const _chunk of wrapped2) void _chunk
      assert.strictEqual(readRecords(file).length, 1, 'persistStopLog=false 时不应写第二条')
    } finally {
      process.env.DSH_DUPGUARD_STOP_LOG = previous
      if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
      else process.env.DSH_PROFILE_DIR = previousProfileDir
      removeDir(dir)
    }
  })

  await test('stopLogFullContent：设置页开关动态控制脱敏，环境变量优先级更高', () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, 'stops.jsonl')
      const env = { DSH_DUPGUARD_STOP_LOG: file }
      const logger = createStopLogger({ env })
      logger.record({ unit: 'ab', count: 10, span: 20, source: 'text' }, {}, {
        runtime: { persistStopLog: true, stopLogFullContent: false },
        sessionTitle: 'title', workspacePath: 'D:\\w', workspaceTitle: 'w',
      })
      logger.record({ unit: 'ab', count: 10, span: 20, source: 'text' }, {}, {
        runtime: { persistStopLog: true, stopLogFullContent: true },
        sessionTitle: 'title', workspacePath: 'D:\\w', workspaceTitle: 'w',
      })
      const records = readRecords(file)
      assert.strictEqual(records[0].redacted, true, '默认（设置关闭）应脱敏')
      assert.strictEqual(records[0].unit, null)
      assert.strictEqual(records[1].redacted, false, '设置开启应写完整内容')
      assert.strictEqual(records[1].unit, 'ab')
      assert.strictEqual(records[1].sessionTitle, 'title')
      // 环境变量显式脱敏时，即使设置页开启也优先脱敏。
      const envRedact = { DSH_DUPGUARD_STOP_LOG: file, DSH_DUPGUARD_STOP_LOG_REDACT: '1' }
      const forced = createStopLogger({ env: envRedact })
      forced.record({ unit: 'cd', count: 10, span: 20, source: 'text' }, {}, {
        runtime: { persistStopLog: true, stopLogFullContent: true },
        sessionTitle: 'title', workspacePath: 'D:\\w', workspaceTitle: 'w',
      })
      assert.strictEqual(readRecords(file)[2].redacted, true, 'REDACT=1 必须覆盖设置页')
    } finally {
      removeDir(dir)
    }
  })

  await test('readRecentLogs：stops/allows 双列表 + 当前脱敏状态清洗旧完整记录', () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, 'stops.jsonl')
      const env = { DSH_DUPGUARD_STOP_LOG: file }
      const stopLogger = createStopLogger({ env })
      const allowLogger = createAllowLogger({ env })
      const record = { unit: 'ef', count: 10, span: 20, source: 'text' }
      const extra = { runtime: { persistStopLog: true, stopLogFullContent: true }, sessionTitle: 't', workspacePath: 'D:\\w', workspaceTitle: 'w' }
      stopLogger.record(record, {}, { ...extra, decision: 'auto', heldMs: 100 })
      allowLogger.record(record, {}, { ...extra, decision: 'allowed', heldMs: 250 })
      const detail = readRecentLogs({ env, runtime: { persistStopLog: true, stopLogFullContent: true }, limit: 5 })
      assert.strictEqual(detail.enabled, true)
      assert.strictEqual(detail.detailed, true)
      assert.strictEqual(detail.stops[0].unit, 'ef')
      assert.strictEqual(detail.stops[0].decision, 'auto')
      assert.strictEqual(detail.allows[0].decision, 'allowed')
      const redacted = readRecentLogs({ env, runtime: { persistStopLog: true, stopLogFullContent: false }, limit: 5 })
      assert.strictEqual(redacted.enabled, true)
      assert.strictEqual(redacted.detailed, false)
      assert.strictEqual(redacted.stops[0].unit, null, '旧完整记录在当前脱敏模式下必须隐藏')
      assert.strictEqual(redacted.stops[0].sessionTitle, null)
      assert.strictEqual(redacted.allows[0].unit, null)
      const disabled = readRecentLogs({ env, runtime: { persistStopLog: false, stopLogFullContent: true }, limit: 5 })
      assert.strictEqual(disabled.enabled, false)
      assert.strictEqual(disabled.reason, 'settings-off')
    } finally {
      removeDir(dir)
    }
  })

  await test('DSH 0.2.2 兼容：schema 就绪后回填 runtime.Config', () => {
    // DSH 0.2.2 的 loader 只读一次 Config；这里模拟运行中的 fiber runtime 初始为空，
    // plugin.apply 应在 schema 可用时把真实的 28 字段 schema 写回 runtime.Config。
    const { ctx } = makeCtx({})
    ctx.fiber = { runtime: { Config: undefined } }
    plugin.apply(ctx, {})
    assert.strictEqual(typeof ctx.fiber.runtime.Config, 'function')
    assert.strictEqual(Object.keys(ctx.fiber.runtime.Config.dict).length, 28)
  })

  console.log('')
  console.log('全部通过：' + String(report.passed) + ' 项（截停持久化日志）')
  report.summary()
}

main().catch((error) => {
  console.error('截停持久化日志测试无法运行：', error)
  process.exitCode = 1
})
