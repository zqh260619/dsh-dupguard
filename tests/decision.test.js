'use strict'

// ============================================================================
// 阈值决策窗口（方案 B）——引擎状态机测试
//
// 直接驱动 createStreamGuard，覆盖：
//   - 无决策钩子时维持「阈值即停」；
//   - 阈值命中暂停拉取上游，用户 stop / allow / continue；
//   - continue 后达到「阈值 × 倍数」自动截停；
//   - 重复中断（recovered）与块结束；
//   - 检测窗口不足时的回退；
//   - 决策钩子异常时的安全回退。
// ============================================================================

const assert = require('node:assert')
const engine = require('../lib/engine.js')
const report = require('./helpers/report.cjs').createReport()
const { test } = report

const DEFAULT_CONFIG = engine.DEFAULT_CONFIG

function makeRuntime(overrides) {
  return {
    ...DEFAULT_CONFIG,
    threshold: 3,
    minUnitLength: 1,
    maxUnitLength: 20,
    detectionWindow: 8192,
    thresholdMode: 'simple',
    ignoredChars: [],
    ignoredSubstrings: [],
    stripWhitespace: true,
    skipCodeBlocks: false,
    monitorReasoning: true,
    monitorToolArguments: false,
    stopDecision: true,
    decisionTimeoutMs: 4000,
    stopAtMultiplier: 2,
    ...overrides,
  }
}

function makeChunks(parts) {
  const text = parts.join('')
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...parts.map((part) => ({ type: 'text-delta', index: 0, text: part })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 可控上游：记录拉取次数与是否被 return()，用于验证暂停时确实不再拉取。 */
function makeSource(chunks) {
  const state = { closed: false, pulls: 0 }
  let index = 0
  const iterator = {
    [Symbol.asyncIterator]() {
      return iterator
    },
    next() {
      state.pulls += 1
      if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined })
      return Promise.resolve({ done: false, value: chunks[index++] })
    },
    return() {
      state.closed = true
      return Promise.resolve({ done: true, value: undefined })
    },
  }
  return { source: iterator, state }
}

function startGuard(source, runtime, hooks) {
  const guard = engine.createStreamGuard({ provider: 'test', model: 'test-model' }, runtime, hooks)
  return guard(source)[Symbol.asyncIterator]()
}

async function nextWithWait(iterator, waitMs) {
  let settled = false
  const promise = iterator.next().then((result) => {
    settled = true
    return result
  })
  await new Promise((resolve) => setTimeout(resolve, waitMs === undefined ? 80 : waitMs))
  if (!settled) return { pending: true, promise }
  return { pending: false, result: await promise }
}

async function drain(iterator) {
  const chunks = []
  for (;;) {
    const result = await iterator.next()
    if (result.done) return chunks
    chunks.push(result.value)
  }
}

