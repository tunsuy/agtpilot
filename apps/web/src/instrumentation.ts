export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { getAgentBackend } = await import('@/lib/agent-backend');
      const backend = getAgentBackend();
      backend.initCronScheduler();
      // 番茄自动同步 sweeper(P2):15min 周期把 book.json 落盘意图翻回队列
      // (进程重启恢复 / 限频跨天续传 / 章节失败冷却重试);与 cron 调度器并列
      const { ensureFanqieSyncSweeper } = await import('@/lib/fanqie-sync');
      ensureFanqieSyncSweeper();
      // 程序运行日志(runtime.log)在此落首条:数据目录一旦可写,后续所有
      // 生命周期/错误事件都有档可查(容器重建后凭这行确认日志链路活着)
      const { logRuntime } = await import('@/lib/runtime-log');
      logRuntime('INFO', 'server', 'AgtPilot runtime started, cron scheduler registered.');
      console.log('[Instrumentation] AgtPilot background cron scheduler registered.');
    } catch (err) {
      console.error('[Instrumentation] Failed to register cron scheduler:', err);
    }
  }
}
