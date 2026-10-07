/**
 * dupguard 截停通知测试（宿主侧）。
 *
 * 覆盖三件事：
 *   1. 通知队列本身（入队 / 上限 / 状态流转 / 展示裁剪）；
 *   2. 会话元数据解析（工作区路径 + 工作区名称 + 会话标题，服务缺失时降级为 null）；
 *   3. 端到端：一次真实截停 → 通知入队 → HTTP 列表 → 用户「发送继续指令」→ 宿主注入消息。
 *
 * 与 detector.test.js 一样，测试必须与开发机环境隔离（不读真实 profile 配置）。
 */
'use strict'

delete process.env.DSH_PROFILE_DIR

const assert = require('node:assert')
const path = require('node:path')

const plugin = require(path.join(__dirname, '..', 'lib', 'index.js'))
const notify = plugin.__notify

let passed = 0
const ok = (label) => {
  console.log('  ✓ ' + label)
  passed += 1
}

// ---- 上游流 ------------------------------------------------------------------
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

function textChunks(index, text, step = 4) {
  const chunks = [{ type: 'block-start', index, blockType: 'text' }]
  for (let i = 0; i < text.length; i += step) chunks.push({ type: 'text-delta', index, text: text.slice(i, i + step) })
  chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

/** 假的 HTTP 请求/响应（足够驱动 WebRoute handler）。 */
function fakeHttp(method, url, body, headers) {
  const request = {
    method,
    url,
    headers: headers === undefined ? { host: '127.0.0.1:3080' } : headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8')
    },
  }
  const response = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, responseHeaders) {
      response.status = status
      response.headers = responseHeaders
    },
    end(text) {
      response.body = text === undefined ? '' : String(text)
    },
  }
  return { request, response }
}

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

// ---- T1：通知队列 --------------------------------------------------------------
function testQueue() {
  const notifier = notify.createStopNotifier()
  assert.deepStrictEqual(notifier.list(), [], '新队列应为空')
  const first = notifier.push({ sessionId: 's-1', unit: 'a', count: 10, span: 10, source: 'text' })
  assert.strictEqual(first.id, 'dupguard-stop-1', 'id 应递增（dupguard-stop-N）')
  assert.strictEqual(first.status, 'pending', '新通知应为 pending')
  const second = notifier.push({ sessionId: 's-2', unit: 'b', count: 3, span: 6, code: true, source: 'reasoning' })
  const list = notifier.list()
  assert.strictEqual(list.length, 2, '应入队两条')
  assert.strictEqual(list[0].id, second.id, '最新通知应排在最前')
  assert.strictEqual(list[0].code, true, '代码区域内命中应保留 code 标记')
  assert.strictEqual(list[0].source, 'reasoning', '应保留通道来源')
  assert.strictEqual(notifier.find(first.id).status, 'pending', 'find 应按 id 命中')

  // 上限：只保留最近 NOTIFY_LIMIT 条。
  for (let i = 0; i < notify.NOTIFY_LIMIT + 5; i++) notifier.push({ sessionId: 's-x', unit: 'x', count: 2, span: 2 })
  assert.strictEqual(notifier.list().length, notify.NOTIFY_LIMIT, '队列应裁剪到上限 ' + String(notify.NOTIFY_LIMIT))
  ok('通知队列：入队 / 顺序 / 状态 / 上限裁剪')

  // 展示裁剪：超长重复串按码点截断（emoji 与中文都不能被切成半个）。
  const long = '重'.repeat(200)
  const pushed = notifier.push({ sessionId: 's-3', unit: long, count: 10, span: 2000 })
  const view = notifier.find(pushed.id)
  const shown = notify.publicNotice(view)
  assert.strictEqual([...shown.unit].length, notify.NOTIFY_UNIT_MAX, '展示串应截断到 ' + String(notify.NOTIFY_UNIT_MAX) + ' 码点')
  assert.strictEqual(shown.unitLength, 200, 'unitLength 应保留真实长度')
  assert.strictEqual(shown.unitTruncated, true, '应标记已截断')
  const emoji = notifier.push({ sessionId: 's-4', unit: '😀'.repeat(200), count: 10, span: 200 })
  assert.strictEqual(notify.publicNotice(notifier.find(emoji.id)).unitTruncated, true, 'emoji 串同样按码点截断')
  assert.strictEqual([...notify.publicNotice(notifier.find(emoji.id)).unit].length, notify.NOTIFY_UNIT_MAX, 'emoji 不得被切成半个')
  ok('展示裁剪：超长重复串按码点截断且保留真实长度')
}

