'use strict'

// ============================================================================
// 阈值决策（连续输出模式）测试
//
// 覆盖：
//   - 无决策钩子时维持「阈值即停」；
//   - 命中阈值不暂停输出，只发卡片；
//   - 用户立即截停 / 允许继续（下一个 chunk 生效）；
//   - 自动截停 = 重复达到「阈值 × 倍数」且已过「最短反应时间」（两个条件都满足）；
//   - 倍数先到 / 反应时间先到两种顺序、重复中断、流结束、窗口不足、钩子异常；
//   - 宿主集成：卡片 watching 状态、通知动作、自动截停。
// ============================================================================

const assert = require('node:assert')
const os = require('node:os')
const path = require('node:path')

// 与开发机环境隔离：不读真实 profile / 不写真实截停日志。
process.env.DSH_PROFILE_DIR = path.join(os.tmpdir(), 'dupguard-decision-test-profile')
process.env.DSH_DUPGUARD_STOP_LOG = 'off'
delete process.env.DSH_DUPGUARD_DECISION

const engine = require('../lib/engine.js')
const plugin = require('../lib/index.js')
const { makeCtx, textChunks } = require('./helpers/host-harness.cjs')
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

/** 可控上游：记录拉取次数与是否被 return()。 */
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

/** 带节拍的上游：每次 next() 前等待 delayMs（用于验证“两个条件都满足才停”）。 */
function makeTimedUpstream(chunks, delayMs) {
  let index = 0
  let closed = false
  const iterator = {
    [Symbol.asyncIterator]() {
      return iterator
    },
    async next() {
      if (index >= chunks.length) return { done: true, value: undefined }
      await delay(delayMs)
      return { done: false, value: chunks[index++] }
    },
    return() {
      closed = true
      return Promise.resolve({ done: true, value: undefined })
    },
  }
  return { iterator, isClosed: () => closed }
}

function startGuard(source, runtime, hooks, provider = 'test') {
  const guard = engine.createStreamGuard({ provider, model: 'test-model' }, runtime, hooks)
  return guard(source)[Symbol.asyncIterator]()
}

async function consumeAll(iterator) {
  const chunks = []
  for (;;) {
    const result = await iterator.next()
    if (result.done === true) return chunks
    chunks.push(result.value)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 驱动真实宿主插件（npm 入口）：通过 Config 分支设置决策参数。 */
function setupHost(config) {
  let route = null
  const { ctx, listeners } = makeCtx({
    webServer: {
      register: (registered) => {
        route = registered
        return () => {}
      },
    },
    // 有 settings 服务但没有 register → 走插件 Config 分支（同步生效，测试无需等异步）。
    settings: { configure: () => () => {} },
  })
  plugin.apply(ctx, config === undefined ? {} : config)
  return { ctx, listeners, getRoute: () => route }
}

/** 调用宿主实际注册的通知路由（浏览器同款链路）。 */
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
    writeHead(status) {
      response.status = status
    },
    end(text) {
      response.body = text === undefined ? '' : String(text)
    },
  }
  await route.handler(request, response)
  return { status: response.status, body: JSON.parse(response.body) }
}

async function listNotices(route) {
  const result = await callRoute(route, 'GET', '/dsh-dupguard/notifications')
  return result.body.items
}

/** 消费到出现决策卡片（阈值已被命中）为止，返回已消费 chunk 数。 */
async function consumeUntilDecision(iterator, route, maxChunks = 40) {
  for (let i = 1; i <= maxChunks; i++) {
    const result = await iterator.next()
    if (result.done === true) throw new Error('流在触发决策前就结束了')
    const items = await listNotices(route)
    const decision = items.find((item) => item.kind === 'decision')
    if (decision !== undefined) return { consumed: i, decision }
  }
  throw new Error('未在 ' + String(maxChunks) + ' 个 chunk 内触发决策')
}

