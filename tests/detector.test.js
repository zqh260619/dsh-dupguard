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
const libCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8')
const entries = [
  {
    label: 'dynamic (plugin/host.js)',
    source: hostCode,
    load() {
      return new Function(hostCode)()
    },
  },
  {
    label: 'npm (lib/index.js)',
    source: libCode,
    load() {
      return require('../lib/index.js')
    },
  },
]

/** 把源码中的 monitorReasoning 开关替换后生成变体插件（用于验证开关行为）。 */
function makeReasoningOffVariant(entry) {
  const variantSource = entry.source.replace(/monitorReasoning: true/g, 'monitorReasoning: false')
  assert.notStrictEqual(variantSource, entry.source, entry.label + '：变体替换失败（未命中 monitorReasoning: true）')
  if (entry.label.startsWith('dynamic')) {
    return new Function(variantSource)()
  }
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', variantSource)(mod, mod.exports, require)
  return mod.exports
}

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
    get() {
      return undefined
    },
    inject(keys, callback) {
      callback(fakeCtx) // 模拟服务立即可用的注入
    },
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

    // 11. 默认检测 reasoning 循环并截停，且按协议闭合成 reasoning 块
    await test('reasoning 循环默认触发截停并正确闭合', async () => {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '想'.repeat(10) },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: '正常回答' },
      ]
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true, 'reasoning 循环应触发截停')
      const ends = out.filter((c) => c.type === 'block-end')
      assert.strictEqual(ends.length, 1, '只应闭合一个块（reasoning）')
      assert.deepStrictEqual(ends[0].block, { type: 'reasoning', text: '想'.repeat(10) })
      assert.strictEqual(out[out.length - 1].type, 'finish')
      assert.strictEqual(out[out.length - 1].reason.kind, 'stop')
    })

    // 11b. 正常 reasoning 不触发
    await test('正常 reasoning 不触发', async () => {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '让我想想怎么回答这个问题' },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: '让我想想怎么回答这个问题' } },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: '正常回答' },
        { type: 'block-end', index: 1, block: { type: 'text', text: '正常回答' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false, '正常 reasoning 不应触发')
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

    // 16. DSH standing-mount 兼容补丁：cordisInspect.register 幂等化
    await test('cordisInspect.register 幂等补丁（多代并存不再冲突）', async () => {
      // 复刻 dsh-cordis-host-runner 的注册语义：同 id 重复注册抛错
      const providers = new Map()
      const inspect = {
        providers,
        register(reg) {
          const id = reg.manifest.id
          if (providers.has(id)) {
            throw new Error('Host Cordis inspect provider "' + id + '" is already registered')
          }
          const stored = { ...reg, manifest: { ...reg.manifest } }
          providers.set(id, stored)
          return () => {
            if (providers.get(id) === stored) providers.delete(id)
          }
        },
      }
      const patchCtx = {
        get(name) {
          return name === 'cordisInspect' ? inspect : undefined
        },
        cordisInspect: inspect,
        inject(keys, callback) {
          callback(patchCtx) // 模拟服务立即可用的注入
        },
        on() {
          return () => {}
        },
      }
      plugin.apply(patchCtx) // 安装幂等补丁

      const reg = {
        manifest: { id: 'Service', description: 'test provider', methods: [] },
        query: async () => ({ ok: true }),
      }
      const first = inspect.register(reg) // 旧代（standing 第 N 代）
      const second = inspect.register(reg) // 新代（stamp 变化后的第 N+1 代）——未补丁时会抛错
      assert.ok(providers.has('Service'), '补丁后同 id 注册应共享已有注册')
      assert.strictEqual(typeof second, 'function', '新代应拿到 disposer')
      second() // 新代卸载：不得注销共享注册
      assert.ok(providers.has('Service'), '新代卸载不应注销共享注册')
      first() // 旧代卸载：正常注销
      inspect.register(reg) // 注册表清空后再次注册 → 走原语义
      assert.ok(providers.has('Service'), '清空后可再次正常注册')

      // 重复 apply（如 HMR 重载）不应叠加第二层补丁
      plugin.apply(patchCtx)
      inspect.register(reg)
      assert.ok(providers.has('Service'), '重复 apply 不叠加补丁、仍保持幂等')
    })

    // 17. Markdown 表格分隔行不触发（ignoredChars 白名单）
    await test('Markdown 表格分隔行不触发', async () => {
      const chunks = textChunks(0, '| 列1 | 列2 | 列3 | 列4 | 列5 |\n| --- | --- | --- | --- | --- |')
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false, '表格分隔行不应触发截停')
      assert.deepStrictEqual(out, chunks)
    })

    // 18. 多列表格分隔行不触发（连字符与竖线均被忽略）
    await test('多列表格分隔行不触发', async () => {
      const chunks = textChunks(0, '|---|---|---|---|---|---|---|---|---|---|')
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false, '多列表格分隔行不应触发截停')
      assert.deepStrictEqual(out, chunks)
    })

    // 19. 长分隔线整行不触发
    await test('长分隔线整行不触发', async () => {
      const chunks = textChunks(0, '------------------------------')
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false, '分隔线不应触发截停')
      assert.deepStrictEqual(out, chunks)
    })

    // 20. 白名单字符夹在真实复读中仍触发（移除后模式重复依旧被识别）
    await test('带连字符的模式复读仍触发', async () => {
      const chunks = textChunks(0, ('-ab-').repeat(10))
      const { up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), true, '移除白名单字符后的模式复读应被识别')
    })

    // 21. 围栏代码块内放宽阈值：15 次重复不触发（默认倍数 3 → 需 30 次）
    await test('围栏代码块内放宽阈值（15 次重复不触发）', async () => {
      const body = [
        '```js',
        'const t = [' + '1, '.repeat(15) + ']',
        '```',
        '以上是生成的代码。',
      ].join('\n')
      const chunks = textChunks(0, body)
      const { out, up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false, '代码块内 15 次重复不应触发（放宽阈值 30）')
      assert.deepStrictEqual(out, chunks)
    })

    // 22. 围栏代码块内的失控复读仍会被兜住（≥ 倍数阈值）
    await test('围栏代码块内失控复读仍被截停（≥30 次）', async () => {
      const body = '```\n' + 'x'.repeat(40) + '\n```'
      const { up } = await collect(textChunks(0, body))
      assert.strictEqual(up.isClosed(), true, '代码块内 40 次重复应触发（放宽阈值 30）')
    })

    // 23. 围栏标记跨增量切分仍被识别
    await test('围栏标记被切分时仍按代码块放宽', async () => {
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '``' },
        { type: 'text-delta', index: 0, text: '`js\n' },
        { type: 'text-delta', index: 0, text: 'q'.repeat(15) },
        { type: 'text-delta', index: 0, text: '\n``' },
        { type: 'text-delta', index: 0, text: '`' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      const { up } = await collect(chunks)
      assert.strictEqual(up.isClosed(), false, '被切分的围栏仍应放宽（15 次不触发）')
    })

    // 24. 行内代码与不足 3 个反引号的行不构成代码块 → 仍按普通阈值
    await test('行内代码/不足三个反引号不构成代码块', async () => {
      const inline = textChunks(0, '说明 `code` 之后：' + 'z'.repeat(12))
      const inlineResult = await collect(inline)
      assert.strictEqual(inlineResult.up.isClosed(), true, '行内代码不应放宽阈值')

      const twoTicks = textChunks(0, '``\n' + 'y'.repeat(12))
      const twoTicksResult = await collect(twoTicks)
      assert.strictEqual(twoTicksResult.up.isClosed(), true, '两个反引号不构成围栏')
    })

    // 25. 长围栏不能被短围栏关闭（```` 开启后 ``` 只是代码内容）
    await test('长围栏不被短围栏关闭', async () => {
      const body = '````md\n' + '```\n' + 'a'.repeat(15) + '\n' + '```\n' + '````'
      const { up } = await collect(textChunks(0, body))
      assert.strictEqual(up.isClosed(), false, '四反引号围栏内的 15 次重复应仍按代码块放宽')
    })

    // 26. 波浪号围栏同样生效
    await test('波浪号围栏同样放宽', async () => {
      const body = '~~~\n' + 'b'.repeat(15) + '\n~~~'
      const { up } = await collect(textChunks(0, body))
      assert.strictEqual(up.isClosed(), false, '~~~ 围栏内 15 次重复不应触发')
      const runaway = await collect(textChunks(0, '~~~\n' + 'b'.repeat(35) + '\n~~~'))
      assert.strictEqual(runaway.up.isClosed(), true, '~~~ 围栏内 35 次重复应触发')
    })

    // 27. 围栏外文本仍按普通阈值（代码块前后都不受影响）
    await test('围栏外文本仍按普通阈值', async () => {
      const before = await collect(textChunks(0, 'c'.repeat(12) + '\n```\ncode\n```'))
      assert.strictEqual(before.up.isClosed(), true, '围栏前的复读应触发')
      const after = await collect(textChunks(0, '```\ncode\n```\n' + 'd'.repeat(12)))
      assert.strictEqual(after.up.isClosed(), true, '围栏后的复读应触发')
    })

    console.log('  通过 ' + passed + ' 项')
    return passed
  }
}