// ---- T2：会话元数据 ------------------------------------------------------------
function testDescribe() {
  const session = { header: { id: 'sess-1', cwd: 'D:\\Work\\Repo' } }
  const services = {
    sessions: { get: (id) => (id === 'sess-1' ? session : undefined) },
    sessionTitle: { get: (s) => (s === session ? { title: '修复登录流程' } : undefined) },
    workspaceRegistry: {
      list: () => [
        { id: 'w1', path: 'd:/work/repo/', title: '工作区甲' },
        { id: 'w2', path: 'D:\\Other', title: '工作区乙' },
      ],
    },
  }
  const info = notify.describeStoppedSession(services, 'sess-1')
  assert.strictEqual(info.workspacePath, 'D:\\Work\\Repo', '应取会话 header.cwd 作为工作区路径')
  assert.strictEqual(info.workspaceTitle, '工作区甲', '应按路径（大小写 / 分隔符 / 末尾斜杠归一）匹配工作区名称')
  assert.strictEqual(info.sessionTitle, '修复登录流程', '应取 sessionTitle 服务的标题')
  ok('会话元数据：工作区路径 + 工作区名称 + 会话标题（含 Windows 路径归一）')

  // 服务缺失 / 会话不存在：全部降级为 null，且不得抛错。
  assert.deepStrictEqual(
    notify.describeStoppedSession({}, 'sess-1'),
    { sessionTitle: null, workspacePath: null, workspaceTitle: null },
    '服务缺失时应全部为 null',
  )
  const partial = { sessions: { get: () => ({ header: {} }) } }
  assert.strictEqual(notify.describeStoppedSession(partial, 'sess-1').workspacePath, null, 'header 无 cwd 时应为 null')
  assert.deepStrictEqual(notify.describeStoppedSession({}, null), { sessionTitle: null, workspacePath: null, workspaceTitle: null }, '无 sessionId 时应为 null')
  // 回归：服务对象为空（等价于"服务没注入"）时必须降级而不是抛错——
  // 这正是「用 ctx.get 拿服务 ⇒ 通知显示未知工作区」的防线。
  assert.deepStrictEqual(
    notify.describeStoppedSession({ sessions: undefined, sessionTitle: undefined, workspaceRegistry: undefined }, 'sess-1'),
    { sessionTitle: null, workspacePath: null, workspaceTitle: null },
    '服务未注入时应降级为 null',
  )
  ok('会话元数据：服务缺失 / 无 cwd / 无 sessionId 一律降级为 null')
}

// ---- T3：继续指令消息 ----------------------------------------------------------
function testMessage() {
  const built = notify.buildUserMessage('继续干活')
  assert.strictEqual(built.message.role, 'user', '消息角色应为 user')
  assert.strictEqual(built.message.source.kind, 'user', '消息来源应为 user')
  assert.deepStrictEqual(built.message.content, [{ type: 'text', text: '继续干活' }], '内容应为单个文本块')
  assert.strictEqual(typeof built.message.id, 'string', '消息必须有 id')
  assert.ok(built.message.id.length >= 8, 'id 应为 UUID 形态')
  assert.strictEqual(Object.isFrozen(built.message), true, '手工构造的消息应冻结')
  assert.strictEqual(built.via, 'manual', '无 DSH 模块时应走内置构造')
  ok('继续指令消息：role/source/content/id 形状正确且冻结')

  // 工厂路径：把假的 createUserMessage 塞进 require.cache，插件应按同款解析并优先使用。
  const fakeKey = path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
  let factoryCalls = 0
  require.cache[fakeKey] = {
    id: fakeKey,
    filename: fakeKey,
    loaded: true,
    exports: {
      createUserMessage: (input) => {
        factoryCalls += 1
        return { id: 'from-factory', role: 'user', content: input.content, source: input.source }
      },
    },
  }
  try {
    const viaFactory = notify.buildUserMessage('走工厂')
    assert.strictEqual(viaFactory.via, 'factory', '存在 createUserMessage 时应优先使用')
    assert.strictEqual(viaFactory.message.id, 'from-factory', '应使用工厂返回值')
    assert.strictEqual(factoryCalls, 1, '工厂应被调用一次')
  } finally {
    delete require.cache[fakeKey]
  }
  assert.strictEqual(notify.buildUserMessage('回退').via, 'manual', '移除假模块后应回退到内置构造')
  ok('继续指令消息：优先复用 DSH 的 createUserMessage，缺失时回退')
}

