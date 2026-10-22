'use strict'

// ============================================================================
// 宿主测试桩（notify.test.js / stop-log.test.js 共用）
//
// 提供：
//   - makeCtx(services)：最小宿主演入 ctx（inject / on / effect / get 语义与真实一致）；
//   - makeUpstream(chunks)：可控的上游 AsyncIterable（含 isClosed 观测）；
//   - textChunks(index, text, step)：把一段文本拆成 LLM 流式 chunk 序列。
//
// 约定：ctx.get() 必须解析不到 root 服务（插件禁止用它拿服务，否则通知通道不注册）。
// ============================================================================

/** 组装一个最小宿主 ctx（可注入 sessions / sessionTitle / workspaceRegistry / agents / webServer / settings）。 */
function makeCtx(services) {
  const listeners = {}
  const routes = []
  const scope = services === undefined ? {} : services
  const ctx = {
    fiber: undefined,
    services: scope,
    // 服务挂在作用域上（插件读 settingsCtx.settings / webCtx.webServer）
    settings: scope.settings,
    webServer: scope.webServer,
    sessions: scope.sessions,
    sessionTitle: scope.sessionTitle,
    workspaceRegistry: scope.workspaceRegistry,
    agents: scope.agents,
    // 与真实 loader entry ctx 一致：get() **解析不到 root 服务**——用 ctx.get 拿服务的写法会立刻失败。
    // （本插件曾因此出现"路由没注册、通知永远不弹"，这里刻意保留该约定以防回归。）
    get() {
      return undefined
    },
    inject(keys, callback) {
      // 与 cordis 一致：依赖缺席时不回调；这里全部视为可用，交给插件内部再判空。
      const disposer = callback(ctx)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on(name, listener) {
      listeners[name] = listener
      return () => {
        delete listeners[name]
      }
    },
    // cordis 的 effect：函数体立即执行，返回值作为注销器。
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : undefined
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    console,
    setTimeout,
    clearTimeout,
  }
  return { ctx, listeners, routes }
}

/** 可控上游流：逐块产出，并记录是否被提前 return()（截停应关闭上游）。 */
function makeUpstream(chunks) {
  const gen = (function* generate() {
    for (const chunk of chunks) yield chunk
  })()
  let closed = false
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
  return { iterator, isClosed: () => closed }
}

/** 把一段文本拆成 LLM 流式 chunk 序列（首个 block-start，末尾 block-end + finish）。 */
function textChunks(index, text, step = 4) {
  const chunks = [{ type: 'block-start', index, blockType: 'text' }]
  for (let i = 0; i < text.length; i += step) chunks.push({ type: 'text-delta', index, text: text.slice(i, i + step) })
  chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

module.exports = { makeCtx, makeUpstream, textChunks }
