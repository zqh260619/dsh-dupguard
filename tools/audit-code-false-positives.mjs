#!/usr/bin/env node
/**
 * 误杀审计：把**真实源码**包进代码块（模拟"模型输出里的代码块"），用当前配置重放检测器，
 * 统计会被误判为复读的处数与触发单位；并逐个试加候选白名单字符，看哪个能消除误杀、代价多大。
 *
 *   node tools/audit-code-false-positives.mjs
 *   node tools/audit-code-false-positives.mjs --roots D:\repo1,D:\repo2 --max-files 300 --json
 *   node tools/audit-code-false-positives.mjs --extensions .js,.ts,.py,.md
 *
 * 为什么这样测：模型输出里的代码都在围栏里 ⇒ 走 `阈值 × codeBlockMultiplier`（默认 10×3=30）；
 * 本工具就是把文件内容套上围栏后喂给**发布版同一份检测器**（lib/index.js 的 createStreamGuard），
 * 因此数字就是"真实代码块会不会被截停"的答案。
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const plugin = require(path.join(here, '..', 'lib', 'index.js'))

// 审计会产生大量预期内的日志（检测器命中会打印"已停止生成"，代码里的未配对反引号会告警）
// ⇒ 两个通道都收进缓冲，最后统一折叠展示，避免刷屏。
const captured = { log: [], warn: [] }
const originalLog = console.log
const originalWarn = console.warn
console.log = (...args) => { captured.log.push(args.map((arg) => String(arg)).join(' ')) }
console.warn = (...args) => { captured.warn.push(args.map((arg) => String(arg)).join(' ')) }

const argv = process.argv.slice(2)
const options = {
  roots: ['D:\\ZQH260619\\repos'],
  maxFiles: 300,
  maxBytes: 80000,
  extensions: ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.py', '.md', '.yml', '.yaml', '.json', '.css', '.html', '.ps1', '.sh'],
  json: false,
}
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]
  if (arg === '--roots') { options.roots = argv[++index].split(',').map((item) => item.trim()).filter(Boolean) } else if (arg === '--max-files') { options.maxFiles = Number(argv[++index]) } else if (arg === '--max-bytes') { options.maxBytes = Number(argv[++index]) } else if (arg === '--extensions') { options.extensions = argv[++index].split(',').map((item) => item.trim()) } else if (arg === '--json') { options.json = true } else if (arg === '--help' || arg === '-h') { console.log('见文件头部注释'); process.exit(0) } else { console.error('未知参数：' + arg); process.exit(2) }
}

/** 取 schemastery 默认值（发布版的默认运行时配置）。 */
function unwrap(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}
function defaultRuntime() {
  const resolved = plugin.Config({})
  const runtime = {}
  for (const key of Object.keys(resolved)) {
    const value = unwrap(resolved[key])
    runtime[key] = Array.isArray(value) ? value.slice() : value
  }
  runtime.thresholdMode = 'simple'
  return runtime
}

