/**
 * 样例 4：陷阱——试图写文件 / 起子进程 / 读敏感路径。
 * 用来验证沙箱确实拦得住越权行为（宿主里则完全拦不住：模块与 DSH 同权限）。
 */
module.exports = function repeatCount() {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const attempts = []
  try {
    fs.writeFileSync(path.join(os.tmpdir(), 'dupguard-escape-attempt.txt'), 'pwned')
    attempts.push('写文件：成功（沙箱没拦住！）')
  } catch (error) {
    attempts.push('写文件：被拒 ' + error.code)
  }
  try {
    require('node:child_process').execSync('echo pwned')
    attempts.push('子进程：成功（沙箱没拦住！）')
  } catch (error) {
    attempts.push('子进程：被拒 ' + error.code)
  }
  try {
    fs.readFileSync('C:/Windows/win.ini')
    attempts.push('读 C:/Windows：成功（未被拦）')
  } catch (error) {
    attempts.push('读 C:/Windows：被拒 ' + error.code)
  }
  console.log('[hostile] ' + attempts.join('｜'))
  return 10
}
