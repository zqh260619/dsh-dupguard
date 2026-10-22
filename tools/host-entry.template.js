// ============================================================================
// dupguard —— DSH 动态 Cordis 插件（Host 端）
//
// ⚠ 本文件由 tools/build-host.mjs 生成，请勿手改。
//   检测逻辑在 lib/engine.js（单源实现）：修改后运行 `npm run build:host` 重新生成；
//   `npm test` 会校验本文件是否与引擎/模板一致（tools/build-host.mjs --check）。
//
// 实时检测大模型流式输出中的重复内容：当最新的输出中同一字符串连续重复
// CONFIG.threshold 次及以上时，立即停止本次生成。
//
// 用法：把整个文件内容作为 cordis_define 的 code.host 传入即可，
//       不需要修改任何 DSH 组合（composition）文件。
// 需要随 DSH 常驻时，请改用 npm/组合形式 lib/index.js（与本文件行为一致，
// tests/detector.test.js 会对两个入口跑同一套用例防止漂移）。
// 安装/运行步骤与配置说明见仓库根目录的 README.md。
//
// 说明：动态插件代码体不能 require 依赖，因此检测引擎在本文件内联；
// 本版本不集成 settings 服务，全部检测参数固定取 DEFAULT_CONFIG。
// npm 常驻版（lib/index.js）会注册设置命名空间并提供 Web 设置页（lib/client.js），
// 白名单与检测参数均可动态调整并持久化；两版默认值来自同一份 DEFAULT_CONFIG。
// ============================================================================

/*__ENGINE__*/

/** 动态入口没有设置页：全部参数取代码默认值（与常驻版默认值同源）。 */
const CONFIG = { ...DEFAULT_CONFIG }

/** 表模式下的最大重复单元长度：由表格末行派生（与常驻版同规则）；空表或只有 * 时沿用文档值。 */
const MAX_UNIT_LENGTH = (() => {
  if (CONFIG.thresholdMode !== 'table') return CONFIG.maxUnitLength
  const derived = deriveMaxUnitLength(CONFIG)
  return derived === undefined ? CONFIG.maxUnitLength : derived
})()

/** 生效配置：把派生的最大单元长度体现在策略、窗口与检测三处。 */
const EFFECTIVE = { ...CONFIG, maxUnitLength: MAX_UNIT_LENGTH }

/** 每次 llm/stream 调用使用的策略（动态版 CONFIG 固定，模块加载时构建一次）。 */
const THRESHOLD_POLICY = createThresholdPolicy(EFFECTIVE, 1)
const CODE_THRESHOLD_POLICY = CONFIG.skipCodeBlocks === true && CONFIG.codeBlockMultiplier !== 1
  ? createThresholdPolicy(EFFECTIVE, CONFIG.codeBlockMultiplier)
  : THRESHOLD_POLICY

/** 传给检测引擎的运行时配置（含派生策略）。 */
const HOST_RUNTIME = {
  ...EFFECTIVE,
  thresholdPolicy: THRESHOLD_POLICY,
  codeThresholdPolicy: CODE_THRESHOLD_POLICY,
}

/**
 * 检测窗口（与常驻版同公式，自动派生）：正好等于「最严格的重复跨度」；
 * 动态版没有设置页，因此再取 CONFIG.detectionWindow 与派生值的较大者作为代码级下限。
 */
const DETECTION_WINDOW = Math.max(CONFIG.detectionWindow, deriveWindow(HOST_RUNTIME).value)
HOST_RUNTIME.detectionWindow = DETECTION_WINDOW

return {
  // 测试钩子：暴露派生常量，供「跨实现一致性」用例与常驻版/客户端比对（运行时无副作用）。
  __derived: { detectionWindow: DETECTION_WINDOW, maxUnitLength: MAX_UNIT_LENGTH },
  apply(ctx) {
    if (CONFIG.fixStandingMountConflict) installStandingMountPatch(ctx.get('cordisInspect'))
    // llm/stream：包裹每次流式模型调用的瀑布事件。
    // 监听器返回包装后的 AsyncIterable，即成为本次调用对消费方可见的流。
    // （与 @deepseek-ai/dsh-llm 的 invariant、dsh-session-checkpoint-policy 同款接入方式）
    ctx.on('llm/stream', (options, next) => createStreamGuard(options, HOST_RUNTIME)(next()))
  },
}