function collectFiles() {
  const files = []
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out'])
  const walk = (dir, depth) => {
    if (files.length >= options.maxFiles || depth > 6) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (_error) { return }
    for (const entry of entries) {
      if (files.length >= options.maxFiles) return
      if (skip.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (!options.extensions.includes(path.extname(entry.name))) continue
      let size = 0
      try { size = statSync(full).size } catch (_error) { continue }
      if (size === 0 || size > options.maxBytes) continue
      files.push(full)
    }
  }
  for (const root of options.roots) walk(root, 0)
  return files
}

/** 把一段文本按块喂给检测器，返回命中列表。 */
async function replay(text, runtime) {
  const hits = []
  const guard = plugin.__notify.createStreamGuard({ provider: 'audit', model: 'audit' }, runtime, {
    onStop: (hit) => hits.push(hit),
  })
  const pieces = []
  for (let offset = 0; offset < text.length; offset += 256) pieces.push(text.slice(offset, offset + 256))
  async function* upstream() {
    for (const piece of pieces) yield { type: 'text-delta', index: 0, text: piece }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  }
  const wrapped = guard(upstream())
  try {
    for await (const _chunk of wrapped) { /* 消费到结束 */ }
  } catch (_error) {}
  return hits
}

function describeUnit(unit) {
  const chars = [...String(unit)]
  const unique = new Set(chars)
  if (unique.size === 1) return '单字符「' + chars[0] + '」×' + String(chars.length) + '（即连续重复，字符 U+' + chars[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '）'
  return '单元「' + String(unit).slice(0, 20) + '」（长度 ' + String(chars.length) + '）'
}

const files = collectFiles()
if (files.length === 0) {
  console.error('没有找到可扫描的文件（--roots/--extensions 过滤后为空）')
  process.exit(1)
}

const baseline = defaultRuntime()
const VARIANTS = [
  { name: '当前默认（- |）', add: [] },
  { name: '+ =', add: ['='] },
  { name: '+ *', add: ['*'] },
  { name: '+ /', add: ['/'] },
  { name: '+ .', add: ['.'] },
  { name: '+ #', add: ['#'] },
  { name: '+ _', add: ['_'] },
  { name: '+ ~', add: ['~'] },
  { name: '+ +', add: ['+'] },
  { name: '+ 0', add: ['0'] },
  { name: '+ 1', add: ['1'] },
  { name: '+ = * / . # _ ~ +', add: ['=', '*', '/', '.', '#', '_', '~', '+'] },
  { name: '+ ─（制表横线）', add: ['─'] },
  { name: '+ ─ │ ═ ━（制表族）', add: ['─', '│', '═', '━', '┄', '┈'] },
  { name: '+ █ ▓ ▒ ░（块状/阴影）', add: ['█', '▓', '▒', '░'] },
  { name: '+ 制表 + 块状 + ·', add: ['─', '│', '═', '━', '┄', '┈', '█', '▓', '▒', '░', '·'] },
  { name: '+ 制表族 + = - | 等符号', add: ['─', '│', '═', '━', '┄', '┈', '█', '▓', '▒', '░', '·', '=', '*', '/', '.', '#', '_', '~', '+'] },
  { name: '【只调倍数】倍数 4（阈值 40）', add: [], multiplier: 4 },
  { name: '【只调倍数】倍数 5（阈值 50）', add: [], multiplier: 5 },
  { name: '【只调倍数】倍数 8（阈值 80）', add: [], multiplier: 8 },
  { name: '【只调倍数】倍数 0（代码区不检测）', add: [], multiplier: 0 },
]

const contents = []
for (const file of files) {
  try { contents.push({ file, text: '```\n' + readFileSync(file, 'utf8') + '\n```' }) } catch (_error) {}
}

const results = []
for (const variant of VARIANTS) {
  const runtime = { ...baseline, ignoredChars: baseline.ignoredChars.concat(variant.add) }
  if (variant.multiplier !== undefined) runtime.codeBlockMultiplier = variant.multiplier
  let hitFiles = 0
  let hitCount = 0
  const units = new Map()
  for (const item of contents) {
    const hits = await replay(item.text, runtime)
    if (hits.length > 0) {
      hitFiles++
      hitCount += hits.length
      for (const hit of hits) {
        const key = describeUnit(hit.unit)
        const record = units.get(key) || { count: 0, sample: item.file }
        record.count++
        units.set(key, record)
      }
    }
  }
  const top = [...units.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6)
  results.push({ variant: variant.name, hitFiles, hitCount, top: top.map(([unit, record]) => [unit, record.count, record.sample]) })
}

// 恢复控制台，开始输出结果
console.log = originalLog
console.warn = originalWarn
const pluginWarnings = captured.warn

if (options.json) {
  console.log(JSON.stringify({ scanned: contents.length, warnings: pluginWarnings.length, stopLogs: captured.log.length, results }, null, 1))
} else {
  console.log('扫描文件：' + String(contents.length) + ' 个（roots: ' + options.roots.join(' ; ') + '，每文件 ≤ ' + String(Math.round(options.maxBytes / 1024)) + ' KB，内容包在 ``` 围栏里）')
  console.log('默认运行时：阈值 ' + String(baseline.threshold) + '｜倍数 ' + String(baseline.codeBlockMultiplier) + '｜最大单元 ' + String(baseline.maxUnitLength) + '｜白名单 ' + JSON.stringify(baseline.ignoredChars))
  if (pluginWarnings.length > 0) {
    const kinds = new Map()
    for (const warning of pluginWarnings) kinds.set(warning, (kinds.get(warning) || 0) + 1)
    console.log('检测器告警（已折叠）：' + [...kinds.entries()].map(([text, count]) => text.slice(0, 40) + '… ×' + String(count)).join('；'))
  }
  console.log('')
  console.log('结论        误杀文件数/总文件   误杀处数   触发单位（含样例文件）')
  for (const result of results) {
    const detail = result.top.length === 0
      ? '-'
      : result.top.map(([unit, count, sample]) => unit + ' ×' + String(count) + ' ← ' + path.basename(String(sample))).join('；')
    console.log(
      result.variant.padEnd(28) +
      (String(result.hitFiles) + '/' + String(contents.length)).padEnd(20) +
      String(result.hitCount).padEnd(11) +
      detail,
    )
  }
}
