// ============================================================================
// 诊断实验（不进 CI）：dupguard 截停时，上游关闭链是否等待底层 HTTP 流的 cancel 完成。
//
// 使用真实 DeepSeekAdapter（路径经 DSH_ADAPTER_PATH 指定，默认指向本机 profile 安装），
// mock fetch 返回一个 SSE 流：推送 10 个 text-delta（触发 dupguard 截停）后保持打开，
// 其 cancel() 可配置延迟（模拟网络层慢速取消 / 半开连接）。
//
// 结论（已证实）：截停链不等待底层流 cancel —— cancel 挂起 3s 时截停仅 ~1ms 完成。
// 因此截停路径不会阻塞 agent-loop（不是"截停后会话卡死"的来源）。
//
// 运行：node tests/experiment-cancel.mjs
//        DSH_ADAPTER_PATH=<dsh-llm-deepseek/lib/index.js 的 file: URL> node tests/experiment-cancel.mjs
// ============================================================================

const ADAPTER_URL =
  process.env.DSH_ADAPTER_PATH ??
  'file:///C:/Users/Administrator/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js'

const { DeepSeekAdapter } = await import(ADAPTER_URL)
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dupguard = require('../lib/index.js')

const listeners = {}
const fakeCtx = {
  on(name, fn) {
    listeners[name] = fn
    return () => {}
  },
}
dupguard.apply(fakeCtx)

/** 用 lib/index.js 的 llm/stream 监听器包装一个上游流。 */
function wrap(stream) {
  return listeners['llm/stream']({ provider: 'deepseek-official', model: 'test-model' }, () => stream)
}

/** mock fetch：推送 10 个 "你好" delta 后保持打开；cancel 延迟可控。 */
function makeFetch(cancelDelayMs) {
  return async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i++) {
          const payload = JSON.stringify({
            id: 'chunk-' + i,
            choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
          })
          controller.enqueue(encoder.encode('data: ' + payload + '\n\n'))
        }
        // 故意保持打开：真实服务端此刻仍在生成
      },
      cancel() {
        if (cancelDelayMs > 0) {
          return new Promise((resolve) => setTimeout(resolve, cancelDelayMs))
        }
        return undefined
      },
    })
    return new Response(body, { status: 200 })
  }
}

const adapter = new DeepSeekAdapter({
  options: () => ({
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://mock.local',
    defaults: { thinking: 'disabled', reasoningEffort: 'off' },
    maxTokens: 1000,
    defaultContextWindow: 1000,
    models: [{ id: 'test-model', name: 'test', contextWindow: 1000, maxTokens: 1000 }],
    streamIdleTimeoutMs: 300000,
  }),
  resolveApiKey: async () => 'test-key',
  resolveUserId: () => 'u1',
})

async function run(label, cancelDelayMs) {
  globalThis.fetch = makeFetch(cancelDelayMs)
  const upstream = adapter.stream({
    provider: 'deepseek-official',
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  const wrapped = wrap(upstream)
  const t0 = Date.now()
  let count = 0
  let finishType = null
  try {
    for await (const chunk of wrapped) {
      count++
      if (chunk.type === 'finish') finishType = chunk.reason.kind
    }
  } catch (error) {
    const chain = []
    let e = error
    while (e) {
      chain.push(String(e?.message ?? e))
      e = e.cause
    }
    console.log(label + ': 异常 ' + chain.join(' <= '))
    return
  }
  const elapsed = Date.now() - t0
  console.log(label + ': chunks=' + count + ' finish=' + finishType + ' elapsed=' + elapsed + 'ms')
}

// 场景 A：cancel 立即完成（基线）
await run('A cancel=0ms  ', 0)
// 场景 B：cancel 挂起 3000ms（模拟慢速/半开网络连接）
await run('B cancel=3000ms', 3000)

console.log('若 B 的 elapsed 接近 3000ms，则截停路径确实阻塞在底层流取消上。')
process.exit(0)
