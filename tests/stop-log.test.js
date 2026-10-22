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

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createStopLogger, resolveLogFile } = require('../lib/stop-log.js')
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
    const custom = path.join(tmpDir(), 'custom.jsonl')
    assert.strictEqual(resolveLogFile({ DSH_DUPGUARD_STOP_LOG: custom }), path.resolve(custom), '显式路径优先')
    assert.strictEqual(resolveLogFile({ DSH_DUPGUARD_STOP_LOG: 'off' }), null, 'off 关闭')
    assert.strictEqual(resolveLogFile({ DSH_DUPGUARD_STOP_LOG: '0' }), null, '0 关闭')
    assert.strictEqual(resolveLogFile({ DSH_DUPGUARD_STOP_LOG: 'false' }), null, 'false 关闭')
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
    assert.strictEqual(record.params.threshold, 10)
    assert.deepStrictEqual(record.params.ignoredChars, ['-', '|'])
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
    const logger = createStopLogger({ env: envWith({ DSH_DUPGUARD_STOP_LOG: file }), maxBytes: 900 })
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

  console.log('')
  console.log('全部通过：' + String(report.passed) + ' 项（截停持久化日志）')
  report.summary()
}

main().catch((error) => {
  console.error('截停持久化日志测试无法运行：', error)
  process.exitCode = 1
})
