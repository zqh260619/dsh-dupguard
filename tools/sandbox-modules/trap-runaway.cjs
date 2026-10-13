/**
 * 样例 3：陷阱——死循环。用来验证沙箱的墙钟超时确实能把子进程掐断。
 * 在真实宿主里加载这个模块＝宿主的 LLM 流处理线程直接卡死（同步阻塞事件循环）。
 */
module.exports = function repeatCount() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 故意空转
  }
}
