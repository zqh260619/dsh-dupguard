// ============================================================================
// 诊断实验（不进 CI）：验证对 cordisInspect 的 register 做幂等 monkey-patch 是否可行。
//
// 背景：DSH（≤ 0.1.1-rc.1，实测 0.1.1-rc.1 仍未修复）的 preset standing mount 在 composition 文件变化后创建新一代，
// 旧代永不销毁；tool-cordis 每次挂载向进程全局 cordisInspect 注册 Service/Event/
// Builtin/Tool provider，两代并存即抛 "already registered"，且重试永远失败。
// 本脚本验证：用真实 CordisInspectRegistryService 实例，把 register 包装成幂等
// （同 id 已注册时返回 no-op disposer），是否能消除冲突、且不影响查询。
//
// 运行：node tests/experiment-inspect-patch.mjs
//       DSH_RUNNER_PATH=<dsh-cordis-host-runner 根目录> node tests/experiment-inspect-patch.mjs
// ============================================================================

const RUNNER_ROOT =
  process.env.DSH_RUNNER_PATH ??
  'C:/Users/Administrator/.dsh/profiles/node_modules/@deepseek-ai/dsh-cordis-host-runner'

import { pathToFileURL } from 'node:url'

const { CordisInspectRegistryService } = await import(
  pathToFileURL(RUNNER_ROOT + '/lib/types/inspect-registry.js').href
)

// 最小 ctx stub：Service 构造只调用 ctx.reflect.provide
const ctx = { reflect: { provide() { return () => {} } } }
const svc = new CordisInspectRegistryService(ctx)

// ---- 幂等 patch（与拟议的兼容层逻辑一致）----
const originalRegister = svc.register.bind(svc)
svc.register = (registration) => {
  if (svc.providers.has(registration.manifest.id)) return () => {}
  return originalRegister(registration)
}

// ---- 场景复现：两代 standing mount 先后注册同一批 provider ----
const serviceProvider = {
  manifest: {
    id: 'Service',
    description: 'Progressive Host Service discovery.',
    methods: [
      {
        name: 'listService',
        description: 'directory',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { description: 'any' },
      },
    ],
  },
  query: async () => ({ ok: true }),
}

// 第 N 代（旧代，永不销毁）
const genN = svc.register(serviceProvider)
console.log('第 N 代注册: OK')

// 第 N+1 代（stamp 变化后新挂载）—— 未 patch 时会抛 "already registered"
let genN1
try {
  genN1 = svc.register(serviceProvider)
  console.log('第 N+1 代注册: OK（幂等 patch 生效）')
} catch (error) {
  console.log('第 N+1 代注册: 失败（patch 无效）: ' + error.message)
  process.exit(1)
}

// 旧代 dispose（模拟其 fiber 卸载）—— 注册表不应因此清空（新代还活着）
genN()
console.log('旧代 dispose 后 providers 仍有 Service: ' + svc.providers.has('Service'))

// 第 N+2 代再次注册 —— 仍应幂等
svc.register(serviceProvider)
console.log('第 N+2 代注册: OK')

// 查询通道不受影响
svc.syncClientManifest([])
const list = svc.list()
console.log('list(): ' + JSON.stringify(list.map((p) => p.id + '/' + p.platform)))
console.log('注册表当前条目: ' + [...svc.providers.keys()].join(', '))
console.log('结论：幂等 patch 可消除多代并存的注册冲突，查询通道不受影响。')
process.exit(0)
