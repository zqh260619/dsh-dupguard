/**
 * 样例 7：陷阱——导出不是函数（导出字符串）。
 * 插件规则：`module.exports = fn` 或 `exports.repeatCount = fn` 才算合法；
 * 否则视为"模块不可用"，告警一次并回退基础阈值。
 */
module.exports = 'not a function'