function deferredDecision() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function main() {
  console.log('dupguard 阈值决策窗口测试（引擎）')

  await test('无决策钩子：保持阈值即停（旧行为）', async () => {
    const { source, state } = makeSource(makeChunks(['abcabcabc', 'tail']))
    const stops = []
    const iterator = startGuard(source, makeRuntime(), { onStop: (hit, meta) => stops.push({ hit, meta }) })
    const chunks = await drain(iterator)
    assert.strictEqual(stops.length, 1, '应只截停一次')
    assert.strictEqual(stops[0].hit.count, 3)
    assert.strictEqual(stops[0].meta.decision, 'threshold')
    assert.strictEqual(state.closed, true, '应关闭上游')
    assert.strictEqual(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'tail'), false, '命中后的上游内容不应继续输出')
    assert.strictEqual(chunks[chunks.length - 1].type, 'finish')
  })

  await test('阈值命中暂停：用户 stop 立即收尾，暂停期间不再拉取上游', async () => {
    const { source, state } = makeSource(makeChunks(['abcabcabc', 'tail']))
    const decision = deferredDecision()
    const stops = []
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => decision.promise,
    })
    const first = await iterator.next()
    assert.strictEqual(first.value.type, 'block-start')
    const second = await iterator.next()
    assert.strictEqual(second.value.type, 'text-delta')
    const pullsAtPause = source ? state.pulls : 0
    const paused = await nextWithWait(iterator, 80)
    assert.strictEqual(paused.pending, true, '阈值后应暂停等待决策')
    assert.strictEqual(state.pulls, pullsAtPause, '暂停期间不得继续拉取上游')
    decision.resolve('stop')
    const closing = await paused.promise
    assert.strictEqual(closing.value.type, 'block-end')
    await drain(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'user')
    assert.strictEqual(state.closed, true)
  })

  await test('用户 allow：本次调用不再检测，正常透传剩余内容', async () => {
    const { source, state } = makeSource(makeChunks(['abcabcabc', 'abcabcabcabc', 'tail']))
    const decision = deferredDecision()
    let thresholdCalls = 0
    const stops = []
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => {
        thresholdCalls += 1
        return decision.promise
      },
    })
    await iterator.next()
    await iterator.next()
    const paused = await nextWithWait(iterator, 80)
    assert.strictEqual(paused.pending, true)
    decision.resolve('allow')
    const rest = await drain(iterator)
    assert.strictEqual(thresholdCalls, 1, 'allow 后不应再触发新的阈值决策')
    assert.strictEqual(stops.length, 0, 'allow 后不应截停')
    assert.strictEqual(rest[rest.length - 1].type, 'finish', '上游自然结束')
    assert.strictEqual(state.closed, false, '上游自然结束（不是被 return）')
  })

  await test('决策超时 continue：达到阈值 × 2 时自动截停', async () => {
    const { source, state } = makeSource(makeChunks(['abcabcabc', 'abcabcabc', 'tail']))
    const decision = deferredDecision()
    const stops = []
    const iterator = startGuard(source, makeRuntime({ stopAtMultiplier: 2 }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => decision.promise,
    })
    await iterator.next()
    await iterator.next()
    const paused = await nextWithWait(iterator, 80)
    assert.strictEqual(paused.pending, true)
    decision.resolve('continue')
    // 第二个 delta 后实际重复 6 次 = 3 × 2 → 自动截停
    const closingOrChunk = await paused.promise
    assert.strictEqual(closingOrChunk.value.type, 'text-delta', '先透传第二个 delta')
    const next = await iterator.next()
    assert.strictEqual(next.value.type, 'block-end', '随后补齐闭合块')
    await drain(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].hit.count, 6, '自动截停时应记录实际重复次数')
    assert.strictEqual(stops[0].meta.decision, 'auto')
    assert.strictEqual(state.closed, true)
  })

  await test('continue 后重复中断：标记 recovered，不截停', async () => {
    const { source } = makeSource(makeChunks(['abcabcabc', 'XYZ', 'tail']))
    const decision = deferredDecision()
    const stops = []
    const settled = []
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => decision.promise,
      onThresholdSettled: (hit, outcome) => settled.push({ hit, outcome }),
    })
    await iterator.next()
    await iterator.next()
    const paused = await nextWithWait(iterator, 80)
    assert.strictEqual(paused.pending, true)
    decision.resolve('continue')
    await paused.promise
    await drain(iterator)
    assert.strictEqual(stops.length, 0, '重复中断后不应截停')
    assert.ok(settled.some((event) => event.outcome === 'recovered'), '应通知宿主已恢复')
  })

  await test('块结束仍未达倍数：标记 expired，不截停', async () => {
    const { source } = makeSource(makeChunks(['abcabcabc']))
    const decision = deferredDecision()
    const settled = []
    const stops = []
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => decision.promise,
      onThresholdSettled: (hit, outcome) => settled.push({ hit, outcome }),
    })
    await iterator.next()
    await iterator.next()
    const paused = await nextWithWait(iterator, 80)
    assert.strictEqual(paused.pending, true)
    decision.resolve('continue')
    await paused.promise // block-end
    await drain(iterator)
    assert.strictEqual(stops.length, 0)
    assert.ok(settled.some((event) => event.outcome === 'expired' || event.outcome === 'recovered'), '应通知宿主决策已结束')
  })

  await test('检测窗口不足以观察倍数：直接阈值即停（不暂停）', async () => {
    const { source } = makeSource(makeChunks(['aaa']))
    let thresholdCalls = 0
    const stops = []
    const iterator = startGuard(source, makeRuntime({ detectionWindow: 5 }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => {
        thresholdCalls += 1
        return Promise.resolve('continue')
      },
    })
    await drain(iterator)
    assert.strictEqual(thresholdCalls, 0, '窗口不足时不应暂停等待')
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'threshold')
  })

  await test('决策钩子抛错：回退为直接截停', async () => {
    const { source } = makeSource(makeChunks(['abcabcabc', 'tail']))
    const stops = []
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => {
        throw new Error('boom')
      },
    })
    await drain(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'user')
  })

  await test('自定义倍数（3 倍）：达到阈值 × 3 才自动截停', async () => {
    const { source } = makeSource(makeChunks(['abcabcabc', 'abcabcabc', 'abcabcabc']))
    const decision = deferredDecision()
    const stops = []
    const iterator = startGuard(source, makeRuntime({ stopAtMultiplier: 3 }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => decision.promise,
    })
    await iterator.next()
    await iterator.next()
    const paused = await nextWithWait(iterator, 80)
    decision.resolve('continue')
    const secondDelta = await paused.promise
    assert.strictEqual(secondDelta.value.type, 'text-delta')
    const third = await iterator.next()
    assert.strictEqual(third.value.type, 'text-delta', '第二次恢复后仍不应截停（6 < 9）')
    await drain(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].hit.count, 9)
    assert.strictEqual(stops[0].meta.decision, 'auto')
  })

  console.log('')
  console.log('全部通过：' + String(report.passed) + ' 项（阈值决策窗口）')
  report.summary()
}

main().catch((error) => {
  console.error('阈值决策窗口测试无法运行：', error)
  process.exitCode = 1
})
