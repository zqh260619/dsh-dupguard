#!/usr/bin/env node
/**
 * 文档一致性体检（不依赖第三方包）。
 *
 *   npm run audit:docs
 *
 * 检查：
 *   ① CHANGELOG 版本标题唯一、日期降序；[未发布] 之外每个版本都有 v* tag，
 *      且 tag 内 package.json 版本与标题一致；
 *   ② CHANGELOG 没有重复的 bullet 段落（历史上一次全局替换曾把同一条插入每个版本）；
 *   ③ README / README.en 的「构建 x.y.z」必须等于 lib/client.js 的 BUILD_MARK；
 *   ④ package.json 版本必须等于最新已发布 CHANGELOG 版本；
 *   ⑤ README / client 不再出现错误配置文件名 settings.yaml。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const failures = []
const warnings = []

function fail(message) {
  failures.push(message)
}

function read(relative) {
  try {
    return readFileSync(path.join(root, relative), 'utf8')
  } catch (_error) {
    fail('无法读取 ' + relative)
    return ''
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (_error) {
    return ''
  }
}

const changelog = read('CHANGELOG.md')
const packageJson = JSON.parse(read('package.json'))
const client = read('lib/client.js')
const readmes = ['README.md', 'README.en.md'].map((name) => ({ name, text: read(name) }))

// ---- ① CHANGELOG 版本 / 日期 / tag -----------------------------------------
const sections = []
for (const line of changelog.split(/\r?\n/)) {
  const match = line.match(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?/)
  if (match !== null) sections.push({ version: match[1], date: match[2], line })
}
const released = sections.filter((section) => section.version !== '未发布')
const seen = new Set()
for (const section of released) {
  if (seen.has(section.version)) fail('CHANGELOG 版本重复：' + section.version)
  seen.add(section.version)
  if (section.date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(section.date)) {
    fail('CHANGELOG 版本 ' + section.version + ' 缺少合法日期')
  }
}
for (let i = 1; i < released.length; i += 1) {
  if (released[i].date > released[i - 1].date) {
    fail('CHANGELOG 日期非降序：' + released[i - 1].version + ' ' + released[i - 1].date + ' < ' + released[i].version + ' ' + released[i].date)
  }
}

const gitDir = path.join(root, '.git')
const hasGit = existsSync(gitDir)
if (hasGit) {
  for (const section of released) {
    const tag = 'v' + section.version
    const tagSha = git(['rev-parse', '--verify', 'refs/tags/' + tag])
    if (tagSha === '') {
      // 发版时通常先推送 main、再推送 tag；最新版本的 tag 尚不存在时只告警。
      if (section.version === packageJson.version) {
        warnings.push('最新版本 tag 尚未创建（发版流程中）：' + tag)
      } else {
        fail('CHANGELOG 版本缺少 tag：' + tag)
      }
      continue
    }
    let tagPackage
    try {
      tagPackage = JSON.parse(git(['show', tag + ':package.json']))
    } catch (_error) {
      fail('无法读取 ' + tag + ':package.json')
      continue
    }
    if (tagPackage.version !== section.version) fail('tag ' + tag + ' 的 package.json 版本为 ' + String(tagPackage.version))
    const tagDate = git(['log', '-1', '--format=%ad', '--date=short', tag])
    if (tagDate !== '' && tagDate !== section.date) fail('CHANGELOG ' + section.version + ' 日期 ' + section.date + ' 与 tag 日期 ' + tagDate + ' 不一致')
  }
}

// ---- ② 重复 bullet 段落 ------------------------------------------------------
const paragraphs = []
let current = null
for (const line of changelog.split(/\r?\n/)) {
  if (/^## \[/.test(line) || /^### /.test(line)) {
    if (current !== null) paragraphs.push(current)
    current = null
    continue
  }
  if (line.startsWith('- ')) {
    if (current !== null) paragraphs.push(current)
    current = line
  } else if (current !== null && line.trim() === '') {
    paragraphs.push(current)
    current = null
  } else if (current !== null && /^\s{2,}/.test(line)) {
    current += '\n' + line
  } else if (current !== null) {
    paragraphs.push(current)
    current = null
  }
}
if (current !== null) paragraphs.push(current)
const paragraphCount = new Map()
for (const paragraph of paragraphs) paragraphCount.set(paragraph, (paragraphCount.get(paragraph) || 0) + 1)
for (const [paragraph, count] of paragraphCount) {
  if (count > 1) fail('CHANGELOG 重复 bullet 段落（' + String(count) + ' 次）：' + paragraph.split('\n')[0].slice(0, 100))
}

// ---- ③ README 构建标记 -------------------------------------------------------
const markMatch = client.match(/const BUILD_MARK = '([^']+)'/)
const buildMark = markMatch === null ? null : markMatch[1]
if (buildMark === null) fail('lib/client.js 中找不到 BUILD_MARK')
for (const { name, text } of readmes) {
  const markers = [...text.matchAll(/构建\s+([^\s｜|，,。]+)/g)].map((match) => match[1])
  if (markers.length === 0) fail(name + ' 中找不到「构建 x.y.z」标记')
  for (const marker of markers) if (marker !== buildMark) fail(name + ' 构建标记为 ' + marker + '，BUILD_MARK 为 ' + String(buildMark))
}

// ---- ④ package 版本 = 最新已发布版本 ----------------------------------------
if (released.length > 0 && packageJson.version !== released[0].version) {
  fail('package.json 版本 ' + packageJson.version + ' 不是最新 CHANGELOG 版本 ' + released[0].version)
}

// ---- ⑤ 错误配置文件名 --------------------------------------------------------
if (client.includes('settings.yaml')) fail('lib/client.js 仍包含 settings.yaml')
for (const { name, text } of readmes) if (text.includes('settings.yaml')) fail(name + ' 仍包含 settings.yaml')

if (failures.length > 0) {
  console.error('文档一致性体检失败：')
  for (const failure of failures) console.error('  - ' + failure)
  process.exitCode = 1
} else {
  for (const warning of warnings) console.warn('警告：' + warning)
  console.log('文档一致性体检通过：CHANGELOG 版本/日期/tag、重复段落、README 构建标记、package 版本、配置文件名 ✓')
}
