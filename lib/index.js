'use strict'

const nodeFs = require('fs')

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
//
// 模块边界：检测引擎 lib/engine.js、设置集成 lib/settings.js、截停通知 lib/notify.js；
// 本文件只做入口编排（Config 导出 / apply / 测试钩子），不再承载具体实现。
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
  loadConfigSchema,
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

const { createNotifyApi } = require('./notify')
const notify = createNotifyApi({ defaultContinuePrompt: CONFIG.continuePrompt })
const { createStopLogger } = require('./stop-log')

const {
  NOTIFY_PREFIX,
  NOTIFY_ROUTE,
  NOTIFY_LIMIT,
  NOTIFY_UNIT_MAX,
  createStopNotifier,
  publicNotice,
  describeStoppedSession,
  normalizePathForCompare,
  buildUserMessage,
  deliverContinue,
  registerNotifyRoutes,
  handleNotifyRequest,
} = notify

function apply(ctx, config) {
  // 启动自检：把关键服务可见性直接打到宿主日志，便于诊断挂载问题。
  console.log('[dupguard] 常驻插件 apply 开始')
  const runtime = createRuntime()
  // 每次模型调用用哪份参数：默认代码常量 + 旧版设置作用域（runtime 原地更新）；
  // DSH ≥ 0.1.7 改为按需读插件 Config（用户层写入后 loader 实时下发新 config）。
  let runtimeSource = () => runtime
  // 截停通知队列 + 通道：宿主记录，浏览器（全局浮层）读取并回传用户选择。
  const notifier = createStopNotifier()
  // 阈值决策控制器（每次 llm/stream 最多一个）：通知动作按 item id 路由回对应流。
  const decisionControllers = new Map()
  const handleDecisionAction = (item, action) => {
    const controller = decisionControllers.get(item.id)
    if (controller === undefined) return { ok: false, message: '本次决策已结束' }
    return controller.handle(action)
  }
  try {
    notify.setDecisionHandler(handleDecisionAction)
  } catch (_decisionHandlerError) {}
  // 截停持久化日志（JSONL）；关闭/写失败都静默降级，不影响检测与截停。
  const stopLogger = createStopLogger()
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
  /**
   * 把一次截停写入持久化日志（`~/.dsh/dupgard/stops.jsonl`）。
   *
   * 与通知开关（notifyOnStop）无关：只要检测到截停就记录；工作区/会话名解析失败
   * 时降级为 null。整个函数 best-effort，任何异常都不得影响截停收尾。
   * @param hit - 命中信息（unit / count / span / code / source）。
   * @param options - 本次 llm/stream 的 GenerateOptions（取 sessionId / provider / model）。
   */
  const recordStop = (hit, options, meta) => {
    let current
    try {
      current = runtimeSource()
    } catch (_runtimeError) {
      current = runtime
    }
    let info = { sessionTitle: null, workspacePath: null, workspaceTitle: null }
    try {
      const sessionId = options !== undefined && options !== null && options.sessionId !== undefined && options.sessionId !== null
        ? String(options.sessionId)
        : null
      info = describeStoppedSession(notifyServices, sessionId)
    } catch (_infoError) {}
    stopLogger.record(hit, options, {
      runtime: current,
      sessionTitle: info.sessionTitle,
      workspacePath: info.workspacePath,
      workspaceTitle: info.workspaceTitle,
      decision: meta !== undefined && meta !== null ? meta.decision : undefined,
      heldMs: meta !== undefined && meta !== null ? meta.heldMs : undefined,
    })
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
  // 决策模式可用性：需要有通知通道、通知开关开启、且未关闭决策功能。
  // 环境变量 DSH_DUPGUARD_DECISION=off 可作为临时/排障总开关（回退到阈值即停）。
  const decisionAvailable = (current) => current !== undefined && current !== null &&
    current.stopDecision !== false &&
    current.notifyOnStop === true &&
    notifyServices.webServer !== undefined && notifyServices.webServer !== null &&
    !(typeof process !== 'undefined' && process.env !== undefined &&
      ['off', '0', 'false'].includes(String(process.env.DSH_DUPGUARD_DECISION || '').trim().toLowerCase()))
  /**
   * 创建一次阈值决策控制器。
   * - 暂停窗口（decisionTimeoutMs）内：用户点「立即截停 / 允许继续」通过 resolve 决定；
   * - 超时后：resolve('continue')，引擎进入观察期，达到「阈值 × 倍数」自动截停；
   * - 观察期内用户仍可操作：写 control.action，引擎在下一个 chunk 生效。
   * @param hit - 引擎命中信息（unit/count/span/code/source）。
   * @param options - 本次 llm/stream 的 GenerateOptions。
   * @param current - 命中时的运行时配置快照。
   * @param control - 引擎提供的二期控制句柄 `{ action }`。
   */
  const createDecisionController = (hit, options, current, control) => {
    const sessionId = options !== undefined && options !== null && options.sessionId !== undefined && options.sessionId !== null
      ? String(options.sessionId)
      : null
    let info = { sessionTitle: null, workspacePath: null, workspaceTitle: null }
    try {
      info = describeStoppedSession(notifyServices, sessionId)
    } catch (_infoError) {}
    const need = Number.isSafeInteger(hit.count) && hit.count > 1 ? hit.count : current.threshold
    const multiplier = Number.isSafeInteger(current.stopAtMultiplier) && current.stopAtMultiplier >= 2 ? current.stopAtMultiplier : 2
    const timeoutMs = Number.isSafeInteger(current.decisionTimeoutMs)
      ? Math.min(15000, Math.max(1000, current.decisionTimeoutMs))
      : 4000
    const deadline = Date.now() + timeoutMs
    const item = notifier.push({
      kind: 'decision',
      phase: 'paused',
      sessionId,
      sessionTitle: info.sessionTitle,
      workspacePath: info.workspacePath,
      workspaceTitle: info.workspaceTitle,
      unit: hit !== undefined && hit !== null && typeof hit.unit === 'string' ? hit.unit : '',
      count: Number.isSafeInteger(hit.count) ? hit.count : null,
      span: Number.isSafeInteger(hit.span) ? hit.span : null,
      code: hit !== undefined && hit !== null && hit.code === true,
      source: hit !== undefined && hit !== null && typeof hit.source === 'string' ? hit.source : 'text',
      prompt: '',
      deadline,
      autoStopCount: need * multiplier,
    })
    let resolveDecision = null
    const promise = new Promise((resolve) => {
      resolveDecision = resolve
    })
    const state = { resolved: false, finished: false, timer: null }
    const update = (patch) => {
      try {
        notifier.update(item.id, patch)
      } catch (_updateError) {}
    }
    const stopTimer = () => {
      if (state.timer !== null) {
        clearTimeout(state.timer)
        state.timer = null
      }
    }
    const markTerminal = (status, message, phase) => {
      state.finished = true
      stopTimer()
      update({ status, phase: phase === undefined ? 'stopped' : phase, deadline: null, decisionStatus: status, detail: message })
    }
    const controller = {
      id: item.id,
      promise,
      control,
      /** 处理通知卡片的动作（由 notify 路由调用）。 */
      handle(action) {
        if (state.finished) {
          const already = (action === 'stop-now' && (item.status === 'stopped' || item.status === 'stopped-by-user')) ||
            (action === 'allow-repeat' && item.status === 'allowed')
          if (already) return { ok: true, already: true, status: item.status, message: '该决策已处理' }
          return { ok: false, message: '本次决策已结束' }
        }
        if (action === 'stop-now') {
          control.action = 'stop'
          if (!state.resolved) {
            state.resolved = true
            markTerminal('stopped-by-user', '用户选择立即截停')
            resolveDecision('stop')
          } else {
            markTerminal('stopped-by-user', '用户选择立即截停', 'armed')
          }
          return { ok: true, status: 'stopped-by-user', message: '已立即截停' }
        }
        if (action === 'allow-repeat') {
          control.action = 'allow'
          if (!state.resolved) {
            state.resolved = true
            markTerminal('allowed', '用户允许本次继续', 'allowed')
            resolveDecision('allow')
          } else {
            markTerminal('allowed', '用户允许本次继续', 'allowed')
          }
          return { ok: true, status: 'allowed', message: '已允许本次继续' }
        }
        return { ok: false, message: '未知决策动作' }
      },
      /** 引擎通知「决策/观察期结束」（recovered / cancelled / expired）。 */
      settle(outcome) {
        if (state.finished) return
        state.finished = true
        state.resolved = true
        stopTimer()
        const status = outcome === 'recovered' ? 'recovered' : (outcome === 'cancelled' ? 'cancelled' : 'expired')
        const message = outcome === 'recovered'
          ? '重复已中断，本次不再截停'
          : (outcome === 'cancelled' ? '调用已结束，决策取消' : '调用结束前未达到强制截停次数')
        update({ status, phase: 'ended', deadline: null, decisionStatus: status, detail: message })
        try {
          resolveDecision('continue')
        } catch (_resolveError) {}
        decisionControllers.delete(item.id)
      },
      /** 最终截停时标记卡片（user / auto / threshold）。 */
      finish(meta) {
        stopTimer()
        state.finished = true
        state.resolved = true
        const decision = meta !== undefined && meta !== null ? meta.decision : undefined
        const status = decision === 'user' ? 'stopped-by-user' : 'stopped'
        const message = decision === 'user'
          ? '用户选择立即截停'
          : (decision === 'auto' ? '未操作，达到阈值 × ' + String(multiplier) + ' 自动截停' : '已截停')
        update({ status, phase: 'stopped', deadline: null, decisionStatus: status, detail: message })
        decisionControllers.delete(item.id)
        try {
          resolveDecision('stop')
        } catch (_resolveError) {}
      },
    }
    decisionControllers.set(item.id, controller)
    state.timer = setTimeout(() => {
      if (state.resolved || state.finished) return
      state.resolved = true
      update({ phase: 'armed', deadline: null, detail: '等待超时，继续观察；达到 ' + String(need * multiplier) + ' 次将自动截停' })
      resolveDecision('continue')
    }, timeoutMs)
    // 决策窗口内必须保持进程存活（暂停期间没有其他活跃句柄；不 unref）。
    console.log('[dupguard] 阈值决策 ' + item.id + '：暂停 ' + String(timeoutMs) + 'ms 等待用户（' + String(need * multiplier) + ' 次自动截停）')
    return controller
  }
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
  ctx.on('llm/stream', (options, next) => {
    let currentRuntime
    try {
      currentRuntime = runtimeSource()
    } catch (_runtimeError) {
      currentRuntime = runtime
    }
    let activeController = null
    const hooks = {
      // 每次调用各自绑定自己的 options：通知里要记的是**这次**被截停的会话。
      onStop: (hit, meta) => {
        if (activeController !== null) {
          try {
            activeController.finish(meta)
          } catch (_finishError) {}
          activeController = null
        }
        // 先落盘再入队：即使通知链路出问题，截停记录也不会丢。
        recordStop(hit, options, meta)
        notifyStop(hit, options)
      },
    }
    if (decisionAvailable(currentRuntime)) {
      hooks.onThreshold = (hit, control) => {
        activeController = createDecisionController(hit, options, currentRuntime, control)
        return activeController.promise
      }
      hooks.onThresholdSettled = (hit, outcome) => {
        if (activeController !== null) {
          try {
            activeController.settle(outcome)
          } catch (_settleError) {}
          activeController = null
        }
      }
    }
    return createStreamGuard(options, currentRuntime, hooks)(next())
  })
}

// 测试钩子：截停通知的内部函数（与 plugin/host.js 的 __derived 同款做法）。
// 只读、无副作用；不在 README 中作为公开接口承诺。
module.exports = {
  name,
  apply,
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

// Config 用**访问器**导出（而不是加载时一次性取值）：
// schemastery 的 CJS 入口会 require() ESM 包 cosmokit，DSH 启动期可能撞上
// 「not yet fully loaded」竞态。设置服务在 describe 时读取 runtime.Config，
// 访问器会在竞态结束后重试成功，命名空间随之恢复，无需重启宿主。
// 先写一个静态赋值让 cjs-module-lexer 仍能识别 named export（loader 实际走 default）。
module.exports.Config = undefined
Object.defineProperty(module.exports, 'Config', {
  enumerable: true,
  configurable: true,
  get: () => loadConfigSchema(),
})
