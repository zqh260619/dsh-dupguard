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
//   - 决策钩子异常时的安全回退；
//   - 宿主集成：决策卡片入队 → 通知动作 → 流收尾 / 允许 / 超时自动截停。
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
const { makeCtx, makeUpstream, textChunks } = require('./helpers/host-harness.cjs')
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

/** 消费到「阈值命中暂停」为止：返回已产出的 chunk 和未决的 next()。 */
async function consumeUntilPaused(iterator) {
  const chunks = []
  for (let i = 0; i < 60; i++) {
    const next = iterator.next()
    const raced = await Promise.race([
      next.then((result) => ({ result })),
      delay(50).then(() => ({ paused: true })),
    ])
    if (raced.paused === true) return { chunks, pending: next }
    if (raced.result.done === true) throw new Error('流在进入暂停前就结束了')
    chunks.push(raced.result.value)
  }
  throw new Error('60 个 chunk 内没有进入决策暂停')
}

async function drainStream(iterator, pending) {
  if (pending !== undefined && pending !== null) {
    const first = await pending
    if (first.done === true) return
  }
  for (;;) {
    const result = await iterator.next()
    if (result.done === true) return
  }
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

  await test('观察期（暂停超时后）用户仍可立即截停', async () => {
    const { source } = makeSource(makeChunks(['abcabcabc', 'abcabcabc', 'tail']))
    const decision = deferredDecision()
    let control = null
    const stops = []
    const iterator = startGuard(source, makeRuntime(), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, hookControl) => {
        control = hookControl
        return decision.promise
      },
    })
    await iterator.next()
    await iterator.next()
    const paused = await nextWithWait(iterator, 80)
    assert.strictEqual(paused.pending, true)
    decision.resolve('continue')
    // 暂停超时后、下一次拉取前，用户点「立即截停」。
    control.action = 'stop'
    await paused.promise // 第二个 delta（已透传）
    await drain(iterator)
    assert.strictEqual(stops.length, 1)
    assert.strictEqual(stops[0].meta.decision, 'user')
  })

  await test('观察期用户仍可「允许继续」：停止后续检测', async () => {
    const { source } = makeSource(makeChunks(['abcabcabc', 'abcabcabc', 'abcabcabc', 'tail']))
    const decision = deferredDecision()
    let control = null
    const stops = []
    const iterator = startGuard(source, makeRuntime({ stopAtMultiplier: 2 }), {
      onStop: (hit, meta) => stops.push({ hit, meta }),
      onThreshold: (hit, hookControl) => {
        control = hookControl
        return decision.promise
      },
    })
    await iterator.next()
    await iterator.next()
    const paused = await nextWithWait(iterator, 80)
    assert.strictEqual(paused.pending, true)
    decision.resolve('continue')
    control.action = 'allow'
    await paused.promise
    await drain(iterator)
    assert.strictEqual(stops.length, 0, '允许继续后不应再截停')
  })

  await test('宿主集成：阈值暂停 → 决策卡片 → 用户「立即截停」→ 生成截停通知', async () => {
    const host = setupHost({ decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    assert.ok(route !== null, '应注册通知路由')
    const upstream = makeUpstream(textChunks(0, 'ab'.repeat(30), 4))
    const wrapped = host.listeners['llm/stream']({ provider: 'test', model: 'm', sessionId: 'sess-decision-stop' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    const paused = await consumeUntilPaused(iterator)
    assert.ok(paused.pending, '阈值后应暂停等待决策')
    const items = await listNotices(route)
    const decisionItem = items.find((item) => item.kind === 'decision')
    assert.ok(decisionItem, '应产生决策卡片')
    assert.strictEqual(decisionItem.phase, 'paused')
    assert.strictEqual(decisionItem.status, 'pending')
    assert.strictEqual(decisionItem.count, 10, '决策卡片应显示阈值次数')
    assert.strictEqual(decisionItem.autoStopCount, 20, '决策卡片应显示自动截停次数')
    assert.strictEqual(decisionItem.source, 'text')
    assert.ok(Number.isSafeInteger(decisionItem.deadline), '应有决策截止时间')
    const action = await callRoute(route, 'POST', '/dsh-dupguard/notifications/action', { id: decisionItem.id, action: 'stop-now' })
    assert.strictEqual(action.status, 200, '立即截停动作应成功')
    assert.strictEqual(action.body.status, 'stopped-by-user')
    await drainStream(iterator, paused.pending)
    assert.strictEqual(upstream.isClosed(), true, '用户立即截停后应关闭上游')
    const after = await listNotices(route)
    const decisionAfter = after.find((item) => item.id === decisionItem.id)
    assert.strictEqual(decisionAfter.status, 'stopped-by-user')
    assert.ok(after.some((item) => item.kind === 'stop' && item.status === 'pending'), '最终截停应生成普通通知（可继续指令）')
  })

  await test('宿主集成：用户「允许继续」→ 不截停、不生成截停通知', async () => {
    const host = setupHost({ decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    const upstream = makeUpstream(textChunks(0, 'ab'.repeat(30), 4))
    const wrapped = host.listeners['llm/stream']({ provider: 'test', model: 'm', sessionId: 'sess-decision-allow' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    const paused = await consumeUntilPaused(iterator)
    const items = await listNotices(route)
    const decisionItem = items.find((item) => item.kind === 'decision')
    assert.ok(decisionItem)
    const action = await callRoute(route, 'POST', '/dsh-dupguard/notifications/action', { id: decisionItem.id, action: 'allow-repeat' })
    assert.strictEqual(action.status, 200)
    assert.strictEqual(action.body.status, 'allowed')
    await drainStream(iterator, paused.pending)
    const after = await listNotices(route)
    assert.strictEqual(after.find((item) => item.id === decisionItem.id).status, 'allowed')
    assert.strictEqual(after.some((item) => item.kind === 'stop'), false, '允许继续后不应生成截停通知')
  })

  await test('宿主集成：无操作超时 → 达到阈值 × 倍数自动截停', async () => {
    const host = setupHost({ decisionTimeoutMs: 1000, stopAtMultiplier: 2 })
    const route = host.getRoute()
    const upstream = makeUpstream(textChunks(0, 'ab'.repeat(30), 4))
    const wrapped = host.listeners['llm/stream']({ provider: 'test', model: 'm', sessionId: 'sess-decision-auto' }, () => upstream.iterator)
    const iterator = wrapped[Symbol.asyncIterator]()
    const startedAt = Date.now()
    const paused = await consumeUntilPaused(iterator)
    await delay(1150)
    await drainStream(iterator, paused.pending)
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 1000, '应等待决策窗口后才自动截停')
    assert.strictEqual(upstream.isClosed(), true)
    const after = await listNotices(route)
    const decisionItem = after.find((item) => item.kind === 'decision')
    assert.strictEqual(decisionItem.status, 'stopped', '超时自动截停后决策卡片应标记 stopped')
    assert.ok(after.some((item) => item.kind === 'stop' && item.status === 'pending'), '应生成普通截停通知')
  })

  console.log('')
  console.log('全部通过：' + String(report.passed) + ' 项（阈值决策窗口）')
  report.summary()
}

main().catch((error) => {
  console.error('阈值决策窗口测试无法运行：', error)
  process.exitCode = 1
})
