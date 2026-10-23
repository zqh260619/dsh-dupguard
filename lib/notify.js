'use strict'

// ============================================================================
// dupguard 截停通知通道（宿主 → 浏览器 → 宿主）
//
// 1. 截停发生时，宿主把一条通知入队（工作区、会话名称、重复的字符串、次数、区域）；
// 2. 浏览器端的 `shell.overlay` 组件（见 lib/client.js）轮询 `GET /dsh-dupguard/notifications`
//    —— 该浮层是 root 作用域，因此无论用户当前打开哪个会话，通知都会显示；
// 3. 用户选择「发送继续指令」或「不发送」，浏览器 POST /dsh-dupguard/notifications/action
//    回传；宿主据此决定是否向该会话注入一条用户消息（agent.followup）。
//
// 通道不可用时（DSH 版本过旧、无 webServer / agents 服务）只打印告警：截停本身不受影响。
// ============================================================================

/**
 * 创建截停通知 API。
 * @param options.defaultContinuePrompt - 通知 item 未带 prompt 时使用的默认继续指令文案。
 */
function createNotifyApi(options) {
  const defaultContinuePrompt = options !== undefined && options !== null && typeof options.defaultContinuePrompt === 'string'
    ? options.defaultContinuePrompt
    : '请从中断处继续，不要重复之前的内容。'
  // 决策卡片按钮的处理回调（由 lib/index.js 注入；未注入时旧行为不变）。
  let onDecision = options !== undefined && options !== null && typeof options.onDecision === 'function'
    ? options.onDecision
    : null
  const setDecisionHandler = (handler) => {
    onDecision = typeof handler === 'function' ? handler : null
  }
/**
 * 截停通知通道（宿主 → 浏览器 → 宿主）：
 *
 * 1. 截停发生时，宿主把一条通知入队（工作区、会话名称、重复的字符串、次数、区域）；
 * 2. 浏览器端的 `shell.overlay` 组件（见 lib/client.js）轮询 `GET /dsh-dupguard/notifications`
 *    —— 该浮层是 **root 作用域**，因此无论用户当前打开的是哪个会话，通知都会显示；
 * 3. 用户选择「发送继续指令」或「不发送」，浏览器 `POST /dsh-dupguard/notifications/action`
 *    回传；宿主据此决定是否向该会话注入一条用户消息（`agent.followup`）。
 *
 * 通道不可用时（DSH 版本过旧、无 webServer / agents 服务）只打印告警：截停本身不受影响。
 */
const NOTIFY_PREFIX = '/dsh-dupguard/'
/**
 * 注册到 webServer 的**路由路径**：必须是**不带尾斜杠**的前缀。
 * DSH 的匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`
 * （见 dsh-host-webserver 的 `match()`）——若写成 '/dsh-dupguard/'，只有它自身与
 * '/dsh-dupguard//…' 能命中，'/dsh-dupguard/notifications' 会落到 SPA 兜底并返回空 404
 * （曾因此让"通道已注册"却永远 404、通知永不弹）。
 */
const NOTIFY_ROUTE = '/dsh-dupguard'
/** 队列上限：只保留最近若干条，避免内存无界增长。 */
const NOTIFY_LIMIT = 20
/** 动作请求体上限（字节）：请求里只有一个 id 与动作名。 */
const NOTIFY_BODY_LIMIT = 4096
/** 展示用重复字符串上限（码点）：超出截断并标记，避免把整段复读塞进界面。 */
const NOTIFY_UNIT_MAX = 160
/** 截停通知队列（进程内存）。 */
function createStopNotifier() {
  let seq = 0
  let revision = 0
  const items = []
  return {
    /** 入队一条记录：普通截停（kind=stop）或阈值决策卡片（kind=decision）。 */
    push(entry) {
      seq += 1
      const isDecision = entry.kind === 'decision'
      const item = {
        id: 'dupguard-stop-' + String(seq),
        time: Date.now(),
        kind: isDecision ? 'decision' : 'stop',
        sessionId: entry.sessionId === undefined || entry.sessionId === null ? null : String(entry.sessionId),
        sessionTitle: typeof entry.sessionTitle === 'string' && entry.sessionTitle !== '' ? entry.sessionTitle : null,
        workspacePath: typeof entry.workspacePath === 'string' && entry.workspacePath !== '' ? entry.workspacePath : null,
        workspaceTitle: typeof entry.workspaceTitle === 'string' && entry.workspaceTitle !== '' ? entry.workspaceTitle : null,
        unit: typeof entry.unit === 'string' ? entry.unit : '',
        count: Number.isSafeInteger(entry.count) ? entry.count : null,
        span: Number.isSafeInteger(entry.span) ? entry.span : null,
        code: entry.code === true,
        source: typeof entry.source === 'string' ? entry.source : 'text',
        prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
        status: 'pending',
        detail: null,
        // 决策卡片专用字段（普通截停保持 null，客户端按 kind 分支渲染）。
        phase: isDecision ? (entry.phase === 'armed' ? 'armed' : 'paused') : null,
        deadline: isDecision && Number.isSafeInteger(entry.deadline) ? entry.deadline : null,
        autoStopCount: isDecision && Number.isSafeInteger(entry.autoStopCount) ? entry.autoStopCount : null,
        decisionStatus: isDecision ? 'pending' : null,
      }
      items.unshift(item)
      while (items.length > NOTIFY_LIMIT) items.pop()
      revision += 1
      return item
    },
    /** 更新队列项（状态流转用；返回最新项）。 */
    update(id, patch) {
      const item = items.find((entry) => entry.id === id)
      if (item === undefined) return undefined
      Object.assign(item, patch)
      revision += 1
      return item
    },
    list() {
      return items.map(publicNotice)
    },
    find(id) {
      return items.find((item) => item.id === id)
    },
    revision() {
      return revision
    },
    /** 状态变更后递增版本号，让客户端知道列表变了。 */
    touch() {
      revision += 1
    },
  }
}

/** 队列条目的公开视图（JSON 安全；重复字符串按码点截断）。 */
function publicNotice(item) {
  const chars = [...item.unit]
  const clipped = chars.length > NOTIFY_UNIT_MAX
  return {
    id: item.id,
    time: item.time,
    sessionId: item.sessionId,
    sessionTitle: item.sessionTitle,
    workspacePath: item.workspacePath,
    workspaceTitle: item.workspaceTitle,
    unit: clipped ? chars.slice(0, NOTIFY_UNIT_MAX).join('') : item.unit,
    unitLength: chars.length,
    unitTruncated: clipped,
    count: item.count,
    span: item.span,
    code: item.code,
    source: item.source,
    unitCodePoints: chars.slice(0, 24).map((ch) => ch.codePointAt(0)),
    prompt: item.prompt,
    status: item.status,
    detail: item.detail,
    kind: item.kind === 'decision' ? 'decision' : 'stop',
    phase: item.phase === undefined ? null : item.phase,
    deadline: item.deadline === undefined ? null : item.deadline,
    autoStopCount: item.autoStopCount === undefined ? null : item.autoStopCount,
    decisionStatus: item.decisionStatus === undefined ? null : item.decisionStatus,
  }
}

/** 路径比较用归一化：Windows 大小写与分隔符差异不影响匹配。 */
function normalizePathForCompare(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 解析被截停会话的展示信息：工作区路径 / 工作区名称 / 会话标题。
 * 全部尽力而为——服务缺失或版本过旧时字段为 null，绝不影响截停与通知本身。
 *
 * @param services - 通过 `ctx.inject` 捕获的**服务对象**集合。**不能用 `ctx.get`**：
 *   loader entry 的 ctx 解析不到 root 服务（本插件第 2255 行附近的既有注释即为此约定），
 *   用 get 会静默拿到 undefined ⇒ 通知退化成"未知工作区/未命名会话"。
 * @param sessionId - 被截停会话的 id。
 */
function describeStoppedSession(services, sessionId) {
  const info = { sessionTitle: null, workspacePath: null, workspaceTitle: null }
  if (sessionId === undefined || sessionId === null || sessionId === '') return info
  const source = services === undefined || services === null ? {} : services
  let session
  try {
    const sessions = source.sessions
    if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
      session = sessions.get(sessionId)
    }
  } catch (_sessionsError) {
    session = undefined
  }
  if (session !== undefined && session !== null) {
    try {
      const header = session.header
      if (header !== undefined && header !== null && typeof header.cwd === 'string' && header.cwd !== '') {
        info.workspacePath = header.cwd
      }
    } catch (_headerError) {}
    try {
      const titles = source.sessionTitle
      if (titles !== undefined && titles !== null && typeof titles.get === 'function') {
        const snapshot = titles.get(session)
        if (snapshot !== undefined && snapshot !== null && typeof snapshot.title === 'string' && snapshot.title !== '') {
          info.sessionTitle = snapshot.title
        }
      }
    } catch (_titleError) {}
  }
  if (info.workspacePath !== null) {
    try {
      const registry = source.workspaceRegistry
      if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
        const wanted = normalizePathForCompare(info.workspacePath)
        const workspaces = registry.list()
        if (Array.isArray(workspaces)) {
          for (const workspace of workspaces) {
            if (workspace === null || typeof workspace !== 'object') continue
            if (typeof workspace.path !== 'string' || typeof workspace.title !== 'string') continue
            if (normalizePathForCompare(workspace.path) !== wanted) continue
            info.workspaceTitle = workspace.title
            break
          }
        }
      }
    } catch (_registryError) {}
  }
  return info
}

