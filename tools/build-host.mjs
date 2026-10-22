#!/usr/bin/env node
/**
 * 从单源检测引擎生成动态入口 plugin/host.js。
 *
 *   npm run build:host            # 重新生成（写入 plugin/host.js）
 *   npm run build:host -- --check # 校验已提交的 plugin/host.js 是否与引擎/模板一致
 *
 * 背景：动态 Cordis 插件（cordis_define 的 code.host）是一段被 `new Function` 求值的
 * 代码体，不能 require 依赖，因此无法直接 require lib/engine.js；这里在构建期把引擎
 * 内联进模板，保证「检测逻辑只有一份源码（lib/engine.js）」。
 *
 * 生成结果必须满足：
 *   - 不含 module.exports / require（动态代码体没有模块系统）；
 *   - 能被 new Function 编译（与 cordis_define 的加载方式一致）；
 *   - 输出稳定（UTF-8 / LF / 无时间戳），便于 --check 比较。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const enginePath = join(root, 'lib', 'engine.js')
const templatePath = join(root, 'tools', 'host-entry.template.js')
const outputPath = join(root, 'plugin', 'host.js')
const MARKER = '/*__ENGINE__*/'
const EXPORTS_MARKER = '\nmodule.exports = {'

function readNormalized(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

/** 引擎源码 → 可内联进动态代码体的片段（去掉 use strict 与 module.exports）。 */
function engineBody(engineSource) {
  let body = engineSource.replace(/\r\n/g, '\n')
  const exportsAt = body.indexOf(EXPORTS_MARKER)
  if (exportsAt === -1) throw new Error('lib/engine.js 缺少 module.exports 块（生成器无法切分）')
  body = body.slice(0, exportsAt)
  body = body.replace(/^'use strict'\n\n?/, '')
  return body.trimEnd() + '\n'
}

function generate() {
  const engineSource = readNormalized(enginePath)
  const template = readNormalized(templatePath)
  if (!template.includes(MARKER)) throw new Error('模板缺少内联占位符 ' + MARKER)
  let generated = template.replace(MARKER, engineBody(engineSource).trimEnd())
  generated = generated.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'

  if (/\brequire\s*\(/.test(generated)) throw new Error('生成结果包含 require()，动态入口不能依赖模块系统')
  if (generated.includes('module.exports')) throw new Error('生成结果包含 module.exports，动态入口不能导出 CommonJS 模块')
  try {
    // 与 cordis_define 的加载方式一致：代码体必须可被 new Function 求值。
    new Function(generated) // eslint-disable-line no-new-func
  } catch (error) {
    throw new Error('生成结果无法被 new Function 求值：' + (error && error.message ? error.message : String(error)))
  }
  return generated
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const generated = generate()
  const existing = existsSync(outputPath) ? readNormalized(outputPath) : null

  if (checkOnly) {
    if (existing === generated) {
      console.log('plugin/host.js 与 lib/engine.js + 模板一致 ✓')
      return
    }
    console.error('plugin/host.js 已过期：请运行 `npm run build:host` 重新生成（不要手改该文件）。')
    const count = Math.max(existing === null ? 0 : existing.length, generated.length)
    let at = 0
    while (existing !== null && at < count && existing[at] === generated[at]) at++
    const from = Math.max(0, at - 120)
    console.error('首次差异位置：' + at)
    console.error('已提交片段：' + JSON.stringify(existing === null ? '<缺失>' : existing.slice(from, at + 120)))
    console.error('生成片段：  ' + JSON.stringify(generated.slice(from, at + 120)))
    process.exitCode = 1
    return
  }

  if (existing === generated) {
    console.log('plugin/host.js 已是最新（无变化）。')
    return
  }
  writeFileSync(outputPath, generated, 'utf8')
  console.log('已生成 plugin/host.js（' + generated.split('\n').length + ' 行，来源 lib/engine.js + tools/host-entry.template.js）。')
}

try {
  main()
} catch (error) {
  console.error('生成失败：' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
}
