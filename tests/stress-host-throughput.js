'use strict'

// ============================================================================
// dupguard 宿主端吞吐 / 内存 / 并发压力测试
//
// 覆盖：增量粒度吞吐、最坏情况扫描、命中延迟、长流内存、200 路并发隔离、
//       参数极值。指标以 `METRIC <name> <value> <unit>` 输出，便于横向比较。
// 运行：node tests/stress-host-throughput.js
// ============================================================================

const assert = require('assert')
const path = require('path')

let failed = 0
const ok = (label) => console.log('  ✓ ' + label)
const bad = (label, detail) => {
  failed++
  console.log('  ✗ FAIL ' + label + '：' + detail)
}
const metric = (name, value, unit) => console.log('METRIC ' + name + ' ' + String(value) + ' ' + unit)

/** 确定性 PRNG（mulberry32）：用于生成无重复噪声文本。 */
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- 测试桩
function createHarness() {
  const listeners = {}
  const watchers = []
  let current = null
  const settingsStub = {
    register(ns, schema, options) {
      current = { ...options.base, ignoredChars: [...options.base.ignoredChars] }
      return {
        get: () => current,
        watch(cb) {
          watchers.push(cb)
          return () => {}
        },
        update() {},
        replace() {},
      }
    },
  }
  const ctx = {
    get: () => undefined,
    settings: settingsStub,
    inject: (keys, callback) => callback(ctx),
    on: (name, fn) => {
      listeners[name] = fn
      return () => {}
    },
    effect: () => () => {},
  }
  require(path.join(__dirname, '..', 'lib', 'index.js')).apply(ctx)
  return {
    listeners,
    ready: () => watchers.length > 0,
    apply(patch) {
      current = { ...current, ...patch }
      for (const cb of watchers) cb()
    },
  }
}

/** 动态生成 chunk 的上游（避免为百万级增量预先建数组）。 */
function makeGeneratedUpstream(makeChunk, count) {
  let closed = 0
  let pulled = 0
  async function* raw() {
    for (let index = 0; index < count; index++) {
      pulled++
      yield makeChunk(index)
    }
  }
  const gen = raw()
  const iterator = {
    [Symbol.asyncIterator]() {
      return iterator
    },
    next() {
      return gen.next()
    },
    return() {
      closed++
      return gen.return()
    },
  }
  return { iterator, closedCount: () => closed, pulledCount: () => pulled }
}

