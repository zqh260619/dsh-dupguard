'use strict'

// ============================================================================
// dupguard 浏览器端（lib/client.js）单元测试
//
// 用最小 React 桩 + 最小 DSH 客户端 ctx 桩直接驱动设置页组件，覆盖：
//   1. 写路径调用 settingsScope 控制器的 set/unset（不再触碰 connection.api，
//      DSH 0.1.2 起该字段已移除——这正是「保存中…」卡死的根因）；
//   2. 写入成功后状态显示「已保存」；
//   3. 重新挂载（重开设置页）时列表来自控制器快照（持久化值可见）；
//   4. 恢复默认走 unset。
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

const render = (component, props) => {
  slot = 0
  const tree = component(props)
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
const chipTexts = (tree) => collect(tree, (node) => node.props.className === 'dg-chip').map((node) => textOf(node.children[0]))
const statusText = (tree) => collect(tree, (node) => node.props.className === 'dg-note').map(textOf).join(' | ')

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

// ---------------------------------------------------------------------------
// 最小 DSH 客户端 ctx 桩：settingsScope 控制器 + describe 面 + 槽位注册。
// 注意：故意不提供 connection.api —— 组件不得再依赖它。
// ---------------------------------------------------------------------------
function createHarness() {
  const calls = []
  const listeners = new Set()
  const state = {
    ignoredChars: ['-', '|'],
    revision: 1,
  }
  let cached = null
  const snapshot = () => {
    if (cached === null || cached.revision !== state.revision) {
      cached = {
        status: 'ready',
        value: { ignoredChars: [...state.ignoredChars] },
        revision: state.revision,
        base: { ignoredChars: ['-', '|'] },
        user: undefined,
        writable: true,
        mode: 'host',
      }
    }
    return cached
  }
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  const controller = {
    getSnapshot: snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (field, value) => {
      calls.push(['set', field, value])
      state.ignoredChars = [...value]
      state.revision++
      notify()
      return Promise.resolve()
    },
    unset: (field) => {
      calls.push(['unset', field])
      state.ignoredChars = ['-', '|']
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
  const registrations = []
  const ctx = {
    get: (name) => (name === 'connection' ? { isLoopback: true } : undefined),
    effect: () => () => {},
    locale: {
      register: () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
      },
    },
    settingsScope: {
      bind: () => controller,
      describe: () => mirror,
    },
  }
  return { ctx, calls, controller, registrations, state }
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

async function main() {
  console.log('dupguard client 设置页测试（最小 React/DSH 桩）')

  const harness = createHarness()
  plugin.apply(harness.ctx)
  assert.strictEqual(harness.registrations.length, 1, '应注册 settings.section 槽位')
  const entry = harness.registrations[0]
  assert.strictEqual(entry.options.name, 'settings.section')
  assert.strictEqual(entry.options.id, 'dupguard')
  assert.strictEqual(entry.options.order, 25)
  assert.strictEqual(typeof entry.options.label, 'function')
  assert.strictEqual(entry.options.label(), 'nav', 'label 应为注册时本地化的文本 thunk')
  ok('settings.section 槽位注册（id/order/label）')

  const props = entry.options.inject()
  assert.strictEqual(props.api, undefined, 'props 不应再暴露 connection.api')
  assert.strictEqual(typeof props.controller.set, 'function')

  // C1：初始渲染显示控制器快照中的白名单，并在挂载时重拉镜像。
  let tree = render(entry.component, props)
  assert.deepStrictEqual(chipTexts(tree), ['-', '|'], '初始应显示快照白名单')
  assert.ok(harness.calls.some((call) => call[0] === 'mirror.load'), '挂载时应重拉镜像')
  ok('初始渲染读取控制器快照并重拉镜像')

  // C2：输入 + 点击「添加」→ 走控制器 set，状态先「保存中」后「已保存」。
  const input = collect(tree, (node) => node.type === 'input')[0]
  input.props.onChange({ target: { value: 'b' } })
  tree = render(entry.component, props)
  const addButton = buttonByText(tree, 'add')
  assert.ok(addButton !== undefined, '应能找到「添加」按钮')
  addButton.props.onClick()
  tree = render(entry.component, props)
  assert.ok(statusText(tree).indexOf('保存中') !== -1, '写入期间应显示保存中')
  await flush()
  tree = render(entry.component, props)
  assert.deepStrictEqual(harness.calls.find((call) => call[0] === 'set'), ['set', 'ignoredChars', ['-', '|', 'b']], '应调用控制器 set')
  assert.ok(statusText(tree).indexOf('已保存') !== -1, '写入成功后应显示已保存')
  assert.deepStrictEqual(chipTexts(tree), ['-', '|', 'b'], '添加后列表应含新字符')
  ok('添加走控制器 set 并回显「已保存」')

  // C3：重开设置页（重新挂载同一控制器）→ 列表来自快照，新增字符可见。
  remount()
  const reopened = render(entry.component, props)
  assert.deepStrictEqual(chipTexts(reopened), ['-', '|', 'b'], '重开后应显示已持久化的白名单')
  ok('重开设置页显示持久化白名单')

  // C4：删除字符 → 再次 set。
  const before = harness.calls.length
  const removeButton = collect(reopened, (node) => node.props.className === 'dg-chip-remove')[2]
  assert.ok(removeButton !== undefined, '应能找到移除按钮')
  removeButton.props.onClick()
  await flush()
  const removeCall = harness.calls[before]
  assert.deepStrictEqual(removeCall, ['set', 'ignoredChars', ['-', '|']], '删除后应 set 剩余白名单')
  ok('移除字符走控制器 set')

  // C5：恢复默认 → unset。
  remount()
  const resetTree = render(entry.component, props)
  const resetButton = buttonByText(resetTree, 'reset')
  assert.ok(resetButton !== undefined, '应能找到「恢复默认」按钮')
  resetButton.props.onClick()
  await flush()
  const last = harness.calls[harness.calls.length - 1]
  assert.deepStrictEqual(last, ['unset', 'ignoredChars'], '恢复默认应调用控制器 unset')
  const afterReset = render(entry.component, props)
  assert.ok(statusText(afterReset).indexOf('已保存') !== -1, '恢复默认后应显示已保存')
  assert.deepStrictEqual(chipTexts(afterReset), ['-', '|'], '恢复默认后应回到默认白名单')
  ok('恢复默认走控制器 unset')

  console.log('\n全部通过：' + passed + ' 项（client 设置页）')
}

main().catch((error) => {
  console.error('测试失败：', error)
  process.exitCode = 1
})
