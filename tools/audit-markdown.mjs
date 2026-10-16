#!/usr/bin/env node
/**
 * Markdown 渲染体检：把"会在 GitHub / npm 上渲染坏、但肉眼很难发现"的问题挡在 CI 里。
 *
 *   npm run audit:markdown                 # 默认体检 README.md + CHANGELOG.md + docs/*.md
 *   npm run audit:markdown -- --files a.md,b.md
 *   npm run audit:markdown -- --json
 *
 * 五类检查（每一类都来自真实踩过的坑）：
 *   ① 围栏配对：```` ``` ```` / `~~~` 围栏必须成对；反引号围栏的 info string 不允许再含反引号
 *      （那种行按 CommonMark **不是**围栏，是普通段落）。
 *   ② 表格列数：每行的单元格数必须等于表头（未转义的 `|` 会把单元格切开、整行错位）。
 *   ③ 反引号 span：按 CommonMark 的等长配对规则解析；落单的反引号会吞掉同一行后面所有内容。
 *   ④ CJK 粗体：`**` 的左右邻字符决定它能否开启/闭合。最常见的两种坏法：
 *        · `请在**「设置」**安装`  —— 闭合 `**` 前是标点、后是汉字 ⇒ 不能闭合，粗体会**跨句泄漏**；
 *        · `中文**「粗体」**` 同理。
 *      这类错误不会显示成可见的 `**`，只会把粗体加在错的文字上，所以必须静态检查。
 *   ⑤ 编程式区间写法 `1..64`：中文说明里应写 `1–64`。
 *
 * 退出码：0 = 通过；1 = 有问题（CI 直接失败）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const argv = process.argv.slice(2)
const options = { files: null, json: false }
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]
  if (arg === '--files') { options.files = argv[++index].split(',').map((item) => item.trim()).filter(Boolean) } else if (arg === '--json') { options.json = true } else if (arg === '--help' || arg === '-h') { console.log('见文件头部注释'); process.exit(0) } else { console.error('未知参数：' + arg); process.exit(2) }
}

function defaultFiles() {
  const files = []
  for (const name of ['README.md', 'CHANGELOG.md']) if (existsSync(path.join(root, name))) files.push(name)
  const docsDir = path.join(root, 'docs')
  if (existsSync(docsDir)) {
    for (const name of readdirSync(docsDir).sort()) if (name.endsWith('.md')) files.push(path.join('docs', name))
  }
  return files
}

const files = options.files === null ? defaultFiles() : options.files
const PUNCTUATION = /[）」』】》〉”’、，。；：！？)】]/
const OPENING_PUNCTUATION = /[）」』】》〉”’、，。；：！？(（「『【《〈]/
const WORD = /[\u4e00-\u9fffA-Za-z0-9]/
const problems = []

function report(file, line, message, text) {
  problems.push({ file, line, message, text: String(text).trim().slice(0, 150) })
}

for (const file of files) {
  const absolute = path.join(root, file)
  if (!existsSync(absolute)) { report(file, 0, '文件不存在'); continue }
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/)
  let inFence = false
  let fenceChar = '`'
  let fenceLength = 3
  let expectedColumns = null

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = line.trim()

    if (inFence) {
      if (new RegExp('^' + (fenceChar === '`' ? '`' : '~') + '{' + String(fenceLength) + ',}\\s*$').test(trimmed)) inFence = false
      return
    }
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(trimmed)
    if (fence !== null && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      fenceChar = fence[1][0]
      fenceLength = fence[1].length
      inFence = true
      return
    }

    // ② 表格列数
    if (trimmed.startsWith('|')) {
      const body = trimmed.replace(/^\|/, '').replace(/\|$/, '')
      const cells = []
      let current = ''
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '\\' && body[i + 1] === '|') { current += '|'; i++; continue }
        if (body[i] === '|') { cells.push(current); current = ''; continue }
        current += body[i]
      }
      cells.push(current)
      if (cells.every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell))) expectedColumns = cells.length
      else if (expectedColumns !== null && cells.length !== expectedColumns) {
        report(file, lineNumber, '表格列数 ' + String(cells.length) + ' ≠ 表头 ' + String(expectedColumns) + '（有未转义的 | ？）', trimmed)
      }
    } else if (trimmed !== '') {
      expectedColumns = null
    }

    // ③ 反引号 span（CommonMark：闭合 run 长度须与开启相同）
    const runs = []
    const tickRe = /`+/g
    let tick
    while ((tick = tickRe.exec(line)) !== null) runs.push({ start: tick.index, length: tick[0].length, text: tick[0] })
    const inside = new Array(runs.length).fill(false)
    const spans = [] // [start, end) 区间：代码 span 内部不做粗体/区间写法检查（那里是"引用"，不是排版）
    let cursor = 0
    while (cursor < runs.length) {
      const opener = runs[cursor]
      let closeIndex = -1
      for (let i = cursor + 1; i < runs.length; i++) {
        if (runs[i].length === opener.length) { closeIndex = i; break }
      }
      if (closeIndex === -1) {
        report(file, lineNumber, '未闭合的反引号 run（长度 ' + String(opener.length) + '）——会吞掉本行后续内容', trimmed)
        break
      }
      const content = line.slice(opener.start + opener.length, runs[closeIndex].start)
      if (content.startsWith(opener.text) || content.endsWith(opener.text)) {
        report(file, lineNumber, '代码 span 边缘出现等长反引号 run（解析会提前闭合）', trimmed)
      }
      spans.push([opener.start, runs[closeIndex].start + runs[closeIndex].length])
      for (let i = cursor; i <= closeIndex; i++) inside[i] = true
      cursor = closeIndex + 1
    }
    if (runs.filter((_run, i) => !inside[i]).length % 2 === 1) report(file, lineNumber, 'span 之外有落单的反引号', trimmed)
    const inCodeSpan = (index) => spans.some(([start, end]) => index >= start && index < end)

    // ④ CJK 粗体 flanking（代码 span 内部的 `**` 是引用，不判）
    const boldRe = /\*\*([^*\n]+)\*\*/g
    let bold
    while ((bold = boldRe.exec(line)) !== null) {
      if (inCodeSpan(bold.index)) continue
      const inner = bold[1]
      const before = line.slice(Math.max(0, bold.index - 1), bold.index)
      const after = line.slice(bold.index + bold[0].length, bold.index + bold[0].length + 1)
      if (PUNCTUATION.test(inner.slice(-1)) && WORD.test(after)) {
        report(file, lineNumber, '粗体不能闭合（闭合 ** 前是标点、后是文字）⇒ 粗体会跨句泄漏：' + bold[0].slice(0, 30), trimmed)
      }
      if (WORD.test(before) && OPENING_PUNCTUATION.test(inner.slice(0, 1))) {
        report(file, lineNumber, '粗体不能开启（前是文字、首字符是标点）：' + bold[0].slice(0, 30), trimmed)
      }
    }

    // ⑤ 编程式区间写法（同样跳过代码 span：引用坏例子是合理的）
    const rangeRe = /[0-9]\.\.[0-9]/g
    let range
    while ((range = rangeRe.exec(line)) !== null) {
      if (inCodeSpan(range.index)) continue
      report(file, lineNumber, '编程式区间写法（如 1..64）应写成 1–64', trimmed)
      break
    }
  })

  if (inFence) report(file, lines.length, '围栏未闭合（读到文件结束仍在代码块里）')
}

if (options.json) {
  console.log(JSON.stringify({ files, problems }, null, 1))
} else {
  console.log('体检文件：' + files.join('、'))
  for (const problem of problems) {
    console.log(problem.file + ':' + String(problem.line) + '  ' + problem.message)
    if (problem.text !== '') console.log('   ' + problem.text)
  }
  console.log('')
  console.log(problems.length === 0
    ? '通过：围栏配对 / 表格列数 / 反引号 span / CJK 粗体 / 区间写法 均无问题 ✓'
    : '不通过：共 ' + String(problems.length) + ' 处问题')
}
process.exitCode = problems.length === 0 ? 0 : 1