async function main() {
  const harness = createHarness()
  for (let i = 0; i < 200 && !harness.ready(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(harness.ready(), '设置注册应完成')
  const guard = harness.listeners['llm/stream']

  /** 驱动一次守卫：不保留输出（避免内存噪声），只统计 chunk 数与是否截停。 */
  const drive = async (chunks, count, options = {}) => {
    const upstream = makeGeneratedUpstream(chunks, count)
    const wrapped = guard({ provider: 'stress', model: 'm' }, () => upstream.iterator)
    let emitted = 0
    let chars = 0
    let triggerChars = null
    const startedAt = process.hrtime.bigint()
    for await (const chunk of wrapped) {
      emitted++
      if (typeof chunk.text === 'string') chars += chunk.text.length
      if (triggerChars === null && chunk.type === 'finish') triggerChars = chars
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    return { emitted, chars, elapsedMs, closed: upstream.closedCount(), pulled: upstream.pulledCount(), triggerChars }
  }

  console.log('dupguard 吞吐/内存/并发压力测试')

  // ---- 1. 吞吐：1 字符 / 4 字符 / 1KB 增量，两个窗口 ----
  const throughputCases = [
    { label: '1char', size: 1, totalChars: 100000 },
    { label: '4char', size: 4, totalChars: 400000 },
    { label: '1kb', size: 1024, totalChars: 1000000 },
  ]
  for (const window of [8192, 1048576]) {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: window, stripWhitespace: true })
    for (const testCase of throughputCases) {
      const random = makeRandom(12345 + testCase.size)
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
      const chunkCount = Math.ceil(testCase.totalChars / testCase.size)
      const makeChunk = (index) => {
        let text = ''
        for (let i = 0; i < testCase.size; i++) text += alphabet[Math.floor(random() * alphabet.length)]
        return { type: 'text-delta', index: 0, text }
      }
      const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }]
      const prefixCount = 1
      const result = await drive(
        (index) => (index < prefixCount ? { type: 'block-start', index: 0, blockType: 'text' } : makeChunk(index)),
        chunkCount + prefixCount,
      )
      const chars = testCase.totalChars
      metric('throughput_' + testCase.label + '_w' + String(window), (chars / result.elapsedMs).toFixed(1), 'chars/ms')
      metric('perchunk_' + testCase.label + '_w' + String(window), ((result.elapsedMs * 1000) / chunkCount).toFixed(2), 'us/chunk')
      metric('elapsed_' + testCase.label + '_w' + String(window), result.elapsedMs.toFixed(1), 'ms')
      if (result.closed !== 1 && result.closed !== 0) {
        bad('throughput_' + testCase.label, 'return() 调用次数异常：' + String(result.closed))
      } else {
        ok('吞吐 ' + testCase.label + '（窗口 ' + String(window) + '）：' + (chars / result.elapsedMs).toFixed(1) + ' chars/ms')
      }
      void chunks
    }
  }

  // ---- 2. 最坏情况：局部高度周期但不构成可重复周期（近失配，不触发）----
  {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192 })
    // 注意：任何周期 ≤ maxUnitLength 的循环重复 10 次都会触发，所以「不触发的近失配」
    // 必须是非周期的：每段 'ab'×9（差一次不到阈值）+ 一个唯一标记，既让尾部保持高度
    // 周期性（内层比较循环跑满），又永远凑不满 10 次重复。
    let counter = 0
    const chunkCount = 100000
    const makeChunk = () => ({
      type: 'text-delta',
      index: 0,
      text: 'ab'.repeat(9) + '(' + (counter++).toString(36) + ')',
    })
    const result = await drive((index) => (index === 0 ? { type: 'block-start', index: 0, blockType: 'text' } : makeChunk()), chunkCount + 1)
    assert.strictEqual(result.closed, 0, '近失配模式不应触发截停')
    metric('worstcase_perchunk', ((result.elapsedMs * 1000) / chunkCount).toFixed(2), 'us/chunk')
    metric('worstcase_elapsed', result.elapsedMs.toFixed(1), 'ms')
    ok('最坏情况扫描（近失配 ' + String(chunkCount) + ' 增量）：' + ((result.elapsedMs * 1000) / chunkCount).toFixed(2) + ' us/chunk')
  }

  // ---- 3. 命中延迟 ----
  {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192 })
    const result = await drive(
      (index) => (index === 0
        ? { type: 'block-start', index: 0, blockType: 'text' }
        : { type: 'text-delta', index: 0, text: 'x'.repeat(4) }),
      8,
    )
    assert.ok(result.triggerChars !== null, '应触发截停')
    assert.ok(result.triggerChars <= 12, '触发时消费的字符数应 ≤ 12（10 次重复 + 一个增量），实际 ' + String(result.triggerChars))
    metric('hit_latency_chars', result.triggerChars, 'chars')
    metric('hit_latency_pulled', result.pulled, 'chunks')
    ok('命中延迟：消费 ' + String(result.triggerChars) + ' 字符即截停（' + String(result.pulled) + ' 个增量）')
  }

  // ---- 4. 长流内存 ----
  {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192 })
    if (global.gc) global.gc()
    const before = process.memoryUsage().heapUsed
    const random = makeRandom(999)
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'
    let peak = before
    const result = await drive(
      (index) => {
        if (index === 0) return { type: 'block-start', index: 0, blockType: 'text' }
        let text = ''
        for (let i = 0; i < 1024; i++) text += alphabet[Math.floor(random() * alphabet.length)]
        const usage = process.memoryUsage().heapUsed
        if (usage > peak) peak = usage
        return { type: 'text-delta', index: 0, text }
      },
      5000,
    )
    const after = process.memoryUsage().heapUsed
    const growthMb = (after - before) / 1048576
    const peakMb = (peak - before) / 1048576
    metric('memory_growth_5m_chars', growthMb.toFixed(1), 'MB')
    metric('memory_peak_5m_chars', peakMb.toFixed(1), 'MB')
    metric('memory_elapsed', result.elapsedMs.toFixed(1), 'ms')
    assert.strictEqual(result.closed, 0, '无重复长流不应触发')
    assert.ok(growthMb < 120, '5M 字符长流的堆增长应 < 120MB（完整文本 + 窗口），实际 ' + growthMb.toFixed(1) + 'MB')
    ok('长流内存：5,000,000 字符堆增长 ' + growthMb.toFixed(1) + 'MB（峰值增量 ' + peakMb.toFixed(1) + 'MB）')
  }

  // ---- 5. 并发隔离 ----
  {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192 })
    const guards = 200
    const startedAt = process.hrtime.bigint()
    const runs = []
    for (let g = 0; g < guards; g++) {
      const repeating = g === 7
      const upstream = makeGeneratedUpstream((index) => {
        if (index === 0) return { type: 'block-start', index: 0, blockType: 'text' }
        if (index >= 400) return { type: 'finish', reason: { kind: 'stop' } }
        // 非复读文本必须非周期：每块带唯一编号，避免 'q0wq1w…' 这类 ≤80 字符的周期。
        return { type: 'text-delta', index: 0, text: repeating ? 'zz' : 'q' + index.toString(36) + 'w' }
      }, 401)
      runs.push((async () => {
        const wrapped = guard({ provider: 'stress', model: 'g' + String(g) }, () => upstream.iterator)
        let emitted = 0
        for await (const _chunk of wrapped) emitted++
        return { emitted, closed: upstream.closedCount() }
      })())
    }
    const results = await Promise.all(runs)
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    const stopped = results.filter((result) => result.closed >= 1).length
    const intact = results.filter((result) => result.closed === 0).length
    metric('concurrency_guards', guards, 'guards')
    metric('concurrency_elapsed', elapsedMs.toFixed(1), 'ms')
    metric('concurrency_stopped', stopped, 'guards')
    metric('concurrency_intact', intact, 'guards')
    assert.strictEqual(stopped, 1, '恰好 1 路应被截停，实际 ' + String(stopped))
    assert.strictEqual(intact, guards - 1, '其余 199 路不应被截停，实际 ' + String(intact))
    ok('并发隔离：' + String(guards) + ' 路并发，1 路复读被截停、其余 ' + String(intact) + ' 路完整（' + elapsedMs.toFixed(1) + 'ms）')
  }

  // ---- 6. 参数极值 ----
  {
    const extremes = [
      { label: 'threshold2', patch: { threshold: 2, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192 } },
      { label: 'threshold1000', patch: { threshold: 1000, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192 } },
      { label: 'unit1', patch: { threshold: 10, minUnitLength: 1, maxUnitLength: 1, detectionWindow: 8192 } },
      { label: 'unit8192', patch: { threshold: 10, minUnitLength: 1, maxUnitLength: 8192, detectionWindow: 1048576 } },
      { label: 'window64', patch: { threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 64 } },
      { label: 'window1m', patch: { threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 1048576 } },
    ]
    const random = makeRandom(4242)
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'
    for (const extreme of extremes) {
      harness.apply({ ignoredChars: [], stripWhitespace: true, ...extreme.patch })
      const result = await drive(
        (index) => {
          if (index === 0) return { type: 'block-start', index: 0, blockType: 'text' }
          if (index >= 2500) return { type: 'finish', reason: { kind: 'stop' } }
          let text = ''
          for (let i = 0; i < 4; i++) text += alphabet[Math.floor(random() * alphabet.length)]
          return { type: 'text-delta', index: 0, text }
        },
        2501,
      )
      metric('extreme_' + extreme.label + '_elapsed', result.elapsedMs.toFixed(1), 'ms')
      metric('extreme_' + extreme.label + '_stopped', result.closed, 'runs')
      // 注意：threshold=2 的语义是「任意两个连续相同字符即截停」，随机文本必然命中，
      // 因此这里只断言「不抛异常 + 上游最多被提前关闭一次」，命中与否由参数语义决定。
      assert.ok(result.closed <= 1, extreme.label + '：return() 调用次数应 ≤ 1，实际 ' + String(result.closed))
      ok('参数极值 ' + extreme.label + '：' + result.elapsedMs.toFixed(1) + 'ms / 10,000 字符无异常（截停 ' + String(result.closed) + ' 次）')
    }
    harness.apply({ threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192, ignoredChars: ['-', '|'] })
  }

  console.log('')
  console.log('RESULT ' + (failed === 0 ? 'PASS' : 'FAIL'))
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('吞吐压力测试无法运行：', error)
  process.exitCode = 1
})
