'use strict'

const nodeFs = require('fs')
const nodePath = require('path')

// ============================================================================
// dupguard —— DSH (DeepSeek Harness) 插件（npm / 组合常驻形式，CJS 入口）
//
// 实时检测大模型流式输出中的重复内容：当最新的输出中同一字符串连续重复
// CONFIG.threshold 次及以上时，立即停止本次生成。
//
// 本文件是 package.json 的 main 入口，导出 Cordis 插件对象
// { name, apply }，供 DSH 组合（cordis.yml / preset）挂载；
// 与 plugin/host.js（动态 cordis_define 形式）行为完全一致，
// tests/detector.test.js 会对两者同时跑同一套用例，防止两份代码漂移。
//
// 设置集成（仅本常驻版）：通过 DSH 的 settings 服务注册命名空间
// "dsh-dupguard"，白名单（ignoredChars）可在 Web 设置页修改并持久化
// （见 lib/client.js），修改即时热生效。
//
// 检测引擎（检测算法本体）在 lib/engine.js（单源实现）：
// plugin/host.js 由 tools/build-host.mjs 从同一份引擎生成，改检测逻辑请只改引擎文件。
// ============================================================================

// 检测引擎（单源实现；动态入口 plugin/host.js 由同一份引擎生成）。
const engine = require('./engine')
const {
  DEFAULT_CONFIG,
  CONTINUE_PROMPT_MAX,
  isValidNeed,
  parseThresholdByLength,
  createThresholdPolicy,
  createStreamGuard,
  installStandingMountPatch,
  deriveWindow,
  deriveMaxUnitLength,
  codeBlockMode,
  effectiveCodeThreshold,
} = engine

const { createSettingsApi } = require('./settings')

const name = 'dupguard'

const CONFIG = { ...DEFAULT_CONFIG }
const settings = createSettingsApi(engine, CONFIG)
const {
  Config,
  createRuntime,
  settingsValueFromConfig,
  readLiveOverrides,
  applySettingsToRuntime,
  pushDerived,
  installSettings,
  profileConfigFile,
  logRuntimeSummary,
  warnLiveUpdateFailure,
  loadAdvancedModule,
  describePolicy,
  createPolicy,
} = settings

