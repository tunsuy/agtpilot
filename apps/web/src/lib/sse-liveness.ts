/**
 * SSE 连接活性判定(纯函数,便于单测)。
 *
 * 背景:TCP 连接可以「断了一半」——客户端侧仍显示 ESTABLISHED、EventSource
 * 不触发 onerror,自动重连永远不发生;而服务端广播的事件全部落空。生产实测:
 * 续聊进行到一半连接假死,工具卡/最终答复/完成态一个没送达,页面冻在最后
 * 一帧,顶部「正在处理…」的本地计时还在空转。
 *
 * 服务端每 25s 发一帧具名 ping 事件(见 /api/agent/events 心跳),客户端
 * 记录最近一次收到心跳的时间;超过阈值没有任何心跳 → 判定假死,主动
 * close + 重建连接,重连后 init 事件全量重同步,冻结的会话自动追平。
 */

/** 服务端心跳间隔(与 events route 的 setInterval 保持一致) */
export const SSE_HEARTBEAT_MS = 25_000;

/** 静默判定阈值:约 2 个心跳周期无任何帧 → 假死(留足抖动余量,避免 GC 暂停误杀) */
export const SSE_STALE_MS = 60_000;

/**
 * 是否应重建连接。只在 readyState === OPEN 且超时静默时判定假死:
 * CONNECTING 状态 EventSource 自带退避重试,不掺和;CLOSED 是主动关闭。
 */
export function isZombieSse(opts: {
  readyState: number;
  lastAliveAt: number;
  now?: number;
  staleMs?: number;
}): boolean {
  if (opts.readyState !== 1 /* EventSource.OPEN */) return false;
  const now = opts.now ?? Date.now();
  return now - opts.lastAliveAt > (opts.staleMs ?? SSE_STALE_MS);
}
