#!/usr/bin/env node
/**
 * 无凭据、确定性的端到端测试：假模型吐出**重复文本** → 真实 DSH 宿主 → dupguard 截停。
 *
 * 为什么这样做（而不是用 `@deepseek-ai/dsh-llm-mock-server`）：
 *   本版 DSH 的 DeepSeek 适配器走 **Anthropic Messages 协议**（`<base>/v1/messages`，
 *   `protocol` 不可配置），而那个 mock 包只服务 OpenAI 的 `/chat/completions`
 *   ⇒ 两者对不上（实测：适配器打到 mock 上直接 404）。所以这里内置一个极小的
 *   Messages-SSE 假模型：确定性、无 API key、不花 token，且仍然经过**真实适配器 +
 *   真实 agent loop + 真实 llm/stream 瀑布**——这正是要验证的那条链路。
 *
 * 用法：
 *   node tools/e2e-mock-repetition.mjs                          # 默认 profile: headless
 *   node tools/e2e-mock-repetition.mjs --profile advtest --count 400 --unit ·
 *   node tools/e2e-mock-repetition.mjs --json                   # 机器可读
 *
 * 判定：假模型准备吐 `--count` 份重复文本，而最终助手消息里的份数**明显更少**，
 *       且子进程 stderr 出现 dupguard 的「生效参数」行 ⇒ 截停确实发生在真实流里。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const options = {
  profile: 'headless',
  unit: '·',
  count: 400,
  task: '忽略本任务即可（本次由假模型直接返回脚本内容）',
  timeoutMs: 120000,
  chunkDelayMs: 2,
  json: false,
}
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]
  if (arg === '--profile') { options.profile = argv[++index] } else if (arg === '--unit') { options.unit = argv[++index] } else if (arg === '--count') { options.count = Number(argv[++index]) } else if (arg === '--task') { options.task = argv[++index] } else if (arg === '--timeout') { options.timeoutMs = Number(argv[++index]) } else if (arg === '--delay') { options.chunkDelayMs = Number(argv[++index]) } else if (arg === '--json') { options.json = true } else if (arg === '--help' || arg === '-h') { console.log('见文件头部注释'); process.exit(0) } else { console.error('未知参数：' + arg); process.exit(2) }
}

const countOf = (text, unit) => text.split(unit).length - 1

/** Anthropic Messages 协议的 SSE 假模型：每个请求吐 count 份 unit。 */
function startMessagesStub({ unit, count, chunkDelayMs }) {
  const stats = { requests: 0, deltasWritten: 0, clientAborted: 0 }
  const server = createServer((request, response) => {
    if (!/\/messages$/.test(new URL(request.url, 'http://127.0.0.1').pathname) || request.method !== 'POST') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'stub serves POST <base>/v1/messages only' } }))
      return
    }
    stats.requests++
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (event, data) => response.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
      send('message_start', {
        type: 'message_start',
        message: { id: 'msg_stub', type: 'message', role: 'assistant', model: 'deepseek-chat', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
      })
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      let sent = 0
      let aborted = false
      response.on('close', () => { if (sent < count) { aborted = true; stats.clientAborted++ } })
      const timer = setInterval(() => {
        if (aborted || sent >= count) {
          clearInterval(timer)
          if (!aborted) {
            send('content_block_stop', { type: 'content_block_stop', index: 0 })
            send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: count } })
            send('message_stop', { type: 'message_stop' })
            response.end()
          }
          return
        }
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: unit } })
        sent++
        stats.deltasWritten++
      }, chunkDelayMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        baseURL: 'http://127.0.0.1:' + String(address.port),
        stats,
        close: () => new Promise((done) => { try { server.closeAllConnections() } catch (_error) {} server.close(() => done()) }),
      })
    })
  })
}

let activeStub = null