/**
 * 构造一条用户消息（`user/message` 的完整形状）。
 * 优先复用 DSH 自己的 `createUserMessage`（id 生成与冻结语义与宿主完全一致）；
 * 找不到时按同一形状自行构造：id 用 `randomUUID()`，与宿主 `brandString(randomUUID())` 同形。
 */
function buildUserMessage(text) {
  const content = [{ type: 'text', text }]
  const factory = findUserMessageFactory()
  if (factory !== null) {
    try {
      return { message: factory({ content, source: { kind: 'user' } }), via: 'factory' }
    } catch (_factoryError) {}
  }
  const frozenContent = Object.freeze(content.map((block) => Object.freeze({ ...block })))
  return {
    message: Object.freeze({
      id: String(require('crypto').randomUUID()),
      role: 'user',
      content: frozenContent,
      source: Object.freeze({ kind: 'user' }),
    }),
    via: 'manual',
  }
}

/**
 * 从**已加载**的 DSH 模块里找 `createUserMessage`。
 * 我们的插件装在 profile 下，无法直接 `require('@deepseek-ai/dsh-session')`
 * （profile 的 node_modules 里没有 DSH 包）；但宿主进程必然加载过它，
 * 因此扫描 `require.cache` 是最稳的解析方式（找不到就用手工构造，功能不受影响）。
 */
