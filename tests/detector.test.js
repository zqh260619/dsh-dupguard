// ============================================================================
// dupguard 端到端测试（防漂移双入口套件）
//
// 同一个测试套件会分别加载两个插件入口并各跑一遍：
//   1. dynamic：plugin/host.js —— 通过 new Function 求值（与 cordis_define 的
//      code.host 完全一致）；
//   2. npm：    lib/index.js  —— 通过 require 加载（与组合/预设挂载完全一致）。
//
// 两者必须行为一致；任何一份改动破坏一致性都会在此处失败。
//
// 覆盖：
//   1. 无重复时全量透传，不注入任何额外 chunk；
//   2. 各类重复（单字符 / 多字符 / 带空格 / 带换行 / 前缀后循环）能被识别；
//   3. 达到阈值才触发，阈值减一不触发；
//   4. 停止时补发协议合规的 block-end + finish(stop)；
//   5. 提前结束会调用上游 iterator.return()（对应真实适配器 consumer.abort()）；
//   6. 默认不检测 reasoning / 工具参数；
//   7. 工具调用块在停止时被正确闭合。
//
// 运行：node tests/detector.test.js   （或 npm test）
// ============================================================================

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert')

// ---- 两个入口 ----------------------------------------------------------------
const hostCode = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'host.js'), 'utf8')
const entries = [
  {
    label: 'dynamic (plugin/host.js)',
    load() {
      return new Function(hostCode)()
    },
  },
  {
    label: 'npm (lib/index.js)',
    load() {
      return require('../lib/index.js')
    },
  },
]

// ---- 流工具 ------------------------------------------------------------------
/** 制造一个记录 return() 调用、按给定数组产出 chunk 的上游流。 */
function makeUpstream(chunks) {
  let closed = false
  let pulled = 0
  async function* raw() {
    for (const c of chunks) {
      pulled++
      yield c
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
      closed = true
      return gen.return()
    },
  }
  return { iterator, isClosed: () => closed, pulledCount: () => pulled }
}