async function main() {
  const stub = await startMessagesStub({ unit: options.unit, count: options.count, chunkDelayMs: options.chunkDelayMs })
  activeStub = stub

  const env = { ...process.env, DEEPSEEK_BASE_URL: stub.baseURL, DEEPSEEK_API_KEY: 'stub-key' }
  // 关键：清掉从当前 DSH 会话继承的变量，否则插件会读到**另一个 profile** 的设置。
  for (const name of ['DSH_PROFILE_DIR', 'DSH_PROFILE', 'DSH_SESSION_ID', 'DSH_WEB_URL']) delete env[name]

  const configured = process.env.DSH_BIN
  const shim = configured !== undefined && configured !== ''
    ? configured
    : (process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd') : 'dsh')
  const bin = existsSync(shim) ? shim : 'dsh'
  // Windows 的 .cmd 垫片不能直接 spawn（EINVAL），但也不要用 shell:true（Node 会报 DEP0190）
  // ⇒ 显式经由 cmd.exe，并让 Node 原样传递参数。
  const spawnTarget = process.platform === 'win32' && bin.endsWith('.cmd')
    ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + bin + '"', ...[]] }
    : { command: bin, args: [] }
  const childArgs = ['--profile', options.profile, '--json', options.task]
  const child = spawn(
    spawnTarget.command,
    spawnTarget.command.toLowerCase().endsWith('cmd.exe')
      ? ['/d', '/s', '/c', '"' + bin + '"', ...childArgs]
      : childArgs,
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: spawnTarget.command.toLowerCase().endsWith('cmd.exe') },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch (_error) {} }, options.timeoutMs)
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (status) => resolve(status === null ? -1 : status))
  })
  clearTimeout(timer)

  let finalText = ''
  let streamedText = ''
  let stopReason = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'final' && typeof event.text === 'string') finalText += event.text
      if (typeof event.text === 'string') streamedText += event.text
      if (event.type === 'status' && event.phase === 'turn_end' && event.reason) stopReason = event.reason.kind ?? null
    } catch (_error) {}
  }
  // 插件日志在 --json 模式下走 stdout（普通模式才走 stderr）⇒ 两路都要看。
  const effective = /\[dupguard\] 生效参数：([^\n\r]*)/.exec(stdout + '\n' + stderr)
  const mode = effective === null
    ? null
    : ((/模式=([a-z]+)/.exec(effective[1]) || [])[1] || (/固定阈值 (\d+)/.exec(effective[1]) || [])[1] || 'unknown')
  const streamed = countOf(streamedText, options.unit)
  const final = countOf(finalText, options.unit)
  const seen = Math.max(streamed, final)
  const guardLoaded = effective !== null
  const pass = stub.stats.requests > 0 && guardLoaded && seen > 0 && seen < options.count

  const summary = {
    ok: pass,
    profile: options.profile,
    scriptedUnits: options.count,
    seenUnits: seen,
    streamedUnits: streamed,
    finalUnits: final,
    stubRequests: stub.stats.requests,
    stubDeltasWritten: stub.stats.deltasWritten,
    stubClientAborted: stub.stats.clientAborted,
    guardLoaded,
    detectedMode: mode,
    turnEndReason: stopReason,
    exitCode: code,
    note: pass
      ? '截停生效：假模型准备了 ' + String(options.count) + ' 份重复文本，真实流里只到第 ' + String(seen) + ' 份就停了'
      : (stub.stats.requests === 0
        ? '假模型没收到请求（适配器没指过来？）'
        : (!guardLoaded ? 'dupguard 没加载（该 profile 未安装插件）' : '没有观察到截停')),
  }

  if (options.json) console.log(JSON.stringify(summary))
  else {
    console.log('profile        : ' + summary.profile)
    console.log('假模型脚本     : ' + String(options.count) + ' 份「' + options.unit + '」（收到 ' + String(summary.stubRequests) + ' 个请求，写出 ' + String(summary.stubDeltasWritten) + ' 个 delta，客户端提前断开 ' + String(summary.stubClientAborted) + ' 次）')
    console.log('真实流里看到   : ' + String(seen) + ' 份（流式 ' + String(streamed) + ' / 最终消息 ' + String(final) + '）')
    console.log('dupguard       : ' + (guardLoaded ? '已加载，策略＝' + mode : '未加载'))
    console.log('回合结束原因   : ' + String(stopReason) + '｜子进程退出码 ' + String(code))
    console.log('结论           : ' + (pass ? 'PASS — ' : 'FAIL — ') + summary.note)
    if (!pass) {
      if (stderr.trim() !== '') console.log('子进程 stderr（末 600 字）:\n' + stderr.trim().slice(-600))
      if (stdout.trim() !== '') console.log('子进程 stdout（前 400 字）:\n' + stdout.trim().slice(0, 400))
    }
  }
  process.exitCode = pass ? 0 : 1
}

main()
  .catch((error) => { console.error('失败：' + (error && error.message ? error.message : String(error))); process.exitCode = 1 })
  .finally(async () => {
    if (activeStub !== null) {
      try { await activeStub.close() } catch (_error) {}
    }
  })
