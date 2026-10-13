#!/usr/bin/env node
/**
 * 沙箱工具的自检：把 tools/sandbox-modules/ 下每个样例跑一遍，核对**预期结论**，
 * 并验证权限隔离确实生效（越权样例必须三样齐全地被拒）。
 *
 * 用途：① 本机确认沙箱没被 Node 版本升级悄悄削弱；② CI 里作为一道独立关卡。
 * 用法：npm run sandbox:selftest
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, 'sandbox-threshold-module.mjs')
const modules = path.join(here, 'sandbox-modules')

const CASES = [
  { file: 'ok-piecewise.cjs', verdict: 'PASS', exit: 0, note: '分段函数：合法且覆盖全长度' },
  { file: 'ok-object.cjs', verdict: 'PASS', exit: 0, note: 'exports.repeatCount 导出形态' },
  { file: 'trap-invalid.cjs', verdict: 'WARN', exit: 0, note: '字符串/小数/超上限被识别为非法' },
  { file: 'trap-throw-on-load.cjs', verdict: 'FAIL', exit: 1, note: '加载期抛错' },
  { file: 'trap-runaway.cjs', verdict: 'KILLED', exit: 3, note: '死循环被墙钟超时掐断', timeout: 2000 },
  { file: 'trap-hostile.cjs', verdict: 'PASS', exit: 0, note: '越权被拒但仍能返回合法次数', expectDenials: true },
]

let failed = 0
for (const testCase of CASES) {
  const args = [tool, path.join(modules, testCase.file), '--json', '--lengths', '1,2,3,8,21,100,1000']
  if (testCase.timeout !== undefined) args.push('--timeout', String(testCase.timeout))
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 })
  const stdout = String(run.stdout || '')
  const stderr = String(run.stderr || '')
  const exit = run.status === null ? -1 : run.status
  let parsed = null
  try {
    parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter((line) => line.startsWith('{')).pop() || 'null')
  } catch (_error) {
    parsed = null
  }
  const actualVerdict = parsed === null
    ? 'KILLED'
    : (typeof parsed.verdict === 'string' ? parsed.verdict : (parsed.outcome === 'killed' ? 'KILLED' : 'FAIL'))
  const problems = []
  if (actualVerdict !== testCase.verdict) problems.push('结论=' + String(actualVerdict) + '（期望 ' + testCase.verdict + '）')
  if (exit !== testCase.exit) problems.push('退出码=' + String(exit) + '（期望 ' + String(testCase.exit) + '）')
  if (testCase.expectDenials === true) {
    const log = String(parsed === null ? '' : parsed.moduleLog || '')
    for (const needle of ['写文件：被拒', '子进程：被拒', '读 C:/Windows：被拒']) {
      if (!log.includes(needle)) problems.push('缺少拒绝证据：' + needle)
    }
    if (log.includes('沙箱没拦住')) problems.push('沙箱未生效：模块越权成功了')
  }
  if (parsed !== null && parsed.ok === true && parsed.sandbox !== undefined && parsed.sandbox.writableDenied !== true && testCase.verdict !== 'KILLED') {
    problems.push('子进程竟然可以写文件（沙箱未生效）')
  }
  const mark = problems.length === 0 ? 'OK  ' : 'FAIL'
  if (problems.length > 0) failed++
  console.log(mark + ' ' + testCase.file.padEnd(24) + testCase.note + (problems.length === 0 ? '' : '\n     → ' + problems.join('；')))
  if (problems.length > 0 && stderr.trim() !== '') console.log('     stderr: ' + stderr.trim().slice(0, 300))
}

console.log(failed === 0
  ? '沙箱自检：全部通过（' + String(CASES.length) + ' 个样例，含越权拦截证据）'
  : '沙箱自检：失败 ' + String(failed) + ' / ' + String(CASES.length))
process.exitCode = failed === 0 ? 0 : 1
