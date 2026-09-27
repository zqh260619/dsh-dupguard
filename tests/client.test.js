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
// 片段输入框是页面里第二个 .dg-input（第一个是字符白名单输入）。
const substringInput = (tree) => collect(tree, (node) => node.type === 'input' && node.props.className === 'dg-input')[1]
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
const DICT = {
  windowWarn: '窗口至少 {need}（当前 {current} = 阈值 {threshold} × 倍数 {multiplier} × 最大单元 {maxUnit}），超过 {effective} 字符无法识别',
  loadingDiag: '设置通道：{state}｜{diag}',
  derivedDiag: '自动派生：检测窗口 {window}',
  derivedDiagTable: '自动派生：检测窗口 {window} · 最大重复单元长度 {maxUnit}（末行决定）',
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
}
// 恢复默认会 unset 客户端声明的全部字段；detectionWindow 已改为派生值，不再由客户端 unset。
const FIELDS = Object.keys(DEFAULTS).filter((key) => key !== 'detectionWindow')

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
  assert.strictEqual(harness.registrations.length, 1, '应注册 settings.section 槽位')
  entry = harness.registrations[0]
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
  assert.strictEqual(switchButton(tree, 'skipCodeBlocks').props['aria-checked'], true, '代码块放宽开关应为开')
  assert.strictEqual(switchButton(tree, 'monitorReasoning').props['aria-checked'], true, 'reasoning 开关应为开')
  assert.strictEqual(switchButton(tree, 'monitorToolArguments').props['aria-checked'], false, '工具参数开关应为关')
  assert.strictEqual(warnText(tree), null, '默认参数下不应出现窗口提示')
  assert.ok(harness.calls.some((call) => call[0] === 'mirror.load'), '挂载时应重拉镜像')
  ok('初始渲染读取快照（白名单 + 参数）并重拉镜像')

  // C2：添加白名单 → 控制器 set，状态「保存中…→已保存」。
  const input = collect(tree, (node) => node.props.className === 'dg-input')[0]
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

  // C7b：一次输入多个字符 → 逐个加入白名单（白名单按字符匹配，整串条目永不生效）。
  before = harness.calls.length
  collect(tree, (node) => node.props.className === 'dg-input')[0].props.onChange({ target: { value: 'xy' } })
  tree = rerender()
  buttonByText(tree, 'add').props.onClick()
  await flush()
  tree = rerender()
  assert.deepStrictEqual(
    harness.calls[before],
    ['set', 'ignoredChars', ['-', '|', 'b', 'x', 'y']],
    '多字符输入应拆成单个字符加入',
  )
  assert.deepStrictEqual(chipTexts(tree), ['-', '|', 'b', 'x', 'y'], 'chips 应含逐个加入的字符')
  ok('多字符输入按字符拆分加入白名单')

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

  // C7e：代码块放宽开关与倍数写入。
  before = harness.calls.length
  switchButton(tree, 'skipCodeBlocks').props.onClick()
  await flush()
  tree = rerender()
  assert.deepStrictEqual(harness.calls[before], ['set', 'skipCodeBlocks', false], '代码块放宽开关应写入布尔值')
  assert.strictEqual(switchButton(tree, 'skipCodeBlocks').props['aria-checked'], false, '开关应切到关')
  // 复原为开，避免影响后续窗口提示用例
  switchButton(tree, 'skipCodeBlocks').props.onClick()
  await flush()
  tree = rerender()
  assert.strictEqual(switchButton(tree, 'skipCodeBlocks').props['aria-checked'], true, '开关应可再次切回开')

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
    assert.strictEqual(remote.registrations.length, 1, '只有 remote.settings 时也应注册设置分节')
    // 回归：必须同时声明父服务与点号服务。只声明 'remote.settings' 时，
    // 注入作用域里没有 scope.remote（1.6.0 在 0.1.7 上设置页停在「加载中」的根因）。
    assert.ok(
      remote.injectCalls.some((keys) => keys.includes('remote') && keys.includes('remote.settings')),
      '应同时注入 remote 与 remote.settings，实际：' + JSON.stringify(remote.injectCalls),
    )
    const remoteEntry = remote.registrations[0]
    const remoteProps = remoteEntry.options.inject()
    const renderRemote = () => render(remoteEntry.component, remoteProps)

    await flush()
    let view = renderRemote()
    assert.strictEqual(numberInput(view, 'threshold').props.value, '10', '应从 describe() 读到阈值')
    assert.strictEqual(numberInput(view, 'codeBlockMultiplier').props.value, '3', '应从 describe() 读到代码块倍数')
    assert.strictEqual(switchButton(view, 'skipCodeBlocks').props['aria-checked'], true, '应从 describe() 读到开关值')
    assert.deepStrictEqual(chipTexts(view), ['-', '|'], '应读到白名单')
    ok('新版 remote.settings：describe 读取初始值')

    // 开关写入：mutate(ns, ops, revision)，命名空间取 loader entry id
    const beforeWrite = remote.remoteCalls.length
    switchButton(view, 'skipCodeBlocks').props.onClick()
    await flush()
    view = renderRemote()
    const write = remote.remoteCalls.slice(beforeWrite).find((call) => call[0] === 'mutate')
    assert.ok(write !== undefined, '开关应触发 remote.settings.mutate')
    assert.strictEqual(write[1], 'dupguard', '命名空间应为 loader entry id，实际：' + String(write[1]))
    assert.deepStrictEqual(write[2], [{ op: 'set', path: ['skipCodeBlocks'], value: false }], 'ops 形状应为 { op, path, value }')
    assert.strictEqual(typeof write[3], 'number', '应带上 describe 返回的 revision')
    assert.strictEqual(switchButton(view, 'skipCodeBlocks').props['aria-checked'], false, 'UI 应反映新值')
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
    const conflictedEntry = conflicted.registrations[conflicted.registrations.length - 1]
    const conflictedProps = conflictedEntry.options.inject()
    await settle()
    let conflictedView = render(conflictedEntry.component, conflictedProps)
    switchButton(conflictedView, 'skipCodeBlocks').props.onClick()
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
    const raceEntry = race.registrations[race.registrations.length - 1]
    const raceProps = raceEntry.options.inject()
    // 不等待任何异步完成，直接用桥接的写通道发起一次写入（模拟用户立刻点开关）。
    raceProps.controller.set('skipCodeBlocks', false)
    await settle()
    const raceWrite = race.remoteCalls.find((call) => call[0] === 'mutate')
    assert.ok(raceWrite !== undefined, '立即写入也应产生 mutate')
    assert.strictEqual(raceWrite[1], 'dupguard', '立即写入时命名空间仍应正确，实际：' + String(raceWrite[1]))
    ok('新版 remote.settings：describe 未完成即写入时命名空间仍正确')

    // 命名空间带组合前缀（0.1.7 实测为 include:dupguard）时仍应命中
    const prefixed = createHarness('remote', { remoteNs: 'include:dupguard' })
    plugin.apply(prefixed.ctx)
    const prefixedEntry = prefixed.registrations[prefixed.registrations.length - 1]
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
    const missingEntry = missing.registrations[missing.registrations.length - 1]
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
    assert.strictEqual(bare.registrations.length, 1, '无设置服务时仍应注册设置分节（不得 pending）')
    const bareEntry = bare.registrations[0]
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
    const dottedEntry = dotted.registrations[dotted.registrations.length - 1]
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

  // C10：片段白名单（多字符，整段匹配；不按码点拆分）
  {
    assert.deepStrictEqual(chipTexts(tree).filter((item) => item.length > 1), [], '默认片段白名单为空')

    before = harness.calls.length
    substringInput(tree).props.onChange({ target: { value: '|---|' } })
    tree = rerender()
    buttonByText(tree, 'substringAdd').props.onClick()
    await settle()
    tree = rerender()
    const write = harness.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'ignoredSubstrings')
    assert.deepStrictEqual(write, ['set', 'ignoredSubstrings', ['|---|']], '整段应作为一个条目写入，不得拆分')
    assert.ok(chipTexts(tree).indexOf('|---|') !== -1, '片段应显示为一个 chip')

    // 重复条目：就地报错且不写入
    before = harness.calls.length
    substringInput(tree).props.onChange({ target: { value: '|---|' } })
    tree = rerender()
    buttonByText(tree, 'substringAdd').props.onClick()
    await settle()
    tree = rerender()
    assert.strictEqual(harness.calls.length, before, '重复片段不应写入')
    assert.ok(lastFieldError(tree).indexOf('errSubstringDuplicate') !== -1, '重复片段应就地报错')

    // 超长条目（> 64 码点）：就地报错且不写入
    substringInput(tree).props.onChange({ target: { value: 'x'.repeat(65) } })
    tree = rerender()
    buttonByText(tree, 'substringAdd').props.onClick()
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
    ok('片段白名单：整段加入 / 重复与超长拒绝 / 删除')
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

    // 复原并让「放宽代码块内的检测」为开，验证派生窗口随倍数变化
    await editCell(rowEnd(0), '2')
    if (switchButton(tree, 'skipCodeBlocks').props['aria-checked'] !== true) {
      switchButton(tree, 'skipCodeBlocks').props.onClick()
      await settle()
      tree = rerender()
    }
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

    // 切到高级模式：只显示模块路径；扩展名校验
    modeSelect().props.onChange({ target: { value: 'module' } })
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
    assert.strictEqual(harness.calls.length, before, '非 JS 扩展名不应写入')
    assert.ok(lastFieldError(tree).indexOf('errThresholdFile') !== -1, '扩展名错误应就地报错')
    fileInput().props.onChange({ target: { value: 'C:/tmp/policy.cjs' } })
    tree = rerender()
    fileInput().props.onBlur()
    await settle()
    tree = rerender()
    const fileWrite = harness.calls.slice(before).find((call) => call[0] === 'set' && call[1] === 'advancedThresholdFile')
    assert.deepStrictEqual(fileWrite, ['set', 'advancedThresholdFile', 'C:/tmp/policy.cjs'], '合法路径应写入')
    ok('高级重复设置：三模式下拉 / 分段表表格（增删行、校验、派生）/ 路径校验')
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
    const migratedEntry = migrated.registrations[0]
    const migratedProps = migratedEntry.options.inject()
    const migratedTree = render(migratedEntry.component, migratedProps)
    const starts = collect(migratedTree, (node) => String(node.props.className).indexOf('dg-ro') !== -1).map((node) => textOf(node))
    const ends = collect(migratedTree, (node) => /^dg-row-end-/.test(String(node.props.id))).map((node) => node.props.value)
    assert.deepStrictEqual(starts, ['1', '2', '3'], '`*` 行应接在具名行之后（起始 = 上一行终止 + 1）')
    assert.deepStrictEqual(ends, ['1', '2', '80'], '`*` 行终止应取文档 maxUnitLength（默认 80）')
    ok('分段表旧写法 `*:次数` 迁移为表格末行')
  }

  console.log('\n全部通过：' + passed + ' 项（client 设置页）')
}

main().catch((error) => {
  console.error('测试失败：', error)
  process.exitCode = 1
})
