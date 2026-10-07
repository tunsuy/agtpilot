export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { getAgentBackend } = await import('@/lib/agent-backend');
      const backend = getAgentBackend();
      backend.initCronScheduler();
      console.log('[Instrumentation] AgtPilot background cron scheduler registered.');
    } catch (err) {
      console.error('[Instrumentation] Failed to register cron scheduler:', err);
    }
  }
}