// ---- T4：投递继续指令 ----------------------------------------------------------
function testDeliver() {
  const calls = []
  const agent = { id: 'sess-1', followup: (message) => calls.push(message) }
  const withAgent = { agents: { get: (id) => (id === 'sess-1' ? agent : undefined) } }
  const item = { sessionId: 'sess-1', prompt: '接着写', status: 'pending' }
  const sent = notify.deliverContinue(withAgent, item)
  assert.strictEqual(sent.ok, true, '会话存活时应投递成功')
  assert.strictEqual(calls.length, 1, 'followup 应被调用一次')
  assert.strictEqual(calls[0].content[0].text, '接着写', '应使用通知里记录（或配置）的指令文本')
  ok('投递继续指令：会话存活时注入 followup')

  const gone = notify.deliverContinue({ agents: { get: () => undefined } }, item)
  assert.strictEqual(gone.ok, false, '会话不在运行时不得假装成功')
  assert.strictEqual(gone.reason, 'session-not-live', '应给出 session-not-live 原因')
  const noService = notify.deliverContinue({}, item)
  assert.strictEqual(noService.reason, 'no-agents-service', '缺 agents 服务时应给出对应原因')
  const noSession = notify.deliverContinue(withAgent, { sessionId: null, prompt: '' })
  assert.strictEqual(noSession.reason, 'no-session', '无 sessionId 时应给出对应原因')
  // 指令文本为空时回落 CONFIG 默认值。
  const fallbackItem = { sessionId: 'sess-1', prompt: '   ', status: 'pending' }
  calls.length = 0
  notify.deliverContinue(withAgent, fallbackItem)
  assert.ok(calls[0].content[0].text.includes('继续'), '空指令应回落默认文案（含「继续」）')
  ok('投递继续指令：会话不在 / 服务缺失 / 无 sessionId 都给出明确原因')
}

