#!/usr/bin/env node
/**
 * 高级模式（module）模块的**沙箱试运行**：在受限子进程里加载候选模块，打印它给每个单元长度
 * 判定的重复次数，并对照插件的真实合法性规则给出结论。
 *
 * 为什么需要它：高级模式的模块文件是在 **DSH 宿主进程内**执行的（与宿主同权限）。在把它填进设置页
 * 之前先在这里跑一遍，能把"写文件 / 起子进程 / 死循环 / 返回非法值"这类问题挡在宿主之外。
 *
 * 隔离能力（Windows + Node ≥ 20 的权限模型，已实测）：
 *   ✅ 文件写入 —— 拒绝（ERR_ACCESS_DENIED）
 *   ✅ 子进程   —— 拒绝（ERR_ACCESS_DENIED）
 *   ✅ 文件读取 —— 默认全拒；仅放行"模块所在目录 / 插件目录 / --allow-read 指定目录"
 *   ✅ 死循环 / 超大内存 —— 由超时与 --max-old-space-size 掐断（整个子进程被杀）
 *   ⚠️ 网络     —— **不受限**（Node 权限模型不覆盖网络）；需要真隔离见 docs/advanced-mode-sandbox.md
 *
 * 用法：
 *   node tools/sandbox-threshold-module.mjs <模块文件> [选项]
 *   npm run sandbox:module -- <模块文件> [选项]
 *
 * 选项：
 *   --lengths 1,2,3,8,21,100,1000   采样长度（默认见左）
 *   --multiplier N                  代码区域倍数（默认 1，即块外口径）
 *   --min-unit N --max-unit N       判定范围（默认 1–1000，与设置页范围一致）
 *   --base N                        模块不可用时的基础阈值（默认 10）
 *   --timeout MS                    子进程墙钟上限（默认 5000）
 *   --allow-read DIR                额外放行的读取目录（可重复）
 *   --unsafe                        不开权限模型（模块确实要读自己的配置时用；会打印警告）
 *   --json                          输出原始 JSON（便于接到别的脚本里）
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const runner = path.join(here, 'sandbox-runner.cjs')

const USAGE = `用法: node tools/sandbox-threshold-module.mjs <模块文件> [--lengths 1,2,3,8,21,100,1000]
       [--multiplier N] [--min-unit N] [--max-unit N] [--base N] [--timeout MS]
       [--allow-read DIR]... [--unsafe] [--json]`

function parseArgs(argv) {
  const options = {
    modulePath: null,
    lengths: '1,2,3,8,21,100,1000',
    multiplier: 1,
    minUnit: 1,
    maxUnit: 1000,
    base: 10,
    timeout: 5000,
    allowRead: [],
    unsafe: false,
    json: false,
  }
  const take = (index, name) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(name + ' 缺少取值')
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--lengths') { options.lengths = take(index, arg); index++ } else if (arg === '--multiplier') { options.multiplier = Number(take(index, arg)); index++ } else if (arg === '--min-unit') { options.minUnit = Number(take(index, arg)); index++ } else if (arg === '--max-unit') { options.maxUnit = Number(take(index, arg)); index++ } else if (arg === '--base') { options.base = Number(take(index, arg)); index++ } else if (arg === '--timeout') { options.timeout = Number(take(index, arg)); index++ } else if (arg === '--allow-read') { options.allowRead.push(path.resolve(take(index, arg))); index++ } else if (arg === '--unsafe') { options.unsafe = true } else if (arg === '--json') { options.json = true } else if (arg === '--help' || arg === '-h') { options.help = true } else if (arg.startsWith('--')) { throw new Error('未知选项：' + arg) } else if (options.modulePath === null) { options.modulePath = arg } else { throw new Error('多余的参数：' + arg) }
  }
  return options
}

function fail(message, code) {
  process.stderr.write('错误：' + message + '\n' + USAGE + '\n')
  process.exit(code)
}

const SENTINEL = '<<<DUPGUARD-SANDBOX-JSON>>>'

function runChild(options, modulePath) {
  // 读取白名单：插件自身（require lib/index.js 与其依赖）+ 模块所在目录 + 用户追加目录。
  const readRoots = [pluginRoot, path.dirname(modulePath), ...options.allowRead]
  const args = [runner, modulePath, options.lengths, String(options.multiplier), String(options.minUnit), String(options.maxUnit), String(options.base)]
  if (!options.unsafe) {
    args.unshift(
      '--permission',
      ...readRoots.map((root) => '--allow-fs-read=' + path.join(root, '*')),
    )
  }
  args.unshift('--max-old-space-size=256')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: options.timeout,
      killSignal: 'SIGKILL',
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ outcome: 'spawn-error', error: error.message, stdout, stderr }))
    child.on('close', (code, signal) => {
      if (signal !== null) return resolve({ outcome: 'killed', signal, stdout, stderr })
      if (code !== 0) return resolve({ outcome: 'crash', code, stdout, stderr })
      // 哨兵之前的都是模块/子进程自己的输出，之前之后的才是结果。
      const cut = stdout.lastIndexOf(SENTINEL)
      const moduleLog = (cut === -1 ? stdout : stdout.slice(0, cut)).trim()
      if (cut === -1) return resolve({ outcome: 'bad-output', moduleLog, stdout, stderr })
      try {
        return resolve({ outcome: 'ok', parsed: JSON.parse(stdout.slice(cut + SENTINEL.length)), moduleLog, stdout, stderr })
      } catch (_parseError) {
        return resolve({ outcome: 'bad-output', moduleLog, stdout, stderr })
      }
    })
  })
}

function render(result, options) {
  const lines = []
  const sandbox = options.unsafe
    ? '⚠ 未启用权限模型（--unsafe）：模块可写文件、起子进程、读任意路径'
    : '权限模型已启用（读：模块目录 + 插件目录' + (options.allowRead.length > 0 ? ' + ' + options.allowRead.join(' + ') : '') + '；写/子进程：禁止；网络：不受限）'
  lines.push('模块：' + result.modulePath)
  lines.push('沙箱：' + sandbox)
  lines.push('限制：墙钟 ' + String(options.timeout) + ' ms｜堆 256 MB｜采样长度 ' + options.lengths + '｜倍数 ' + String(options.multiplier))
  if (!options.unsafe) {
    lines.push('自证：受控子进程写文件' + (result.sandbox.writableDenied === true ? '被拒 ✓（沙箱生效）' : '竟然成功 ✗（沙箱未生效，请检查 Node 版本 ≥ 20）'))
  }
  if (result.error !== null && result.error !== undefined) {
    lines.push('结果：加载/构建失败 — ' + result.error)
    return { text: lines.join('\n'), verdict: 'FAIL' }
  }
  lines.push('加载：成功（repeatCount 已解析）')
  lines.push('')
  lines.push('长度'.padEnd(8) + '原始返回'.padEnd(14) + '合法'.padEnd(6) + '生效次数'.padEnd(10) + '说明')
  let invalid = 0
  let disabled = 0
  for (const sample of result.samples) {
    const raw = sample.rawError !== null ? '抛错：' + sample.rawError : String(sample.raw) + ' (' + sample.rawType + ')'
    const note = sample.rawError !== null
      ? '该长度调用抛错 → 宿主回退基础阈值'
      : sample.valid
        ? (sample.effective === 0 ? '按代码倍数缩放后 < 2，该长度不判定' : '-')
        : sample.disabled
          ? '整数 < 2：显式关闭该长度（合法写法）'
          : '返回值非法（需为 2–1000 的整数）→ 该长度不判定'
    if (sample.rawError !== null || (!sample.valid && !sample.disabled)) invalid++
    if ((sample.valid && sample.effective === 0) || sample.disabled) disabled++
    const legal = sample.valid ? '是' : (sample.disabled ? '关闭' : '否')
    lines.push(String(sample.length).padEnd(8) + raw.slice(0, 13).padEnd(14) + legal.padEnd(6) + String(sample.effective).padEnd(10) + note)
  }
  lines.push('')
  lines.push('策略摘要：' + String(result.summary) + (disabled > 0 ? '（含 ' + String(disabled) + ' 个被显式关闭的采样长度）' : ''))
  let verdict = 'PASS'
  if (invalid > 0) verdict = 'WARN'
  if (result.samples.every((sample) => !sample.valid && !sample.disabled)) verdict = 'FAIL'
  lines.push('结论：' + verdict + (verdict === 'PASS'
    ? '（可直接填进设置页的高级模式）'
    : verdict === 'WARN'
      ? '（能加载，但有 ' + String(invalid) + ' 个采样长度返回值非法；这些长度不会被判定）'
      : '（全部采样长度都不可用，等于模块没起作用）'))
  lines.push('提醒：本工具只验证"模块本身"在这套限制下的行为；一旦在宿主里启用高级模式，该文件仍以完整权限运行。')
  return { text: lines.join('\n'), verdict }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message, 2)
  }
  if (options.help) {
    process.stdout.write(USAGE + '\n')
    return
  }
  if (options.modulePath === null) fail('缺少模块文件路径', 2)
  const modulePath = path.resolve(options.modulePath)
  if (!existsSync(modulePath)) fail('模块文件不存在：' + modulePath, 2)
  if (!statSync(modulePath).isFile()) fail('模块路径不是文件：' + modulePath, 2)

  const run = await runChild(options, modulePath)
  if (run.outcome !== 'ok') {
    const detail = run.outcome === 'killed'
      ? '子进程被强杀（' + String(run.signal) + '）——通常是死循环或超出 ' + String(options.timeout) + ' ms；也可能是内存超限'
      : run.outcome === 'crash'
        ? '子进程异常退出（code ' + String(run.code) + '）'
        : run.outcome === 'bad-output'
          ? '子进程没有输出可解析的结果（哨兵行缺失）'
          : '无法启动子进程：' + String(run.error)
    if (options.json) {
      process.stdout.write(JSON.stringify({ ok: false, outcome: run.outcome, detail, moduleLog: run.moduleLog, stderr: run.stderr.slice(-800) }) + '\n')
    } else {
      process.stdout.write('模块：' + modulePath + '\n结果：' + detail + '\n')
      if (run.moduleLog !== undefined && run.moduleLog !== '') {
        const lines = run.moduleLog.split(/\r?\n/).filter((line) => line.trim() !== '')
        const unique = [...new Set(lines)]
        process.stdout.write('模块自身输出（共 ' + String(lines.length) + ' 行，去重后 ' + String(unique.length) + ' 种）：\n')
        for (const line of unique.slice(0, 5)) process.stdout.write('  ' + line.slice(0, 200) + '\n')
      }
      if (run.stderr.trim() !== '') process.stdout.write('子进程 stderr（末 800 字）：\n' + run.stderr.trim().slice(-800) + '\n')
      process.stdout.write('结论：FAIL（宿主里加载它会有同样的下场，别填进设置页）\n')
    }
    process.exitCode = 3
    return
  }

  const rendered = render(run.parsed, options)
  if (options.json) process.stdout.write(JSON.stringify({ ...run.parsed, verdict: rendered.verdict, moduleLog: run.moduleLog }) + '\n')
  else {
    process.stdout.write(rendered.text + '\n')
    if (run.moduleLog !== undefined && run.moduleLog !== '') {
      // 模块自己的 console.log：既可能是噪声，也可能是"越权被拒"的证据，单独展示并去重。
      const lines = run.moduleLog.split(/\r?\n/).filter((line) => line.trim() !== '')
      const unique = [...new Set(lines)]
      process.stdout.write('模块自身输出（共 ' + String(lines.length) + ' 行，去重后 ' + String(unique.length) + ' 种）：\n')
      for (const line of unique.slice(0, 5)) process.stdout.write('  ' + line.slice(0, 200) + '\n')
      if (unique.length > 5) process.stdout.write('  …（其余 ' + String(unique.length - 5) + ' 种省略）\n')
    }
  }
  process.exitCode = rendered.verdict === 'FAIL' ? 1 : 0
}

main().catch((error) => fail(error && error.message ? error.message : String(error), 2))
