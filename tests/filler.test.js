'use strict'

// ============================================================================
// dupguard 思维链填充词提醒测试
//
// 覆盖：列表解析/词边界/非重叠计数、频率阈值、窗口复用、只检测 reasoning、
// 默认关闭、同 chunk 普通重复优先（不产生 filler 提醒）。
// ============================================================================

const assert = require('node:assert')
const engine = require('../lib/engine.js')
const { createReport } = require('./helpers/report.cjs')

const report = createReport()
const { test } = report

function makeRuntime(overrides) {
  return {
    ...engine.DEFAULT_CONFIG,
    threshold: 1000,
    minUnitLength: 1,
    maxUnitLength: 80,
    detectionWindow: 500,
    thresholdMode: 'simple',
    thresholdPolicy: undefined,
    codeThresholdPolicy: undefined,
    ignoredChars: [],
    ignoredSubstrings: [],
    stripWhitespace: false,
    skipCodeBlocks: false,
    monitorReasoning: true,
    monitorReasoningFillers: true,
    reasoningFillerPatterns: 'hmm, wait, hold on',
    reasoningFillerThresholdPerK: 40,
    ...overrides,
  }
}

function chunks(text, blockType, extraParts) {
  return [
    { type: 'block-start', index: 0, blockType },
    { type: blockType === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: 0, text },
    ...(extraParts === undefined ? [] : extraParts),
    { type: 'block-end', index: 0, block: { type: blockType, text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function runGuard(text, runtime, blockType) {
  const alerts = []
  const seen = []
  const guard = engine.createStreamGuard({ provider: 'test', model: 'm' }, runtime, {
    onReasoningFiller: (payload) => alerts.push(payload),
  })
  const source = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks(text, blockType === undefined ? 'reasoning' : blockType)) {
        seen.push(chunk)
        yield chunk
      }
    },
  }
  for await (const chunk of guard(source)) void chunk
  return { alerts, seen }
}

async function main() {
  console.log('dupguard 思维链填充词提醒测试')

  await test('列表解析：分隔符/大小写去重/空列表', () => {
    assert.strictEqual(engine.DEFAULT_CONFIG.reasoningFillerThresholdPerK, 40, '默认频率阈值应为 40/千字符')
    assert.deepStrictEqual(engine.parseReasoningFillerPatterns('hmm, Wait，HOLD ON; hmm'), ['hmm', 'Wait', 'HOLD ON'])
    assert.deepStrictEqual(engine.parseReasoningFillerPatterns(' , ;\n'), [])
    assert.deepStrictEqual(engine.normalizeReasoningFillerPatterns('', 'hmm'), '')
    assert.strictEqual(engine.normalizeReasoningFillerPatterns(undefined, 'hmm'), 'hmm')
  })

  await test('计数：大小写不敏感、词边界、非重叠；await 不命中 wait', () => {
    assert.strictEqual(engine.countReasoningFillerOccurrences('Hmm hmm HMM', 'hmm'), 3)
    assert.strictEqual(engine.countReasoningFillerOccurrences('await wait wait', 'wait'), 2)
    assert.strictEqual(engine.countReasoningFillerOccurrences('hmmmm', 'hmm'), 0)
    assert.strictEqual(engine.countReasoningFillerOccurrences('hold on, hold on', 'hold on'), 2)
  })

  await test('频率达到阈值只提醒一次，不截停', async () => {
    const text = 'hmm '.repeat(20) + 'The parser, schema, and cache are all consistent. '.repeat(5)
    const { alerts } = await runGuard(text, makeRuntime())
    assert.strictEqual(alerts.length, 1, '应只提醒一次')
    assert.deepStrictEqual(alerts[0].hits.map((hit) => hit.pattern), ['hmm'])
    assert.ok(alerts[0].hits[0].count >= 10)
    assert.strictEqual(alerts[0].source, 'reasoning')
    assert.ok(alerts[0].observedChars >= 200)
    // 没有正常截停：所有 chunk 都应该被消费完。
    assert.ok(alerts[0].windowChars === 500)
  })

  await test('低于阈值/关闭开关/关闭 reasoning 均不提醒', async () => {
    const text = 'hmm '.repeat(19) + 'The parser, schema, and cache are all consistent. '.repeat(5)
    assert.strictEqual((await runGuard(text, makeRuntime({ reasoningFillerThresholdPerK: 1000 }))).alerts.length, 0)
    assert.strictEqual((await runGuard(text, makeRuntime({ monitorReasoningFillers: false }))).alerts.length, 0)
    assert.strictEqual((await runGuard(text, makeRuntime({ monitorReasoning: false }))).alerts.length, 0)
  })

  await test('只检测列表内容；可见正文不触发', async () => {
    const text = 'hmm '.repeat(20) + 'The parser, schema, and cache are all consistent. '.repeat(5)
    const { alerts } = await runGuard(text, makeRuntime({ reasoningFillerPatterns: 'wait, hold on' }))
    assert.strictEqual(alerts.length, 0, '列表外 hmm 不应触发')
    const visible = await runGuard(text, makeRuntime(), 'text')
    assert.strictEqual(visible.alerts.length, 0, '可见正文不应触发 reasoning filler')
  })

  await test('同一 chunk 普通重复优先：不产生填充词提醒', async () => {
    const repeated = 'ab'.repeat(1200)
    const text = 'hmm '.repeat(20) + repeated
    const { alerts } = await runGuard(text, makeRuntime({ threshold: 3, detectionWindow: 500 }))
    assert.strictEqual(alerts.length, 0, '普通重复命中同一 chunk 时不发 filler 提醒')
  })

  await test('不足最小样本不判断', async () => {
    const text = 'hmm '.repeat(20)
    const { alerts } = await runGuard(text, makeRuntime())
    assert.strictEqual(alerts.length, 0, '少于 200 字符不应判断')
  })

  console.log('')
  console.log('全部通过：' + String(report.passed) + ' 项（思维链填充词提醒）')
  report.summary()
}

main().catch((error) => {
  console.error('思维链填充词测试无法运行：', error)
  process.exitCode = 1
})
