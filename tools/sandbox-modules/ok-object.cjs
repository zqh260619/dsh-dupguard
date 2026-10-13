/**
 * 样例 2：合法——用 exports.repeatCount 导出（插件同时接受 module.exports = fn 与 exports.repeatCount）。
 * 返回值的合法区间是 2–1000 的整数；< 2 表示"该长度不判定"。
 */
exports.repeatCount = (length) => {
  // 单字符循环要求 30 次，其余一律 8 次
  return length <= 1 ? 30 : 8
}
