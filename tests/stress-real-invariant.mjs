#!/usr/bin/env node
/**
 * 端到端协议压力验证（真实 DSH 实现，非桩）。
 *
 * 把本插件截停后的流分别喂给 DSH 自带的两个真实实现：
 *   1. `@deepseek-ai/dsh-llm/invariant` 的 validateStream —— 生产环境里包裹
 *      所有模型流的协议校验器（block-start/end 配对、finish 终止、usage 唯一、
 *      finish 之后不得再发 chunk）；
 *   2. `@deepseek-ai/dsh-llm` 的 BlockAssembler —— agent-loop 实际用来把 chunk
 *      装配成助手消息的装配器。
 *
 * 因为 invariant 以 `{ prepend: true }` 注册，它在瀑布里位于最外层：消费方看到的
 * 正是「本插件补发的合成块」，所以这条链路等价于生产路径。
 *
 * 运行：node tests/stress-real-invariant.mjs
 * DSH 安装位置探测顺序：$DSH_LLM_DIR → $DSH_INSTALL → $DSH_HOME/profiles/node_modules
 * → 全局 npm 安装（$APPDATA/npm/node_modules/@deepseek-ai/dsh）。找不到则打印 SKIP 并以 0 退出。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert'

const require = createRequire(import.meta.url)
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let passed = 0
let failed = 0
const metrics = []
const metric = (name, value, unit) => {
  metrics.push(['METRIC', name, String(value), unit].join(' '))
}
const ok = (label) => {
  passed++
  console.log('  ✓ ' + label)
}
const bad = (label, detail) => {
  failed++
  console.log('  ✗ FAIL ' + label + (detail === undefined ? '' : '：' + detail))
}

/** 探测 dsh-llm 包目录。 */
function findDshLlm() {
  const candidates = []
  if (process.env.DSH_LLM_DIR) candidates.push(process.env.DSH_LLM_DIR)
  if (process.env.DSH_INSTALL) candidates.push(join(process.env.DSH_INSTALL, 'node_modules', '@deepseek-ai', 'dsh-llm'))
  if (process.env.DSH_HOME) {
    candidates.push(join(process.env.DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm'))
    candidates.push(join(process.env.DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm'))
  }
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm'))
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

/** 简易上游流：记录 return() 调用次数与实际 pull 的 chunk 数。 */
function makeUpstream(chunks) {
  let closed = 0
  let pulled = 0
  async function* raw() {
    for (const chunk of chunks) {
      pulled++
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
  return { iterator, closedCount: () => closed, pulledCount: () => pulled }
}

const textChunks = (text, step = 4) => {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }]
  for (let i = 0; i < text.length; i += step) chunks.push({ type: 'text-delta', index: 0, text: text.slice(i, i + step) })
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  return chunks
}

async function main() {
  const dshLlm = findDshLlm()
  if (dshLlm === null) {
    console.log('SKIP 未找到 @deepseek-ai/dsh-llm 安装，跳过真实实现端到端校验')
    return
  }
  const version = JSON.parse(readFileSync(join(dshLlm, 'package.json'), 'utf8')).version
  console.log('dupguard 真实协议端到端校验（dsh-llm ' + version + '）')

  // ---- 真实 invariant：apply(ctx) → invariants.register(pkg, install) ----
  const invariant = await import(pathToFileURL(join(dshLlm, 'lib', 'invariant.js')).href)
  let install = null
  let captured = null
  const hookCtx = {
    on(name, listener) {
      if (name === 'llm/stream') captured = listener
      return () => {}
    },
    get: () => undefined,
  }
  await invariant.apply({ ...hookCtx, invariants: { register: (pkg, installer) => { install = installer } } })
  assert.strictEqual(typeof install, 'function', 'invariant 应通过 invariants.register 提供 install')
  install(hookCtx, (message) => {
    throw new Error('[llm-invariant] ' + message)
  })
  assert.strictEqual(typeof captured, 'function', 'invariant 应注册 llm/stream 监听器')

  // ---- 真实 BlockAssembler ----
  let BlockAssembler = null
  try {
    const assemblerModule = await import(pathToFileURL(join(dshLlm, 'lib', 'types', 'assembler.js')).href)
    BlockAssembler = assemblerModule.BlockAssembler
  } catch (error) {
    console.log('  (BlockAssembler 不可用，仅校验协议：' + error.message + ')')
  }

  // ---- 本插件（真实 lib/index.js）----
  const listeners = {}
  const fakeCtx = {
    get: () => undefined,
    inject: (keys, callback) => callback(fakeCtx),
    on: (name, listener) => {
      listeners[name] = listener
      return () => {}
    },
    effect: () => () => {},
  }
  require(join(here, '..', 'lib', 'index.js')).apply(fakeCtx)
  const guard = listeners['llm/stream']
  assert.strictEqual(typeof guard, 'function', '插件应注册 llm/stream 监听器')

  /** 走完整链路：插件守卫 → 真实 invariant → 真实装配器。 */
  async function runThroughRealStack(chunks) {
    const upstream = makeUpstream(chunks)
    const guarded = guard({ provider: 'stress', model: 'm' }, () => upstream.iterator)
    const validated = captured({ provider: 'stress', model: 'm' }, () => guarded)
    const out = []
    for await (const chunk of validated) out.push(chunk)
    let assembled = null
    if (BlockAssembler !== null) {
      const assembler = new BlockAssembler()
      for (const chunk of out) assembler.push(chunk)
      assembled = assembler
    }
    return { out, upstream, assembled }
  }

  const scenarios = [
    {
      name: 'text_hit',
      chunks: [...textChunks('a'.repeat(12)), { type: 'finish', reason: { kind: 'stop' } }],
      expectStop: true,
    },
    {
      name: 'multiblock_hit',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-start', index: 1, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 1, text: '思考' },
        { type: 'block-start', index: 2, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'demo', argumentsDelta: '{"a":1}' },
        { type: 'text-delta', index: 0, text: '重复'.repeat(10) },
      ],
      expectStop: true,
    },
    {
      name: 'hit_on_last_delta',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'ok' },
        { type: 'text-delta', index: 0, text: 'x'.repeat(10) },
      ],
      expectStop: true,
    },
    {
      name: 'reasoning_hit',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '想'.repeat(10) },
      ],
      expectStop: true,
    },
    {
      name: 'usage_before_hit',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'text-delta', index: 0, text: 'z'.repeat(10) },
      ],
      expectStop: true,
    },
    {
      name: 'empty_open_block',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'y'.repeat(10) },
      ],
      expectStop: true,
    },
    {
      name: 'no_hit_passthrough',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'hello ' },
        { type: 'text-delta', index: 0, text: 'world' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } },
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      expectStop: false,
    },
  ]

  for (const scenario of scenarios) {
    try {
      const { out, upstream, assembled } = await runThroughRealStack(scenario.chunks)
      const finishes = out.filter((chunk) => chunk.type === 'finish')
      assert.strictEqual(finishes.length, 1, '应恰好一个 finish，实际 ' + String(finishes.length))
      assert.strictEqual(out[out.length - 1].type, 'finish', 'finish 必须是最后一个 chunk')
      const open = new Map()
      for (const chunk of out) {
        if (chunk.type === 'block-start') open.set(chunk.index, chunk.blockType)
        if (chunk.type === 'block-end') {
          assert.strictEqual(open.get(chunk.index), chunk.block.type, 'block-end 类型需与 block-start 匹配')
          open.delete(chunk.index)
        }
      }
      if (scenario.expectStop) {
        assert.strictEqual(open.size, 0, '截停后不得有未闭合块')
        assert.strictEqual(finishes[0].reason.kind, 'stop', '截停的 finish 原因应为 stop')
        assert.ok(upstream.closedCount() >= 1, '截停必须调用上游 return()')
      } else {
        assert.deepStrictEqual(out, scenario.chunks, '无重复流必须逐块原样透传')
        assert.strictEqual(upstream.closedCount(), 0, '未截停时不应提前关闭上游')
      }
      if (assembled !== null) {
        assert.strictEqual(assembled.finish.kind, 'stop', '装配器应看到 stop 结束原因')
        const blocks = assembled.blocks()
        assert.ok(Array.isArray(blocks) && blocks.length >= 1, '装配器应产出至少一个块')
      }
      metric('scenario_' + scenario.name + '_chunks', out.length, 'chunks')
      ok(scenario.name + '（真实 invariant + 装配器通过）')
    } catch (error) {
      bad(scenario.name, error && error.message ? error.message : String(error))
    }
  }

  // 压力变体：多个场景重复跑，确认无状态泄漏
  try {
    const startedAt = Date.now()
    const rounds = 50
    for (let i = 0; i < rounds; i++) {
      await runThroughRealStack([...textChunks('q'.repeat(12)), { type: 'finish', reason: { kind: 'stop' } }])
      await runThroughRealStack(scenarios[6].chunks)
    }
    metric('stress_rounds', rounds * 2, 'runs')
    metric('stress_elapsed', Date.now() - startedAt, 'ms')
    ok('重复 ' + String(rounds * 2) + ' 次真实链路无异常')
  } catch (error) {
    bad('stress_loop', error && error.message ? error.message : String(error))
  }

  for (const line of metrics) console.log(line)
  console.log('RESULT ' + (failed === 0 ? 'PASS' : 'FAIL') + '（通过 ' + String(passed) + ' 项，失败 ' + String(failed) + ' 项）')
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('真实协议校验无法运行：', error)
  process.exitCode = 1
})
