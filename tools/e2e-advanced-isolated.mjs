#!/usr/bin/env node
/**
 * **完整的高级模式隔离测试**（一键）：在完全独立的 `DSH_HOME` 里跑三个用例，核对预期结论。
 *
 *   npm run e2e:isolated
 *   npm run e2e:isolated -- --dsh-home D:\path\to\iso-home --profile advtest
 *
 * 三个用例（都经过真实适配器 + 真实 agent loop + 真实 llm/stream，模型侧是本地假模型，无凭据、零 token）：
 *   ① 合法模块           —— 模块的返回值决定截停次数（长度 1 → 20 次）
 *   ② 加载期抛错的模块   —— 宿主打印「高级模式不可用」，回退基础阈值（10 次）
 *   ③ 导出非函数的模块   —— 同上
 *
 * 前置（脚本会检查并给出修复命令，不会替你改动你的环境）：
 *   · 存在独立 home：<dsh-home>\profiles\<profile>\  且该 profile 装了 dsh-dupguard
 *   · 该 profile 的 bundles 里有 @deepseek-ai/dsh-base 与 @deepseek-ai/dsh-headless（一次性运行）
 *   · 被测模块文件存在（默认用一次性工作区里的 repeat-count.cjs）
 *
 * 危险用例（死循环、越权读写）**故意不在此套件里**：它们在真实宿主里会卡死或真的得手，
 * 由第 1 层的沙箱工具（npm run sandbox:selftest）覆盖。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const harness = path.join(here, 'e2e-mock-repetition.mjs')
const samples = path.join(here, 'sandbox-modules')

const argv = process.argv.slice(2)
const options = {
  dshHome: 'D:\\ZQH260619\\repos\\dupguard-advtest-home',
  profile: 'advtest',
  goodModule: 'D:\\ZQH260619\\repos\\dupguard-advtest\\repeat-count.cjs',
  unit: '·',
  count: 400,
}
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]
  if (arg === '--dsh-home') { options.dshHome = argv[++index] } else if (arg === '--profile') { options.profile = argv[++index] } else if (arg === '--module') { options.goodModule = argv[++index] } else if (arg === '--unit') { options.unit = argv[++index] } else if (arg === '--count') { options.count = Number(argv[++index]) } else if (arg === '--help' || arg === '-h') { console.log('见文件头部注释'); process.exit(0) } else { console.error('未知参数：' + arg); process.exit(2) }
}

const profileDir = path.join(options.dshHome, 'profiles', options.profile)
if (!existsSync(path.join(profileDir, 'package.json'))) {
  console.error('找不到隔离 profile：' + profileDir)
  console.error('修复：\n  $env:DSH_HOME = "' + options.dshHome + '"\n  dsh plugin --profile ' + options.profile + ' add file:D:/ZQH260619/repos/DuplicationPrevention')
  process.exit(1)
}

const CASES = [
  { name: '① 合法模块（长度 1 → 20 次）', module: options.goodModule, expectModule: true, expectFallback: false, expectFinal: 20 },
  { name: '② 加载期抛错 → 回退基础阈值 10', module: path.join(samples, 'trap-throw-on-load.cjs'), expectModule: false, expectFallback: true, expectFinal: 10 },
  { name: '③ 导出非函数 → 回退基础阈值 10', module: path.join(samples, 'trap-not-a-function.cjs'), expectModule: false, expectFallback: true, expectFinal: 10 },
]

const rows = []
let failed = 0
for (const testCase of CASES) {
  const run = spawnSync(process.execPath, [
    harness,
    '--dsh-home', options.dshHome,
    '--profile', options.profile,
    '--module', testCase.module,
    '--count', String(options.count),
    '--unit', options.unit,
    '--json',
  ], { encoding: 'utf8', timeout: 180000 })
  let parsed = null
  try {
    parsed = JSON.parse(String(run.stdout || '').trim().split(/\r?\n/).filter((line) => line.startsWith('{')).pop() || 'null')
  } catch (_error) { parsed = null }
  const problems = []
  if (parsed === null) problems.push('没有拿到结构化结果（退出码 ' + String(run.status) + '）')
  else {
    if (parsed.ok !== true) problems.push('未观察到截停')
    const moduleEffective = String(parsed.detectedMode) === 'module'
    if (moduleEffective !== testCase.expectModule) problems.push('策略=' + String(parsed.detectedMode) + '（期望 ' + (testCase.expectModule ? 'module' : '回退后的固定阈值') + '）')
    if (parsed.fallbackToBaseThreshold !== testCase.expectFallback) problems.push('回退标记=' + String(parsed.fallbackToBaseThreshold) + '（期望 ' + String(testCase.expectFallback) + '）')
    if (Number(parsed.finalUnits) !== testCase.expectFinal) problems.push('最终消息 ' + String(parsed.finalUnits) + ' 份（期望 ' + String(testCase.expectFinal) + '）')
    if (Number(parsed.exitCode) !== 0) problems.push('子进程退出码 ' + String(parsed.exitCode))
  }
  if (problems.length > 0) failed++
  rows.push({
    name: testCase.name,
    module: path.basename(testCase.module),
    strategy: parsed === null ? '?' : String(parsed.detectedMode),
    final: parsed === null ? '?' : String(parsed.finalUnits),
    fallback: parsed === null ? '?' : (parsed.fallbackToBaseThreshold ? '是' : '否'),
    result: problems.length === 0 ? 'PASS' : 'FAIL',
    problems,
  })
}

console.log('隔离 home : ' + options.dshHome)
console.log('profile   : ' + options.profile + '（假模型提供 400 份「' + options.unit + '」重复文本，真实适配器/回路/瀑布）')
console.log('')
for (const row of rows) {
  console.log(row.result + '  ' + row.name.padEnd(30) + '模块=' + row.module.padEnd(28) + '策略=' + row.strategy.padEnd(8) + '最终消息=' + row.final.padEnd(4) + '回退=' + row.fallback)
  for (const problem of row.problems) console.log('      → ' + problem)
}
console.log('')
console.log(failed === 0
  ? '结论：PASS — 三项都在完全隔离的 home 里跑通（模块生效 + 两种坏模块回退）'
  : '结论：FAIL — ' + String(failed) + ' / ' + String(rows.length) + ' 项未达预期')
process.exitCode = failed === 0 ? 0 : 1
