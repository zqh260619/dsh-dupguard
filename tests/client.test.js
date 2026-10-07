'use strict'

// ============================================================================
// dupguard 浏览器端（lib/client.js）单元测试
//
// 用最小 React 桩 + 最小 DSH 客户端 ctx 桩直接驱动设置页组件，覆盖：
//   1. 写路径调用 settingsScope 控制器（不再触碰 connection.api，DSH 0.1.2
//      起该字段已移除——这正是「保存中…」卡死的根因）；
//   2. 白名单增删与「已保存」回显、重开显示持久化值；
//   3. 数值参数（阈值/最小单元/最大单元/窗口）与布尔开关的动态写入；
//   4. 非法输入与跨字段违规不写入，并给出内联错误；
//   5. 窗口 < 阈值 × 最大单元长度时显示「窗口长度需要提高」提示；
//   6. 「恢复默认」逐字段 unset，回到代码默认值。
// ============================================================================

const fs = require('fs')
const path = require('path')
const assert = require('assert')

let passed = 0
const ok = (label) => {
  console.log('  ✓ ' + label)
  passed++
}

// ---------------------------------------------------------------------------
// 最小 React：只实现组件用到的那部分 hook（按调用顺序编号的槽位数组）。
// ---------------------------------------------------------------------------
let slots = []
let slot = 0
let effectsRun = false

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props === null || props === undefined ? {} : props,
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  useState: (initial) => {
    const index = slot++
    if (slots.length <= index) slots[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      slots[index] = typeof value === 'function' ? value(slots[index]) : value
    }
    return [slots[index], set]
  },
  useRef: (initial) => {
    const index = slot++
    if (slots.length <= index) slots[index] = { current: initial }
    return slots[index]
  },
  useEffect: (fn) => {
    const index = slot++
    if (effectsRun) return
    if (slots.length <= index) {
      slots[index] = true
      fn()
    }
  },
  useSyncExternalStore: (subscribe, getSnapshot) => {
    slot++
    return getSnapshot()
  },
}

const render = (component, componentProps) => {
  slot = 0
  const tree = component(componentProps)
  effectsRun = true
  return tree
}

const remount = () => {
  slots = []
  effectsRun = false
}

// ---------------------------------------------------------------------------
// 树工具：查找元素 / 取文本。
// ---------------------------------------------------------------------------
const collect = (node, predicate, out = []) => {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children) collect(child, predicate, out)
  return out
}
const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined) return ''
  return node.children.map(textOf).join('')
}
const buttonByText = (tree, text) => collect(tree, (node) => node.type === 'button' && textOf(node) === text)[0]
const fieldNode = (tree, key) => collect(tree, (node) => node.props.className === 'dg-field' && node.props.key === key)[0]
const numberInput = (tree, key) => collect(fieldNode(tree, key), (node) => node.type === 'input')[0]
const switchButton = (tree, key) => collect(fieldNode(tree, key), (node) => node.props.role === 'switch')[0]
// 派生窗口/最大单元只显示在底部诊断行里（不再单独占行）：从整页文本里取。
const autoWindowText = (tree) => {
  const match = /检测窗口 (\d+)/.exec(textOf(tree))
  return match === null ? null : match[1]
}
const autoMaxUnitText = (tree) => {
  const match = /最大重复单元长度 (\d+)/.exec(textOf(tree))
  return match === null ? null : match[1]
}
const fieldError = (tree, key) => {
  const node = collect(fieldNode(tree, key), (item) => item.props.className === 'dg-field-error')[0]
  return node === undefined ? null : textOf(node)
}
const chipTexts = (tree) => collect(tree, (node) => node.props.className === 'dg-chip').map((node) => textOf(node.children[0]))
// 白名单只有一个输入框（字符与片段共用，写入时自动分类）。
const whitelistInput = (tree) => collect(tree, (node) => node.props.id === 'dg-whitelist-input')[0]
// 片段行内错误：不在 .dg-field 内，取最后一个 dg-field-error。
const lastFieldError = (tree) => {
  const nodes = collect(tree, (node) => node.props.className === 'dg-field-error')
  return nodes.length === 0 ? '' : textOf(nodes[nodes.length - 1])
}
// 按 chip 文本找到它的删除按钮（chip 文本含结尾的 ×）。
const removeChipByLabel = (tree, label) => {
  const chip = collect(tree, (node) => node.props.className === 'dg-chip' && textOf(node) === label + '\u00d7')[0]
  return chip === undefined ? undefined : collect(chip, (node) => node.props.className === 'dg-chip-remove')[0]
}
const warnText = (tree) => {
  const node = collect(tree, (item) => item.props.className === 'dg-warn')[0]
  return node === undefined ? null : textOf(node)
}
// 状态行：正常态是 dg-note，错误态是 dg-note dg-error，两者都要收集。
const statusText = (tree) => collect(
  tree,
  (node) => typeof node.props.className === 'string' && node.props.className.indexOf('dg-note') === 0,
).map(textOf).join(' | ')

