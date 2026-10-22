'use strict'
/**
 * 压力套件共用的报告辅助（ok / bad / metric / test + 统一 summary）。
 *
 * 三个压力套件此前各自复制了一份 ok/bad/metric；收敛到这里，保证：
 *   - 输出格式一致（CI 与人工排查按同样格式读）；
 *   - 退出码语义一致（有失败 → exit code 1，由调用方在 summary 中设置）。
 */

function createReport() {
  let passed = 0
  let failed = 0
  const failures = []

  const ok = (label) => {
    passed++
    console.log('  ✓ ' + label)
  }
  const bad = (label, detail) => {
    failed++
    failures.push(label + '：' + detail)
    console.log('  ✗ FAIL ' + label + '：' + detail)
  }
  const metric = (name, value, unit) => console.log('METRIC ' + name + ' ' + String(value) + ' ' + unit)
  const test = async (name, fn) => {
    try {
      await fn()
      ok(name)
    } catch (error) {
      bad(name, error && error.message ? error.message : String(error))
    }
  }

  /**
   * 打印统一结尾并设置退出码。
   * @param options.passedLine - 是否打印「用例：通过 N 项，失败 M 项」与失败明细
   *   （对抗性套件需要明细；吞吐/客户端压力套件只需要 RESULT 行）。
   */
  const summary = (options) => {
    const passedLine = options !== undefined && options !== null && options.passedLine === true
    console.log('')
    if (passedLine) {
      console.log('用例：通过 ' + String(passed) + ' 项，失败 ' + String(failed) + ' 项')
      if (failures.length > 0) {
        console.log('失败明细：')
        for (const line of failures) console.log('  - ' + line)
      }
    }
    console.log('RESULT ' + (failed === 0 ? 'PASS' : 'FAIL'))
    if (failed > 0) process.exitCode = 1
  }

  return {
    ok,
    bad,
    metric,
    test,
    summary,
    get passed() {
      return passed
    },
    get failed() {
      return failed
    },
    failures,
  }
}

module.exports = { createReport }