/** 变体套件：monitorReasoning 置为 false 时，reasoning 循环不触发（验证开关可关闭）。 */
async function runReasoningOffSuite(label, plugin) {
  const listeners = {}
  const fakeCtx = {
    get() {
      return undefined
    },
    inject(keys, callback) {
      callback(fakeCtx) // 模拟服务立即可用的注入
    },
    on(name, fn) {
      listeners[name] = fn
      return () => {}
    },
  }
  plugin.apply(fakeCtx)
  assert.strictEqual(typeof listeners['llm/stream'], 'function', label + '：应注册 llm/stream 监听器')

  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '想'.repeat(10) },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想'.repeat(10) } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '正常回答' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '正常回答' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const up = makeUpstream(chunks)
  const wrapped = listeners['llm/stream']({ provider: 'test', model: 'test-model' }, () => up.iterator)
  const out = []
  for await (const chunk of wrapped) out.push(chunk)
  assert.strictEqual(up.isClosed(), false, label + '：monitorReasoning=false 时 reasoning 循环不应触发')
  assert.deepStrictEqual(out, chunks, label + '：monitorReasoning=false 时应全量透传')
  console.log('· ' + label + '（monitorReasoning=false 变体）')
  console.log('  ✓ reasoning 循环不触发、全量透传')
  return 1
}

