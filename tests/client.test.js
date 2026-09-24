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
const fieldError = (tree, key) => {
  const node = collect(fieldNode(tree, key), (item) => item.props.className === 'dg-field-error')[0]
  return node === undefined ? null : textOf(node)
}
const chipTexts = (tree) => collect(tree, (node) => node.props.className === 'dg-chip').map((node) => textOf(node.children[0]))
const warnText = (tree) => {
  const node = collect(tree, (item) => item.props.className === 'dg-warn')[0]
  return node === undefined ? null : textOf(node)
}
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

// 本地化桩：只给需要校验占位符替换的键提供模板，其余直接回显键名。
const DICT = {
  windowWarn: '窗口至少 {need}（当前 {current} = 阈值 {threshold} × 倍数 {multiplier} × 最大单元 {maxUnit}），超过 {effective} 字符无法识别',
}
const fakeT = (key) => (DICT[key] === undefined ? key : DICT[key])

// ---------------------------------------------------------------------------
// 最小 DSH 客户端 ctx 桩：settingsScope 控制器 + describe 面 + 槽位注册。
// 注意：故意不提供 connection.api —— 组件不得再依赖它。
// ---------------------------------------------------------------------------
const DEFAULTS = {
  ignoredChars: ['-', '|'],
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
const FIELDS = Object.keys(DEFAULTS)

function createHarness() {
  const calls = []
  const listeners = new Set()
  const state = { revision: 1, user: {} }
  const currentValue = () => {
    const out = {}
    for (const key of FIELDS) {
      const stored = state.user[key]
      out[key] = stored !== undefined ? stored : DEFAULTS[key]
    }
    out.ignoredChars = [...out.ignoredChars]
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
  const registrations = []
  const ctx = {
    get: (name) => (name === 'connection' ? { isLoopback: true } : undefined),
    effect: () => () => {},
    locale: {
      register: () => {},
      bind: () => fakeT,
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
  assert.strictEqual(numberInput(tree, 'detectionWindow').props.value, '8192', '窗口应显示快照值')
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

  // C8：窗口 < 最严格阈值 × 最大单元长度 → 显示「窗口长度需要提高」提示。
  // 此时阈值已被 C4 改为 5，代码块倍数已复原为 3、最大单元 80 → 所需窗口 5 × 3 × 80 = 1200，
  // 当前 100 时只能识别 100 / 15 = 6 字符的单元。
  numberInput(tree, 'detectionWindow').props.onChange({ target: { value: '100' } })
  tree = rerender()
  const warn = warnText(tree)
  assert.ok(warn !== null, '窗口不足时应显示提示')
  assert.ok(warn.indexOf('1200') !== -1, '提示应给出所需窗口 5 × 3 × 80 = 1200，实际：' + String(warn))
  assert.ok(warn.indexOf('100') !== -1, '提示应给出当前窗口，实际：' + String(warn))
  assert.ok(warn.indexOf('6') !== -1, '提示应给出当前窗口下可识别的最大单元 floor(100 / 15) = 6')
  numberInput(tree, 'detectionWindow').props.onChange({ target: { value: '8192' } })
  tree = rerender()
  assert.strictEqual(warnText(tree), null, '窗口充足时提示应消失')
  ok('窗口不足时提示「窗口长度需要提高」，恢复后消失')

  // C9：恢复默认 → 逐字段 unset，回到代码默认值。
  before = harness.calls.length
  buttonByText(tree, 'reset').props.onClick()
  await flush()
  tree = rerender()
  const unsets = harness.calls.slice(before).filter((call) => call[0] === 'unset').map((call) => call[1])
  assert.strictEqual(unsets.length, FIELDS.length, '恢复默认应 unset 全部字段，实际：' + unsets.join(','))
  assert.deepStrictEqual(harness.state.user, {}, '用户层应被清空')
  assert.ok(statusText(tree).indexOf('saved') !== -1, '恢复默认后应显示已保存')
  assert.deepStrictEqual(chipTexts(tree), ['-', '|'], '白名单应回到默认')
  assert.strictEqual(numberInput(tree, 'threshold').props.value, '10', '阈值应回到默认')
  assert.strictEqual(numberInput(tree, 'detectionWindow').props.value, '8192', '窗口应回到默认')
  ok('恢复默认逐字段 unset 并回到代码默认值')

  console.log('\n全部通过：' + passed + ' 项（client 设置页）')
}

main().catch((error) => {
  console.error('测试失败：', error)
  process.exitCode = 1
})