async function main() {
  console.log('dupguard 阈值决策（连续输出模式）测试')

  await test('无决策钩子：维持「阈值即停」', async () => {
    const { source, state } = makeSource(makeChunks(['abcabcabc', 'tail']))
    const stops = []
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
    })
    await consumeAll(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'threshold')
    assert.strictEqual(state.closed, true)
  })

  await test('命中阈值不暂停：输出继续、卡片回调一次、流结束不截停', async () => {
    const { source, state } = makeSource(makeChunks(['abcabcabc', 'p', 'q', 'r']))
    const stops = []
    const settled = []
    let thresholdCalls = 0
    let pullsAtHit = 0
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, control) => {
        thresholdCalls += 1
        pullsAtHit = state.pulls
        assert.ok(control !== null && typeof control === 'object', '应提供控制句柄')
        assert.strictEqual(hit.count, 3)
      },
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    const chunks = await consumeAll(iterator)
    assert.strictEqual(thresholdCalls, 1, '阈值钩子只应触发一次')
    assert.strictEqual(stops.length, 0, '流结束前未满足条件，不应截停')
    assert.strictEqual(state.closed, false, '不应提前关闭上游')
    assert.ok(state.pulls > pullsAtHit, '命中后应继续拉取上游（不暂停）')
    assert.strictEqual(chunks.filter((chunk) => chunk.type === 'text-delta').length, 4)
    assert.deepStrictEqual(settled, ['recovered'])
  })

  await test('用户立即截停：下一个 chunk 生效', async () => {
    const { source, state } = makeSource(makeChunks(['abcabcabc', 'p', 'q', 'r', 's']))
    const stops = []
    const settled = []
    let control = null
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, handle) => {
        control = handle
      },
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    // 第 3 次 next() 会回到 yield 之后，触发阈值钩子；之后再设置动作。
    for (let i = 0; i < 3; i++) await iterator.next()
    assert.ok(control !== null, '应已触发阈值钩子')
    control.action = 'stop'
    const chunks = await consumeAll(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'user')
    assert.strictEqual(state.closed, true)
    assert.strictEqual(chunks[chunks.length - 1].type, 'finish')
    assert.deepStrictEqual(settled, [], '用户截停走 onStop，不走 settled')
  })

  await test('用户允许继续：本次调用不再检测', async () => {
    const { source, state } = makeSource(makeChunks(['abcabcabc', 'p', 'q', 'r', 's']))
    const stops = []
    const settled = []
    let control = null
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, handle) => {
        control = handle
      },
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    for (let i = 0; i < 3; i++) await iterator.next()
    assert.ok(control !== null)
    control.action = 'allow'
    await consumeAll(iterator)
    assert.strictEqual(stops.length, 0)
    assert.strictEqual(state.closed, false)
    assert.deepStrictEqual(settled, ['allowed'])
  })

  await test('到倍数但反应时间未到：不提前截停；重复中断后不截停', async () => {
    // 阈值 3 × 倍数 2 = 6；命中后立刻继续重复到 6+，但反应时间 300ms 远未到。
    const parts = ['abcabcabc', 'abc', 'abc', 'abc', 'abc', 'abc', 'tail']
    const { source, state } = makeSource(makeChunks(parts))
    const stops = []
    const settled = []
    const iterator = startGuard(source, makeRuntime({ decisionTimeoutMs: 300 }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => undefined,
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    await consumeAll(iterator)
    assert.strictEqual(stops.length, 0, '反应时间未到，即使到倍数也不能停')
    assert.strictEqual(state.closed, false)
    assert.deepStrictEqual(settled, ['recovered'])
  })

  await test('反应时间先到、倍数后到：达到倍数且仍在重复才停', async () => {
    // 命中后再以 30ms/块继续重复 'x'（单元 'ab'），60ms 反应时间先到，之后才到 2×。
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ababab' },
      { type: 'text-delta', index: 0, text: 'ab' },
      { type: 'text-delta', index: 0, text: 'ab' },
      { type: 'text-delta', index: 0, text: 'ab' },
      { type: 'text-delta', index: 0, text: 'ab' },
      { type: 'text-delta', index: 0, text: 'ab' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'abababababababab' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const timed = makeTimedUpstream(chunks, 30)
    const stops = []
    const startedAt = Date.now()
    const iterator = startGuard(timed.iterator, makeRuntime({ decisionTimeoutMs: 60 }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => undefined,
    })
    await consumeAll(iterator)
    assert.strictEqual(stops.length, 1, '应自动截停')
    assert.strictEqual(stops[0].meta.decision, 'auto')
    assert.ok(stops[0].meta.heldMs >= 55, '进入自动截停前应已过反应时间，实际 ' + stops[0].meta.heldMs)
    assert.ok(stops[0].hit.count >= 6, '截停次数应达到倍数阈值，实际 ' + stops[0].hit.count)
    assert.ok(Date.now() - startedAt >= 60)
    assert.strictEqual(timed.isClosed(), true)
  })

  await test('倍数先到、反应时间后到：等到反应时间结束才停', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ababab' },
      ...Array.from({ length: 12 }, () => ({ type: 'text-delta', index: 0, text: 'ab' })),
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ab'.repeat(15) } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const timed = makeTimedUpstream(chunks, 10)
    const stops = []
    const iterator = startGuard(timed.iterator, makeRuntime({ decisionTimeoutMs: 120 }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => undefined,
    })
    await consumeAll(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'auto')
    assert.ok(stops[0].meta.heldMs >= 110, '应等到反应时间结束，实际 ' + stops[0].meta.heldMs)
  })

  await test('周期旋转文本：一次重复事件只一张卡片，且到点自动截停', async () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'
    const text = alphabet.repeat(12)
    const parts = []
    for (let i = 0; i < text.length; i += 7) parts.push(text.slice(i, i + 7))
    const timed = makeTimedUpstream(makeChunks(parts), 10)
    const runtime = makeRuntime({
      threshold: 3,
      minUnitLength: 1,
      maxUnitLength: 30,
      decisionTimeoutMs: 40,
      stopAtMultiplier: 2,
    })
    const thresholds = []
    const stops = []
    const settled = []
    const iterator = startGuard(timed.iterator, runtime, {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit) => thresholds.push(hit),
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    await consumeAll(iterator)
    assert.strictEqual(thresholds.length, 1, '同一轮连续重复应只生成一张卡片')
    assert.strictEqual(stops.length, 1, '应自动截停')
    assert.strictEqual(stops[0].meta.decision, 'auto')
    assert.ok(stops[0].hit.count >= 6, '应按倍数计数截停，实际 ' + stops[0].hit.count)
    assert.ok(stops[0].meta.heldMs >= 35, '应等待反应时间，实际 ' + stops[0].meta.heldMs)
    assert.deepStrictEqual(settled, [], '自动截停前不应因相位旋转误判 recovered')
    assert.strictEqual(timed.isClosed(), true)
  })

  await test('周期旋转文本：卡片不会瞬间 recovered，延迟点击允许继续仍有效', async () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'
    const text = alphabet.repeat(12)
    const parts = []
    for (let i = 0; i < text.length; i += 7) parts.push(text.slice(i, i + 7))
    const timed = makeTimedUpstream(makeChunks(parts), 10)
    const runtime = makeRuntime({
      threshold: 3,
      minUnitLength: 1,
      maxUnitLength: 30,
      decisionTimeoutMs: 200,
      stopAtMultiplier: 2,
    })
    const settled = []
    const stops = []
    let thresholds = 0
    const iterator = startGuard(timed.iterator, runtime, {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, control) => {
        thresholds += 1
        // 模拟客户端轮询/人类反应：命中后 25ms 才点「允许继续」。
        setTimeout(() => {
          control.action = 'allow'
        }, 25)
      },
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    await consumeAll(iterator)
    assert.strictEqual(thresholds, 1, '不应因相位旋转产生第二张卡片')
    assert.strictEqual(stops.length, 0, '允许继续后不应截停')
    assert.deepStrictEqual(settled, ['allowed'])
  })

  await test('窗口判定真正中断：足够长的非重复内容后 recovered', async () => {
    // 命中后接足够长的不同内容（超出 need+2 个单元的窗口）→ 才算重复中断。
    const { source } = makeSource(makeChunks(['abcabcabc', 'defghijklmnopqrstuv']))
    const stops = []
    const settled = []
    let thresholds = 0
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => {
        thresholds += 1
      },
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    await consumeAll(iterator)
    assert.strictEqual(thresholds, 1)
    assert.strictEqual(stops.length, 0)
    assert.deepStrictEqual(settled, ['recovered'])
  })

  await test('暂停显示：命中块先扣住，点立即截停只保留命中前内容', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'abcabcabc' },
      { type: 'text-delta', index: 0, text: 'abc'.repeat(10) },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'abc'.repeat(13) } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { source } = makeSource(chunks)
    const stops = []
    const delivered = []
    let control = null
    let thresholds = 0
    const iterator = startGuard(source, makeRuntime({
      threshold: 5,
      pauseDecisionOutput: true,
      decisionTimeoutMs: 1000,
    }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, ctl) => {
        thresholds += 1
        control = ctl
      },
    })
    assert.strictEqual((await iterator.next()).value.type, 'block-start')
    assert.strictEqual((await iterator.next()).value.text, 'abcabcabc')
    const held = iterator.next()
    let heldSettled = false
    held.then(() => { heldSettled = true })
    await delay(25)
    assert.strictEqual(thresholds, 1)
    assert.strictEqual(heldSettled, false, '命中块在暂停显示期间不应交给消费方')
    control.action = 'stop'
    const first = await held
    delivered.push(first.value)
    const rest = await consumeAll(iterator)
    delivered.push(...rest)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'user')
    const blockEnd = delivered.find((chunk) => chunk.type === 'block-end')
    assert.strictEqual(blockEnd.block.text, 'abcabcabc', '截停时应丢弃未显示的命中块，只保留命中前内容')
    assert.strictEqual(delivered.some((chunk) => chunk.type === 'text-delta' && chunk.text.includes('abc'.repeat(10))), false)
  })

  await test('暂停显示：允许继续会放行被扣住的命中块', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'abcabcabc' },
      { type: 'text-delta', index: 0, text: 'abc'.repeat(10) },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'abc'.repeat(13) } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { source } = makeSource(chunks)
    const stops = []
    const settled = []
    let control = null
    const iterator = startGuard(source, makeRuntime({
      threshold: 5,
      pauseDecisionOutput: true,
      decisionTimeoutMs: 1000,
    }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, ctl) => { control = ctl },
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    await iterator.next()
    await iterator.next()
    const held = iterator.next()
    await delay(25)
    control.action = 'allow'
    const first = await held
    assert.strictEqual(first.value.type, 'text-delta')
    assert.strictEqual(first.value.text, 'abc'.repeat(10), '允许继续应放行命中块')
    const rest = await consumeAll(iterator)
    assert.strictEqual(stops.length, 0)
    assert.deepStrictEqual(settled, ['allowed'])
    assert.ok(rest.some((chunk) => chunk.type === 'block-end'))
  })

  await test('暂停显示：到期且达到倍数 → 自动截停并丢弃命中块', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'abcabcabc' },
      { type: 'text-delta', index: 0, text: 'abc'.repeat(10) },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'abc'.repeat(13) } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { source } = makeSource(chunks)
    const stops = []
    const iterator = startGuard(source, makeRuntime({
      threshold: 5,
      stopAtMultiplier: 2,
      pauseDecisionOutput: true,
      decisionTimeoutMs: 60,
    }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => undefined,
    })
    await iterator.next()
    await iterator.next()
    const held = iterator.next()
    const first = await held
    const rest = await consumeAll(iterator)
    const delivered = [first.value, ...rest]
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'auto')
    assert.ok(stops[0].meta.heldMs >= 50, '应等到最短反应时间')
    const blockEnd = delivered.find((chunk) => chunk.type === 'block-end')
    assert.strictEqual(blockEnd.block.text, 'abcabcabc', '自动截停也不应显示未放行的命中块')
  })

  await test('暂停显示：到期但未达倍数 → 恢复显示并继续观察', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'abcabcabc' },
      { type: 'text-delta', index: 0, text: 'abcabc' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'abc'.repeat(5) } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { source } = makeSource(chunks)
    const stops = []
    const settled = []
    let resumed = 0
    let control = null
    const iterator = startGuard(source, makeRuntime({
      threshold: 5,
      stopAtMultiplier: 2,
      pauseDecisionOutput: true,
      decisionTimeoutMs: 50,
    }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, ctl) => {
        control = ctl
        ctl.onResume = () => { resumed += 1 }
      },
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    await iterator.next()
    await iterator.next()
    const held = iterator.next()
    const first = await held
    assert.strictEqual(first.value.type, 'text-delta')
    assert.strictEqual(first.value.text, 'abcabc')
    const rest = await consumeAll(iterator)
    assert.strictEqual(stops.length, 0)
    assert.strictEqual(resumed, 1, '到期未达倍数应恢复输出')
    assert.deepStrictEqual(settled, ['recovered'], '之后按连续观察结束本次事件')
    assert.ok(rest.some((chunk) => chunk.type === 'finish'))
  })

  await test('本地 provider：只弹卡片不自动截停，手动立即截停仍有效', async () => {
    const text = 'ab'.repeat(60)
    const parts = []
    for (let i = 0; i < text.length; i += 4) parts.push(text.slice(i, i + 4))
    const timed = makeTimedUpstream(makeChunks(parts), 10)
    const stops = []
    const thresholds = []
    let control = null
    const iterator = startGuard(timed.iterator, makeRuntime({
      threshold: 3,
      decisionTimeoutMs: 40,
      stopAtMultiplier: 2,
      localNoForcedStop: true,
      localProviderIds: 'ollama',
    }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, ctl) => {
        thresholds.push(hit)
        control = ctl
      },
    }, 'ollama')
    while (thresholds.length === 0) {
      const next = await iterator.next()
      if (next.done === true) break
    }
    assert.strictEqual(thresholds.length, 1)
    // 超过最短反应时间 + 超过倍数：仍不应自动截停（本地默认不强制）。
    for (let i = 0; i < 8; i++) {
      const next = await iterator.next()
      if (next.done === true) break
    }
    assert.strictEqual(stops.length, 0, '本地模型不应自动截停')
    control.action = 'stop'
    const rest = await consumeAll(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'user')
    assert.ok(rest.length >= 0)
  })

  await test('本地 provider + 无决策通道：命中也不强制截停', async () => {
    const { source } = makeSource(makeChunks(['ab'.repeat(40)]))
    const stops = []
    const delivered = []
    const iterator = startGuard(source, makeRuntime({
      threshold: 3,
      localNoForcedStop: true,
      localProviderIds: 'ollama',
    }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
    }, 'ollama')
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      delivered.push(next.value)
    }
    assert.strictEqual(stops.length, 0)
    assert.ok(delivered.some((chunk) => chunk.type === 'text-delta'))
    assert.ok(delivered.some((chunk) => chunk.type === 'finish'), '应让上游正常结束，而不是关闭流')
  })

  await test('重复中断：取消观察，不截停', async () => {
    const { source } = makeSource(makeChunks(['abcabcabc', 'p', 'q', 'tail']))
    const stops = []
    const settled = []
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => undefined,
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    await consumeAll(iterator)
    assert.strictEqual(stops.length, 0)
    assert.deepStrictEqual(settled, ['recovered'])
  })

  await test('流自然结束：不截停（expired）', async () => {
    // 不带 block-end，直接以 finish 结束，覆盖「流结束前未满足条件」的路径。
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'abcabcabc' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { source } = makeSource(chunks)
    const stops = []
    const settled = []
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => undefined,
      onThresholdSettled: (hit, outcome) => settled.push(outcome),
    })
    await consumeAll(iterator)
    assert.strictEqual(stops.length, 0)
    assert.deepStrictEqual(settled, ['expired'])
  })

  await test('检测窗口不足以观察倍数：回退为阈值即停', async () => {
    const { source } = makeSource(makeChunks(['abcabcabc', 'abc', 'abc']))
    const stops = []
    const iterator = startGuard(source, makeRuntime({ detectionWindow: 10 }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: () => undefined,
    })
    await consumeAll(iterator)
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
    await consumeAll(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'threshold')
  })

  await test('宿主集成：命中后卡片 watching、输出不暂停、允许继续不截停', async () => {
    const host = setupHost({ decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    assert.ok(route !== null, '应注册通知路由')
    const upstream = makeTimedUpstream(textChunks(0, 'ab'.repeat(30), 4), 5)
    const wrapped = host.listeners['llm/stream']({ provider: 'test', model: 'm', sessionId: 'sess-watching' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    const decisionInfo = await consumeUntilDecision(iterator, route)
    const decision = decisionInfo.decision
    assert.strictEqual(decision.phase, 'watching')
    assert.strictEqual(decision.status, 'pending')
    assert.strictEqual(decision.count, 10)
    assert.strictEqual(decision.autoStopCount, 20)
    assert.ok(Number.isSafeInteger(decision.deadline), '应有最短反应时间截止点')
    // 输出仍在继续：命中后还能继续拿到数据块。
    const next = await iterator.next()
    assert.strictEqual(next.done, false, '决策期间输出不应暂停')
    const action = await callRoute(route, 'POST', '/dsh-dupguard/notifications/action', { id: decision.id, action: 'allow-repeat' })
    assert.strictEqual(action.status, 200)
    assert.strictEqual(action.body.status, 'allowed')
    const rest = []
    for (;;) {
      const result = await iterator.next()
      if (result.done === true) break
      rest.push(result.value)
    }
    assert.ok(rest.length > 0)
    const after = await listNotices(route)
    assert.strictEqual(after.find((item) => item.id === decision.id).status, 'allowed')
    assert.strictEqual(after.some((item) => item.kind === 'stop'), false, '允许继续后不应生成截停通知')
    assert.strictEqual(upstream.isClosed(), false, '自然结束不应关闭上游')
  })

  await test('宿主集成：立即截停 → 关闭上游并生成截停通知', async () => {
    const host = setupHost({ decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    const upstream = makeTimedUpstream(textChunks(0, 'ab'.repeat(40), 4), 5)
    const wrapped = host.listeners['llm/stream']({ provider: 'test', model: 'm', sessionId: 'sess-stopnow' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    const { decision } = await consumeUntilDecision(iterator, route)
    const action = await callRoute(route, 'POST', '/dsh-dupguard/notifications/action', { id: decision.id, action: 'stop-now' })
    assert.strictEqual(action.status, 200)
    assert.strictEqual(action.body.status, 'stopped-by-user')
    for (;;) {
      const result = await iterator.next()
      if (result.done === true) break
    }
    assert.strictEqual(upstream.isClosed(), true, '用户截停后应关闭上游')
    const after = await listNotices(route)
    assert.strictEqual(after.find((item) => item.id === decision.id).status, 'stopped-by-user')
    assert.ok(after.some((item) => item.kind === 'stop' && item.status === 'pending'), '应生成普通截停通知')
  })

  await test('宿主集成：暂停显示扣住命中块，paused 卡片立即截停只保留命中前内容', async () => {
    const host = setupHost({ pauseDecisionOutput: true, decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ab'.repeat(5) },
      { type: 'text-delta', index: 0, text: 'ab'.repeat(100) },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ab'.repeat(105) } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const upstream = makeTimedUpstream(chunks, 5)
    const wrapped = host.listeners['llm/stream']({ provider: 'test', model: 'm', sessionId: 'sess-pause' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    assert.strictEqual((await iterator.next()).value.type, 'block-start')
    assert.strictEqual((await iterator.next()).value.type, 'text-delta')
    const held = iterator.next()
    let heldResolved = false
    held.then(() => { heldResolved = true })
    await delay(30)
    assert.strictEqual(heldResolved, false, '暂停显示期间命中块不应交给客户端')
    const items = await listNotices(route)
    const decision = items.find((item) => item.kind === 'decision' && item.status === 'pending')
    assert.ok(decision, '应生成决策卡片')
    assert.strictEqual(decision.phase, 'paused')
    const action = await callRoute(route, 'POST', '/dsh-dupguard/notifications/action', { id: decision.id, action: 'stop-now' })
    assert.strictEqual(action.status, 200)
    assert.strictEqual(action.body.status, 'stopped-by-user')
    const first = await held
    assert.strictEqual(first.value.type, 'block-end')
    assert.strictEqual(first.value.block.text, 'ab'.repeat(5), '截停不应显示被扣住的命中块')
    for (;;) {
      const result = await iterator.next()
      if (result.done === true) break
    }
    assert.strictEqual(upstream.isClosed(), true)
    const after = await listNotices(route)
    assert.strictEqual(after.find((item) => item.id === decision.id).status, 'stopped-by-user')
    assert.ok(after.some((item) => item.kind === 'stop' && item.status === 'pending'))
  })

  await test('宿主集成：暂停到期未达倍数 → 卡片恢复 watching 并继续输出', async () => {
    const host = setupHost({ pauseDecisionOutput: true, decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ab'.repeat(9) },
      { type: 'text-delta', index: 0, text: 'ab' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ab'.repeat(10) } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const upstream = makeTimedUpstream(chunks, 5)
    const wrapped = host.listeners['llm/stream']({ provider: 'test', model: 'm', sessionId: 'sess-pause-resume' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    const held = iterator.next()
    const first = await held
    assert.strictEqual(first.value.type, 'text-delta')
    const items = await listNotices(route)
    const decision = items.find((item) => item.kind === 'decision' && item.status === 'pending')
    assert.ok(decision, '恢复后卡片仍可操作')
    assert.strictEqual(decision.phase, 'watching', '到期未达倍数应切回输出继续状态')
    for (;;) {
      const result = await iterator.next()
      if (result.done === true) break
    }
    const after = await listNotices(route)
    const settled = after.find((item) => item.id === decision.id)
    assert.ok(settled.status === 'recovered' || settled.status === 'expired')
  })

  await test('宿主集成：周期旋转文本不会刷卡片，延迟点击立即截停仍成功', async () => {
    const host = setupHost({ decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    const alphabetText = 'abcdefghijklmnopqrstuvwxyz'.repeat(20)
    const upstream = makeTimedUpstream(textChunks(0, alphabetText, 7), 5)
    const wrapped = host.listeners['llm/stream']({ provider: 'test', model: 'm', sessionId: 'sess-rotation' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    const { decision } = await consumeUntilDecision(iterator, route)
    // 模拟客户端继续接收若干块后再点击：旧逻辑会在这里产生大量 recovered 卡片 / 卡片已结束。
    for (let i = 0; i < 10; i++) {
      const result = await iterator.next()
      if (result.done === true) break
    }
    const pending = (await listNotices(route)).filter((item) => item.kind === 'decision')
    assert.strictEqual(pending.length, 1, '同一次重复事件不应刷出多张卡片，实际 ' + pending.length)
    assert.strictEqual(pending[0].id, decision.id)
    assert.strictEqual(pending[0].status, 'pending')
    assert.strictEqual(pending[0].phase, 'watching')
    const action = await callRoute(route, 'POST', '/dsh-dupguard/notifications/action', { id: decision.id, action: 'stop-now' })
    assert.strictEqual(action.status, 200, '延迟点击应立即截停而不是 409')
    assert.strictEqual(action.body.status, 'stopped-by-user')
    for (;;) {
      const result = await iterator.next()
      if (result.done === true) break
    }
    assert.strictEqual(upstream.isClosed(), true)
    const after = await listNotices(route)
    assert.strictEqual(after.find((item) => item.id === decision.id).status, 'stopped-by-user')
    assert.ok(after.some((item) => item.kind === 'stop' && item.status === 'pending'))
  })

  await test('宿主集成：本地 provider 卡片标记 noForcedStop，手动立即截停仍生效', async () => {
    const host = setupHost({ localNoForcedStop: true, localProviderIds: 'ollama', decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    const upstream = makeTimedUpstream(textChunks(0, 'ab'.repeat(80), 4), 5)
    const wrapped = host.listeners['llm/stream']({ provider: 'ollama', model: 'm', sessionId: 'sess-local' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    const { decision } = await consumeUntilDecision(iterator, route)
    assert.strictEqual(decision.noForcedStop, true, '本地模型卡片应标记不自动截停')
    assert.strictEqual(decision.deadline, null, '不自动截停时不应显示反应倒计时')
    assert.strictEqual(decision.autoStopCount, null)
    const action = await callRoute(route, 'POST', '/dsh-dupguard/notifications/action', { id: decision.id, action: 'stop-now' })
    assert.strictEqual(action.status, 200)
    assert.strictEqual(action.body.status, 'stopped-by-user')
    for (;;) {
      const result = await iterator.next()
      if (result.done === true) break
    }
    assert.strictEqual(upstream.isClosed(), true)
    const after = await listNotices(route)
    assert.strictEqual(after.find((item) => item.id === decision.id).status, 'stopped-by-user')
    assert.ok(after.some((item) => item.kind === 'stop' && item.status === 'pending'))
  })

  await test('宿主集成：达到倍数且过反应时间才自动截停（不提前）', async () => {
    // 10 次阈值 ×2 = 20；每块 60ms：命中约 0.3s，倍数约 0.6s，反应时间 1s → 应等到 1s 后才停。
    const host = setupHost({ decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    const upstream = makeTimedUpstream(textChunks(0, 'ab'.repeat(80), 4), 60)
    const wrapped = host.listeners['llm/stream']({ provider: 'test', model: 'm', sessionId: 'sess-auto' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    const { decision } = await consumeUntilDecision(iterator, route)
    const firstStopCheck = await listNotices(route)
    assert.strictEqual(firstStopCheck.some((item) => item.kind === 'stop'), false, '刚命中时不应已截停')
    const startedAt = Date.now()
    for (;;) {
      const result = await iterator.next()
      if (result.done === true) break
    }
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 800, '应等待反应时间结束才自动截停，实际等待 ' + elapsed + 'ms')
    assert.strictEqual(upstream.isClosed(), true)
    const after = await listNotices(route)
    assert.strictEqual(after.find((item) => item.id === decision.id).status, 'stopped')
    assert.ok(after.some((item) => item.kind === 'stop' && item.status === 'pending'), '自动截停应生成普通截停通知')
  })

  console.log('')
  console.log('全部通过：' + String(report.passed) + ' 项（阈值决策：连续输出模式）')
  report.summary()
}

main().catch((error) => {
  console.error('阈值决策测试无法运行：', error)
  process.exitCode = 1
})