//#region 截停通知（全局弹窗 + 可选的继续指令）

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
    /** 入队一条截停记录（字段全部来自宿主，未做展示层裁剪）。 */
    push(entry) {
      seq += 1
      const item = {
        id: 'dupguard-stop-' + String(seq),
        time: Date.now(),
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
      }
      items.unshift(item)
      while (items.length > NOTIFY_LIMIT) items.pop()
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
  const prompt = typeof item.prompt === 'string' && item.prompt.trim() !== '' ? item.prompt : CONFIG.continuePrompt
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

//#endregion

function apply(ctx, config) {
  // 启动自检：把关键服务可见性直接打到宿主日志，便于诊断挂载问题。
  console.log('[dupguard] 常驻插件 apply 开始')
  const runtime = createRuntime()
  // 每次模型调用用哪份参数：默认代码常量 + 旧版设置作用域（runtime 原地更新）；
  // DSH ≥ 0.1.7 改为按需读插件 Config（用户层写入后 loader 实时下发新 config）。
  let runtimeSource = () => runtime
  // 截停通知队列 + 通道：宿主记录，浏览器（全局浮层）读取并回传用户选择。
  const notifier = createStopNotifier()
  /**
   * 截停时生成通知：解析被截停会话的工作区与会话名称（与用户当前打开哪个会话无关），
   * 记下重复的字符串与命中参数。整段尽力而为——任何异常都不得影响截停收尾。
   * @param hit - 命中信息（unit / count / span / code）。
   * @param options - 本次 llm/stream 的 GenerateOptions（取其中的 sessionId）。
   */
  const notifyStop = (hit, options) => {
    let current
    try {
      current = runtimeSource()
    } catch (_runtimeError) {
      current = runtime
    }
    if (current === undefined || current === null || current.notifyOnStop !== true) return
    const sessionId = options !== undefined && options !== null && options.sessionId !== undefined && options.sessionId !== null
      ? String(options.sessionId)
      : null
    const info = describeStoppedSession(notifyServices, sessionId)
    const item = notifier.push({
      sessionId,
      sessionTitle: info.sessionTitle,
      workspacePath: info.workspacePath,
      workspaceTitle: info.workspaceTitle,
      unit: hit !== undefined && hit !== null && typeof hit.unit === 'string' ? hit.unit : '',
      count: hit !== undefined && hit !== null && Number.isSafeInteger(hit.count) ? hit.count : null,
      span: hit !== undefined && hit !== null && Number.isSafeInteger(hit.span) ? hit.span : null,
      code: hit !== undefined && hit !== null && hit.code === true,
      source: hit !== undefined && hit !== null && typeof hit.source === 'string' ? hit.source : 'text',
      prompt: current.continuePrompt,
    })
    console.log(
      '[dupguard] 截停通知 ' + item.id +
      '：工作区=' + (info.workspacePath === null ? '未知' : info.workspacePath) +
      (info.workspaceTitle === null ? '' : '（' + info.workspaceTitle + '）') +
      ' 会话=' + (info.sessionTitle === null ? String(sessionId) : info.sessionTitle) +
      ' 重复=' + JSON.stringify(hit !== undefined && hit !== null ? hit.unit : '') +
      ' ×' + String(hit !== undefined && hit !== null ? hit.count : '?') +
      '（通知已入队，浏览器端浮层会显示）'
    )
  }
  // 通知所需的宿主服务。**必须在 ctx.inject 回调里用属性访问**（`webCtx.webServer`）：
  // loader entry 的 ctx 用 `ctx.get()` 解析不到 root 服务，会静默拿到 undefined ——
  // 这正是「路由没注册、通知永远不弹、工作区显示未知」的根因（与 DSH 官方插件
  // dsh-client-modules / dsh-client-connection 的写法一致）。
  const notifyServices = {
    sessions: undefined,
    sessionTitle: undefined,
    workspaceRegistry: undefined,
    agents: undefined,
    webServer: undefined,
  }
  const captureService = (key) => (serviceCtx) => {
    notifyServices[key] = serviceCtx === undefined || serviceCtx === null ? undefined : serviceCtx[key]
    return () => {
      notifyServices[key] = undefined
    }
  }
  ctx.inject(['sessions'], captureService('sessions'))
  ctx.inject(['sessionTitle'], captureService('sessionTitle'))
  ctx.inject(['workspaceRegistry'], captureService('workspaceRegistry'))
  ctx.inject(['agents'], captureService('agents'))
  // 通知通道：webServer 就绪时注册同源 HTTP 路由（列表 + 动作）。
  ctx.inject(['webServer'], (webCtx) => {
    notifyServices.webServer = webCtx === undefined || webCtx === null ? undefined : webCtx.webServer
    const mount = () => {
      const dispose = registerNotifyRoutes(notifyServices.webServer, notifier, notifyServices)
      return () => {
        notifyServices.webServer = undefined
        if (typeof dispose === 'function') dispose()
      }
    }
    // 官方写法（dsh-client-modules）：把路由注册放进 effect，随作用域自动注销。
    // 极简 ctx（测试桩 / 宿主裁剪）没有 effect 时直接注册，只是缺少自动注销。
    if (webCtx !== undefined && webCtx !== null && typeof webCtx.effect === 'function') {
      webCtx.effect(mount, 'dupguard: notify routes')
    } else {
      mount()
    }
    console.log('[dupguard] 截停通知通道已注册：' + NOTIFY_ROUTE + '（列表 ' + NOTIFY_PREFIX + 'notifications）')
  })
  // 启动自检：把服务可见性打到宿主日志——"通知不弹 / 显示未知工作区"的第一现场就在这里。
  // 注意：这是**时刻快照**，而部分服务（如 workspaceRegistry）在启动期是异步激活的
  //   —— dsh-workspace 的服务描述：先等 sessionPersistence，再建 canonical-cwd 头索引，
  //   最后完成一次性历史 bootstrap 才 active。2 秒时未就绪属正常，故：
  //   ① 措辞用「未就绪」而不是「缺失」（后者容易被读成坏了）；
  //   ② 8 秒再查一次，只在状态发生变化时补一行，避免误报变成噪音。
  const serviceState = (value) => (value === undefined ? '未就绪' : '就绪')
  const selfCheckLine = () =>
    'webServer=' + serviceState(notifyServices.webServer) +
    '｜sessions=' + serviceState(notifyServices.sessions) +
    '｜sessionTitle=' + serviceState(notifyServices.sessionTitle) +
    '｜workspaceRegistry=' + serviceState(notifyServices.workspaceRegistry) +
    '｜agents=' + serviceState(notifyServices.agents)
  /** 自检用的定时器（含 8 秒复查），随作用域一并清理。 */
  const selfCheckTimers = []
  const notifySelfCheck = setTimeout(() => {
    const first = selfCheckLine()
    console.log('[dupguard] 截停通知自检：' + first + '（启动期快照；未就绪的异步服务会稍后注入，截停时按需读取）')
    const lateCheck = setTimeout(() => {
      const second = selfCheckLine()
      if (second !== first) console.log('[dupguard] 截停通知自检（+8s 复查）：' + second)
    }, 8000)
    if (lateCheck !== undefined && typeof lateCheck.unref === 'function') lateCheck.unref()
    selfCheckTimers.push(lateCheck)
  }, 2000)
  if (notifySelfCheck !== undefined && typeof notifySelfCheck.unref === 'function') notifySelfCheck.unref()
  ctx.effect(() => () => {
    clearTimeout(notifySelfCheck)
    for (const timer of selfCheckTimers) clearTimeout(timer)
  }, 'dupguard: notify self-check')
  // loader entry 的 ctx 无法用 ctx.get 直接解析 root 服务（DSH 宿主行的约定），
  // 必须经 ctx.inject 等待服务注入后在回调中访问 ctx.settings / ctx.cordisInspect。
  ctx.inject(['cordisInspect'], (inspectCtx) => {
    if (CONFIG.fixStandingMountConflict) installStandingMountPatch(inspectCtx.cordisInspect)
  })
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (settings === undefined) return
    // 自定义设置页由客户端注册；关闭 DSH 自动生成的通用页避免出现两个页面。
    // 必须显式传本插件的 fiber：configure(presentation, owner = this.ctx.fiber) 的
    // 默认 owner 是 settings 服务自己的 fiber，传错就等于没关。
    // configure 仅 ≥ 0.1.7 提供，旧版本静默跳过。
    if (typeof settings.configure === 'function') {
      try {
        settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'dupguard: settings presentation')
      } catch (error) {
        console.warn('[dupguard] 关闭自动设置页失败（不影响检测）：' + (error && error.message ? error.message : String(error)))
      }
    }
    if (typeof settings.register === 'function') {
      // DSH ≤ 0.1.6：注册独立命名空间（dsh-dupguard）并 watch 其取值。
      installSettings(settingsCtx, runtime)
      return
    }
    // DSH ≥ 0.1.7：设置值来自 loader 注入的插件 Config（命名空间 = entry id）。
    // 组合补丁层的写入不会回流到运行中的 fiber，因此这里把「文件里的用户层值」叠加在 Config 之上。
    const fromConfig = () => {
      const next = createRuntime()
      const base = settingsValueFromConfig(config)
      const live = readLiveOverrides()
      const merged = live === null ? base : { ...base, ...live }
      applySettingsToRuntime(next, merged, (info) => {
        pushDerived(settings, info)
      })
      return next
    }
    const startup = fromConfig() // 启动时先算一次：日志中暴露非法配置
    runtimeSource = fromConfig
    console.log('[dupguard] 设置参数取自插件 Config（DSH ≥ 0.1.7 模型；命名空间为 loader entry id）')
    // 生效参数清单：用于确认宿主加载的版本与「设置是否真的进来了」（片段白名单是否生效靠它判断）。
    logRuntimeSummary(startup, '生效参数：')

    /** 把最新持久化配置推回自身 fiber，让设置页读回也看到新值（失败只告警一次）。 */
    const pushLiveConfig = () => {
      const live = readLiveOverrides()
      if (live === null) return
      const merged = { ...settingsValueFromConfig(config), ...live }
      try {
        if (ctx.fiber !== undefined && typeof ctx.fiber.update === 'function') ctx.fiber.update(merged)
      } catch (error) {
          warnLiveUpdateFailure(error && error.message ? error.message : String(error))
      }
      logRuntimeSummary(fromConfig(), '生效参数（热更新）：')
    }
    // 事件在 describe() 内同步发出：延后一拍执行，避免在描述符构建过程中改动 fiber。
    let pushScheduled = false
    const schedulePush = () => {
      if (pushScheduled) return
      pushScheduled = true
      setTimeout(() => {
        pushScheduled = false
        pushLiveConfig()
      }, 0)
      if (typeof pushScheduled.unref === 'function') pushScheduled.unref()
    }
    ctx.on('settings/document-updated', (ns) => {
      if (ns === undefined || String(ns).indexOf('dupgard') !== -1) schedulePush()
    })
    try {
      const watched = profileConfigFile()
      const statWatcher = nodeFs.watchFile(watched, { interval: 1000 }, () => schedulePush())
      // unref：轮询句柄不得阻止进程退出（宿主常驻无影响，测试/CLI 场景下很重要）。
      if (statWatcher !== undefined && typeof statWatcher.unref === 'function') statWatcher.unref()
      ctx.effect(() => () => {
        try {
          nodeFs.unwatchFile(watched)
        } catch (_unwatchError) {}
      }, 'dupgard: live config watch')
    } catch (_watchError) {}
  })
  // llm/stream：包裹每次流式模型调用的瀑布事件。
  // 监听器返回包装后的 AsyncIterable，即成为本次调用对消费方可见的流。
  // （与 @deepseek-ai/dsh-llm 的 invariant、dsh-session-checkpoint-policy 同款接入方式）
  ctx.on('llm/stream', (options, next) => createStreamGuard(options, runtimeSource(), {
    // 每次调用各自绑定自己的 options：通知里要记的是**这次**被截停的会话。
    onStop: (hit) => notifyStop(hit, options),
  })(next()))
}

