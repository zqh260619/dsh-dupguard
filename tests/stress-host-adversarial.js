'use strict'

// ============================================================================
// dupguard 宿主端对抗性压力测试
//
// 目标：用边界、畸变、协议交错与热更新churn 找出检测器的正确性缺陷。
// 运行：node tests/stress-host-adversarial.js
// 失败会打印 FAIL <用例> <预期/实际> 并以非零码退出。
// ============================================================================

const assert = require('assert')
const path = require('path')

let passed = 0
let failed = 0
const failures = []

const ok = (name) => {
  passed++
  console.log('  ✓ ' + name)
}
const bad = (name, detail) => {
  failed++
  failures.push(name + '：' + detail)
  console.log('  ✗ FAIL ' + name + '：' + detail)
}
const test = async (name, fn) => {
  try {
    await fn()
    ok(name)
  } catch (error) {
    bad(name, error && error.message ? error.message : String(error))
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

/** 上游流：记录 return() 次数、pull 的 chunk 数与文本长度；可注入 per-chunk 钩子。 */
function makeUpstream(chunks, onBeforeChunk) {
  let closed = 0
  let pulled = 0
  let pulledText = 0
  async function* raw() {
    for (const chunk of chunks) {
      if (onBeforeChunk !== undefined) onBeforeChunk(chunk)
      pulled++
      if (typeof chunk.text === 'string') pulledText += chunk.text.length
      if (typeof chunk.argumentsDelta === 'string') pulledText += chunk.argumentsDelta.length
      yield chunk
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
  return { iterator, closedCount: () => closed, pulledCount: () => pulled, pulledText: () => pulledText }
}

/** 未闭合的文本流：block-start + deltas（不含 block-end / finish）。 */
const openText = (index, text, step = 4) => {
  const chunks = [{ type: 'block-start', index, blockType: 'text' }]
  for (let i = 0; i < text.length; i += step) chunks.push({ type: 'text-delta', index, text: text.slice(i, i + step) })
  return chunks
}

const closedTextStream = (index, text, step = 4) => [
  ...openText(index, text, step),
  { type: 'block-end', index, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 校验协议形状：finish 唯一且在最后；所有块闭合且类型匹配。 */
function assertProtocolClosure(out, label) {
  const finishes = out.filter((chunk) => chunk.type === 'finish')
  assert.strictEqual(finishes.length, 1, label + '：应恰好一个 finish，实际 ' + String(finishes.length))
  assert.strictEqual(out[out.length - 1].type, 'finish', label + '：finish 必须是最后一个 chunk')
  const open = new Map()
  for (const chunk of out) {
    if (chunk.type === 'block-start') open.set(chunk.index, chunk.blockType)
    if (chunk.type === 'block-end') {
      assert.strictEqual(open.get(chunk.index), chunk.block.type, label + '：block-end 类型应与 block-start 匹配')
      open.delete(chunk.index)
    }
  }
  assert.strictEqual(open.size, 0, label + '：不得有未闭合块')
  return finishes[0]
}

async function main() {
  const harness = createHarness()
  for (let i = 0; i < 200 && !harness.ready(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(harness.ready(), '设置注册应完成')
  const guard = harness.listeners['llm/stream']
  assert.strictEqual(typeof guard, 'function', '插件应注册 llm/stream 监听器')

  /** 跑一次守卫，返回输出与上游统计。可变参数便于协议交错用例。 */
  const run = async (chunks, options = {}) => {
    const upstream = makeUpstream(chunks, options.onBeforeChunk)
    const wrapped = guard({ provider: 'stress', model: 'm' }, () => upstream.iterator)
    const out = []
    let error = null
    try {
      for await (const chunk of wrapped) out.push(chunk)
    } catch (thrown) {
      error = thrown
    }
    return { out, error, upstream }
  }

  console.log('dupguard 对抗性压力测试')

  // ---- 1. 阈值边界 ----
  await test('阈值边界：9 次不触发 / 10 次触发', async () => {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192, stripWhitespace: true })
    const miss = await run(openText(0, 'a'.repeat(9)))
    assert.strictEqual(miss.upstream.closedCount(), 0, '9 次重复不应截停')
    assert.deepStrictEqual(miss.out, openText(0, 'a'.repeat(9)), '9 次重复应原样透传')
    const hit = await run(openText(0, 'a'.repeat(10)))
    assert.ok(hit.upstream.closedCount() >= 1, '10 次重复应截停')
    assert.strictEqual(assertProtocolClosure(hit.out, '阈值命中').reason.kind, 'stop')
  })

  await test('阈值边界：threshold=2 时 "aa" 触发', async () => {
    harness.apply({ ignoredChars: [], threshold: 2 })
    const hit = await run(openText(0, 'aa'))
    assert.ok(hit.upstream.closedCount() >= 1, '阈值 2 时 "aa" 应截停')
    harness.apply({ threshold: 10 })
  })

  // ---- 2. 单元长度边界 ----
  await test('单元长度边界：恰好 maxUnitLength 触发、+1 不触发', async () => {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 4 })
    const exact = await run(openText(0, 'abcd'.repeat(10)))
    assert.ok(exact.upstream.closedCount() >= 1, '单元长度 = maxUnitLength 应触发')
    const longer = await run(openText(0, 'abcde'.repeat(10)))
    assert.strictEqual(longer.upstream.closedCount(), 0, '单元长度 = maxUnitLength+1 不应触发')
    harness.apply({ maxUnitLength: 80 })
  })

  // ---- 3. 周期重叠 ----
  await test('周期重叠：单字符/双字符/三字符周期均触发且文本无损', async () => {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80 })
    for (const [label, unit, times] of [['单字符', 'a', 30], ['双字符', 'ab', 20], ['三字符', 'abc', 20]]) {
      const text = unit.repeat(times)
      const result = await run(openText(0, text))
      assert.ok(result.upstream.closedCount() >= 1, label + '周期应触发')
      const finish = assertProtocolClosure(result.out, label + '周期')
      assert.strictEqual(finish.reason.kind, 'stop')
      const closed = result.out.filter((chunk) => chunk.type === 'block-end')
      assert.strictEqual(closed.length, 1, label + '：应闭合一个块')
      // 截停在满足阈值的那一刻即返回，因此闭合块必须恰好等于「已经发给消费方的增量之和」：
      // 既不能丢已发出的文本，也不能凭空多出未发出的文本。
      const emitted = result.out.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
      assert.ok(text.startsWith(emitted), label + '：已发出文本必须是输入的前缀')
      assert.strictEqual(closed[0].block.text, emitted, label + '：闭合块文本应等于已发出的增量之和')
      assert.ok(emitted.length >= 10, label + '：触发时至少应消费 threshold 个字符')
    }
  })

  // ---- 4. 分块不变性 ----
  await test('分块不变性：1/2/3/7 字符切分下触发位置一致', async () => {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80 })
    const prefix = '正文前言-'.repeat(3)
    const repeated = 'wxyz'.repeat(10)
    const text = prefix + repeated
    const ideal = text.length
    for (const step of [1, 2, 3, 7]) {
      const chunks = openText(0, text, step)
      const upstream = makeUpstream(chunks)
      const wrapped = guard({ provider: 'stress', model: 'm' }, () => upstream.iterator)
      let pulledAtFinish = null
      for await (const chunk of wrapped) {
        if (chunk.type === 'finish') pulledAtFinish = upstream.pulledText()
      }
      assert.ok(pulledAtFinish !== null, 'step=' + step + ' 应触发')
      assert.ok(
        Math.abs(pulledAtFinish - ideal) <= step,
        'step=' + step + ' 触发时的已喂文本 ' + pulledAtFinish + ' 应接近 ' + ideal + '（容差 ' + step + '）',
      )
    }
  })

  // ---- 5. 空白开关 ----
  await test('空白开关：带空格复读仅在忽略空白时触发', async () => {
    const spaced = 'a a a a a a a a a a'
    harness.apply({ ignoredChars: [], stripWhitespace: true, threshold: 10 })
    const withStrip = await run(openText(0, spaced))
    assert.ok(withStrip.upstream.closedCount() >= 1, '忽略空白时应触发')
    harness.apply({ stripWhitespace: false })
    const withoutStrip = await run(openText(0, spaced))
    assert.strictEqual(withoutStrip.upstream.closedCount(), 0, '不忽略空白时不应触发')
    harness.apply({ stripWhitespace: true })
  })

  // ---- 6. 白名单：emoji 与非法条目 ----
  await test('白名单：emoji 条目生效、多字符条目丢弃并告警', async () => {
    harness.apply({ ignoredChars: ['😀'], threshold: 10, stripWhitespace: true })
    const emoji = await run(openText(0, '😀'.repeat(10)))
    assert.strictEqual(emoji.upstream.closedCount(), 0, 'emoji 作为单字符条目应生效')

    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.map(String).join(' '))
    try {
      harness.apply({ ignoredChars: ['ab'] })
    } finally {
      console.warn = originalWarn
    }
    assert.ok(
      warnings.some((line) => line.indexOf('白名单条目必须是单个字符') !== -1),
      '多字符条目应触发告警，实际：' + JSON.stringify(warnings),
    )
    const multi = await run(openText(0, 'ab'.repeat(10)))
    assert.ok(multi.upstream.closedCount() >= 1, '多字符条目不应生效（"ab" 复读仍应触发）')
    harness.apply({ ignoredChars: ['-', '|'] })
  })

  // ---- 7. 协议闭合：多块同时打开 ----
  await test('协议闭合：命中时 text/reasoning/tool-call 三块全部正确闭合', async () => {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, monitorReasoning: true })
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '前缀' },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 1, text: '思考中' },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 'call-7', name: 'demo', argumentsDelta: '{"q":' },
      { type: 'text-delta', index: 0, text: '复读'.repeat(10) },
    ]
    const { out, upstream } = await run(chunks)
    assert.ok(upstream.closedCount() >= 1, '应触发截停')
    const finish = assertProtocolClosure(out, '多块命中')
    assert.strictEqual(finish.reason.kind, 'stop')
    const ends = out.filter((chunk) => chunk.type === 'block-end')
    assert.strictEqual(ends.length, 3, '三个打开的块都应闭合')
    const toolEnd = ends.find((chunk) => chunk.index === 2)
    assert.deepStrictEqual(toolEnd.block, {
      type: 'tool-call',
      id: 'call-7',
      name: 'demo',
      arguments: '{"q":',
    }, 'tool-call 块应保留 id/name/arguments')
  })

  // ---- 8. 命中发生在最后一个增量 ----
  await test('协议闭合：命中恰在最后一个增量时仍完整收尾', async () => {
    harness.apply({ ignoredChars: [], threshold: 10 })
    const { out, upstream } = await run(openText(0, 'x'.repeat(10)))
    assert.ok(upstream.closedCount() >= 1, '应触发')
    assert.strictEqual(assertProtocolClosure(out, '末增量命中').reason.kind, 'stop')
  })

  // ---- 9. 上游异常 ----
  await test('上游异常：原样向上抛出且不追加协议块', async () => {
    harness.apply({ ignoredChars: [] })
    async function* failing() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      throw new Error('upstream boom')
    }
    const iterator = {
      [Symbol.asyncIterator]() {
        return iterator
      },
      next: () => failingGen.next(),
      return: () => {
        closed++
        return failingGen.return()
      },
    }
    let closed = 0
    const failingGen = failing()
    const wrapped = guard({ provider: 'stress', model: 'm' }, () => iterator)
    const out = []
    await assert.rejects(async () => {
      for await (const chunk of wrapped) out.push(chunk)
    }, /upstream boom/, '上游异常应原样抛出')
    assert.strictEqual(out.some((chunk) => chunk.type === 'finish'), false, '异常路径不应补发 finish')
    assert.ok(closed <= 1, 'return() 调用次数应 ≤ 1，实际 ' + String(closed))
  })

  // ---- 10. 无重复流逐块透传 ----
  await test('无重复流：输出与输入完全一致且不提前关闭上游', async () => {
    harness.apply({ ignoredChars: [] })
    const chunks = closedTextStream(0, 'hello world, no repetition here')
    const { out, upstream } = await run(chunks)
    assert.deepStrictEqual(out, chunks, '透明透传')
    assert.strictEqual(upstream.closedCount(), 0, '未命中不应调用 return()')
  })

  // ---- 11. 流进行中热更新 churn ----
  await test('设置 churn：每个 chunk 前切换全部参数不破坏协议', async () => {
    const patches = [
      { threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192, stripWhitespace: true, monitorReasoning: true, monitorToolArguments: false, ignoredChars: ['-', '|'] },
      { threshold: 4, minUnitLength: 2, maxUnitLength: 40, detectionWindow: 512, stripWhitespace: true, monitorReasoning: false, monitorToolArguments: true, ignoredChars: [] },
      { threshold: 6, minUnitLength: 1, maxUnitLength: 16, detectionWindow: 256, stripWhitespace: false, monitorReasoning: true, monitorToolArguments: false, ignoredChars: ['a'] },
    ]
    let index = 0
    const chunks = openText(0, 'ab'.repeat(12), 3)
    const { out, error, upstream } = await run(chunks, {
      onBeforeChunk: () => {
        harness.apply(patches[index % patches.length])
        index++
      },
    })
    assert.strictEqual(error, null, 'churn 过程不应抛异常：' + (error && error.message))
    assert.ok(out.length > 0, '应有输出')
    if (upstream.closedCount() >= 1) {
      assert.strictEqual(assertProtocolClosure(out, 'churn 命中').reason.kind, 'stop')
    } else {
      assert.deepStrictEqual(out, chunks, '未命中时应原样透传')
    }
    harness.apply(patches[0])
  })

  // ---- 12. 畸形输入 ----
  await test('畸形输入：空 delta / 超长单块 / 缺 name 的工具参数 / 重复 block-start', async () => {
    harness.apply({ ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80 })
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'call-x', argumentsDelta: '{"no":"name"}' },
      { type: 'text-delta', index: 0, text: 'p'.repeat(100000) },
      { type: 'block-end', index: 9, block: { type: 'text', text: 'ghost' } },
    ]
    const { out, error } = await run(chunks)
    assert.strictEqual(error, null, '畸形输入不应导致插件抛异常：' + (error && error.message))
    assert.ok(out.length > 0, '应有输出')
  })

  // ---- 13. 围栏代码块放宽阈值 ----
  await test('围栏代码块：块内放宽、块外严格、倍数可调', async () => {
    const body15 = '```js\n' + 'q'.repeat(15) + '\n```'
    const body40 = '```js\n' + 'q'.repeat(40) + '\n```'
    harness.apply({ ignoredChars: [], threshold: 10, codeBlockMultiplier: 3, skipCodeBlocks: true, detectionWindow: 8192 })
    assert.strictEqual((await run(openText(0, body15))).upstream.closedCount(), 0, '块内 15 次 < 3×10 不应触发')
    assert.ok((await run(openText(0, body40))).upstream.closedCount() >= 1, '块内 40 次 ≥ 3×10 应触发')
    assert.ok((await run(openText(0, 'q'.repeat(15)))).upstream.closedCount() >= 1, '块外 15 次应触发')

    harness.apply({ codeBlockMultiplier: 1 })
    assert.ok((await run(openText(0, body15))).upstream.closedCount() >= 1, '倍数 1 时块内 15 次应触发')

    harness.apply({ codeBlockMultiplier: 10, skipCodeBlocks: false })
    assert.ok((await run(openText(0, body15))).upstream.closedCount() >= 1, '关闭放宽后块内 15 次应触发')
    harness.apply({ codeBlockMultiplier: 3, skipCodeBlocks: true })
  })

  await test('围栏代码块：未闭合围栏、跨增量切分与长围栏', async () => {
    harness.apply({ ignoredChars: [], threshold: 10, codeBlockMultiplier: 3, skipCodeBlocks: true, detectionWindow: 8192 })
    // 未闭合围栏：其后内容一律按代码块放宽
    assert.strictEqual((await run(openText(0, '```\n' + 'w'.repeat(15)))).upstream.closedCount(), 0, '未闭合围栏内 15 次不应触发')
    assert.ok((await run(openText(0, '```\n' + 'w'.repeat(35)))).upstream.closedCount() >= 1, '未闭合围栏内 35 次应触发')
    // 围栏标记跨增量切分
    const split = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '``' },
      { type: 'text-delta', index: 0, text: '`' },
      { type: 'text-delta', index: 0, text: '\n' },
      { type: 'text-delta', index: 0, text: 'v'.repeat(15) },
    ]
    assert.strictEqual((await run(split)).upstream.closedCount(), 0, '切分后的围栏仍应按代码块放宽')
    // 长围栏（````）不被短围栏（```）关闭
    const longFence = '````\n```\n' + 'u'.repeat(15) + '\n```\n````'
    assert.strictEqual((await run(openText(0, longFence))).upstream.closedCount(), 0, '长围栏内 15 次不应触发')
    // 4 空格缩进不是围栏：仍按普通阈值
    assert.ok((await run(openText(0, '    ' + 't'.repeat(15)))).upstream.closedCount() >= 1, '缩进代码块不享受放宽')
  })

  await test('围栏代码块：倍数 0 时块内完全不检测', async () => {
    harness.apply({ ignoredChars: [], threshold: 10, codeBlockMultiplier: 0, skipCodeBlocks: true, detectionWindow: 8192 })
    assert.strictEqual((await run(openText(0, '```\n' + 'n'.repeat(100) + '\n```'))).upstream.closedCount(), 0, '倍数 0 时块内 100 次不应触发')
    assert.strictEqual((await run(openText(0, '~~~\n' + 'n'.repeat(100) + '\n~~~'))).upstream.closedCount(), 0, '波浪号围栏同样不检测')
    assert.ok((await run(openText(0, 'n'.repeat(12)))).upstream.closedCount() >= 1, '倍数 0 不影响块外判定')
    const across = await run(openText(0, 'n'.repeat(9) + '\n```\nx\n```\n' + 'n'.repeat(9)))
    assert.strictEqual(across.upstream.closedCount(), 0, '围栏两侧的重复不得拼接触发')
    assert.strictEqual((await run(openText(0, '```\n' + 'n'.repeat(80)))).upstream.closedCount(), 0, '未闭合围栏内也不检测')
    harness.apply({ codeBlockMultiplier: 3 })
  })

  await test('围栏代码块：窗口缺口按「阈值 × 倍数」判定', async () => {
    // 窗口 500、阈值 10、倍数 3 → 需要 10 × 3 × 80 = 2400，缺口存在
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.map(String).join(' '))
    try {
      harness.apply({ ignoredChars: [], threshold: 10, maxUnitLength: 80, detectionWindow: 500, codeBlockMultiplier: 3, skipCodeBlocks: true })
    } finally {
      console.warn = originalWarn
    }
    assert.ok(
      warnings.some((line) => line.indexOf('检测窗口长度需要提高') !== -1),
      '倍数放大窗口需求后应告警，实际：' + JSON.stringify(warnings),
    )
    // 放宽阈值 30、窗口 500 → 只能识别 floor(500/30)=16 字符以内的单元
    const inside = await run(openText(0, '```\n' + 'abcdefghijklmnopq'.repeat(10) + '\n```'))
    assert.strictEqual(inside.upstream.closedCount(), 0, '超出窗口可识别长度的单元不应触发')
    harness.apply({ detectionWindow: 8192, codeBlockMultiplier: 3 })
  })

  await test('片段白名单：跨增量、长片段优先、恶意输入与状态隔离', async () => {
    const base = { ignoredChars: [], threshold: 10, minUnitLength: 1, maxUnitLength: 80, detectionWindow: 8192, skipCodeBlocks: true }
    // 前置对照：未配置片段时同样文本应触发（该 harness 的 apply 是合并语义，故显式清空）
    harness.apply({ ...base, ignoredSubstrings: [] })
    assert.ok(
      (await run(openText(0, '<br>'.repeat(12)))).upstream.closedCount() >= 1,
      '对照：未配置该片段时应触发',
    )

    // 一字符增量：片段被切到极细仍应整段剔除
    harness.apply({ ...base, ignoredSubstrings: ['<br>'] })
    const fine = [{ type: 'block-start', index: 0, blockType: 'text' }]
    for (const ch of '<br>'.repeat(12)) fine.push({ type: 'text-delta', index: 0, text: ch })
    fine.push({ type: 'finish', reason: { kind: 'stop' } })
    assert.strictEqual((await run(fine)).upstream.closedCount(), 0, '一字符增量下片段仍应整段剔除')

    // 长片段优先：['ab','abcd'] 时 abcd 必须整段剔除（否则会被 ab 拆散而残留 cd）
    harness.apply({ ...base, ignoredSubstrings: ['ab', 'abcd'] })
    assert.strictEqual((await run(openText(0, 'abcd'.repeat(12)))).upstream.closedCount(), 0, '长片段优先应整段剔除')

    // 恶意/无效输入：空串、超长、重复、超量 → 安全丢弃且不崩，有效条目仍生效
    const many = Array.from({ length: 80 }, (_value, index) => 'p' + String(index))
    harness.apply({ ...base, ignoredSubstrings: ['', 'x'.repeat(65), 'k', 'k', ...many] })
    assert.strictEqual((await run(openText(0, 'k'.repeat(12)))).upstream.closedCount(), 0, '有效条目仍生效，无效条目被安全丢弃')

    // 状态隔离：清空片段表后下一条流恢复原有检测
    harness.apply({ ...base, ignoredSubstrings: [] })
    assert.ok((await run(openText(0, '<br>'.repeat(12)))).upstream.closedCount() >= 1, '清空片段表后应恢复原有检测')

    // 未闭合围栏 + 片段：块内按放宽阈值，片段剔除不改变围栏判定
    harness.apply({ ...base, ignoredSubstrings: ['q'], codeBlockMultiplier: 3 })
    assert.strictEqual((await run(openText(0, '```\n' + 'q'.repeat(200) + '\n```'))).upstream.closedCount(), 0, '片段剔除后块内不应触发')
    harness.apply({ ignoredChars: ['-', '|'], ignoredSubstrings: [], codeBlockMultiplier: 3 })
  })

  // ---- 汇总 ----
  console.log('')
  console.log('用例：通过 ' + String(passed) + ' 项，失败 ' + String(failed) + ' 项')
  if (failures.length > 0) {
    console.log('失败明细：')
    for (const line of failures) console.log('  - ' + line)
  }
  console.log('RESULT ' + (failed === 0 ? 'PASS' : 'FAIL'))
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('对抗性压力测试无法运行：', error)
  process.exitCode = 1
})
