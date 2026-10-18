import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@agtpilot/core';

/**
 * browser 工具的「截图不进模型上下文」契约(层1 源头裁剪 ①,
 * docs/design/token-consumption-and-tool-loading.md §9.3):
 * browser_navigate / browser_screenshot 的工具返回值不再携带 screenshotBase64
 * (~12KB base64 对文本模型零信息量),截图只走 viewport_update 事件通道
 * (驾驶舱视口读事件流,apps/web agent-backend.ts viewport_update 分支)。
 * 服务层 navigateAndDistill 契约不变(登录通道/xhs 托管读工具复用其截图)。
 * playwright 全 mock,不起真浏览器。
 */

const { launchPersistentContext } = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));
vi.mock('playwright', () => ({ chromium: { launchPersistentContext } }));

function fakePage(html = '<html><head><title>示例页</title></head><body><h1>标题</h1><p>正文内容</p></body></html>') {
  return {
    isClosed: () => false,
    goto: vi.fn(async () => {}),
    title: vi.fn(async () => '示例页'),
    content: vi.fn(async () => html),
    url: () => 'https://example.com/',
    screenshot: vi.fn(async () => Buffer.from('fake-jpeg-bytes')),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  };
}

function buildHarness() {
  const page = fakePage();
  launchPersistentContext.mockResolvedValue({
    pages: () => [page],
    newPage: async () => page,
    close: async () => {},
  });

  const ctx = new Context();
  new AgentService(ctx);
  const events: any[] = [];
  ctx.on('agtpilot/event', (e: any) => events.push(e));

  // 动态 import:apply 在 mock 就位后执行(plugin 顶层 import playwright 被 mock)
  return { ctx, page, events };
}

async function loadPlugin(ctx: Context) {
  const mod = await import('./index');
  mod.apply(ctx, { headless: true });
}

beforeEach(() => {
  launchPersistentContext.mockReset();
});

describe('browser_navigate · 截图剥离', () => {
  it('工具返回不带 screenshotBase64;viewport_update 事件携带 data URI', async () => {
    const h = buildHarness();
    await loadPlugin(h.ctx);
    const tool = h.ctx.agent.getTool('browser_navigate')!;
    const result: any = await tool.execute({ url: 'https://example.com' }, { taskId: 't1', step: 1 });

    expect(result.success).toBe(true);
    expect(result.url).toBe('https://example.com');
    expect(result.title).toBe('示例页');
    expect(result.content).toContain('正文内容'); // Turndown 蒸馏正常
    expect('screenshotBase64' in result).toBe(false); // ← 层1 契约:模型返回零 base64
    expect(JSON.stringify(result)).not.toContain('base64');

    const viewport = h.events.find((e) => e.type === 'viewport_update');
    expect(viewport).toBeTruthy();
    expect(viewport.payload.screenshotBase64).toBe(
      `data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes').toString('base64')}`,
    );
  });

  it('服务层 navigateAndDistill 契约不变(截图仍返回给事件通道/托管工具复用)', async () => {
    const h = buildHarness();
    await loadPlugin(h.ctx);
    const distill = await (h.ctx as any).browser.navigateAndDistill('u1', 'https://example.com');
    expect(distill.screenshotBase64).toBe(Buffer.from('fake-jpeg-bytes').toString('base64'));
    expect(distill.title).toBe('示例页');
  });
});

describe('browser_screenshot · 截图剥离', () => {
  it('工具返回只带 savePath/message,不带 screenshotBase64;事件通道保留画面', async () => {
    const h = buildHarness();
    await loadPlugin(h.ctx);
    const tool = h.ctx.agent.getTool('browser_screenshot')!;
    const result: any = await tool.execute({ filename: 'shot.jpg' }, { taskId: 't1', step: 1 });

    expect(result.success).toBe(true);
    expect(result.savePath).toContain('shot.jpg');
    expect(result.message).toContain('截图已保存至');
    expect('screenshotBase64' in result).toBe(false); // ← 层1 契约
    expect(JSON.stringify(result)).not.toContain('base64');

    const viewport = h.events.find((e) => e.type === 'viewport_update');
    expect(viewport).toBeTruthy();
    expect(typeof viewport.payload.screenshotBase64).toBe('string');
    expect(viewport.payload.screenshotBase64.length).toBeGreaterThan(0);
  });
});
