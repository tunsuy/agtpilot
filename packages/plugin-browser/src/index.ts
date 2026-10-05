import { Context } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import { chromium, BrowserContext, Page } from 'playwright';
import TurndownService from 'turndown';
import path from 'path';
import fs from 'fs';

export const name = 'agtpilot-plugin-browser';
export const inject = ['agent'];

export interface BrowserPluginConfig {
  headless?: boolean;
  userDataDir?: string;
}

export function apply(ctx: Context, config: BrowserPluginConfig = { headless: true }) {
  let browserContext: BrowserContext | null = null;
  let activePage: Page | null = null;

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });

  // 过滤脚本、样式等干扰大模型阅读的噪音标签
  turndown.remove(['script', 'style', 'noscript', 'svg', 'canvas']);

  // 获取或初始化持久化浏览器环境
  async function getOrCreatePage(): Promise<Page> {
    if (activePage && !activePage.isClosed()) {
      return activePage;
    }

    const defaultProfileDir = path.resolve(process.cwd(), '.cache/browser-profile');
    const profileDir = config.userDataDir || defaultProfileDir;
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    if (!browserContext) {
      browserContext = await chromium.launchPersistentContext(profileDir, {
        headless: config.headless ?? true,
        viewport: { width: 1280, height: 800 },
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      });
    }

    activePage = browserContext.pages()[0] || (await browserContext.newPage());
    return activePage;
  }

  // 1. 真实导航与网页内容蒸馏 (browser_navigate)
  ctx.agent.registerTool({
    name: 'browser_navigate',
    description: '使用持久化浏览器导航至指定网址，并返回蒸馏后的主要 Markdown 文本内容',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '需要访问的目标网址 (URL)' },
      },
      required: ['url'],
    },
    execute: async ({ url }) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'browser_navigate', url },
        timestamp: Date.now(),
      });

      try {
        const page = await getOrCreatePage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const title = await page.title();
        const html = await page.content();
        
        // 使用 Turndown 将网页转为干净的 Markdown，并截取前 4000 字符防止大模型上下文溢出
        const rawMarkdown = turndown.turndown(html);
        const markdown = rawMarkdown.length > 4000 ? rawMarkdown.slice(0, 4000) + '\n\n...(内容过长，已截断)' : rawMarkdown;

        return {
          success: true,
          url,
          title,
          content: markdown,
        };
      } catch (err: any) {
        return {
          success: false,
          url,
          error: err.message,
        };
      }
    },
  });

  // 2. 真实元素点击 (browser_click)
  ctx.agent.registerTool({
    name: 'browser_click',
    description: '在当前页面上模拟鼠标点击特定元素 (支持 CSS Selector 或 文本)',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '待点击元素的 CSS 选择器或文本内容' },
      },
      required: ['selector'],
    },
    execute: async ({ selector }) => {
      try {
        const page = await getOrCreatePage();
        await page.click(selector, { timeout: 10000 });
        return {
          success: true,
          selector,
          message: `已成功点击: ${selector}`,
        };
      } catch (err: any) {
        return {
          success: false,
          selector,
          error: err.message,
        };
      }
    },
  });

  // 3. 真实屏幕截图 (browser_screenshot)
  ctx.agent.registerTool({
    name: 'browser_screenshot',
    description: '截取当前网页屏幕并保存至本地，用于视觉核验',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '截图保存的文件名 (可选，默认为 screenshot.png)' },
      },
    },
    execute: async ({ filename = 'screenshot.png' }) => {
      try {
        const page = await getOrCreatePage();
        const savePath = path.resolve(process.cwd(), filename);
        await page.screenshot({ path: savePath, fullPage: false });
        return {
          success: true,
          savePath,
          message: `截图已保存至: ${savePath}`,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
        };
      }
    },
  });

  // 进程退出时妥善关闭浏览器
  ctx.on('dispose', async () => {
    if (browserContext) {
      await browserContext.close();
      browserContext = null;
      activePage = null;
    }
  });
}