/** 设置集成套件（仅 npm 常驻版）：settings 服务注册、参数读取与热更新。 */
async function runSettingsSuite(entry) {
  if (!entry.label.startsWith('npm')) return 0
  const listeners = {}
  const watchers = []
  const settingsStub = {
    register(ns, schema, options) {
      assert.strictEqual(ns, 'dsh-dupguard', '命名空间应为 dsh-dupguard')
      settingsStub.base = options.base
      settingsStub.validate = options.validate
      settingsStub.schema = schema
      settingsStub._current = { ...options.base, ignoredChars: [...options.base.ignoredChars] }
      return {
        get: () => settingsStub._current,
        watch(cb) {
          watchers.push(cb)
          return () => {}
        },
        update() {},
        replace() {},
      }
    },
  }
  const fakeCtx = {
    get() {
      return undefined
    },
    settings: settingsStub,
    inject(keys, callback) {
      callback(fakeCtx) // 模拟服务立即可用的注入
    },
    on(name, fn) {
      listeners[name] = fn
      return () => {}
    },
    effect() {
      return () => {}
    },
  }
  const plugin = entry.load()
  plugin.apply(fakeCtx)
  // 设置注册现在经动态 import 惰性加载 schema（Node 18 兼容），
  // 轮询等待注册完成后再断言 watcher。
  for (let i = 0; i < 100 && watchers.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.strictEqual(typeof listeners['llm/stream'], 'function')
  assert.ok(watchers.length > 0, '应注册设置 watcher')

  async function collect(chunks) {
    const up = makeUpstream(chunks)
    const wrapped = listeners['llm/stream']({ provider: 'test', model: 'test-model' }, () => up.iterator)
    const out = []
    for await (const chunk of wrapped) out.push(chunk)
    return { out, up }
  }
  const warnLog = []
  const originalWarn = console.warn
  const notify = () => {
    console.warn = (...args) => {
      warnLog.push(args.map((arg) => String(arg)).join(' '))
    }
    try {
      for (const cb of watchers) cb()
    } finally {
      console.warn = originalWarn
    }
  }
  /** 以一份完整设置值热更新（未给出的字段沿用 base 默认）。 */
  const applySettings = (patch) => {
    settingsStub._current = { ...settingsStub.base, ignoredChars: [...settingsStub.base.ignoredChars], ...patch }
    warnLog.length = 0
    notify()
  }
  const toolCallChunks = (args) => [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'demo', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'demo', arguments: args } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  console.log('· ' + entry.label + '（settings 集成）')
  let passed = 0

  // S0：注册内容 —— base 覆盖全部可设置字段、schema 带边界、validate 拒绝跨字段违规
  {
    const base = settingsStub.base
    assert.deepStrictEqual(base.ignoredChars, ['-', '|'], 'base 应含默认白名单')
    assert.strictEqual(base.threshold, 10, 'base 应含默认阈值')
    assert.strictEqual(base.minUnitLength, 1, 'base 应含默认最小单元')
    assert.strictEqual(base.maxUnitLength, 80, 'base 应含默认最大单元')
    assert.strictEqual(base.detectionWindow, 8192, 'base 应含默认窗口')
    assert.strictEqual(base.stripWhitespace, true, 'base 应含空白开关')
    assert.strictEqual(base.skipCodeBlocks, true, 'base 应含代码块放宽开关')
    assert.strictEqual(base.codeBlockMultiplier, 3, 'base 应含代码块倍数')
    assert.strictEqual(base.monitorReasoning, true, 'base 应含 reasoning 开关')
    assert.strictEqual(base.monitorToolArguments, false, 'base 应含工具参数开关')

    const resolved = settingsStub.schema({})
    assert.strictEqual(resolved.threshold, 10, 'schema 默认阈值应为 10')
    assert.strictEqual(resolved.maxUnitLength, 80, 'schema 默认最大单元应为 80')
    assert.strictEqual(resolved.codeBlockMultiplier, 3, 'schema 默认代码块倍数应为 3')
    assert.strictEqual(resolved.skipCodeBlocks, true, 'schema 默认应开启代码块放宽')
    assert.throws(() => settingsStub.schema({ threshold: 1 }), /threshold/, 'schema 应拒绝低于下界的阈值')
    assert.throws(() => settingsStub.schema({ threshold: 10.5 }), /threshold/, 'schema 应拒绝非整数阈值')
    assert.throws(() => settingsStub.schema({ detectionWindow: 1 }), /detectionWindow/, 'schema 应拒绝过小的窗口')
    assert.throws(() => settingsStub.schema({ codeBlockMultiplier: -1 }), /codeBlockMultiplier/, 'schema 应拒绝负数倍数')
    assert.throws(() => settingsStub.schema({ codeBlockMultiplier: 101 }), /codeBlockMultiplier/, 'schema 应拒绝大于 100 的倍数')
    assert.strictEqual(
      settingsStub.schema({ codeBlockMultiplier: 0 }).codeBlockMultiplier,
      0,
      '倍数 0 合法（哨兵值：代码块内完全不检测）',
    )

    assert.strictEqual(typeof settingsStub.validate, 'function', '应声明跨字段 validate')
    assert.throws(
      () => settingsStub.validate({ minUnitLength: 5, maxUnitLength: 4 }),
      /不能小于/,
      'validate 应拒绝 最大单元 < 最小单元',
    )
    settingsStub.validate({ minUnitLength: 5, maxUnitLength: 5 })
    console.log('  ✓ 注册内容：base/schema 边界/跨字段 validate')
    passed++
  }
  // S1：默认 base（连字符与竖线）→ 多列表格分隔行不触发
  {
    const { up } = await collect(textChunks(0, '|'.repeat(11)))
    assert.strictEqual(up.isClosed(), false, '默认白名单下竖线连串不应触发')
    console.log('  ✓ 默认 base 生效（竖线不计数）')
    passed++
  }
  // S2：设置改为只忽略连字符 → 竖线开始计数 → 触发
  {
    applySettings({ ignoredChars: ['-'] })
    const { up } = await collect(textChunks(0, '|'.repeat(11)))
    assert.strictEqual(up.isClosed(), true, '白名单收窄后竖线连串应触发')
    console.log('  ✓ 白名单热更新生效（竖线开始计数并触发）')
    passed++
  }
  // S3：清空白名单 → 连字符也计数 → 表格分隔行触发
  {
    applySettings({ ignoredChars: [] })
    const { up } = await collect(textChunks(0, '------------------------------'))
    assert.strictEqual(up.isClosed(), true, '清空白名单后连字符连串应触发')
    console.log('  ✓ 清空白名单后连字符开始计数并触发')
    passed++
  }
  // S4：阈值热更新 → 3 次重复即触发
  {
    applySettings({ threshold: 3 })
    const { up } = await collect(textChunks(0, 'aaa'))
    assert.strictEqual(up.isClosed(), true, '阈值降为 3 后 "aaa" 应触发')
    console.log('  ✓ 阈值热更新生效（重复 3 次即截停）')
    passed++
  }
  // S5：最小单元长度热更新 → 短单元不再参与检测
  {
    applySettings({ minUnitLength: 5 })
    const { up } = await collect(textChunks(0, 'ab'.repeat(10)))
    assert.strictEqual(up.isClosed(), false, '最小单元为 5 时 "ab" 复读不应触发')
    console.log('  ✓ 最小单元长度热更新生效（短单元不触发）')
    passed++
  }
  // S6：窗口小于 阈值 × 最大单元长度 → 长单元无法识别，且打出「窗口长度需要提高」告警
  {
    const text = 'abcdefghijkl'.repeat(10) // 12 字符单元 ×10 = 120 字符
    applySettings({ detectionWindow: 80, threshold: 10, maxUnitLength: 80 })
    assert.ok(
      warnLog.some((line) => line.indexOf('检测窗口长度需要提高') !== -1),
      '窗口偏小时应打出「检测窗口长度需要提高」告警',
    )
    const { up } = await collect(textChunks(0, text))
    assert.strictEqual(up.isClosed(), false, '窗口 80 时 12 字符单元的复读不应触发')
    console.log('  ✓ 窗口偏小：长单元不识别并告警')
    passed++
  }
  // S7：窗口恢复到默认 → 同一段落触发
  {
    const text = 'abcdefghijkl'.repeat(10)
    applySettings({ detectionWindow: 8192, threshold: 10, maxUnitLength: 80 })
    assert.strictEqual(warnLog.length, 0, '窗口充足时不应告警')
    const { up } = await collect(textChunks(0, text))
    assert.strictEqual(up.isClosed(), true, '窗口充足时同一段落应触发')
    console.log('  ✓ 窗口恢复后长单元触发')
    passed++
  }
  // S8：空白开关热更新 → 关闭后带分隔的复读不再识别
  {
    const text = 'a a a a a a a a a a' // 10 个 a 以空格分隔
    applySettings({ stripWhitespace: true })
    const withStrip = await collect(textChunks(0, text))
    assert.strictEqual(withStrip.up.isClosed(), true, '忽略空白时 "a a a ..." 应触发')
    applySettings({ stripWhitespace: false })
    const withoutStrip = await collect(textChunks(0, text))
    assert.strictEqual(withoutStrip.up.isClosed(), false, '不忽略空白时同一文本不应触发')
    console.log('  ✓ 空白开关热更新生效')
    passed++
  }
  // S9：工具参数开关热更新 → 开启后工具参数复读触发
  {
    applySettings({ monitorToolArguments: true })
    const { up } = await collect(toolCallChunks('x'.repeat(10)))
    assert.strictEqual(up.isClosed(), true, '开启后工具参数复读应触发')
    applySettings({ monitorToolArguments: false })
    const off = await collect(toolCallChunks('x'.repeat(10)))
    assert.strictEqual(off.up.isClosed(), false, '关闭后工具参数复读不应触发')
    console.log('  ✓ 工具参数开关热更新生效')
    passed++
  }
  // S10：恢复默认 → 阈值回到 10、白名单回到连字符与竖线
  {
    applySettings({})
    const short = await collect(textChunks(0, 'aaa'))
    assert.strictEqual(short.up.isClosed(), false, '恢复默认后 3 次重复不应触发')
    const table = await collect(textChunks(0, '------------------------------'))
    assert.strictEqual(table.up.isClosed(), false, '恢复默认后分隔线不应触发')
    console.log('  ✓ 恢复默认后回到代码默认值')
    passed++
  }
  // S11：白名单按单个字符匹配 —— 多字符/空条目被丢弃并告警
  {
    applySettings({ ignoredChars: ['ab', ''] })
    assert.ok(
      warnLog.some((line) => line.indexOf('白名单条目必须是单个字符') !== -1),
      '多字符/空条目应触发白名单告警',
    )
    const multi = await collect(textChunks(0, 'ab'.repeat(10)))
    assert.strictEqual(multi.up.isClosed(), true, '多字符条目不应生效（"ab" 复读仍应触发）')
    applySettings({ ignoredChars: ['a'] })
    const single = await collect(textChunks(0, 'a'.repeat(10)))
    assert.strictEqual(single.up.isClosed(), false, '单字符条目应生效（"a" 复读被忽略）')
    console.log('  ✓ 白名单按字符匹配（多字符条目丢弃并告警）')
    passed++
  }
  // S12：代码块放宽默认生效 —— 块内 15 次重复（≥10 但 < 3×10）不触发，块外仍按原阈值
  {
    const fenced = '```js\n' + 'q'.repeat(15) + '\n```'
    const relaxed = await collect(textChunks(0, fenced))
    assert.strictEqual(relaxed.up.isClosed(), false, '默认（倍数 3）下代码块内 15 次重复不应触发')
    const plain = await collect(textChunks(0, 'q'.repeat(15)))
    assert.strictEqual(plain.up.isClosed(), true, '代码块外 15 次重复仍应触发')
    console.log('  ✓ 代码块内放宽阈值默认生效（倍数 3）')
    passed++
  }
  // S13：关闭 skipCodeBlocks → 代码块内恢复普通阈值
  {
    applySettings({ skipCodeBlocks: false })
    const { up } = await collect(textChunks(0, '```js\n' + 'q'.repeat(15) + '\n```'))
    assert.strictEqual(up.isClosed(), true, '关闭放宽后代码块内 15 次重复应触发')
    applySettings({ skipCodeBlocks: true })
    console.log('  ✓ skipCodeBlocks 热更新生效')
    passed++
  }
  // S14：倍数热更新 —— 1 等价于不放宽，50 让 40 次重复也不触发
  {
    applySettings({ codeBlockMultiplier: 1 })
    const strict = await collect(textChunks(0, '```\n' + 'q'.repeat(15) + '\n```'))
    assert.strictEqual(strict.up.isClosed(), true, '倍数 1 时代码块内 15 次重复应触发')
    applySettings({ codeBlockMultiplier: 50 })
    const loose = await collect(textChunks(0, '```\n' + 'q'.repeat(40) + '\n```'))
    assert.strictEqual(loose.up.isClosed(), false, '倍数 50 时代码块内 40 次重复不应触发')
    const outside = await collect(textChunks(0, 'q'.repeat(15)))
    assert.strictEqual(outside.up.isClosed(), true, '倍数不影响代码块外的判定')
    applySettings({ codeBlockMultiplier: 3 })
    console.log('  ✓ 代码块倍数热更新生效（1 = 不放宽，50 = 放宽到 500 次）')
    passed++
  }
  // S15：窗口缺口按「阈值 × 倍数」计算（倍数放大后窗口要求随之提高）
  {
    applySettings({ threshold: 10, maxUnitLength: 80, detectionWindow: 500, codeBlockMultiplier: 3 })
    assert.ok(
      warnLog.some((line) => line.indexOf('检测窗口长度需要提高') !== -1 && line.indexOf('2400') !== -1),
      '窗口 500 < 10 × 3 × 80 = 2400 时应提示所需窗口 2400，实际：' + JSON.stringify(warnLog),
    )
    applySettings({ codeBlockMultiplier: 1 })
    assert.ok(
      warnLog.every((line) => line.indexOf('检测窗口长度需要提高') === -1),
      '倍数为 1 时窗口 500 ≥ 10 × 80 = 800，不应再提示，实际：' + JSON.stringify(warnLog),
    )
    applySettings({ detectionWindow: 8192, codeBlockMultiplier: 3 })
    console.log('  ✓ 窗口缺口按「阈值 × 代码块倍数 × 最大单元」计算')
    passed++
  }
  // S16：倍数 0 = 代码块内完全不检测（不跨围栏拼接、块外不受影响）
  {
    applySettings({ codeBlockMultiplier: 0, threshold: 10, ignoredChars: [] })
    const small = await collect(textChunks(0, '```\n' + 'm'.repeat(15) + '\n```'))
    assert.strictEqual(small.up.isClosed(), false, '倍数 0 时块内 15 次不应触发')
    const huge = await collect(textChunks(0, '```\n' + 'm'.repeat(200) + '\n```'))
    assert.strictEqual(huge.up.isClosed(), false, '倍数 0 时块内 200 次也不应触发')
    const outside = await collect(textChunks(0, 'm'.repeat(12)))
    assert.strictEqual(outside.up.isClosed(), true, '倍数 0 不影响块外判定')
    const acrossFence = await collect(textChunks(0, 'm'.repeat(9) + '\n```\ncode\n```\n' + 'm'.repeat(9)))
    assert.strictEqual(acrossFence.up.isClosed(), false, '围栏两侧的重复不得拼接触发')
    const afterFence = await collect(textChunks(0, '```\ncode\n```\n' + 'm'.repeat(12)))
    assert.strictEqual(afterFence.up.isClosed(), true, '代码块之后的复读应触发')
    // 倍数 0 不应提高窗口要求（块内完全不检测）：窗口 1000 满足 10 × 80 = 800，无告警
    applySettings({ detectionWindow: 1000, maxUnitLength: 80, codeBlockMultiplier: 0 })
    assert.ok(
      warnLog.every((line) => line.indexOf('检测窗口长度需要提高') === -1),
      '倍数 0 时窗口要求不放大（1000 ≥ 10 × 80），实际：' + JSON.stringify(warnLog),
    )
    // 对照：同一窗口在倍数 3 下要求 10 × 3 × 80 = 2400，应告警
    applySettings({ detectionWindow: 1000, maxUnitLength: 80, codeBlockMultiplier: 3 })
    assert.ok(
      warnLog.some((line) => line.indexOf('检测窗口长度需要提高') !== -1),
      '倍数 3 时窗口 1000 < 2400 应告警，实际：' + JSON.stringify(warnLog),
    )
    applySettings({ detectionWindow: 8192, codeBlockMultiplier: 3 })
    console.log('  ✓ 倍数 0：代码块内完全不检测（且不跨围栏拼接、不放大窗口要求）')
    passed++
  }
  return passed
}

async function main() {
  console.log('dupguard tests（' + entries.length + ' 个入口）')
  let total = 0
  for (const entry of entries) {
    const plugin = entry.load()
    total += await runSuite(entry.label, plugin)()
  }
  for (const entry of entries) {
    const variant = makeReasoningOffVariant(entry)
    total += await runReasoningOffSuite(entry.label, variant)
  }
  for (const entry of entries) {
    total += await runSettingsSuite(entry)
  }
  console.log('\n全部通过：' + total + ' 项（2 个入口行为一致，含 reasoning 开关与 settings 集成套件）')
}

main().catch((error) => {
  console.error('\n测试失败：', error)
  process.exitCode = 1
})