/** 构造一段文本块的完整 chunk 序列。 */
function textChunks(index, text, step = 4) {
  const chunks = [{ type: 'block-start', index, blockType: 'text' }]
  for (let i = 0; i < text.length; i += step) {
    chunks.push({ type: 'text-delta', index, text: text.slice(i, i + step) })
  }
  chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
  chunks.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

// ---- 套件 --------------------------------------------------------------------
function runSuite(label, plugin) {
  assert.strictEqual(typeof plugin.apply, 'function', label + '：插件应导出/返回 apply')

  const listeners = {}
  const fakeCtx = {
    on(name, listener) {
      listeners[name] = listener
      return () => {
        if (listeners[name] === listener) delete listeners[name]
      }
    },
  }
  plugin.apply(fakeCtx)
  assert.strictEqual(typeof listeners['llm/stream'], 'function', label + '：应注册 llm/stream 监听器')

  /** 通过监听器包装上游流并完整收集输出。 */
  async function collect(chunks) {
    const up = makeUpstream(chunks)
    const wrapped = listeners['llm/stream']({ provider: 'test', model: 'test-model' }, () => up.iterator)
    const out = []
    for await (const chunk of wrapped) out.push(chunk)
    return { out, up }
  }

  let passed = 0
  async function test(name, fn) {
    await fn()
    passed++
    console.log('  ✓ ' + name)
  }

  return async () => {
    console.log('· ' + label)

    // 1. 无重复：全量透传，无额外注入，不提前关闭
    await test('无重复时全量透传、不注入额外 chunk、不提前 return()', async () => {
      const chunks = textChunks(0, '这是一段完全正常的回答，没有任何重复内容。')
      const { out, up } = await collect(chunks)
      assert.deepStrictEqual(out, chunks)
      assert.strictEqual(up.isClosed(), false, '自然结束时不应调用 return()')
    })

    // 2. 单字符重复 10 次
    await test('单字符 "a"×10 触发停止', async () => {
      const chunks = textChunks(0, 'aaaaaaaaaa')
      const { out, up } = await collect(chunks)
      const types = out.map((c) => c.type)
      assert.ok(types.includes('finish'), '应以 finish 结尾')
      assert.strictEqual(up.isClosed(), true, '触发后应提前调用上游 return()')
      const close = out[out.length - 1]
      assert.deepStrictEqual(close, { type: 'finish', reason: { kind: 'stop' } })
      const ends = out.filter((c) => c.type === 'block-end')
      assert.strictEqual(ends.length, 1, '补发一次 block-end')
      assert.deepStrictEqual(ends[0].block, { type: 'text', text: 'aaaaaaaaaa' }, '闭合块应携带完整文本')
    })

    // 3. 多字符单元重复
    await test('"哈哈"×10 触发停止', async () => {
      const chunks = textChunks(0, '哈哈'.repeat(10))
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true)
      assert.strictEqual(out[out.length - 1].type, 'finish')
    })

    // 4. 带空格分隔的复读（stripWhitespace）
    await test('"hello hello ..."（空格分隔）触发停止', async () => {
      const chunks = textChunks(0, Array(10).fill('hello').join(' '))
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true, '空格分隔的复读应被识别')
      const closedBlock = out.find((c) => c.type === 'block-end')
      assert.ok(closedBlock.block.text.startsWith('hello hello'))
    })

    // 5. 换行分隔的复读
    await test('逐行重复 10 次触发停止', async () => {
      const chunks = textChunks(0, ('抱歉，我无法完成。\n').repeat(10))
      const { up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true, '换行分隔的复读应被识别')
    })

    // 6. 阈值减一不触发
    await test('重复 9 次不触发', async () => {
      const chunks = textChunks(0, '重复'.repeat(9))
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false)
      assert.deepStrictEqual(out, chunks, '未触发时应全量透传')
    })

    // 7. 正常前缀后陷入循环
    await test('正常前缀之后陷入循环仍触发，且前缀被保留', async () => {
      const chunks = textChunks(0, '好的，下面开始回答：' + '循环'.repeat(12))
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true)
      const closedBlock = out.find((c) => c.type === 'block-end')
      assert.ok(closedBlock.block.text.startsWith('好的，下面开始回答：'), '前缀必须保留在闭合块中')
      assert.ok(closedBlock.block.text.endsWith('循环'))
    })

    // 8. 超过 maxUnitLength 的单元不触发（默认 80）
    // 注意：不能用 'x'*81 这类同字符串，因为其尾部本身含单字符 'x' 连续 10+ 次，
    // 插件会（正确地）以 unit="x" 命中。这里改用 sqrt(2) 的小数位——
    // 前 81 位无小周期，重复 10 次后不存在长度 <= 80 的尾部连续重复单元。
    await test('重复单元长度超过 maxUnitLength(80) 不触发', async () => {
      const sqrt2 =
        '141421356237309504880168872420969807856967187537694807317667973799073247846210703885038753432764157273501384623091229702492483605585073721264412149709993583141322266592750559275579995050115278206057147010955997160597027453459686201472851741864088919860955232923048430871432145083976260362799525140798968725339654633180882'
      const unit = sqrt2.slice(0, 81)
      assert.strictEqual(unit.length, 81)
      const chunks = textChunks(0, unit.repeat(10), unit.length)
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false, '单元长度超过 maxUnitLength 不应触发')
      assert.deepStrictEqual(out, chunks)
    })

    // 9. 阈值恰好 10 触发（>= 语义）
    await test('恰好重复 10 次触发（>= 语义）', async () => {
      const chunks = textChunks(0, 'ab'.repeat(10))
      const { up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true)
    })

    // 10. 循环发生在跨增量边界处也能触发
    await test('循环发生在增量分块边界处仍能触发', async () => {
      // 前 3 个 delta 各 1 字符，其后大步长，迫使重复单元跨多个 delta
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'a' },
        { type: 'text-delta', index: 0, text: 'a' },
        { type: 'text-delta', index: 0, text: 'a' },
        { type: 'text-delta', index: 0, text: 'aaaaaaa' }, // 累计 10 个 a
      ]
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true)
      assert.strictEqual(out[out.length - 1].type, 'finish')
    })

    // 11. 默认不检测 reasoning 循环
    await test('reasoning 循环默认不触发', async () => {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '想'.repeat(10) },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想'.repeat(10) } },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: '正常回答' },
        { type: 'block-end', index: 1, block: { type: 'text', text: '正常回答' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false)
      assert.deepStrictEqual(out, chunks)
    })

    // 12. 默认不检测工具参数循环
    await test('工具参数循环默认不触发', async () => {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'demo', argumentsDelta: 'x'.repeat(10) },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'demo', arguments: 'x'.repeat(10) } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false)
      assert.deepStrictEqual(out, chunks)
    })

    // 13. 文本循环触发时若有未闭合的工具调用块，一并正确闭合
    await test('停止时未闭合的 tool-call 块被正确闭合（罕见交错场景）', async () => {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'demo', argumentsDelta: '{"a":' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: '复读'.repeat(10) },
      ]
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true)
      const ends = out.filter((c) => c.type === 'block-end')
      assert.strictEqual(ends.length, 2, '两个打开的块都应闭合')
      const toolEnd = ends.find((c) => c.index === 0)
      assert.deepStrictEqual(toolEnd.block, {
        type: 'tool-call',
        id: 'call-9',
        name: 'demo',
        arguments: '{"a":',
      })
      const textEnd = ends.find((c) => c.index === 1)
      assert.deepStrictEqual(textEnd.block, { type: 'text', text: '复读'.repeat(10) })
      assert.strictEqual(out[out.length - 1].type, 'finish')
    })

    // 14. 触发后上游不再被继续拉取
    await test('触发后不再拉取上游剩余 chunk', async () => {
      const unit = '哦'.repeat(3)
      const chunks = textChunks(0, unit.repeat(10) + '这些内容不应被拉取')
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true)
      const upstreamTotal = chunks.length
      assert.ok(up.pulledCount() < upstreamTotal, '触发后应停止拉取上游')
      const deltaTexts = out
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.text)
        .join('')
      assert.ok(!deltaTexts.includes('这些内容不应被拉取'), '剩余文本不应出现在输出中')
    })

    // 15. 多个独立流互不串扰
    await test('多次调用之间状态互不串扰', async () => {
      const clean = textChunks(0, '正常的回答内容')
      const { out: out1, up: up1 } = await collect(clean)
      assert.strictEqual(up1.isClosed(), false)
      assert.deepStrictEqual(out1, clean)

      const { up: up2 } = await collect(textChunks(0, '卡'.repeat(10)))
      assert.strictEqual(up2.isClosed(), true)

      const { out: out3, up: up3 } = await collect(textChunks(0, '还是正常的回答'))
      assert.strictEqual(up3.isClosed(), false, '前一次触发不应污染后续流')
      assert.deepStrictEqual(out3, textChunks(0, '还是正常的回答'))
    })

    console.log('  通过 ' + passed + ' 项')
    return passed
  }
}

async function main() {
  console.log('dupguard tests（' + entries.length + ' 个入口）')
  let total = 0
  for (const entry of entries) {
    const plugin = entry.load()
    total += await runSuite(entry.label, plugin)()
  }
  console.log('\n全部通过：' + total + ' 项（2 个入口行为一致）')
}

main().catch((error) => {
  console.error('\n测试失败：', error)
  process.exitCode = 1
})