// ---- T5：HTTP 路由 -------------------------------------------------------------
async function testRoutes() {
  const notifier = notify.createStopNotifier()
  const calls = []
  const agent = { id: 'sess-9', followup: (message) => calls.push(message) }
  const services = { agents: { get: (id) => (id === 'sess-9' ? agent : undefined) } }
  const item = notifier.push({
    sessionId: 'sess-9',
    sessionTitle: '会话九',
    workspacePath: 'D:\\Repo9',
    workspaceTitle: '仓库九',
    unit: '好的，下面开始回答：',
    count: 10,
    span: 90,
    source: 'text',
    prompt: '请继续',
  })

  // GET 列表
  let http = fakeHttp('GET', notify.NOTIFY_PREFIX + 'notifications')
  await notify.handleNotifyRequest(services, notifier, http.request, http.response)
  assert.strictEqual(http.response.status, 200, 'GET 列表应返回 200')
  const payload = JSON.parse(http.response.body)
  assert.strictEqual(payload.items.length, 1, '应回传一条通知')
  assert.strictEqual(payload.items[0].workspaceTitle, '仓库九', '列表应含工作区名称')
  assert.strictEqual(payload.items[0].sessionTitle, '会话九', '列表应含会话名称')
  assert.strictEqual(payload.items[0].unit, '好的，下面开始回答：', '列表应含重复的字符串')
  assert.strictEqual(http.response.headers['cache-control'], 'no-store', '通知不得被缓存')
  ok('通知通道：GET 回传工作区 / 会话 / 重复字符串')

  // POST continue
  http = fakeHttp('POST', notify.NOTIFY_PREFIX + 'notifications/action', JSON.stringify({ id: item.id, action: 'continue' }))
  await notify.handleNotifyRequest(services, notifier, http.request, http.response)
  assert.strictEqual(http.response.status, 200, '发送继续指令应返回 200')
  assert.strictEqual(calls.length, 1, '应注入一次消息')
  assert.strictEqual(notifier.find(item.id).status, 'sent', '状态应变为 sent')

  // 幂等：再次 continue 不再注入
  http = fakeHttp('POST', notify.NOTIFY_PREFIX + 'notifications/action', JSON.stringify({ id: item.id, action: 'continue' }))
  await notify.handleNotifyRequest(services, notifier, http.request, http.response)
  assert.strictEqual(calls.length, 1, '已发送过的通知不得重复注入')
  assert.strictEqual(JSON.parse(http.response.body).already, true, '应标记 already')
  ok('通知通道：continue 动作注入一次且幂等')

  // dismiss
  const other = notifier.push({ sessionId: 'sess-9', unit: 'x', count: 3, span: 3 })
  http = fakeHttp('POST', notify.NOTIFY_PREFIX + 'notifications/action', JSON.stringify({ id: other.id, action: 'dismiss' }))
  await notify.handleNotifyRequest(services, notifier, http.request, http.response)
  assert.strictEqual(notifier.find(other.id).status, 'dismissed', 'dismiss 应把状态改为 dismissed')
  assert.strictEqual(calls.length, 1, 'dismiss 不得注入消息')
  ok('通知通道：dismiss 只记录用户选择，不注入消息')

  // 失败路径：会话已不在运行
  const stale = notifier.push({ sessionId: 'sess-gone', unit: 'y', count: 3, span: 3 })
  http = fakeHttp('POST', notify.NOTIFY_PREFIX + 'notifications/action', JSON.stringify({ id: stale.id, action: 'continue' }))
  await notify.handleNotifyRequest(services, notifier, http.request, http.response)
  assert.strictEqual(http.response.status, 409, '会话不在运行时应返回 409')
  assert.strictEqual(notifier.find(stale.id).status, 'failed', '状态应为 failed，界面据此提示')
  ok('通知通道：会话不在运行时不静默失败（409 + failed）')

  // 边界：未知路径 / 方法 / JSON / 跨站 / 未知 id
  for (const [label, method, url, body, headers, expected] of [
    ['未知路径', 'GET', notify.NOTIFY_PREFIX + 'nope', undefined, undefined, 404],
    ['方法不允许', 'PUT', notify.NOTIFY_PREFIX + 'notifications', undefined, undefined, 405],
    ['动作方法不允许', 'GET', notify.NOTIFY_PREFIX + 'notifications/action', undefined, undefined, 405],
    ['非法 JSON', 'POST', notify.NOTIFY_PREFIX + 'notifications/action', '{oops', undefined, 400],
    ['未知 id', 'POST', notify.NOTIFY_PREFIX + 'notifications/action', JSON.stringify({ id: 'nope', action: 'continue' }), undefined, 404],
    ['未知动作', 'POST', notify.NOTIFY_PREFIX + 'notifications/action', JSON.stringify({ id: item.id, action: 'explode' }), undefined, 400],
    ['跨站请求', 'GET', notify.NOTIFY_PREFIX + 'notifications', undefined, { host: '127.0.0.1:3080', origin: 'https://evil.example' }, 403],
    ['超大请求体', 'POST', notify.NOTIFY_PREFIX + 'notifications/action', 'x'.repeat(9000), undefined, 400],
  ]) {
    const probe = fakeHttp(method, url, body, headers)
    await notify.handleNotifyRequest(services, notifier, probe.request, probe.response)
    assert.strictEqual(probe.response.status, expected, label + ' 应返回 ' + String(expected) + '，实际 ' + String(probe.response.status))
  }
  ok('通知通道：未知路径 / 错误方法 / 非法 JSON / 跨站 / 超大请求体一律被拒绝')

  // 同源请求（Origin 与 Host 一致）必须放行
  const sameOrigin = fakeHttp('GET', notify.NOTIFY_PREFIX + 'notifications', undefined, { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })
  await notify.handleNotifyRequest(services, notifier, sameOrigin.request, sameOrigin.response)
  assert.strictEqual(sameOrigin.response.status, 200, '同源请求应放行')
  ok('通知通道：同源请求放行')

  // 路由注册：无 webServer → null（并告警）；有则注册 prefix 路由
  const noServer = notify.registerNotifyRoutes(undefined, notifier, {})
  assert.strictEqual(noServer, null, '无 webServer 时应返回 null（截停不受影响）')
  let registered = null
  const fakeServer = {
    register: (route) => {
      registered = route
      return () => {}
    },
  }
  const dispose = notify.registerNotifyRoutes(fakeServer, notifier, services)
  assert.strictEqual(typeof dispose, 'function', '应返回注销器')
  assert.strictEqual(registered.kind, 'prefix', '应注册 prefix 路由')
  assert.strictEqual(typeof registered.handler, 'function', '路由应带 handler')
  // 关键回归：复刻 dsh-host-webserver 的真实匹配规则
  //   if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
  // 注册路径带尾斜杠 ⇒ /dsh-dupguard/notifications 匹配不上（曾因此"已注册却永远 404"）。
  const matches = (prefix, pathname) => pathname === prefix || pathname.startsWith(prefix + '/')
  assert.strictEqual(registered.path, notify.NOTIFY_ROUTE, '注册路径应为不带尾斜杠的前缀常量')
  assert.strictEqual(registered.path.endsWith('/'), false, 'prefix 路由不得以 / 结尾（否则子路径匹配不上）')
  assert.strictEqual(
    matches(registered.path, notify.NOTIFY_PREFIX + 'notifications'),
    true,
    '注册路径必须能匹配列表路径 ' + notify.NOTIFY_PREFIX + 'notifications',
  )
  assert.strictEqual(
    matches(registered.path, notify.NOTIFY_PREFIX + 'notifications/action'),
    true,
    '注册路径必须能匹配动作路径',
  )
  ok('通知通道：注册 prefix 路由且能匹配子路径；缺 webServer 时降级为 null')
}

