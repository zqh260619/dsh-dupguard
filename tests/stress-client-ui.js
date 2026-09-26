'use strict'

// ============================================================================
// dupguard 客户端设置页压力测试
//
// 覆盖：大规模白名单渲染、高频混合交互、乱序写应答、远端 churn、挂载/卸载泄漏、
//       数值非法与极值。用最小 React 桩驱动真实 lib/client.js 组件。
// 运行：node tests/stress-client-ui.js
// ============================================================================

const fs = require('fs')
const path = require('path')
const assert = require('assert')

let failed = 0
const ok = (label) => console.log('  ✓ ' + label)
const bad = (label, detail) => {
  failed++
  console.log('  ✗ FAIL ' + label + '：' + detail)
}
const metric = (name, value, unit) => console.log('METRIC ' + name + ' ' + String(value) + ' ' + unit)
const timeIt = (fn) => {
  const startedAt = process.hrtime.bigint()
  const result = fn()
  return { result, ms: Number(process.hrtime.bigint() - startedAt) / 1e6 }
}

// ---------------------------------------------------------------- 最小 React
let slots = []
let subscriptions = []
let slot = 0
let effectsRun = false
let pending = false

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props === null || props === undefined ? {} : props,
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  useState: (initial) => {
    const index = slot++
    if (slots.length <= index) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (value) => {
      slots[index] = typeof value === 'function' ? value(slots[index]) : value
      pending = true
    }]
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
    const index = slot++
    if (typeof subscriptions[index] === 'function') subscriptions[index]()
    const dispose = subscribe(() => {
      pending = true
    })
    subscriptions[index] = typeof dispose === 'function' ? dispose : () => {}
    return getSnapshot()
  },
}

let component = null
let componentProps = null

/** 渲染到稳定（含由 store 通知触发的重渲染）。 */
function render() {
  let guard = 0
  let tree = null
  do {
    pending = false
    slot = 0
    tree = component(componentProps)
    effectsRun = true
  } while (pending && ++guard < 500)
  return tree
}

/** 模拟真实卸载：先执行订阅清理，再清空 hook 槽位，使下次挂载重新跑 effect。 */
const remount = () => {
  for (const dispose of subscriptions) if (typeof dispose === 'function') dispose()
  subscriptions = []
  slots = []
  slot = 0
  effectsRun = false
  pending = false
}

const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  return render()
}

/**
 * 等待所有写入结算。
 * 写操作分两段异步：runWrite 先 Promise.resolve().then(...) 调用 controller.set（微任务），
 * 假控制器再用 setTimeout 结算（宏任务）。因此需要交替排空微任务与等待宏任务，
 * 直到连续两轮「没有新写入且全部已结算」为止。
 */
