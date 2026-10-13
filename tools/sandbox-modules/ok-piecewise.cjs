/**
 * 样例 1：合法——按单元长度给次数的分段函数（与作者设置页里的分段表等价）。
 * 长单元少重复几次即截停，短单元多重复几次才算复读。
 */
module.exports = function repeatCount(length) {
  if (length <= 1) return 20
  if (length <= 2) return 15
  if (length <= 10) return 10
  if (length <= 20) return 5
  return 3
}
