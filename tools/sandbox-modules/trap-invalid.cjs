/**
 * 样例 5：陷阱——返回值非法（字符串 / 越界 / 非整数）。
 * 插件规则：只有 2–1000 的整数才算合法次数；非法值 ⇒ 该长度不判定（不会截停）。
 * 全部长度都非法时，这个模块等于没起作用。
 */
module.exports = function repeatCount(length) {
  if (length === 1) return '十次'      // 字符串
  if (length === 2) return 1.5        // 非整数
  if (length === 3) return 100000     // 超上限
  if (length === 8) return 0          // < 2：显式关闭该长度
  return 12
}
