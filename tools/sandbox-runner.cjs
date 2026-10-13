'use strict'
/**
 * 沙箱试运行的内层脚本：**只在受限子进程里运行**，由 tools/sandbox-threshold-module.mjs 启动。
 *
 * 它复用插件的真实加载与判次代码（lib/index.js 的 __advanced），因此打印出来的
 * "生效次数"与宿主将来真正采用的值同源，而不是另写一套近似逻辑。
 *
 * 用法（由外层脚本拼装，不建议手敲）：
 *   node --permission --allow-fs-read=... tools/sandbox-runner.cjs <模块文件> <采样长度,逗号分隔> [倍数] [minUnit] [maxUnit] [基础阈值]
 */
const path = require('node:path')

const plugin = require(path.join(__dirname, '..', 'lib', 'index.js'))
const { loadAdvancedModule, createThresholdPolicy, describePolicy, isValidNeed } = plugin.__advanced

const modulePath = process.argv[2]
const samples = String(process.argv[3] || '1,2,3,8,21,100,1000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const multiplier = Number(process.argv[4] || '1')
const minUnitLength = Number(process.argv[5] || '1')
const maxUnitLength = Number(process.argv[6] || '1000')
const baseThreshold = Number(process.argv[7] || '10')

const result = {
  ok: false,
  stage: 'load',
  modulePath,
  error: null,
  sandbox: {
    permissionModel: process.permission !== undefined,
    // 受限子进程里我们**没有**开任何写权限：能写就说明沙箱被绕过了。
    writableDenied: null,
  },
  samples: [],
  summary: null,
  rows: [],
}

// 自证沙箱生效：试图写一个临时文件，被拒即为预期。
try {
  require('node:fs').writeFileSync(path.join(require('node:os').tmpdir(), 'dupguard-sandbox-probe.txt'), 'probe')
  result.sandbox.writableDenied = false
} catch (_writeError) {
  result.sandbox.writableDenied = true
}

const loaded = loadAdvancedModule(modulePath)

/** JSON 结果必须在最后，且带哨兵行：模块自己可能往 stdout 打日志，不能污染解析。 */
const SENTINEL = '\n<<<DUPGUARD-SANDBOX-JSON>>>'
const emit = (value) => {
  process.stdout.write(SENTINEL + JSON.stringify(value))
}

if (loaded.error !== null) {
  result.error = loaded.error
  emit(result)
  process.exitCode = 0
  return
}
result.stage = 'run'

const runtime = {
  thresholdMode: 'module',
  advancedThresholdFile: modulePath,
  threshold: baseThreshold,
  minUnitLength,
  maxUnitLength,
  thresholdByLength: '',
}
const policy = createThresholdPolicy(runtime, multiplier)
if (policy === undefined) {
  result.error = '策略构建失败（模块抛错或返回值全部非法），宿主会回退基础阈值 ' + String(baseThreshold)
  emit(result)
  process.exitCode = 0
  return
}

for (const length of samples) {
  let raw
  let rawError = null
  try {
    // 直接调用模块本体，看它"原始返回"是什么（与策略里的合法化结果对照）
    raw = loaded.fn(length)
  } catch (error) {
    rawError = error && error.message ? error.message : String(error)
  }
  const effective = policy.counts[length]
  // 插件语义：整数 2–1000 才算"有效次数"；整数 < 2 是**显式关闭该长度**（合法写法）；
  // 其余（字符串 / 小数 / >1000 / NaN）才是非法返回值，同样不判定。
  const disabled = Number.isInteger(raw) && raw < 2
  result.samples.push({
    length,
    raw: raw === undefined ? null : raw,
    rawType: typeof raw,
    rawError,
    valid: rawError === null && isValidNeed(raw),
    disabled,
    effective: effective === undefined ? 0 : effective,
  })
}
result.summary = describePolicy(policy, runtime)
result.ok = true
emit(result)