function findUserMessageFactory() {
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.indexOf('@deepseek-ai') === -1) continue
      if (key.indexOf('dsh-session') === -1 && key.indexOf('dsh-llm') === -1) continue
      const cached = require.cache[key]
      const exports = cached === undefined ? undefined : cached.exports
      if (exports !== null && typeof exports === 'object' && typeof exports.createUserMessage === 'function') {
        return exports.createUserMessage
      }
    }
  } catch (_scanError) {}
  return null
}

/**
 * 把「继续指令」投递到被截停的会话（该会话必须仍然存活）。
 * @param services - 通过 `ctx.inject` 捕获的服务对象集合（同上：不用 ctx.get）。
 */
function deliverContinue(services, item) {
  const prompt = typeof item.prompt === 'string' && item.prompt.trim() !== '' ? item.prompt : defaultContinuePrompt
  if (item.sessionId === null) {
    return { ok: false, reason: 'no-session', message: '这次截停没有记录会话 id（DSH 未在请求里提供 sessionId）' }
  }
  const source = services === undefined || services === null ? {} : services
  const agents = source.agents
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    return { ok: false, reason: 'no-agents-service', message: '宿主没有 agents 服务，无法注入消息' }
  }
  const agent = agents.get(item.sessionId)
  if (agent === undefined || agent === null) {
    return { ok: false, reason: 'session-not-live', message: '该会话已不在运行（可能已关闭或归档），请打开它后手动继续' }
  }
  if (typeof agent.followup !== 'function') {
    return { ok: false, reason: 'no-followup', message: '该 agent 不支持注入消息（DSH 版本过旧）' }
  }
  const built = buildUserMessage(prompt)
  agent.followup(built.message)
  return {
    ok: true,
    reason: 'sent',
    via: built.via,
    message: '已向该会话发送继续指令（' + (built.via === 'factory' ? 'DSH 消息工厂' : '内置构造') + '）',
  }
}

/** 写出一个 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读取 JSON 请求体（超限或非法返回 null）。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > NOTIFY_BODY_LIMIT) return null
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (_parseError) {
    return null
  }
}

/** 同源校验：带 Origin 头的请求必须与 Host 一致，跨站请求直接拒绝。 */
function sameOrigin(req) {
  const origin = req.headers === undefined ? undefined : req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch (_urlError) {
    return false
  }
}