// ---- T6：端到端（截停 → 通知 → 用户操作 → 注入） -------------------------------
async function testEndToEnd() {
  const sessionId = 'sess-e2e'
  const session = { header: { id: sessionId, cwd: 'D:\\E2E' } }
  const injected = []
  let registeredRoute = null
  const { ctx, listeners } = makeCtx({
    sessions: { get: (id) => (id === sessionId ? session : undefined) },
    sessionTitle: { get: () => ({ title: '端到端会话' }) },
    workspaceRegistry: { list: () => [{ id: 'w', path: 'D:\\E2E', title: '端到端工作区' }] },
    agents: { get: (id) => (id === sessionId ? { id: sessionId, followup: (message) => injected.push(message) } : undefined) },
    webServer: {
      register: (route) => {
        registeredRoute = route
        return () => {}
      },
    },
    settings: {
      // 走「旧版设置通道」分支：避免测试依赖 schemastery / loader。
      register: () => ({
        get: () => undefined,
        watch: () => () => {},
        update() {},
        replace() {},
      }),
    },
  })
  plugin.apply(ctx, {})
  assert.strictEqual(typeof listeners['llm/stream'], 'function', '应注册 llm/stream')
  assert.ok(registeredRoute !== null, '应注册通知路由（webServer 可用时）')

  // 一次真实截停：'ab' 重复 10 次
  const upstream = makeUpstream(textChunks(0, 'ab'.repeat(10)))
  const wrapped = listeners['llm/stream'](
    { provider: 'test', model: 'test-model', sessionId },
    () => upstream.iterator,
  )
  const out = []
  for await (const chunk of wrapped) out.push(chunk)
  assert.strictEqual(upstream.isClosed(), true, '截停后应关闭上游流')
  assert.strictEqual(out[out.length - 1].reason.kind, 'stop', '应以 finish(stop) 收尾')

  // 通知列表：工作区 / 会话 / 重复字符串 / 次数 / 通道
  // 注意：这里驱动的是 apply 时**真正注册**的路由 handler（它闭包持有 apply 内的队列），
  // 因此这条链路等于浏览器实际走的那条。
  const listProbe = fakeHttp('GET', notify.NOTIFY_PREFIX + 'notifications')
  await registeredRoute.handler(listProbe.request, listProbe.response)
  const payload = JSON.parse(listProbe.response.body)
  assert.strictEqual(payload.items.length, 1, '一次截停应产生一条通知')
  const notice = payload.items[0]
  assert.strictEqual(notice.workspacePath, 'D:\\E2E', '通知应含工作区路径')
  assert.strictEqual(notice.workspaceTitle, '端到端工作区', '通知应含工作区名称')
  assert.strictEqual(notice.sessionTitle, '端到端会话', '通知应含会话名称')
  assert.strictEqual(notice.sessionId, sessionId, '通知应含会话 id')
  assert.strictEqual(notice.unit, 'ab', '通知应含重复的字符串')
  assert.strictEqual(notice.count, 10, '通知应含重复次数')
  assert.strictEqual(notice.source, 'text', '通知应含命中通道')
  ok('端到端：截停 → 通知含工作区 / 会话 / 重复字符串 / 次数')

  // 用户点「发送继续指令」
  const actionProbe = fakeHttp('POST', notify.NOTIFY_PREFIX + 'notifications/action', JSON.stringify({ id: notice.id, action: 'continue' }))
  await registeredRoute.handler(actionProbe.request, actionProbe.response)
  assert.strictEqual(actionProbe.response.status, 200, 'continue 应成功')
  assert.strictEqual(injected.length, 1, '应向被截停会话注入一条用户消息')
  assert.strictEqual(injected[0].role, 'user', '注入的应是用户消息')
  assert.ok(injected[0].content[0].text.length > 0, '注入消息应有内容')
  ok('端到端：用户选择继续 → 宿主向该会话注入继续指令')

  // 同一次截停不会重复通知；开关关闭后不再通知
  const second = makeUpstream(textChunks(1, 'ab'.repeat(10)))
  const wrapped2 = listeners['llm/stream']({ provider: 'test', model: 'test-model', sessionId }, () => second.iterator)
  for await (const _chunk of wrapped2) void _chunk
  const probe2 = fakeHttp('GET', notify.NOTIFY_PREFIX + 'notifications')
  await registeredRoute.handler(probe2.request, probe2.response)
  assert.strictEqual(JSON.parse(probe2.response.body).items.length, 2, '第二次截停应再产生一条通知（各自独立）')
  ok('端到端：每次截停各自产生一条通知（不合并、不丢）')
}