// 测试钩子：截停通知的内部函数（与 plugin/host.js 的 __derived 同款做法）。
// 只读、无副作用；不在 README 中作为公开接口承诺。
module.exports = {
  name,
  apply,
  Config,
  __notify: {
    NOTIFY_PREFIX,
    NOTIFY_ROUTE,
    NOTIFY_LIMIT,
    NOTIFY_UNIT_MAX,
    CONTINUE_PROMPT_MAX,
    createStopNotifier,
    publicNotice,
    describeStoppedSession,
    normalizePathForCompare,
    buildUserMessage,
    deliverContinue,
    registerNotifyRoutes,
    handleNotifyRequest,
    createStreamGuard,
  },
  /**
   * 高级模式（module）的加载与判次路径——沙箱试运行工具（tools/sandbox-threshold-module.mjs）
   * 用的就是这几个函数，保证"试运行结果"与"宿主真实生效结果"同源；同时供测试断言。
   */
  __advanced: {
    loadAdvancedModule,
    createThresholdPolicy: createPolicy,
    describePolicy,
    isValidNeed,
    parseThresholdByLength,
  },
  /**
   * 派生逻辑的只读测试钩子：客户端设置页有一份镜像实现（浏览器 bundle 不能 require 宿主模块），
   * tests/client.test.js 用这里与客户端 __derive 做跨实现等价比较，防止两侧公式漂移。
   */
  __derive: {
    deriveWindow,
    deriveMaxUnitLength,
    parseThresholdByLength,
    createThresholdPolicy,
    codeBlockMode,
    effectiveCodeThreshold,
  },
}