/** 处理通知通道请求：GET 列表 / POST 动作。 */
async function handleNotifyRequest(services, notifier, req, res) {
  const method = req.method === undefined ? '' : String(req.method).toUpperCase()
  const url = req.url === undefined ? '' : String(req.url)
  const path = url.split('?')[0]
  if (sameOrigin(req) !== true) {
    sendJson(res, 403, { ok: false, error: 'cross-origin' })
    return
  }
  if (path === NOTIFY_PREFIX + 'notifications') {
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    sendJson(res, 200, { ok: true, revision: notifier.revision(), items: notifier.list() })
    return
  }
  if (path === NOTIFY_PREFIX + 'notifications/action') {
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { ok: false, error: 'bad-json' })
      return
    }
    const item = typeof body.id === 'string' ? notifier.find(body.id) : undefined
    if (item === undefined) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    if (item.kind === 'decision') {
      if (body.action === 'dismiss') {
        item.status = 'dismissed'
        item.detail = '用户关闭了决策卡片（继续观察）'
        notifier.touch()
        sendJson(res, 200, { ok: true, status: item.status, message: item.detail })
        return
      }
      if (body.action !== 'stop-now' && body.action !== 'allow-repeat') {
        sendJson(res, 400, { ok: false, error: 'bad-action' })
        return
      }
      if (onDecision === null) {
        sendJson(res, 409, { ok: false, error: 'decision-unavailable', message: '当前宿主未接入决策处理器' })
        return
      }
      let result
      try {
        result = onDecision(item, body.action)
      } catch (error) {
        console.warn('[dupguard] 阈值决策动作处理失败：' + (error && error.message ? error.message : String(error)))
        result = { ok: false, message: '决策动作处理失败' }
      }
      if (result !== null && typeof result === 'object' && result.ok === true) {
        if (typeof result.status === 'string') item.status = result.status
        if (typeof result.message === 'string') item.detail = result.message
        notifier.touch()
        sendJson(res, 200, {
          ok: true,
          status: item.status,
          message: item.detail,
          already: result.already === true,
        })
        return
      }
      sendJson(res, 409, {
        ok: false,
        error: 'decision-not-actionable',
        message: result !== null && typeof result === 'object' && typeof result.message === 'string'
          ? result.message
          : '当前决策不可操作',
      })
      return
    }
    if (body.action === 'dismiss') {
      item.status = 'dismissed'
      item.detail = '用户选择不发送继续指令'
      notifier.touch()
      console.log('[dupguard] 截停通知 ' + item.id + '：用户选择不发送继续指令')
      sendJson(res, 200, { ok: true, status: item.status, message: item.detail })
      return
    }
    if (body.action !== 'continue') {
      sendJson(res, 400, { ok: false, error: 'bad-action' })
      return
    }
    if (item.status === 'sent') {
      sendJson(res, 200, { ok: true, status: item.status, message: '此前已发送过继续指令', already: true })
      return
    }
    const result = deliverContinue(services, item)
    item.status = result.ok ? 'sent' : 'failed'
    item.detail = result.message
    notifier.touch()
    if (result.ok) {
      console.log('[dupguard] 截停通知 ' + item.id + '：已发送继续指令（via=' + String(result.via) + '）')
    } else {
      console.warn('[dupguard] 截停通知 ' + item.id + '：继续指令投递失败（' + String(result.reason) + '）' + result.message)
    }
    sendJson(res, result.ok ? 200 : 409, {
      ok: result.ok,
      status: item.status,
      error: result.reason,
      message: result.message,
    })
    return
  }
  sendJson(res, 404, { ok: false, error: 'not-found' })
}

/** 注册通知通道；webServer 缺失时告警并返回 null（截停不受影响）。 */
function registerNotifyRoutes(server, notifier, services) {
  if (server === undefined || server === null || typeof server.register !== 'function') {
    console.warn('[dupguard] 宿主没有 webServer 服务：截停通知不可用（检测与截停不受影响）')
    return null
  }
  try {
    return server.register({
      kind: 'prefix',
      // 不带尾斜杠：见 NOTIFY_ROUTE 的说明（带尾斜杠会让子路径匹配不上）。
      path: NOTIFY_ROUTE,
      // 返回 Promise：webServer 接受 void | Promise<void>，测试也能确定性地等待处理完成。
      handler: (req, res) => handleNotifyRequest(services, notifier, req, res).catch((error) => {
        try {
          sendJson(res, 500, { ok: false, error: 'internal', message: error && error.message ? error.message : String(error) })
        } catch (_writeError) {}
      }),
    })
  } catch (error) {
    console.warn('[dupguard] 注册截停通知通道失败（检测与截停不受影响）：' + (error && error.message ? error.message : String(error)))
    return null
  }
}

  return {
    NOTIFY_PREFIX,
    NOTIFY_ROUTE,
    NOTIFY_LIMIT,
    NOTIFY_BODY_LIMIT,
    NOTIFY_UNIT_MAX,
    createStopNotifier,
    publicNotice,
    normalizePathForCompare,
    describeStoppedSession,
    buildUserMessage,
    findUserMessageFactory,
    deliverContinue,
    sendJson,
    sameOrigin,
    handleNotifyRequest,
    registerNotifyRoutes,
    setDecisionHandler,
  }
}

module.exports = { createNotifyApi }