// ---- T7：开关（notifyOnStop）真实生效 -----------------------------------------
async function testToggle() {
  /**
   * 用「DSH ≥ 0.1.7 路径」跑一次 apply：config 直接决定运行参数，因此开关可确定性地验证
   * （settings 服务存在但没有 register ⇒ 走插件 Config 分支）。
   */
  async function runOnce(config) {
    const sessionId = 'sess-toggle'
    let route = null
    const { ctx, listeners } = makeCtx({
      sessions: { get: () => ({ header: { id: sessionId, cwd: 'D:\\Toggle' } }) },
      sessionTitle: { get: () => ({ title: '开关会话' }) },
      agents: { get: () => ({ id: sessionId, followup: () => {} }) },
      settings: { configure: () => () => {} }, // 有 settings 服务、无 register ⇒ 插件 Config 分支
      webServer: {
        register: (value) => {
          route = value
          return () => {}
        },
      },
    })
    plugin.apply(ctx, config)
    const upstream = makeUpstream(textChunks(0, 'cd'.repeat(10)))
    const wrapped = listeners['llm/stream']({ provider: 'test', model: 'm', sessionId }, () => upstream.iterator)
    for await (const _chunk of wrapped) void _chunk
    const probe = fakeHttp('GET', notify.NOTIFY_PREFIX + 'notifications')
    await route.handler(probe.request, probe.response)
    return JSON.parse(probe.response.body).items
  }

  const enabled = await runOnce({ notifyOnStop: true })
  assert.strictEqual(enabled.length, 1, '开关打开时截停应产生通知')
  const disabled = await runOnce({ notifyOnStop: false })
  assert.strictEqual(disabled.length, 0, '开关关闭时截停不得产生通知（截停本身照常）')
  ok('开关：notifyOnStop=false 时截停仍发生但不产生通知')
}

// ---- T8：静态防回归（源码级约定） ---------------------------------------------
function testSourceGuards() {
  const fs = require('node:fs')
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8')
  // 去掉注释后再查：注释里可以提到 ctx.get，代码里不许用。
  const code = hostSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.strictEqual(
    code.includes("ctx.get('"),
    false,
    '宿主不得用 ctx.get 解析 root 服务：loader entry 的 ctx 拿不到（曾因此导致通知通道未注册）',
  )
  assert.strictEqual(
    code.includes('webCtx.webServer'),
    true,
    '通知路由必须用注入作用域的属性（webCtx.webServer）注册',
  )
  assert.strictEqual(
    code.includes('describeStoppedSession(notifyServices') && code.includes('deliverContinue(services'),
    true,
    '会话元数据与继续指令必须使用注入捕获的服务对象',
  )
  ok('静态约定：服务一律经 ctx.inject 捕获（禁止 ctx.get 解析 root 服务）')
}

async function main() {
  console.log('dupguard 截停通知测试（宿主）')
  testQueue()
  testDescribe()
  testMessage()
  testDeliver()
  await testRoutes()
  await testEndToEnd()
  await testToggle()
  testSourceGuards()
  console.log('全部通过：' + String(passed) + ' 项（截停通知）')
}

main().catch((error) => {
  console.error('测试失败：' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
})