// ---------------------------------------------------------------------------
// 载入 client bundle（window.__ModuleLoader__ 形态）。
// ---------------------------------------------------------------------------
let bundle = null
global.window = {
  __ModuleLoader__: {
    load: (spec) => {
      bundle = spec
    },
  },
}
const clientSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
new Function('window', 'require', clientSource)(global.window, (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
assert.ok(bundle !== null, 'bundle 应通过 window.__ModuleLoader__.load 注册')
assert.strictEqual(bundle.id, 'dsh-dupguard')
const plugin = bundle.factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
assert.strictEqual(typeof plugin.apply, 'function')

// 本地化桩：只给需要校验占位符替换的键提供模板，其余直接回显键名。
// 截停通知浮层的文案与被断言的值必须与 lib/client.js 的 zh 字典一致（见 C15）。
const DICT = {
  windowWarn: '窗口至少 {need}（当前 {current} = 阈值 {threshold} × 倍数 {multiplier} × 最大单元 {maxUnit}），超过 {effective} 字符无法识别',
  loadingDiag: '设置通道：{state}｜{diag}',
  derivedDiag: '自动派生：检测窗口 {window}',
  derivedDiagTable: '自动派生：检测窗口 {window} · 最大重复单元长度 {maxUnit}（末行决定）',
  noticeTitle: '重复输出已截停',
  noticeWorkspace: '工作区',
  noticeSession: '会话',
  noticeUnit: '重复字符串',
  noticeDetail: '连续重复 {count} 次｜跨度 {span} 字符',
  noticeUnknownWorkspace: '（未知工作区）',
  noticeUnknownSession: '（未命名会话）',
  noticeSourceText: '可见输出',
  noticeSourceReasoning: '思考文本',
  noticeSourceTool: '工具调用参数',
  noticeCodeRegion: '代码区域内（已按倍数放宽）',
  noticeSend: '发送继续指令',
  noticeDismiss: '不发送',
  noticeOpen: '打开该会话',
  noticeSending: '正在发送…',
  noticeEmptyUnit: '（空字符串/纯空白）',
  noticeHostMissing: '截停通知未生效：宿主半体尚未加载',
  noticeHostMissingHint: '通知通道由宿主提供（/dsh-dupguard/notifications），当前请求失败。宿主代码只在进程启动时加载——**重启 `dsh web`** 后生效；检测与截停本身不受影响。',
  noticeHostMissingDismiss: '知道了',
}
const fakeT = (key) => (DICT[key] === undefined ? key : DICT[key])

// ---------------------------------------------------------------------------
// 最小 DSH 客户端 ctx 桩：settingsScope 控制器 + describe 面 + 槽位注册。
// 注意：故意不提供 connection.api —— 组件不得再依赖它。
// ---------------------------------------------------------------------------
const DEFAULTS = {
  ignoredChars: ['-', '|'],
  ignoredSubstrings: [],
  thresholdMode: 'simple',
  thresholdByLength: '',
  advancedThresholdFile: '',
  threshold: 10,
  codeBlockMultiplier: 3,
  minUnitLength: 1,
  maxUnitLength: 80,
  detectionWindow: 8192,
  stripWhitespace: true,
  skipCodeBlocks: true,
  monitorReasoning: true,
  monitorToolArguments: false,
  notifyOnStop: true,
  continuePrompt: '请从中断处继续，不要重复之前的内容。',
}
// 恢复默认会 unset 客户端声明的全部字段；detectionWindow 已改为派生值，不再由客户端 unset。
const FIELDS = Object.keys(DEFAULTS).filter((key) => key !== 'detectionWindow')

/**
 * 从 harness 的注册列表里取设置分节。
 * 客户端现在注册两个槽位：设置分节（settings.section）与截停通知浮层（shell.overlay），
 * 因此凡是「取设置分节」的地方都按 name 筛选，不依赖注册顺序或总数。
 */
const sections = (harness) => harness.registrations.filter((item) => item.options.name === 'settings.section')

/**
 * 最小 DSH 客户端 ctx 桩。
 *
 * mode：
 *   - 'legacy'：只提供 settingsScope（DSH ≤ 0.1.6 的设置通道）；
 *   - 'remote'：只提供 remote + remote.settings（DSH ≥ 0.1.7 的 typert 通道）；
 *   - 'none'  ：两者都不提供（无头/未知版本）——插件仍须正常激活。
 * 注意：故意不提供 connection.api —— 组件不得再依赖它。
 */
function createHarness(mode = 'legacy', options = {}) {
  const calls = []
  const remoteCalls = []
  const listeners = new Set()
  const state = { revision: 1, user: {} }
  const remoteNs = options.remoteNs === undefined ? 'dupguard' : options.remoteNs
  let writable = options.writable !== false
  let failMutate = options.failMutate === true
  let failOnce = options.failOnce === true
  const currentValue = () => {
    const out = {}
    for (const key of FIELDS) {
      const stored = state.user[key]
      out[key] = stored !== undefined ? stored : DEFAULTS[key]
    }
    out.ignoredChars = [...out.ignoredChars]
    out.ignoredSubstrings = [...out.ignoredSubstrings]
    // detectionWindow 不在 FIELDS 里（「恢复默认」不再 unset 它），但它确实出现在宿主快照中
    // （schema 字段照常投影）——本插件用它显示 module 模式下宿主写回的窗口值。
    out.detectionWindow = state.user.detectionWindow !== undefined
      ? state.user.detectionWindow
      : DEFAULTS.detectionWindow
    return out
  }
  let cached = null
  const snapshot = () => {
    if (cached === null || cached.revision !== state.revision) {
      cached = {
        status: 'ready',
        value: currentValue(),
        revision: state.revision,
        base: { ...DEFAULTS },
        user: { ...state.user },
        writable: true,
        mode: 'host',
      }
    }
    return cached
  }
  const notify = () => {
    cached = null
    for (const listener of [...listeners]) listener()
  }
  const controller = {
    getSnapshot: snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (field, next) => {
      calls.push(['set', field, next])
      state.user[field] = Array.isArray(next) ? [...next] : next
      state.revision++
      notify()
      return Promise.resolve()
    },
    unset: (field) => {
      calls.push(['unset', field])
      delete state.user[field]
      state.revision++
      notify()
      return Promise.resolve()
    },
    mutate: (ops) => {
      calls.push(['mutate', ops])
      return Promise.resolve()
    },
    dispose: () => Promise.resolve(),
  }
  const mirror = {
    getSnapshot: () => ({ status: 'ready', view: { namespaces: [], writable: true, hasDocument: false }, error: null }),
    subscribe: () => () => {},
    load: () => {
      calls.push(['mirror.load'])
      return Promise.resolve()
    },
  }
  // 新版 remote.settings 桩：describe()/mutate(ns, ops, expectedRevision)。
  const rowView = () => ({
    ns: remoteNs,
    autoGenerate: false,
    schema: {},
    value: currentValue(),
    base: { ...DEFAULTS },
    user: { ...state.user },
    applies: 'live',
    revision: state.revision,
  })
  const remoteService = {
    settings: {
      describe: () => {
        remoteCalls.push(['describe'])
        const namespaces = options.rowMissing === true ? [] : [rowView()]
        return Promise.resolve({ ok: true, value: { writable, namespaces } })
      },
      mutate: (ns, ops, expectedRevision) => {
        remoteCalls.push(['mutate', ns, ops, expectedRevision])
        if (failOnce) {
          failOnce = false
          return Promise.resolve({ ok: false, error: { message: 'SETTINGS_CONFLICT' } })
        }
        if (failMutate) return Promise.resolve({ ok: false, error: { message: '宿主拒绝了该写入' } })
        if (expectedRevision !== undefined && expectedRevision !== state.revision) {
          return Promise.resolve({ ok: false, error: { message: 'SETTINGS_CONFLICT' } })
        }
        for (const op of ops) {
          if (op.op === 'set') state.user[op.path[0]] = op.value
          else delete state.user[op.path[0]]
        }
        state.revision++
        return Promise.resolve({ ok: true, value: rowView() })
      },
    },
    $host: { isLoopback: options.loopback !== false },
    $on: () => () => {},
  }
  const registrations = []
  const injectCalls = []
  const disposers = []
  const settingsScopeService = {
    bind: () => controller,
    describe: () => mirror,
  }
  const ctx = {
    get: (name) => {
      if (name === 'connection') return { isLoopback: true }
      // 与 cordis 一致：只有已注册的服务可被 get 取到。
      if (mode === 'remote' || mode === 'remote-dotted') {
        if (name === 'remote') return remoteService
        if (name === 'remote.settings') return remoteService.settings
      }
      return undefined
    },
    effect: (fn) => {
      const produced = typeof fn === 'function' ? fn() : undefined
      const disposer = () => {
        if (typeof produced === 'function') produced()
      }
      disposers.push(disposer)
      return disposer
    },
    locale: {
      register: () => {},
      bind: () => fakeT,
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (options2, component) => {
        registrations.push({ options: options2, component })
      },
    },
    // 动态服务注入：依赖缺席时 cordis 不会调用回调（插件因此保持激活而非 pending）。
    inject: (keys, callback) => {
      injectCalls.push([...keys])
      const scope = { on: () => () => {} }
      for (const key of keys) {
        if (key === 'settingsScope') {
          if (mode === 'none') return () => {}
          scope.settingsScope = settingsScopeService
        } else if (key === 'remote') {
          if (mode !== 'remote' && mode !== 'remote-dotted') return () => {}
          scope.remote = remoteService
        } else if (key === 'remote.settings') {
          if (mode !== 'remote' && mode !== 'remote-dotted') return () => {}
          scope['remote.settings'] = remoteService.settings
        } else return () => {}
      }
      // 忠实模拟 cordis：父服务未被显式声明时，作用域里没有 remote。
      if (mode === 'remote-dotted') delete scope.remote
      const disposer = callback(scope)
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  if (mode === 'legacy') ctx.settingsScope = settingsScopeService
  return {
    ctx,
    calls,
    remoteCalls,
    injectCalls,
    controller,
    registrations,
    state,
    remoteService,
    dispose: () => {
      for (const disposer of disposers.splice(0)) disposer()
    },
    setWritable: (value) => {
      writable = value
    },
    setFailMutate: (value) => {
      failMutate = value
    },
    reload: () => Promise.resolve(),
  }
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** 更深的微任务排空：新版写通道把并发写串行化，恢复默认会排队 N 个 mutate。 */
const settle = async () => {
  for (let i = 0; i < 128; i++) await Promise.resolve()
}

let entry = null
let props = null
const rerender = () => render(entry.component, props)

async function main() {
  console.log('dupguard client 设置页测试（最小 React/DSH 桩）')

  const harness = createHarness()
  plugin.apply(harness.ctx)
  // 现在注册两个槽位：设置分节 + 截停通知浮层（shell.overlay，root 作用域）。
  assert.strictEqual(harness.registrations.length, 2, '应注册 settings.section 与 shell.overlay 两个槽位')
  entry = harness.registrations.find((item) => item.options.name === 'settings.section')
  assert.ok(entry !== undefined, '应注册 settings.section 槽位，实际：' +
    harness.registrations.map((item) => item.options.name).join(','))
  const noticeEntry = harness.registrations.find((item) => item.options.name === 'shell.overlay')
  assert.ok(noticeEntry !== undefined, '应注册 shell.overlay 截停通知浮层')
  assert.strictEqual(noticeEntry.options.id, 'dupguard-stop-notice')
  assert.strictEqual(typeof noticeEntry.component, 'function', '浮层应有组件')
  assert.strictEqual(entry.options.name, 'settings.section')
  assert.strictEqual(entry.options.id, 'dupguard')
  assert.strictEqual(entry.options.order, 25)
  assert.strictEqual(typeof entry.options.label, 'function')
  assert.strictEqual(entry.options.label(), 'nav', 'label 应为注册时本地化的文本 thunk')
  ok('settings.section 槽位注册（id/order/label）')

  props = entry.options.inject()
  assert.strictEqual(props.api, undefined, 'props 不应再暴露 connection.api')
  assert.strictEqual(typeof props.controller.set, 'function')

  // C0：客户端默认值必须与宿主注册的 base 一致（两侧各有一份常量，防止漂移）。
  {
    const hostPlugin = require(path.join(__dirname, '..', 'lib', 'index.js'))
    const captured = { ns: null, base: null, schema: null }
    const hostWatchers = []
    const hostCtx = {
      get: () => undefined,
      settings: {
        register: (ns, schema, options) => {
          captured.ns = ns
          captured.base = options.base
          captured.schema = schema
          return {
            get: () => options.base,
            watch: (cb) => {
              hostWatchers.push(cb)
              return () => {}
            },
            update() {},
            replace() {},
          }
        },
      },
      inject: (keys, callback) => callback(hostCtx),
      on: () => () => {},
      effect: () => () => {},
    }
    hostPlugin.apply(hostCtx)
    for (let i = 0; i < 100 && hostWatchers.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.strictEqual(captured.ns, 'dsh-dupguard', '宿主应注册 dsh-dupguard 命名空间')
    assert.ok(captured.base !== null, '宿主应注册设置 base')
    assert.deepStrictEqual(captured.base, DEFAULTS, '宿主 base 与客户端 DEFAULTS 必须一致')
    assert.strictEqual(typeof captured.schema, 'function', '宿主应传入 schemastery schema')
    ok('宿主 base 与客户端默认值一致（防两侧漂移）')
  }

  // C1：初始渲染读取控制器快照，并在挂载时重拉镜像。
  let tree = rerender()
  assert.deepStrictEqual(chipTexts(tree), ['-', '|'], '初始应显示快照白名单')
  assert.strictEqual(numberInput(tree, 'threshold').props.value, '10', '阈值应显示快照值')
  assert.strictEqual(numberInput(tree, 'codeBlockMultiplier').props.value, '3', '代码块倍数应显示快照值')
  assert.strictEqual(numberInput(tree, 'minUnitLength').props.value, '1', '最小单元应显示快照值')
  assert.strictEqual(numberInput(tree, 'maxUnitLength').props.value, '80', '最大单元应显示快照值')
  assert.strictEqual(numberInput(tree, 'detectionWindow'), undefined, '检测窗口不应再有输入框（自动派生）')
  assert.strictEqual(autoWindowText(tree), '2400', '派生窗口应为 10 × 3 × 80 = 2400')
  assert.strictEqual(collect(tree, (node) => node.props.id === 'dg-skipCodeBlocks').length, 0,
    '冗余开关 skipCodeBlocks 不应再渲染（与倍数 1 等价）')
  assert.strictEqual(switchButton(tree, 'monitorReasoning').props['aria-checked'], true, 'reasoning 开关应为开')
  assert.strictEqual(switchButton(tree, 'monitorToolArguments').props['aria-checked'], false, '工具参数开关应为关')
  assert.strictEqual(warnText(tree), null, '默认参数下不应出现窗口提示')
  assert.ok(harness.calls.some((call) => call[0] === 'mirror.load'), '挂载时应重拉镜像')
  ok('初始渲染读取快照（白名单 + 参数）并重拉镜像')

  // C2：添加白名单 → 控制器 set，状态「保存中…→已保存」。
  const input = whitelistInput(tree)
  input.props.onChange({ target: { value: 'b' } })
  tree = rerender()
  buttonByText(tree, 'add').props.onClick()
  tree = rerender()
  assert.ok(statusText(tree).indexOf('saving') !== -1, '写入期间应显示保存中')
  await flush()
  tree = rerender()
  assert.deepStrictEqual(harness.calls.find((call) => call[0] === 'set'), ['set', 'ignoredChars', ['-', '|', 'b']], '应调用控制器 set')
  assert.ok(statusText(tree).indexOf('saved') !== -1, '写入成功后应显示已保存')
  assert.deepStrictEqual(chipTexts(tree), ['-', '|', 'b'], '添加后列表应含新字符')
  ok('添加走控制器 set 并回显「已保存」')

  // C3：重开设置页（重新挂载同一控制器）→ 列表来自快照。
  remount()
  tree = rerender()
  assert.deepStrictEqual(chipTexts(tree), ['-', '|', 'b'], '重开后应显示已持久化的白名单')
  ok('重开设置页显示持久化设置')

  // C4：数值参数提交（改动后失焦）→ 控制器 set 对应字段。
  let before = harness.calls.length
  numberInput(tree, 'threshold').props.onChange({ target: { value: '5' } })
  tree = rerender()
  numberInput(tree, 'threshold').props.onBlur()
  await flush()
  tree = rerender()
  assert.deepStrictEqual(harness.calls[before], ['set', 'threshold', 5], '阈值应经控制器写入数字')
  assert.ok(statusText(tree).indexOf('saved') !== -1, '参数写入后应显示已保存')
  assert.strictEqual(numberInput(tree, 'threshold').props.value, '5', '输入框应显示新值')
  ok('数值参数经控制器 set 写入并回显')

  // C5：非法数值不写入，并显示内联错误。
  before = harness.calls.length
  numberInput(tree, 'threshold').props.onChange({ target: { value: '1' } })
  tree = rerender()
  numberInput(tree, 'threshold').props.onBlur()
  await flush()
  tree = rerender()
  assert.strictEqual(harness.calls.length, before, '越界输入不应产生写入')
  assert.strictEqual(fieldError(tree, 'threshold'), 'errRange', '越界输入应显示范围错误')
  numberInput(tree, 'threshold').props.onChange({ target: { value: '5' } })
  tree = rerender()
  assert.strictEqual(fieldError(tree, 'threshold'), null, '恢复合法值后错误应消失')
  ok('非法数值不写入并显示内联错误')

  // C6：跨字段校验（最大单元 < 最小单元）在最大单元行报错且不写入。
  numberInput(tree, 'minUnitLength').props.onChange({ target: { value: '90' } })
  tree = rerender()
  assert.strictEqual(fieldError(tree, 'maxUnitLength'), 'errCross', '最大单元小于最小单元时应报跨字段错误')
  before = harness.calls.length
  numberInput(tree, 'maxUnitLength').props.onBlur()
  await flush()
  assert.strictEqual(harness.calls.length, before, '跨字段违规不应写入')
  numberInput(tree, 'minUnitLength').props.onChange({ target: { value: '1' } })
  tree = rerender()
  ok('跨字段违规在最大单元行报错且不写入')

  // C7：布尔开关 → 控制器 set 布尔值。
  before = harness.calls.length
  switchButton(tree, 'monitorToolArguments').props.onClick()
  await flush()
  tree = rerender()
  assert.deepStrictEqual(harness.calls[before], ['set', 'monitorToolArguments', true], '开关应写入布尔值')
  assert.strictEqual(switchButton(tree, 'monitorToolArguments').props['aria-checked'], true, '开关应切到开')
  ok('布尔开关经控制器 set 写入')

  // C7b：白名单合并输入框 —— 多条目用空白/逗号分隔，其余情况整体输入
  //      （`x y` 加两个字符，`xy` 会作为一个片段条目，这是自动分类的显式规则）。
  before = harness.calls.length
  whitelistInput(tree).props.onChange({ target: { value: 'x y' } })
  tree = rerender()
  buttonByText(tree, 'add').props.onClick()
  await flush()
  tree = rerender()
  assert.deepStrictEqual(
    harness.calls[before],
    ['set', 'ignoredChars', ['-', '|', 'b', 'x', 'y']],
    '空白分隔的多个单字符应逐个加入字符白名单',
  )
  assert.deepStrictEqual(chipTexts(tree), ['-', '|', 'b', 'x', 'y'], 'chips 应含逐个加入的字符')
  before = harness.calls.length
  whitelistInput(tree).props.onChange({ target: { value: 'xy' } })
  tree = rerender()
  buttonByText(tree, 'add').props.onClick()
  await flush()
  tree = rerender()
  assert.deepStrictEqual(
    harness.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'ignoredSubstrings'),
    ['set', 'ignoredSubstrings', ['xy']],
    '未分隔的多字符输入应作为一个片段条目写入',
  )
  assert.deepStrictEqual(chipTexts(tree), ['-', '|', 'b', 'x', 'y', 'xy'], '片段条目应显示为单个 chip')
  ok('白名单合并输入：分隔符切分 + 单字符/片段自动分类')

  // C7c：数值未变化时失焦不写入（否则仅聚焦/失焦就会污染用户层）。
  before = harness.calls.length
  numberInput(tree, 'maxUnitLength').props.onBlur()
  await flush()
  assert.strictEqual(harness.calls.length, before, '未修改的数值失焦不应写入')
  ok('未修改的数值失焦不写入')

  // C7d：从「最小单元」一侧提交跨字段违规 → 在该行报错且不写入。
  numberInput(tree, 'minUnitLength').props.onChange({ target: { value: '90' } })
  tree = rerender()
  assert.strictEqual(fieldError(tree, 'minUnitLength'), 'errCrossMin', '最小单元超过最大单元时应在其行报错')
  before = harness.calls.length
  numberInput(tree, 'minUnitLength').props.onBlur()
  await flush()
  assert.strictEqual(harness.calls.length, before, '最小单元一侧的跨字段违规同样不应写入')
  numberInput(tree, 'minUnitLength').props.onChange({ target: { value: '1' } })
  tree = rerender()
  ok('最小单元一侧的跨字段违规在本地拦截')

  // C7e：布尔开关写入（探针用 stripWhitespace；skipCodeBlocks 已隐藏）。
  before = harness.calls.length
  switchButton(tree, 'stripWhitespace').props.onClick()
  await flush()
  tree = rerender()
  assert.deepStrictEqual(harness.calls[before], ['set', 'stripWhitespace', false], '布尔开关应写入布尔值')
  assert.strictEqual(switchButton(tree, 'stripWhitespace').props['aria-checked'], false, '开关应切到关')
  // 复原为开，避免影响后续窗口提示用例
  switchButton(tree, 'stripWhitespace').props.onClick()
  await flush()
  tree = rerender()
  assert.strictEqual(switchButton(tree, 'stripWhitespace').props['aria-checked'], true, '开关应可再次切回开')

  before = harness.calls.length
  numberInput(tree, 'codeBlockMultiplier').props.onChange({ target: { value: '5' } })
  tree = rerender()
  numberInput(tree, 'codeBlockMultiplier').props.onBlur()
  await flush()
  tree = rerender()
  assert.deepStrictEqual(harness.calls[before], ['set', 'codeBlockMultiplier', 5], '代码块倍数应写入数字')
  assert.strictEqual(numberInput(tree, 'codeBlockMultiplier').props.value, '5', '输入框应显示新倍数')
  ok('代码块放宽开关与倍数经控制器写入')

  // C7f：倍数为 1 时窗口提示按普通阈值计算（不放大要求）；随后复原倍数。
  numberInput(tree, 'codeBlockMultiplier').props.onChange({ target: { value: '1' } })
  tree = rerender()
  numberInput(tree, 'codeBlockMultiplier').props.onBlur()
  await flush()
  tree = rerender()
  assert.strictEqual(warnText(tree), null, '倍数 1、阈值 5、窗口 8192 时不应提示')
  ok('倍数为 1 时窗口需求不放大')
  numberInput(tree, 'codeBlockMultiplier').props.onChange({ target: { value: '3' } })
  tree = rerender()
  numberInput(tree, 'codeBlockMultiplier').props.onBlur()
  await flush()
  tree = rerender()

  // C7g：倍数 0（哨兵值：代码块内完全不检测）可写入，且不放大窗口要求。
  before = harness.calls.length
  numberInput(tree, 'codeBlockMultiplier').props.onChange({ target: { value: '0' } })
  tree = rerender()
  numberInput(tree, 'codeBlockMultiplier').props.onBlur()
  await flush()
  tree = rerender()
  assert.deepStrictEqual(harness.calls[before], ['set', 'codeBlockMultiplier', 0], '倍数 0 应可写入')
  assert.strictEqual(fieldError(tree, 'codeBlockMultiplier'), null, '倍数 0 不应报错')
  assert.strictEqual(numberInput(tree, 'codeBlockMultiplier').props.value, '0', '输入框应显示 0')
  // 阈值 5、最大单元 80：倍数 0 → 派生窗口 400；倍数 3 → 1200；超上限则夹到 1048576
  numberInput(tree, 'codeBlockMultiplier').props.onChange({ target: { value: '0' } })
  tree = rerender()
  assert.strictEqual(autoWindowText(tree), '400', '倍数 0 时派生窗口应为 400（不放大）')
  numberInput(tree, 'codeBlockMultiplier').props.onChange({ target: { value: '3' } })
  tree = rerender()
  assert.strictEqual(autoWindowText(tree), '1200', '倍数 3 时派生窗口应为 1200')
  numberInput(tree, 'threshold').props.onChange({ target: { value: '1000' } })
  tree = rerender()
  numberInput(tree, 'maxUnitLength').props.onChange({ target: { value: '8192' } })
  tree = rerender()
  assert.strictEqual(autoWindowText(tree), '1048576', '需求超上限时派生窗口应夹到 1048576')
  assert.ok(warnText(tree) !== null, '夹上限时应显示提示')
  numberInput(tree, 'threshold').props.onChange({ target: { value: '5' } })
  tree = rerender()
  numberInput(tree, 'maxUnitLength').props.onChange({ target: { value: '80' } })
  tree = rerender()
  numberInput(tree, 'codeBlockMultiplier').props.onBlur()
  await flush()
  tree = rerender()
  ok('倍数 0（不检测代码块）可写入且派生窗口随参数变化（超上限夹住并提示）')

  // C8：派生窗口正常时不提示；被上限夹住时给出提示（已在上一条覆盖），此处验证恢复
  assert.strictEqual(warnText(tree), null, '参数回到默认范围后不应有窗口提示')
  ok('派生窗口随参数变化且不误报')

  // C9：恢复默认 → 逐字段 unset，回到代码默认值。
  before = harness.calls.length
  buttonByText(tree, 'reset').props.onClick()
  await settle() // 逐字段 unset 会排队，需要更深的微任务排空
  tree = rerender() // 第一帧：同步逻辑触发 setForm
  tree = rerender() // 第二帧：应用 setForm 结果（真实 React 会自动重渲，桩需手动）
  const unsets = harness.calls.slice(before).filter((call) => call[0] === 'unset').map((call) => call[1])
  assert.strictEqual(unsets.length, FIELDS.length, '恢复默认应 unset 全部字段，实际：' + unsets.join(','))
  assert.deepStrictEqual(harness.state.user, {}, '用户层应被清空')
  assert.ok(statusText(tree).indexOf('saved') !== -1, '恢复默认后应显示已保存')
  assert.deepStrictEqual(chipTexts(tree), ['-', '|'], '白名单应回到默认')
  assert.strictEqual(numberInput(tree, 'threshold').props.value, '10', '阈值应回到默认')
  assert.strictEqual(autoWindowText(tree), '2400', '派生窗口应按默认参数显示 2400')
  ok('恢复默认逐字段 unset 并回到代码默认值')

  // ---- D：DSH ≥ 0.1.7 的 remote.settings 通道（settingsScope 已被移除） ----
  {
    // 静态依赖若包含某个版本不存在的服务，整个客户端入口会永久 pending
    // （"web boot: 1 entry did not activate / waiting for service: settingsScope"）。
    assert.deepStrictEqual(
      plugin.inject,
      ['slots', 'locale'],
      '静态依赖只应放各版本都有的服务',
    )

    const remote = createHarness('remote')
    plugin.apply(remote.ctx)
    assert.strictEqual(sections(remote).length, 1, '只有 remote.settings 时也应注册设置分节')
    // 回归：必须同时声明父服务与点号服务。只声明 'remote.settings' 时，
    // 注入作用域里没有 scope.remote（1.6.0 在 0.1.7 上设置页停在「加载中」的根因）。
    assert.ok(
      remote.injectCalls.some((keys) => keys.includes('remote') && keys.includes('remote.settings')),
      '应同时注入 remote 与 remote.settings，实际：' + JSON.stringify(remote.injectCalls),
    )
    const remoteEntry = sections(remote)[0]
    const remoteProps = remoteEntry.options.inject()
    const renderRemote = () => render(remoteEntry.component, remoteProps)

    await flush()
    let view = renderRemote()
    assert.strictEqual(numberInput(view, 'threshold').props.value, '10', '应从 describe() 读到阈值')
    assert.strictEqual(numberInput(view, 'codeBlockMultiplier').props.value, '3', '应从 describe() 读到代码块倍数')
    assert.strictEqual(switchButton(view, 'stripWhitespace').props['aria-checked'], true, '应从 describe() 读到开关值')
    assert.deepStrictEqual(chipTexts(view), ['-', '|'], '应读到白名单')
    ok('新版 remote.settings：describe 读取初始值')

    // 开关写入：mutate(ns, ops, revision)，命名空间取 loader entry id
    const beforeWrite = remote.remoteCalls.length
    switchButton(view, 'stripWhitespace').props.onClick()
    await flush()
    view = renderRemote()
    const write = remote.remoteCalls.slice(beforeWrite).find((call) => call[0] === 'mutate')
    assert.ok(write !== undefined, '开关应触发 remote.settings.mutate')
    assert.strictEqual(write[1], 'dupguard', '命名空间应为 loader entry id，实际：' + String(write[1]))
    assert.deepStrictEqual(write[2], [{ op: 'set', path: ['stripWhitespace'], value: false }], 'ops 形状应为 { op, path, value }')
    assert.strictEqual(typeof write[3], 'number', '应带上 describe 返回的 revision')
    assert.strictEqual(switchButton(view, 'stripWhitespace').props['aria-checked'], false, 'UI 应反映新值')
    assert.ok(statusText(view).indexOf('saved') !== -1, '写入成功应显示已保存')
    ok('新版 remote.settings：开关经 mutate 写入（含命名空间与 revision）')

    // 数值写入 + 恢复默认（unset 全部字段）
    const beforeNumber = remote.remoteCalls.length
    numberInput(view, 'threshold').props.onChange({ target: { value: '12' } })
    view = renderRemote()
    numberInput(view, 'threshold').props.onBlur()
    await flush()
    view = renderRemote()
    const numberWrite = remote.remoteCalls.slice(beforeNumber).find((call) => call[0] === 'mutate')
    assert.deepStrictEqual(numberWrite[2], [{ op: 'set', path: ['threshold'], value: 12 }], '数值写入应为 set 操作')

    const beforeReset = remote.remoteCalls.length
    buttonByText(view, 'reset').props.onClick()
    await settle()
    view = renderRemote() // 第一帧：同步逻辑触发 setForm
    view = renderRemote() // 第二帧：应用 setForm 结果（真实 React 会自动重渲，桩需手动）
    const resetOps = remote.remoteCalls.slice(beforeReset)
      .filter((call) => call[0] === 'mutate')
      .flatMap((call) => call[2])
    const unsetFields = resetOps.filter((op) => op.op === 'unset').map((op) => op.path[0])
    assert.strictEqual(unsetFields.length, FIELDS.length, '恢复默认应 unset 全部字段，实际：' + unsetFields.join(','))
    assert.deepStrictEqual(remote.state.user, {}, '用户层应被清空')
    assert.strictEqual(numberInput(view, 'threshold').props.value, '10', '恢复默认后应回到代码默认值')
    ok('新版 remote.settings：数值写入与恢复默认（unset）')

    // 写失败：显示错误并回读宿主真实状态
    remote.setFailMutate(true)
    const beforeFail = remote.remoteCalls.filter((call) => call[0] === 'describe').length
    switchButton(view, 'monitorReasoning').props.onClick()
    await settle()
    view = renderRemote()
    assert.ok(statusText(view).indexOf('saveFailed') !== -1, '写失败应显示保存失败，实际：' + statusText(view))
    assert.ok(
      statusText(view).indexOf('宿主拒绝了该写入') !== -1,
      '写失败应带上宿主返回的原始原因，实际：' + statusText(view),
    )
    const afterFail = remote.remoteCalls.filter((call) => call[0] === 'describe').length
    assert.ok(afterFail > beforeFail, '写失败后应回读宿主状态（describe 次数应增加）')
    remote.setFailMutate(false)
    ok('新版 remote.settings：写失败回读宿主状态并提示宿主原始原因')

    // 冲突（revision 过期）：回读后自动重试一次即可成功
    const conflicted = createHarness('remote', { failOnce: true })
    plugin.apply(conflicted.ctx)
    const conflictedEntry = sections(conflicted)[0]
    const conflictedProps = conflictedEntry.options.inject()
    await settle()
    let conflictedView = render(conflictedEntry.component, conflictedProps)
    switchButton(conflictedView, 'stripWhitespace').props.onClick()
    await settle()
    conflictedView = render(conflictedEntry.component, conflictedProps)
    const attempts = conflicted.remoteCalls.filter((call) => call[0] === 'mutate').length
    assert.ok(attempts >= 2, '冲突后应重试写入，实际尝试 ' + String(attempts) + ' 次')
    assert.ok(statusText(conflictedView).indexOf('saved') !== -1, '重试成功后应显示已保存，实际：' + statusText(conflictedView))
    conflicted.dispose()
    ok('新版 remote.settings：revision 冲突自动回读并重试')

    // 首次写入发生在 describe 完成之前时，必须先补一次 describe，否则命名空间还是初始值。
    const race = createHarness('remote')
    plugin.apply(race.ctx)
    const raceEntry = sections(race)[0]
    const raceProps = raceEntry.options.inject()
    // 不等待任何异步完成，直接用桥接的写通道发起一次写入（模拟用户立刻点开关）。
    raceProps.controller.set('stripWhitespace', false)
    await settle()
    const raceWrite = race.remoteCalls.find((call) => call[0] === 'mutate')
    assert.ok(raceWrite !== undefined, '立即写入也应产生 mutate')
    assert.strictEqual(raceWrite[1], 'dupguard', '立即写入时命名空间仍应正确，实际：' + String(raceWrite[1]))
    ok('新版 remote.settings：describe 未完成即写入时命名空间仍正确')

    // 命名空间带组合前缀（0.1.7 实测为 include:dupguard）时仍应命中
    const prefixed = createHarness('remote', { remoteNs: 'include:dupguard' })
    plugin.apply(prefixed.ctx)
    const prefixedEntry = sections(prefixed)[0]
    const prefixedProps = prefixedEntry.options.inject()
    await settle()
    assert.strictEqual(
      numberInput(render(prefixedEntry.component, prefixedProps), 'threshold').props.value,
      '10',
      '带前缀的 entry id 命名空间应能命中',
    )
    prefixed.dispose()
    ok('命名空间带组合前缀（include:dupguard）时仍能命中')

    // 命名空间确实缺失时：显示不可用提示 + 诊断文本（便于截图定位）
    const missing = createHarness('remote', { rowMissing: true })
    plugin.apply(missing.ctx)
    const missingEntry = sections(missing)[0]
    const missingProps = missingEntry.options.inject()
    await settle()
    const missingView = render(missingEntry.component, missingProps)
    assert.ok(textOf(missingView).indexOf('unavailable') !== -1, '命名空间缺失时应显示不可用提示')
    assert.ok(textOf(missingView).indexOf('describe 返回 0 个命名空间') !== -1, '不可用状态也应给出诊断文本')
    missing.dispose()
    ok('命名空间缺失时显示不可用提示与诊断')

    // 只读/远程：writable=false → 显示本机连接提示
    remote.setWritable(false)
    await remoteProps.mirror.load()
    await settle()
    view = renderRemote()
    assert.ok(textOf(view).indexOf('remoteHint') !== -1, 'writable=false 时应显示本机连接提示')
    ok('新版 remote.settings：writable=false 时提示仅本机可改')
  }

  // ---- E：完全没有设置服务（无头 / 未知版本）时插件仍须激活 ----
  {
    const bare = createHarness('none')
    plugin.apply(bare.ctx)
    assert.strictEqual(sections(bare).length, 1, '无设置服务时仍应注册设置分节（不得 pending）')
    const bareEntry = sections(bare)[0]
    const bareProps = bareEntry.options.inject()
    const view = render(bareEntry.component, bareProps)
    assert.ok(textOf(view) !== undefined, '无设置服务时应能渲染（loading/unavailable 状态）')
    assert.strictEqual(typeof bareProps.controller.getSnapshot().status, 'string', '应给出状态而不得抛异常')
    bare.dispose() // 停止通道轮询，避免测试进程被定时器挂住
    ok('无设置服务时仍激活并渲染')
  }

  // ---- F：只有点号键暴露（服务面形态差异）时仍能接上 ----
  {
    const dotted = createHarness('remote-dotted')
    plugin.apply(dotted.ctx)
    const dottedEntry = sections(dotted)[0]
    const dottedProps = dottedEntry.options.inject()
    await settle()
    const view = render(dottedEntry.component, dottedProps)
    assert.strictEqual(
      numberInput(view, 'threshold').props.value,
      '10',
      '仅暴露点号键时也应读到设置值（作用域形态差异不应导致停机）',
    )
    dotted.dispose()
    ok('仅暴露 remote.settings 点号键时仍能接入')
  }

  // C10：白名单合并输入框 —— 片段整段加入（不按码点拆分）、单字符自动进字符表、
  //      重复与超长就地拒绝、删除时按归属字段清理
  {
    assert.deepStrictEqual(chipTexts(tree).filter((item) => item.length > 1), [], '默认片段白名单为空')

    before = harness.calls.length
    whitelistInput(tree).props.onChange({ target: { value: '|---|' } })
    tree = rerender()
    buttonByText(tree, 'add').props.onClick()
    await settle()
    tree = rerender()
    const write = harness.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'ignoredSubstrings')
    assert.deepStrictEqual(write, ['set', 'ignoredSubstrings', ['|---|']], '整段应作为一个条目写入，不得拆分')
    assert.ok(chipTexts(tree).indexOf('|---|') !== -1, '片段应显示为一个 chip')

    // 单字符条目自动进字符白名单（同一个输入框）
    before = harness.calls.length
    whitelistInput(tree).props.onChange({ target: { value: '·' } })
    tree = rerender()
    buttonByText(tree, 'add').props.onClick()
    await settle()
    tree = rerender()
    const charWrite = harness.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'ignoredChars')
    assert.deepStrictEqual(charWrite, ['set', 'ignoredChars', ['-', '|', '·']], '单字符条目应写入字符白名单')
    assert.strictEqual(
      harness.calls.slice(before).filter((call) => call[0] === 'set' && call[1] === 'ignoredSubstrings').length, 0,
      '单字符条目不应写入片段白名单',
    )

    // 重复条目：就地报错且不写入（跨两个字段去重）
    before = harness.calls.length
    whitelistInput(tree).props.onChange({ target: { value: '|---|' } })
    tree = rerender()
    buttonByText(tree, 'add').props.onClick()
    await settle()
    tree = rerender()
    assert.strictEqual(harness.calls.length, before, '重复片段不应写入')
    assert.ok(lastFieldError(tree).indexOf('errSubstringDuplicate') !== -1, '重复片段应就地报错')

    // 超长条目（> 64 码点）：就地报错且不写入
    whitelistInput(tree).props.onChange({ target: { value: 'x'.repeat(65) } })
    tree = rerender()
    buttonByText(tree, 'add').props.onClick()
    await settle()
    tree = rerender()
    assert.strictEqual(harness.calls.length, before, '超长片段不应写入')
    assert.ok(lastFieldError(tree).indexOf('errSubstringTooLong') !== -1, '超长片段应就地报错')

    // 删除片段
    before = harness.calls.length
    removeChipByLabel(tree, '|---|').props.onClick()
    await settle()
    tree = rerender()
    const removal = harness.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'ignoredSubstrings')
    assert.deepStrictEqual(removal, ['set', 'ignoredSubstrings', []], '删除片段应写入空列表')
    ok('白名单合并输入：片段整段加入 / 单字符自动分类 / 重复与超长拒绝 / 删除')
  }

  // C11：高级重复设置（三模式下拉 + 分段表表格 + 校验）
  {
    const modeSelect = () => collect(tree, (node) => node.type === 'select')[0]
    const fileInput = () => collect(tree, (node) => node.props.id === 'dg-advancedThresholdFile')[0]
    const rowEnd = (index) => collect(tree, (node) => node.props.id === 'dg-row-end-' + String(index))[0]
    const rowCount = (index) => collect(tree, (node) => node.props.id === 'dg-row-count-' + String(index))[0]
    const removeRowBtn = (index) => collect(tree, (node) => node.props.id === 'dg-row-remove-' + String(index))[0]
    const addRowBtn = () => collect(tree, (node) => node.props.id === 'dg-row-add')[0]
    const rowStarts = () => collect(tree, (node) => String(node.props.className).indexOf('dg-ro') !== -1).map((node) => textOf(node))
        const tableWrites = (from) => harness.calls.slice(from).filter((call) => call[0] === 'set' && call[1] === 'thresholdByLength')
    /** 编辑单元格并提交（onChange → 重渲 → 用**新渲染**的元素 onBlur，保证闭包持有最新草稿）。 */
    const editCell = async (input, value) => {
      const id = input.props.id
      input.props.onChange({ target: { value: value } })
      tree = rerender()
      const fresh = collect(tree, (node) => node.props.id === id)[0]
      ;(fresh === undefined ? input : fresh).props.onBlur()
      await settle()
      tree = rerender()
    }

    assert.strictEqual(modeSelect().props.value, 'simple', '默认模式应为 simple')
    assert.strictEqual(collect(tree, (node) => node.type === 'option').length, 3, '下拉应有 3 个选项')
    assert.strictEqual(fileInput(), undefined, 'simple 模式不显示模块路径')
    assert.ok(collect(tree, (node) => node.props.id === 'dg-threshold')[0] !== undefined, '简单模式应显示基础阈值')
    assert.ok(collect(tree, (node) => node.props.id === 'dg-maxUnitLength')[0] !== undefined, '简单模式应显示最大单元长度')
    assert.strictEqual(collect(tree, (node) => node.props.className === 'dg-num').length, 4, '简单模式应有 4 个数值项')

    // 切到分段表模式：写入模式 + 显示 1 行（起始 1 / 终止 80 / 次数 10）+ 最大单元长度改为只读派生
    before = harness.calls.length
    modeSelect().props.onChange({ target: { value: 'table' } })
    await settle()
    tree = rerender()
    const modeWrite = harness.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'thresholdMode')
    assert.deepStrictEqual(modeWrite, ['set', 'thresholdMode', 'table'], '模式切换应写入宿主')
    assert.strictEqual(fileInput(), undefined, 'table 模式不显示模块路径')
    assert.deepStrictEqual(rowStarts(), ['1'],
      '初始应为 1 行且起始为 1；mode=' + String(modeSelect().props.value) + ' rows=' + String(collect(tree, (node) => node.props.className === 'dg-tr').length))
    assert.strictEqual(rowEnd(0).props.value, '80', '初始终止应为当前最大单元长度 80')
    assert.strictEqual(rowCount(0).props.value, '10', '初始次数应为基础阈值 10')
    assert.strictEqual(
      collect(tree, (node) => node.props.id === 'dg-maxUnitLength')[0], undefined,
      '分段表模式不应再有最大单元长度输入框',
    )
    assert.strictEqual(
      collect(tree, (node) => node.props.id === 'dg-minUnitLength')[0], undefined,
      '分段表模式不应再有最小单元长度输入框（起始固定为 1）',
    )
    assert.strictEqual(
      collect(tree, (node) => String(node.props.className) === 'dg-num').length, 1,
      '分段表模式只应剩代码块倍数一个数值项（表格单元格用 dg-num dg-cell）',
    )
    assert.strictEqual(autoMaxUnitText(tree), '80', '派生值应显示在底部诊断行（末行终止 80）')
    assert.strictEqual(collect(tree, (node) => node.props.id === 'dg-threshold')[0], undefined, 'table 模式不应显示基础阈值')

    // 非法次数（1）：就地报错且不写入
    before = harness.calls.length
    await editCell(rowCount(0), '1')
    assert.strictEqual(tableWrites(before).length, 0, '非法次数不应写入')
    assert.ok(lastFieldError(tree) !== '', '非法次数应就地报错')

    // 单行 2:40 → 序列化写入
    before = harness.calls.length
    await editCell(rowCount(0), '40')
    await editCell(rowEnd(0), '2')
    assert.deepStrictEqual(
      tableWrites(before).pop(), ['set', 'thresholdByLength', '2:40'],
      '单行应序列化为 2:40，实际：' + JSON.stringify(tableWrites(before)),
    )

    // 增行 → 第二行起始 = 3；填成 10:30；再增行 → 第三行起始 = 11；填成 1000:3
    addRowBtn().props.onClick()
    await settle()
    tree = rerender()
    assert.deepStrictEqual(rowStarts(), ['1', '3'], '新增行起始应为上一行终止 + 1')
    await editCell(rowEnd(1), '10')
    await editCell(rowCount(1), '30')
    addRowBtn().props.onClick()
    await settle()
    tree = rerender()
    assert.deepStrictEqual(rowStarts(), ['1', '3', '11'], '第三行起始应为 11')
    await editCell(rowEnd(2), '1000')
    await editCell(rowCount(2), '3')
    assert.deepStrictEqual(
      tableWrites(before).pop(), ['set', 'thresholdByLength', '2:40, 10:30, 1000:3'],
      '三行应序列化为 2:40, 10:30, 1000:3，实际：' + JSON.stringify(tableWrites(before)),
    )
    // 派生值：最大单元长度 = 末行终止 1000；派生窗口 = 3 × 1000 × 倍数
    assert.strictEqual(autoMaxUnitText(tree), '1000', '派生最大单元长度应为末行终止 1000')

    // 终止 ≥ 下一行终止：报错且不写入
    before = harness.calls.length
    await editCell(rowEnd(0), '50')
    assert.strictEqual(tableWrites(before).length, 0, '终止不小于下行终止时不应写入')
    assert.ok(lastFieldError(tree) !== '', '分段重叠应就地报错')

    // 复原终止值，验证派生窗口只由倍数决定（分档开关已并入倍数语义）
    await editCell(rowEnd(0), '2')
    assert.strictEqual(autoWindowText(tree), '9000', '倍数 3 时派生窗口 = 3 × 3 × 1000 = 9000')
    numberInput(tree, 'codeBlockMultiplier').props.onChange({ target: { value: '0' } })
    tree = rerender()
    assert.strictEqual(autoWindowText(tree), '3000', '倍数 0 时派生窗口 = 3 × 1000 = 3000')
    numberInput(tree, 'codeBlockMultiplier').props.onChange({ target: { value: '3' } })
    tree = rerender()

    // 删行到 1 行后删除禁用；增到 16 行后添加禁用
    removeRowBtn(2).props.onClick()
    await settle()
    tree = rerender()
    removeRowBtn(1).props.onClick()
    await settle()
    tree = rerender()
    assert.deepStrictEqual(rowStarts(), ['1'], '删到只剩 1 行')
    assert.strictEqual(removeRowBtn(0).props.disabled, true, '仅剩 1 行时删除应禁用')
    for (let index = 0; index < 20; index++) {
      addRowBtn().props.onClick()
      await settle()
      tree = rerender()
    }
    await settle()
    tree = rerender()
    assert.strictEqual(rowStarts().length, 16, '行数上限应为 16')
    assert.strictEqual(addRowBtn().props.disabled, true, '达到上限后添加应禁用')

    // 切到高级模式：先弹风险确认（实验性 + 宿主进程执行），确认后只显示模块路径；
    // 路径不再限定扩展名（Node 按 CommonJS 加载未注册扩展名）
    modeSelect().props.onChange({ target: { value: 'module' } })
    tree = rerender()
    assert.deepStrictEqual(
      harness.calls.slice(before).filter((call) => call[0] === 'set' && call[1] === 'thresholdMode'), [],
      '弹出风险确认前不应写入 thresholdMode',
    )
    collect(tree, (node) => node.props.id === 'dg-risk-ack')[0].props.onChange({ target: { checked: true } })
    tree = rerender()
    collect(tree, (node) => node.props.id === 'dg-risk-confirm')[0].props.onClick()
    await settle()
    tree = rerender()
    assert.ok(fileInput() !== undefined, 'module 模式应显示模块路径输入')
    assert.strictEqual(collect(tree, (node) => node.props.id === 'dg-threshold')[0], undefined, 'module 模式不应显示基础阈值')
    before = harness.calls.length
    fileInput().props.onChange({ target: { value: 'C:/tmp/policy.txt' } })
    tree = rerender()
    fileInput().props.onBlur()
    await settle()
    tree = rerender()
    assert.deepStrictEqual(
      harness.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'advancedThresholdFile'),
      ['set', 'advancedThresholdFile', 'C:/tmp/policy.txt'],
      '任意扩展名路径都应写入（.txt 也能被 Node 按 JS 加载）',
    )
    // 空路径：就地报错且不写入
    before = harness.calls.length
    fileInput().props.onChange({ target: { value: '   ' } })
    tree = rerender()
    fileInput().props.onBlur()
    await settle()
    tree = rerender()
    assert.strictEqual(harness.calls.length, before, '空路径不应写入')
    assert.ok(lastFieldError(tree).indexOf('errThresholdFile') !== -1, '空路径应就地报错')
    fileInput().props.onChange({ target: { value: 'C:/tmp/policy.cjs' } })
    tree = rerender()
    fileInput().props.onBlur()
    await settle()
    tree = rerender()
    const fileWrite = harness.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'advancedThresholdFile')
    assert.deepStrictEqual(fileWrite, ['set', 'advancedThresholdFile', 'C:/tmp/policy.cjs'], '合法路径应写入')

    // 回归：module 模式在浏览器里无法求值 ⇒ 诊断行显示**宿主快照**里的窗口（桩默认 8192），
    // 不能再拼出 undefined/—（窗口字段不在表单里，须单独从快照读）。
    assert.strictEqual(
      autoWindowText(tree), '8192',
      'module 模式应显示宿主快照里的窗口值，实际：' + String(autoWindowText(tree)),
    )
    ok('高级重复设置：三模式下拉 / 分段表表格（增删行、校验、派生）/ 模块路径校验 / module 窗口显示')
  }

  // C12：旧写法 `*:次数` 迁移为表格末行（终止 = 文档 maxUnitLength）
  {
    const migrated = createHarness('legacy')
    migrated.state.user.thresholdMode = 'table'
    migrated.state.user.thresholdByLength = '1:20, 2:15, *:3'
    plugin.apply(migrated.ctx)
    await flush()
    // 共享 hook 存储：新挂载必须从初始状态开始（否则会继承上一段落的状态）。
    remount()
    const migratedEntry = sections(migrated)[0]
    const migratedProps = migratedEntry.options.inject()
    const migratedTree = render(migratedEntry.component, migratedProps)
    const starts = collect(migratedTree, (node) => String(node.props.className).indexOf('dg-ro') !== -1).map((node) => textOf(node))
    const ends = collect(migratedTree, (node) => /^dg-row-end-/.test(String(node.props.id))).map((node) => node.props.value)
    assert.deepStrictEqual(starts, ['1', '2', '3'], '`*` 行应接在具名行之后（起始 = 上一行终止 + 1）')
    assert.deepStrictEqual(ends, ['1', '2', '80'], '`*` 行终止应取文档 maxUnitLength（默认 80）')
    ok('分段表旧写法 `*:次数` 迁移为表格末行')
  }

  // C14：高级模式标注为实验性 + 风险确认弹窗（对齐 DSH「完全权限」弹窗：勾选后才可确认）
  {
    const risk = createHarness('legacy')
    plugin.apply(risk.ctx)
    await flush()
    remount()
    const riskEntry = sections(risk)[0]
    // 始终渲染**本用例**的 harness（rerender() 绑定的是主 harness 的组件）
    const draw = () => render(riskEntry.component, riskEntry.options.inject())
    let riskTree = draw()
    const select = () => collect(riskTree, (node) => node.type === 'select')[0]
    const dialog = () => collect(riskTree, (node) => node.props.className === 'dg-modal')[0]
    const ack = () => collect(riskTree, (node) => node.props.id === 'dg-risk-ack')[0]
    const confirmBtn = () => collect(riskTree, (node) => node.props.id === 'dg-risk-confirm')[0]
    const cancelBtn = () => collect(riskTree, (node) => node.props.id === 'dg-risk-cancel')[0]

    // 1) 非高级模式不弹窗
    assert.strictEqual(dialog(), undefined, '初始不应有弹窗')
    select().props.onChange({ target: { value: 'table' } })
    await settle()
    riskTree = draw()
    assert.strictEqual(dialog(), undefined, '切到分段表不应弹窗')
    assert.deepStrictEqual(
      risk.calls.find((call) => call[0] === 'set' && call[1] === 'thresholdMode'),
      ['set', 'thresholdMode', 'table'],
      '分段表应直接写入，实际调用：' + JSON.stringify(risk.calls),
    )

    // 2) 切到高级模式：弹窗出现、未写入、确认按钮在勾选前禁用
    let before = risk.calls.length
    select().props.onChange({ target: { value: 'module' } })
    await settle()
    riskTree = draw()
    assert.ok(dialog() !== undefined, '高级模式应弹出风险确认')
    assert.strictEqual(textOf(collect(riskTree, (node) => node.props.className === 'dg-modal-title')[0]), 'riskTitle',
      '弹窗标题应取字典键（测试桩）')
    assert.strictEqual(confirmBtn().props.disabled, true, '未勾选「我已了解风险」时确认按钮应禁用')
    assert.strictEqual(
      risk.calls.slice(before).filter((call) => call[0] === 'set').length, 0,
      '确认前不得写入任何设置，实际：' + JSON.stringify(risk.calls.slice(before)),
    )

    // 3) 取消：不写入、弹窗关闭、下拉回到原模式
    cancelBtn().props.onClick()
    await settle()
    riskTree = draw()
    assert.strictEqual(dialog(), undefined, '取消后弹窗应关闭')
    assert.strictEqual(select().props.value, 'table', '取消后下拉应回到原模式')
    assert.strictEqual(
      risk.calls.slice(before).filter((call) => call[0] === 'set').length, 0,
      '取消不得写入任何设置',
    )

    // 4) 勾选后确认：写入 module
    select().props.onChange({ target: { value: 'module' } })
    await settle()
    riskTree = draw()
    ack().props.onChange({ target: { checked: true } })
    riskTree = draw()
    assert.strictEqual(confirmBtn().props.disabled, false, '勾选后确认按钮应可用')
    confirmBtn().props.onClick()
    await settle()
    riskTree = draw()
    assert.strictEqual(dialog(), undefined, '确认后弹窗应关闭')
    assert.deepStrictEqual(
      risk.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'thresholdMode'),
      ['set', 'thresholdMode', 'module'],
      '确认后应写入高级模式，实际：' + JSON.stringify(risk.calls.slice(before)),
    )

    // 5) 已处于高级模式时重复选择不再弹窗；离开后可再次触发
    select().props.onChange({ target: { value: 'module' } })
    await settle()
    riskTree = draw()
    assert.strictEqual(dialog(), undefined, '已在高级模式时不应再次弹窗')
    select().props.onChange({ target: { value: 'simple' } })
    await settle()
    riskTree = draw()
    select().props.onChange({ target: { value: 'module' } })
    await settle()
    riskTree = draw()
    assert.ok(dialog() !== undefined, '离开后再次进入高级模式应重新弹窗')

    // 6) 主按钮配色必须用 DSH 的按钮 token（brand-primary 是开关/复选框强调色，用作填充会出现白底白字），
    //    且选择器要比基础 .dg-btn 更具体（基础样式定义在后，同优先级会覆盖背景）。
    assert.ok(
      clientSource.indexOf('.dg-btn.dg-btn-primary{background:var(--dsw-alias-button-primary-fill)') !== -1 &&
      clientSource.indexOf('color:var(--dsw-alias-label-primary-foreground)') !== -1 &&
      clientSource.indexOf('--dsw-alias-button-primary-hover') !== -1,
      '主按钮应使用 DSH 的 button-primary-fill / label-primary-foreground token',
    )
    assert.ok(
      clientSource.indexOf('.dg-modal-ack input') !== -1 &&
      clientSource.indexOf('accent-color:var(--dsw-alias-button-primary-fill)') !== -1,
      '勾选框应使用主题 accent-color',
    )
    ok('高级模式（实验性）风险确认：弹窗门控 / 勾选后才可确认 / 取消不写入')
  }

  // C13：冗余开关收敛 —— skipCodeBlocks=false ≡ 倍数 1，设置页只保留倍数
  {
    const legacy = createHarness('legacy')
    legacy.state.user.skipCodeBlocks = false // 老配置：显式关掉了分档
    plugin.apply(legacy.ctx)
    await flush()
    remount()
    const legacyEntry = sections(legacy)[0]
    const legacyProps = legacyEntry.options.inject()
    let legacyTree = render(legacyEntry.component, legacyProps)

    // 1) 开关不再渲染，但字段仍参与「恢复默认」的 unset 列表
    assert.strictEqual(
      collect(legacyTree, (node) => node.props.id === 'dg-skipCodeBlocks').length, 0,
      'skipCodeBlocks 开关不应渲染（与倍数 1 等价）',
    )
    assert.ok(FIELDS.indexOf('skipCodeBlocks') !== -1, '字段本身保留：恢复默认仍会 unset 它')

    // 2) 老配置下显示等价提示
    assert.ok(
      textOf(legacyTree).indexOf('legacySkipCodeBlocksHint') !== -1,
      '老配置（skipCodeBlocks=false）应提示「等价于倍数 1」，实际：' + textOf(legacyTree),
    )

    // 3) 提交倍数时先 unset 旧键、再写入倍数（否则隐藏的开关会继续覆盖倍数）
    const legacyStart = legacy.calls.length
    numberInput(legacyTree, 'codeBlockMultiplier').props.onChange({ target: { value: '0' } })
    legacyTree = render(legacyEntry.component, legacyProps)
    numberInput(legacyTree, 'codeBlockMultiplier').props.onBlur()
    await settle()
    const legacyWrites = legacy.calls.slice(legacyStart).filter((call) => call[0] === 'unset' || call[0] === 'set')
    assert.deepStrictEqual(
      legacyWrites,
      [['unset', 'skipCodeBlocks'], ['set', 'codeBlockMultiplier', 0]],
      '老配置改倍数应先 unset 旧键再写倍数，实际：' + JSON.stringify(legacyWrites),
    )

    // 4) 新配置（用户层没有该键）不产生多余 unset
    const clean = createHarness('legacy')
    plugin.apply(clean.ctx)
    await flush()
    remount()
    const cleanEntry = sections(clean)[0]
    const cleanProps = cleanEntry.options.inject()
    let cleanTree = render(cleanEntry.component, cleanProps)
    const cleanStart = clean.calls.length
    numberInput(cleanTree, 'codeBlockMultiplier').props.onChange({ target: { value: '0' } })
    cleanTree = render(cleanEntry.component, cleanProps)
    numberInput(cleanTree, 'codeBlockMultiplier').props.onBlur()
    await settle()
    const cleanWrites = clean.calls.slice(cleanStart).filter((call) => call[0] === 'unset' || call[0] === 'set')
    assert.deepStrictEqual(
      cleanWrites, [['set', 'codeBlockMultiplier', 0]],
      '用户层没有该键时不应产生额外 unset，实际：' + JSON.stringify(cleanWrites),
    )

    // 5) 等价关系写进提示文案（防后人改回去、丢掉说明）
    assert.ok(clientSource.indexOf('1 = 关闭分档') !== -1, '倍数提示应写明「1 = 关闭分档」的等价关系')
    // 6) 三类代码区域统一判定的说明（围栏 / 行内 / 缩进）
    assert.ok(
      clientSource.indexOf('代码内阈值倍数（围栏 / 行内 / 缩进）') !== -1 &&
      clientSource.indexOf('缩进代码块（行首 4 空格且前有空行）') !== -1 &&
      clientSource.indexOf('未闭合的反引号按普通文本判定') !== -1,
      '倍数提示应写明三类代码区域统一判定与边界语义',
    )
    ok('冗余开关收敛：隐藏 skipCodeBlocks + 改倍数清理旧键 + 等价关系文档化')
  }

  // C15：截停通知浮层（shell.overlay，root 作用域）——与当前打开的会话无关，
  // 至少显示工作区 / 会话名称 / 重复的字符串，并由用户决定是否发送继续指令。
  {
    const noticeHarness = createHarness()
    plugin.apply(noticeHarness.ctx)
    const noticeEntry = noticeHarness.registrations.find((item) => item.options.name === 'shell.overlay')
    assert.ok(noticeEntry !== undefined, '应注册 shell.overlay 浮层')

    const acts = []
    let pendingItems = []
    let listShouldFail = false
    const stubTransport = {
      // 结构化结果：{ ok: true, items } / { ok: false, error }（与真实 transport 同形）
      list: async () => {
        if (listShouldFail) return { ok: false, error: 'host-route-missing' }
        return { ok: true, items: pendingItems }
      },
      act: async (id, action) => {
        acts.push([id, action])
        if (action === 'continue' && id === 'dupguard-stop-9') {
          return { ok: false, status: 'failed', message: '该会话已不在运行（可能已关闭或归档），请打开它后手动继续' }
        }
        return { ok: true, status: action === 'continue' ? 'sent' : 'dismissed', message: action === 'continue' ? '已向该会话发送继续指令' : '用户选择不发送继续指令' }
      },
    }
    const noticeProps = {
      t: fakeT,
      transport: stubTransport,
      pollMs: 0, // 测试里不启动定时器：只跑首帧加载 + 手动重渲染
      openSession: () => undefined,
    }
    const baseItem = {
      id: 'dupguard-stop-1',
      time: Date.now(),
      sessionId: 'sess-abcdef123456',
      sessionTitle: '修复登录流程',
      workspacePath: 'D:\\Work\\Repo',
      workspaceTitle: '工作区甲',
      unit: '好的，下面开始回答：',
      unitLength: 10,
      unitTruncated: false,
      count: 10,
      span: 100,
      code: false,
      source: 'text',
      status: 'pending',
      detail: null,
    }

    // 1) 空列表 → 不渲染任何东西（浮层不占位）
    remount()
    let noticeTree = render(noticeEntry.component, noticeProps)
    await settle()
    noticeTree = render(noticeEntry.component, noticeProps)
    assert.strictEqual(noticeTree, null, '没有待处理通知时浮层不应渲染')
    ok('截停通知浮层：无通知时不渲染')

    // 2) 一条待处理通知：工作区 / 会话 / 重复字符串 / 次数 / 通道 / 三个按钮
    pendingItems = [baseItem]
    remount()
    noticeTree = render(noticeEntry.component, noticeProps)
    await settle()
    noticeTree = render(noticeEntry.component, noticeProps)
    assert.ok(noticeTree !== null, '有待处理通知时应渲染浮层')
    const noticeText = textOf(noticeTree)
    assert.ok(noticeText.includes('工作区甲'), '应显示工作区名称，实际：' + noticeText)
    assert.ok(noticeText.includes('D:\\Work\\Repo'), '应显示工作区路径')
    assert.ok(noticeText.includes('修复登录流程'), '应显示会话名称')
    assert.ok(noticeText.includes('sess-abc'), '应显示会话 id 短号')
    assert.ok(noticeText.includes('"好的，下面开始回答："'), '应显示重复的字符串（带引号）')
    assert.ok(noticeText.includes('10'), '应显示重复次数')
    assert.ok(noticeText.includes('100'), '应显示跨度')
    assert.ok(noticeText.includes(DICT.noticeSourceText), '应显示命中通道（可见输出）')
    assert.ok(buttonByText(noticeTree, DICT.noticeSend) !== undefined, '应有「发送继续指令」按钮')
    assert.ok(buttonByText(noticeTree, DICT.noticeDismiss) !== undefined, '应有「不发送」按钮')
    assert.ok(buttonByText(noticeTree, DICT.noticeOpen) !== undefined, '应提供「打开该会话」入口')
    ok('截停通知浮层：显示工作区 / 会话 / 重复字符串 / 次数 / 通道 + 三个操作')

    // 3) 点「发送继续指令」：回传宿主并本地移除
    buttonByText(noticeTree, DICT.noticeSend).props.onClick()
    await settle()
    noticeTree = render(noticeEntry.component, noticeProps)
    await settle()
    noticeTree = render(noticeEntry.component, noticeProps)
    assert.deepStrictEqual(acts, [['dupguard-stop-1', 'continue']], '应回传 continue 动作')
    assert.strictEqual(noticeTree, null, '发送成功后应立即从浮层移除')
    ok('截停通知浮层：发送继续指令后回传宿主并移除卡片')

    // 4) 点「不发送」：同样回传，且不注入
    acts.length = 0
    pendingItems = [Object.assign({}, baseItem, { id: 'dupguard-stop-2' })]
    remount()
    noticeTree = render(noticeEntry.component, noticeProps)
    await settle()
    noticeTree = render(noticeEntry.component, noticeProps)
    buttonByText(noticeTree, DICT.noticeDismiss).props.onClick()
    await settle()
    noticeTree = render(noticeEntry.component, noticeProps)
    assert.deepStrictEqual(acts, [['dupguard-stop-2', 'dismiss']], '应回传 dismiss 动作')
    assert.strictEqual(noticeTree, null, '选择不发送后应移除卡片')
    ok('截停通知浮层：不发送时只记录用户选择')

    // 5) 失败路径：会话已不在运行 → 显示原因且卡片保留
    acts.length = 0
    pendingItems = [Object.assign({}, baseItem, { id: 'dupguard-stop-9', workspacePath: null, workspaceTitle: null, sessionTitle: null })]
    remount()
    noticeTree = render(noticeEntry.component, noticeProps)
    await settle()
    noticeTree = render(noticeEntry.component, noticeProps)
    const partialText = textOf(noticeTree)
    assert.ok(partialText.includes(DICT.noticeUnknownWorkspace), '缺工作区时应显示未知标记')
    assert.ok(partialText.includes(DICT.noticeUnknownSession), '缺会话名称时应显示未命名标记')
    buttonByText(noticeTree, DICT.noticeSend).props.onClick()
    await settle()
    noticeTree = render(noticeEntry.component, noticeProps)
    const failedText = textOf(noticeTree)
    assert.ok(failedText.includes('已不在运行'), '失败原因应显示在卡片上，实际：' + failedText)
    assert.ok(buttonByText(noticeTree, DICT.noticeSend) !== undefined, '失败后卡片应保留，供用户重试或手动处理')
    ok('截停通知浮层：投递失败时显示原因并保留卡片')

    // 6) 已处理（sent/dismissed）的通知不再显示；代码区域与思考通道文案生效
    pendingItems = [
      Object.assign({}, baseItem, { id: 'dupguard-stop-3', status: 'sent' }),
      Object.assign({}, baseItem, { id: 'dupguard-stop-4', status: 'dismissed' }),
      Object.assign({}, baseItem, { id: 'dupguard-stop-5', source: 'reasoning', code: true, unit: '' }),
    ]
    remount()
    noticeTree = render(noticeEntry.component, noticeProps)
    await settle()
    noticeTree = render(noticeEntry.component, noticeProps)
    const onlyPending = textOf(noticeTree)
    assert.ok(noticeTree.props['data-dupguard-notices'] === '1', '只显示 pending 的那一条，实际：' + String(noticeTree.props['data-dupguard-notices']))
    assert.ok(onlyPending.includes(DICT.noticeSourceReasoning), '思考通道应显示对应文案')
    assert.ok(onlyPending.includes(DICT.noticeCodeRegion), '代码区域内应显示放宽说明')
    assert.ok(onlyPending.includes(DICT.noticeEmptyUnit), '空的重复串应显示占位文案')
    ok('截停通知浮层：只显示待处理通知 + 通道 / 代码区域 / 空串文案')

    // 7) 宿主不可达（半体未加载）：显示可见诊断，点「知道了」后隐藏——不再静默什么都不弹
    listShouldFail = true
    pendingItems = []
    remount()
    assert.doesNotThrow(() => render(noticeEntry.component, noticeProps), '列表请求失败不得抛错')
    await settle()
    let missingTree = render(noticeEntry.component, noticeProps)
    await settle()
    missingTree = render(noticeEntry.component, noticeProps)
    assert.ok(missingTree !== null, '宿主未加载时应显示诊断卡片（而不是静默）')
    assert.strictEqual(missingTree.props['data-dupguard-host-missing'], '1', '诊断卡片应有可识别的标记')
    const missingText = textOf(missingTree)
    assert.ok(missingText.includes(DICT.noticeHostMissing), '应提示"宿主半体尚未加载"，实际：' + missingText)
    assert.ok(missingText.includes('dsh web'), '应告诉用户重启 dsh web')
    buttonByText(missingTree, DICT.noticeHostMissingDismiss).props.onClick()
    await settle()
    missingTree = render(noticeEntry.component, noticeProps)
    assert.strictEqual(missingTree, null, '点「知道了」后诊断卡片应隐藏')
    listShouldFail = false
    ok('截停通知浮层：宿主半体未加载时给出可见诊断，可关闭')

    // 8) 回归：notifyOnStop 开关不得在设置页出现两次（检测参数组 + 截停通知组）
    {
      const settingsProps = sections(harness)[0].options.inject()
      remount()
      const pageTree = render(sections(harness)[0].component, settingsProps)
      const rows = collect(pageTree, (node) => node.props.className === 'dg-field' && node.props.key === 'notifyOnStop')
      assert.strictEqual(rows.length, 1, 'notifyOnStop 只应渲染一个字段行，实际 ' + String(rows.length) + ' 行')
      const pageText = textOf(pageTree)
      // 每行会出现两次键名（label 一次、hint 键 noticeOnStopHint 一次），故 1 行 = 2 次
      assert.strictEqual(pageText.split('notifyOnStop').length - 1, 2, '文本里应只有一行开关（label + hint）')
      assert.ok(pageText.includes('continuePrompt'), '截停通知组应包含继续指令输入')
      ok('设置页：notifyOnStop 只渲染一次（检测参数组不再重复）')
    }

    // 9) 回归：单行文本框高度必须与白名单输入框一致
    //    根因：`.dg-input` 带 `flex:1`，放进列容器（.dg-field）时 flex-basis 会覆盖 height，
    //    高度塌成内容高度 ⇒ 比白名单输入框（在行容器 .dg-add 里）明显更矮。
    {
      assert.ok(
        clientSource.indexOf('.dg-field>.dg-input{flex:0 0 auto;height:32px}') !== -1,
        '缺少「列容器内的单行文本框固定 32px 高」的样式规则',
      )
      assert.ok(
        clientSource.indexOf('.dg-input{flex:1;max-width:240px;height:32px') !== -1,
        '白名单输入框高度应为 32px（两者取值必须一致）',
      )
      const settingsProps = sections(harness)[0].options.inject()
      remount()
      const pageTree = render(sections(harness)[0].component, settingsProps)
      const continueInput = collect(pageTree, (node) => node.props.id === 'dg-continuePrompt')[0]
      const whitelistInput = collect(pageTree, (node) => node.props.id === 'dg-whitelist-input')[0]
      assert.ok(continueInput !== undefined, '应渲染继续指令输入框')
      assert.ok(whitelistInput !== undefined, '应渲染白名单输入框')
      assert.strictEqual(continueInput.props.className, 'dg-input', '继续指令输入框应使用 dg-input（与白名单同款）')
      assert.strictEqual(whitelistInput.props.className, 'dg-input', '白名单输入框应使用 dg-input')
      // 模块路径输入框与继续指令输入框共用 textRow ⇒ 同一条修复路径覆盖两者
      assert.ok(clientSource.indexOf("textRow('continuePrompt')") !== -1, '继续指令输入框应由 textRow 渲染')
      assert.ok(clientSource.indexOf("textRow('advancedThresholdFile'") !== -1, '模块路径输入框应由 textRow 渲染')
      ok('设置页：继续指令 / 模块路径输入框与白名单输入框同高（32px）')
    }
  }

  console.log('\n全部通过：' + passed + ' 项（client 设置页）')
}

main().catch((error) => {
  console.error('测试失败：', error)
  process.exitCode = 1
})