const waitWrites = async (harness, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  let idleRounds = 0
  while (Date.now() < deadline && idleRounds < 2) {
    const callsBefore = harness.calls.length
    await settle(50)
    const counts = harness.counts()
    if (harness.calls.length === callsBefore && counts.settled >= harness.calls.length) idleRounds++
    else idleRounds = 0
    if (idleRounds >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return settle()
}

// ---------------------------------------------------------------- 树工具
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
const whitelistInput = (tree) => collect(tree, (node) => node.props.className === 'dg-input')[0]
const fieldNode = (tree, key) => collect(tree, (node) => node.props.className === 'dg-field' && node.props.key === key)[0]
const numberInput = (tree, key) => collect(fieldNode(tree, key), (node) => node.type === 'input')[0]
const switchButton = (tree, key) => collect(fieldNode(tree, key), (node) => node.props.role === 'switch')[0]
const fieldError = (tree, key) => {
  const node = collect(fieldNode(tree, key), (item) => item.props.className === 'dg-field-error')[0]
  return node === undefined ? null : textOf(node)
}
const chipTexts = (tree) => collect(tree, (node) => node.props.className === 'dg-chip').map((node) => textOf(node.children[0]))
const statusText = (tree) => collect(tree, (node) => node.props.className === 'dg-note').map(textOf).join(' | ')

// ---------------------------------------------------------------- 加载 bundle
let bundle = null
global.window = {
  __ModuleLoader__: {
    load: (spec) => {
      bundle = spec
    },
  },
}
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
new Function('window', 'require', source)(global.window, (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
const plugin = bundle.factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})

const DEFAULTS = {
  ignoredChars: ['-', '|'],
  ignoredSubstrings: [],
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
const NUMERIC_FIELDS = [
  { key: 'threshold', min: 2, max: 1000 },
  { key: 'codeBlockMultiplier', min: 0, max: 100 },
  { key: 'minUnitLength', min: 1, max: 4096 },
  { key: 'maxUnitLength', min: 1, max: 8192 },
  { key: 'detectionWindow', min: 64, max: 1048576 },
]
const ALL_FIELDS = Object.keys(DEFAULTS)

/** 假控制器：可配置写入延迟（模拟乱序应答）并统计订阅配平。 */
function createHarness(options = {}) {
  const calls = []
  const listeners = new Set()
  const state = { revision: 1, user: {} }
  let subscribeCount = 0
  let disposeCount = 0
  let mirrorLoads = 0
  let settled = 0
  let writeIndex = 0
  let cached = null
  const delayFor = options.delayFor
  const applyChange = (field, value) => {
    if (value === undefined) delete state.user[field]
    else state.user[field] = Array.isArray(value) ? [...value] : value
    state.revision++
    cached = null
    for (const listener of [...listeners]) listener()
  }
  const currentValue = () => {
    const out = {}
    for (const key of ALL_FIELDS) {
      const stored = state.user[key]
      out[key] = stored !== undefined ? stored : DEFAULTS[key]
    }
    out.ignoredChars = [...out.ignoredChars]
    return out
  }
  const snapshot = () => {
    if (cached === null) {
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
  // 真实的 SettingsScopeController 把写入串行化到一条写链上（enqueue），
  // 落库顺序永远等于提交顺序；延迟只影响「响应何时回来」。这里如实建模：
  // 提交顺序落库，但每次应答延迟可不同（用于制造响应间隔与交错回调）。
  let chain = Promise.resolve()
  const queue = (kind, field, value) => {
    calls.push([kind, field, value])
    writeIndex++
    const delay = delayFor === undefined ? 0 : delayFor(writeIndex, kind, field)
    const task = chain.then(() => new Promise((resolve) => {
      setTimeout(() => {
        applyChange(field, kind === 'unset' ? undefined : value)
        settled++
        resolve()
      }, delay)
    }))
    chain = task.then(() => undefined, () => undefined)
    return task
  }
  return {
    calls,
    state,
    /** 模拟远端（宿主 / 另一个页面）改变了设置文档：走与真实控制器相同的失效+通知路径。 */
    remote(patch) {
      Object.assign(state.user, patch)
      state.revision++
      cached = null
      for (const listener of [...listeners]) listener()
    },
    counts: () => ({ subscribeCount, disposeCount, mirrorLoads, settled }),
    controller: {
      getSnapshot: snapshot,
      subscribe: (listener) => {
        subscribeCount++
        listeners.add(listener)
        return () => {
          disposeCount++
          listeners.delete(listener)
        }
      },
      set: (field, value) => queue('set', field, value),
      unset: (field) => queue('unset', field, undefined),
      dispose: () => Promise.resolve(),
    },
    mirror: {
      getSnapshot: () => ({ status: 'ready', view: { namespaces: [], writable: true, hasDocument: false }, error: null }),
      subscribe: () => () => {},
      load: () => {
        mirrorLoads++
        return Promise.resolve()
      },
    },
  }
}

/** 上一次挂载的 effect 清理器：模拟真实卸载时 cordis 运行 effect 清理的行为。 */
let activeDisposers = []

function mount(harness) {
  // 先卸载上一次挂载（真实客户端里插件 fiber 卸载会跑完所有 effect 清理）。
  for (const dispose of activeDisposers.splice(0)) {
    try {
      dispose()
    } catch (_error) {}
  }
  const registrations = []
  const settingsScopeService = { bind: () => harness.controller, describe: () => harness.mirror }
  const disposers = []
  const ctx = {
    get: (name) => (name === 'connection' ? { isLoopback: true } : undefined),
    // effect：立即执行并从返回值取出清理器（与 cordis 语义一致）。
    effect: (fn) => {
      const produced = typeof fn === 'function' ? fn() : undefined
      const disposer = () => {
        if (typeof produced === 'function') produced()
      }
      disposers.push(disposer)
      return disposer
    },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, callback) => callback(),
      register: (options, comp) => registrations.push({ options, comp }),
    },
    // 动态服务注入：只提供旧版 settingsScope（本套件压的是设置页交互路径）。
    inject: (keys, callback) => {
      const scope = { on: () => () => {} }
      for (const key of keys) {
        if (key === 'settingsScope') scope.settingsScope = settingsScopeService
        else return () => {}
      }
      const disposer = callback(scope)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    settingsScope: settingsScopeService,
  }
  plugin.apply(ctx)
  activeDisposers = disposers
  component = registrations[0].comp
  componentProps = registrations[0].options.inject()
  return render()
}

async function main() {
  console.log('dupguard 客户端设置页压力测试')

  // ---- 1. 大规模白名单渲染与批量移除 ----
  {
    const harness = createHarness()
    const big = Array.from({ length: 500 }, (_item, index) => 'c' + index)
    harness.state.user.ignoredChars = big
    let tree = mount(harness)
    const first = timeIt(() => render())
    assert.strictEqual(chipTexts(tree).length, 500, '应渲染 500 个 chip')
    metric('render_500_chips', first.ms.toFixed(1), 'ms')
    ok('500 条白名单渲染：' + first.ms.toFixed(1) + 'ms')

    let removed = 0
    while (chipTexts(tree).length > 0) {
      const removeButton = collect(tree, (node) => node.props.className === 'dg-chip-remove')[0]
      removeButton.props.onClick()
      tree = render()
      removed++
      if (removed > 600) break
    }
    tree = await waitWrites(harness)
    assert.strictEqual(chipTexts(tree).length, 0, '应全部移除')
    assert.strictEqual(harness.calls.filter((call) => call[0] === 'set').length, 500, '每次移除应恰好一次写入')
    metric('remove_500_chips', removed, 'clicks')
    ok('逐个移除 500 条：写入次数与点击次数一致')
  }

  // ---- 2. 高频混合交互 ----
  {
    const harness = createHarness()
    let tree = mount(harness)
    const startedAt = process.hrtime.bigint()
    for (let i = 0; i < 1000; i++) {
      const mode = i % 4
      if (mode === 0) {
        whitelistInput(tree).props.onChange({ target: { value: 'k' + String(i) } })
        tree = render()
        buttonByText(tree, 'add').props.onClick()
        tree = render()
      } else if (mode === 1) {
        if (chipTexts(tree).length > 1) {
          collect(tree, (node) => node.props.className === 'dg-chip-remove')[0].props.onClick()
          tree = render()
        }
      } else if (mode === 2) {
        switchButton(tree, 'monitorToolArguments').props.onClick()
        tree = render()
      } else {
        numberInput(tree, 'minUnitLength').props.onChange({ target: { value: String(1 + (i % 5)) } })
        tree = render()
        numberInput(tree, 'minUnitLength').props.onBlur()
        tree = render()
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    tree = await waitWrites(harness)
    const writes = harness.calls.length
    metric('mixed_1000_ops', elapsedMs.toFixed(1), 'ms')
    metric('mixed_1000_writes', writes, 'writes')
    assert.ok(elapsedMs < 30000, '1000 次混合操作应在 30s 内完成，实际 ' + elapsedMs.toFixed(1) + 'ms')
    assert.ok(writes <= 1000, '写入次数不应超过操作次数，实际 ' + String(writes))
    assert.ok(statusText(tree).indexOf('saving') === -1, '不应停留在「保存中…」，实际：' + statusText(tree))
    const snapshotValue = harness.controller.getSnapshot().value
    assert.deepStrictEqual(chipTexts(tree), snapshotValue.ignoredChars, '白名单应与快照一致')
    assert.strictEqual(numberInput(tree, 'minUnitLength').props.value, String(snapshotValue.minUnitLength), '数值应与快照一致')
    ok('1000 次混合操作：' + elapsedMs.toFixed(1) + 'ms，' + String(writes) + ' 次写入，最终状态与快照一致')
  }

  // ---- 3. 乱序写应答 ----
  {
    const harness = createHarness({ delayFor: (index) => (index % 3) * 2 })
    let tree = mount(harness)
    for (const value of [3, 7, 11, 15, 19, 23]) {
      numberInput(tree, 'threshold').props.onChange({ target: { value: String(value) } })
      tree = render()
      numberInput(tree, 'threshold').props.onBlur()
      tree = render()
    }
    tree = await waitWrites(harness)
    const snapshotValue = harness.controller.getSnapshot().value
    assert.strictEqual(numberInput(tree, 'threshold').props.value, String(snapshotValue.threshold), '乱序应答后 UI 应与快照一致')
    assert.ok(statusText(tree).indexOf('saving') === -1, '不应停留在「保存中…」')
    assert.ok(statusText(tree).indexOf('saved') !== -1, '最终应显示已保存')
    metric('out_of_order_writes', harness.calls.length, 'writes')
    ok('乱序写应答：' + String(harness.calls.length) + ' 次写入后 UI 与快照一致（阈值 ' + String(snapshotValue.threshold) + '）')
  }

  // ---- 4. 远端 churn 与本地脏字段 ----
  {
    const harness = createHarness()
    let tree = mount(harness)
    numberInput(tree, 'threshold').props.onChange({ target: { value: '42' } })
    tree = render()
    for (let i = 0; i < 50; i++) {
      harness.remote({ maxUnitLength: 100 + i })
      tree = render()
    }
    assert.strictEqual(numberInput(tree, 'threshold').props.value, '42', '脏字段不应被远端覆盖')
    assert.strictEqual(numberInput(tree, 'maxUnitLength').props.value, '149', '未编辑字段应跟随远端最新值')
    metric('remote_churn_revisions', 50, 'revisions')
    ok('远端 churn：脏字段保持、其余字段跟随最新快照')
  }

  // ---- 5. 挂载/卸载泄漏 ----
  {
    const harness = createHarness()
    const mounts = 500
    for (let i = 0; i < mounts; i++) {
      remount()
      mount(harness)
    }
    const counts = harness.counts()
    metric('mount_unmount_cycles', mounts, 'cycles')
    metric('subscribe_calls', counts.subscribeCount, 'calls')
    metric('dispose_calls', counts.disposeCount, 'calls')
    metric('mirror_loads', counts.mirrorLoads, 'calls')
    assert.ok(counts.subscribeCount >= mounts, '每次挂载都应订阅')
    assert.ok(
      counts.subscribeCount - counts.disposeCount <= 4,
      '订阅未被配平：subscribe=' + String(counts.subscribeCount) + ' dispose=' + String(counts.disposeCount),
    )
    // 每次挂载会有两次拉取：桥接接入时一次 + 组件打开时强制刷新一次。
    assert.ok(counts.mirrorLoads >= mounts && counts.mirrorLoads <= mounts * 2, '挂载拉取次数应在 1–2 次/挂载之间，实际 ' + String(counts.mirrorLoads))
    ok('500 次挂载/卸载：subscribe=' + String(counts.subscribeCount) + '，dispose=' + String(counts.disposeCount) + '，无泄漏')
  }

  // ---- 6. 数值非法与极值 ----
  {
    const harness = createHarness()
    let tree = mount(harness)
    const cases = []
    for (const field of NUMERIC_FIELDS) {
      cases.push({ field, value: String(field.min - 1), expectWrite: false, expectError: true })
      cases.push({ field, value: String(field.max + 1), expectWrite: false, expectError: true })
      cases.push({ field, value: '1.5', expectWrite: false, expectError: true })
      cases.push({ field, value: '', expectWrite: false, expectError: true })
      cases.push({ field, value: '9'.repeat(20), expectWrite: false, expectError: true })
      cases.push({ field, value: String(field.min), expectWrite: true, expectError: false })
    }
    let checked = 0
    let mismatches = 0
    for (const testCase of cases) {
      const key = testCase.field.key
      if (testCase.expectWrite) {
        // 插件会跳过「与宿主一致」的写入，因此测边界值前先把字段改成另一个合法值，
        // 保证边界写入是一次真实变化。
        const other = testCase.field.min + 1 <= testCase.field.max ? testCase.field.min + 1 : testCase.field.max - 1
        numberInput(tree, key).props.onChange({ target: { value: String(other) } })
        tree = render()
        numberInput(tree, key).props.onBlur()
        tree = await waitWrites(harness)
      }
      const before = harness.calls.length
      numberInput(tree, testCase.field.key).props.onChange({ target: { value: testCase.value } })
      tree = render()
      numberInput(tree, testCase.field.key).props.onBlur()
      tree = await waitWrites(harness)
      const wrote = harness.calls.length > before
      if (testCase.expectWrite !== wrote) {
        mismatches++
        bad('数值校验 ' + testCase.field.key + '=' + testCase.value, '预期写入=' + String(testCase.expectWrite) + '，实际=' + String(wrote))
      }
      const error = fieldError(tree, testCase.field.key)
      if (testCase.expectError && error === null) {
        mismatches++
        bad('数值校验 ' + testCase.field.key + '=' + testCase.value, '预期显示内联错误，实际无')
      } else if (!testCase.expectError && error !== null) {
        mismatches++
        bad('数值校验 ' + testCase.field.key + '=' + testCase.value, '预期无错误，实际：' + error)
      }
      checked++
      numberInput(tree, testCase.field.key).props.onChange({ target: { value: String(DEFAULTS[testCase.field.key]) } })
      tree = render()
      numberInput(tree, testCase.field.key).props.onBlur()
      tree = await waitWrites(harness)
    }
    metric('numeric_cases', checked, 'cases')
    if (mismatches === 0) ok('数值校验：' + String(checked) + ' 组非法/边界取值行为符合预期')
  }

  console.log('')
  console.log('RESULT ' + (failed === 0 ? 'PASS' : 'FAIL'))
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('客户端压力测试无法运行：', error)
  process.exitCode = 1
})
