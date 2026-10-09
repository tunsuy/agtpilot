import { Context } from '@deepseek-ai/cordis';
import '@agtpilot/core';
import { chromium, BrowserContext, Page } from 'playwright';
import FirecrawlApp from '@mendable/firecrawl-js';
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
  // 工具路由自注册：prompt 命中网页/浏览类关键词时挂载本插件工具组（内核不维护前缀表）
  ctx.agent.registerToolRoute({
    id: 'browser',
    prefixes: ['browser_'],
    test: /(网页|网站|浏览|抓取|爬取|打开链接|https?:\/\/|www\.|\.(com|cn|org|net|io)\b|browser|webpage|scrape|crawl)/i,
  });

  // 持久化浏览器环境按用户分域（session.userId；CLI 单用户 = 'default'）：
  // 每用户独立 profile 目录与 BrowserContext —— 登录态/Cookie 互不可见
  const contexts = new Map<string, BrowserContext>();
  const pages = new Map<string, Page>();
  // 初始化串行锁：并发首调 getOrCreatePage 不重复 launch 浏览器
  let initChain: Promise<void> = Promise.resolve();

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });

  // 过滤脚本、样式等干扰大模型阅读的噪音标签
  turndown.remove(['script', 'style', 'noscript', 'svg', 'canvas'] as any);

  const userKey = (userId?: string) => (userId || 'default').replace(/[^\w-]/g, '_');

  // 获取或初始化该用户的持久化浏览器环境
  function getOrCreatePage(userId?: string): Promise<Page> {
    const key = userKey(userId);
    const existing = pages.get(key);
    if (existing && !existing.isClosed()) {
      return Promise.resolve(existing);
    }

    const run = async () => {
      // 'default' 沿用旧目录名（保留 CLI 单用户既有登录态）
      const defaultProfileDir = path.resolve(
        process.cwd(),
        '.cache',
        key === 'default' ? 'browser-profile' : `browser-profile-${key}`
      );
      // userDataDir 覆盖只对 default（单用户/CLI）生效；多用户各自独立目录，避免共享 profile
      const profileDir = (key === 'default' && config.userDataDir) || defaultProfileDir;
      if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
      }

      if (!contexts.has(key)) {
        const context = await chromium.launchPersistentContext(profileDir, {
          headless: config.headless ?? true,
          viewport: { width: 1280, height: 800 },
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        });
        contexts.set(key, context);
      }
      const context = contexts.get(key)!;
      const page = context.pages()[0] || (await context.newPage());
      pages.set(key, page);
      return page;
    };

    const result = initChain.then(run, run);
    initChain = result.then(() => undefined, () => undefined);
    return result;
  }

  // 1. 真实导航与网页内容蒸馏 (browser_navigate)
  ctx.agent.registerTool({
    name: 'browser_navigate',
    description:
      '使用持久化浏览器导航至指定网址，并返回蒸馏后的主要 Markdown 文本内容（每次最多 4000 字符）。' +
      '内容被截断时携带 offset 参数（返回值中的 nextOffset）可续读后续内容，无需换 URL 重抓。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '需要访问的目标网址 (URL)' },
        offset: { type: 'number', description: '续读偏移量：上次返回 nextOffset 时传入可读取后续内容 (可选，默认 0)' },
      },
      required: ['url'],
    },
    execute: async ({ url, offset = 0 }, session?: any) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'browser_navigate', url },
        timestamp: Date.now(),
      });

      try {
        const page = await getOrCreatePage(session?.userId);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const title = await page.title();
        const html = await page.content();

        // 使用 Turndown 将网页转为干净的 Markdown；每次返回 4000 字符窗口，
        // 截断时给出 nextOffset + 显式标记，模型可带 offset 续读，
        // 避免"换 URL 重抓"式的步数空转
        const PAGE_WINDOW = 4000;
        const rawMarkdown = turndown.turndown(html);
        const safeOffset = Math.max(0, Number(offset) || 0);
        const markdown = rawMarkdown.slice(safeOffset, safeOffset + PAGE_WINDOW);
        const nextOffset =
          safeOffset + markdown.length < rawMarkdown.length ? safeOffset + PAGE_WINDOW : undefined;
        const truncatedNote =
          nextOffset !== undefined
            ? `\n\n…[内容过长，本次返回第 ${safeOffset}~${safeOffset + PAGE_WINDOW} 字符（共 ${rawMarkdown.length} 字符），续读请携带 offset=${nextOffset}]…`
            : '';

        let screenshotBase64 = '';
        try {
          const buffer = await page.screenshot({ type: 'jpeg', quality: 65 });
          screenshotBase64 = buffer.toString('base64');
        } catch {
          // 容错处理
        }

        ctx.agent.emitEvent({
          type: 'viewport_update',
          payload: {
            url,
            title,
            screenshotBase64: screenshotBase64 ? `data:image/jpeg;base64,${screenshotBase64}` : '',
          },
          timestamp: Date.now(),
        });

        ctx.agent.emitEvent({
          type: 'tool_result',
          payload: { tool: 'browser_navigate', success: true, url },
          timestamp: Date.now(),
        });

        return {
          success: true,
          url,
          title,
          content: markdown + truncatedNote,
          nextOffset,
          totalLength: rawMarkdown.length,
          screenshotBase64: screenshotBase64 ? `data:image/jpeg;base64,${screenshotBase64}` : undefined,
        };
      } catch (err: any) {
        ctx.agent.emitEvent({
          type: 'tool_result',
          payload: { tool: 'browser_navigate', success: false, url, error: err.message },
          timestamp: Date.now(),
        });
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
    execute: async ({ selector }, session?: any) => {
      try {
        const page = await getOrCreatePage(session?.userId);
        // 先按 Playwright 选择器（CSS / text= / role=）点击；
        // 失败时按纯文本内容兜底（描述承诺"支持文本"）
        try {
          await page.click(selector, { timeout: 10000 });
        } catch {
          await page.getByText(selector).first().click({ timeout: 5000 });
        }
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
    execute: async ({ filename = 'screenshot.png' }, session?: any) => {
      try {
        const page = await getOrCreatePage(session?.userId);
        // 文件名围栏：basename 清洗 + 固定落截图缓存目录，拒绝任意路径写入
        const safeName = String(filename).replace(/[/\\]/g, '_').replace(/\.\./g, '_') || 'screenshot.png';
        const saveDir = path.resolve(process.cwd(), '.cache', 'browser-screens');
        if (!fs.existsSync(saveDir)) {
          fs.mkdirSync(saveDir, { recursive: true });
        }
        const savePath = path.join(saveDir, path.basename(safeName));
        const buffer = await page.screenshot({ path: savePath, fullPage: false, type: 'jpeg', quality: 75 });
        const screenshotBase64 = buffer.toString('base64');
        ctx.agent.emitEvent({
          type: 'viewport_update',
          payload: {
            url: page.url(),
            title: await page.title(),
            screenshotBase64,
          },
          timestamp: Date.now(),
        });
        return {
          success: true,
          savePath,
          message: `截图已保存至: ${savePath}`,
          screenshotBase64: `data:image/jpeg;base64,${screenshotBase64}`,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
        };
      }
    },
  });

  // 4. Stagehand AI 语义化动作操控 (browser_stagehand_act)
  ctx.agent.registerTool({
    name: 'browser_stagehand_act',
    description:
      '使用 Stagehand AI 语义理解执行复杂的自然语言动作 (如: "点击搜索框输入 DeepSeek 并回车")。' +
      '会启动一个独立浏览器实例并先导航到当前会话所在页面 URL，再执行动作（不共享登录态与页面状态）。',
    // 回滚把手(治理 I5):页面内动作(输入/翻页)可逆,但提交类动作(下单/发帖)
    // 一旦触达远端服务即不可撤回 —— 声明为部分可逆,前端/审计据此提示
    compensation: {
      kind: 'partially-reversible',
      undoHint: '页面内操作可通过反向动作撤销(清空输入/返回上一页);若动作已提交到远端服务(下单/发帖/删除),需在对应平台内撤回',
    },
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: '想要在网页上完成的自然语言指令描述' },
      },
      required: ['instruction'],
    },
    execute: async ({ instruction }, session?: any) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'browser_stagehand_act', instruction },
        timestamp: Date.now(),
      });

      let stagehand: any = null;
      try {
        // 附着：以当前会话页面的 URL 为起点（独立实例），保证动作发生在
        // 模型认为的"当前页面"上，而不是空白页
        const currentUrl = (await getOrCreatePage(session?.userId)).url();
        const { Stagehand } = await import('@browserbasehq/stagehand');
        stagehand = await Stagehand.create({
          env: 'LOCAL',
          verbose: 1,
          debugDom: true,
          localBrowserLaunchOptions: {
            headless: config.headless ?? true,
          },
        } as any);
        if (currentUrl && currentUrl !== 'about:blank') {
          await stagehand.page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        const result = await stagehand.act(instruction);

        return {
          success: true,
          instruction,
          pageUrl: currentUrl,
          actionResult: result,
          message: `Stagehand 已成功按指令执行动作: "${instruction}"`,
        };
      } catch (err: any) {
        return {
          success: false,
          instruction,
          error: err.message,
        };
      } finally {
        // 失败路径同样关闭：独立实例泄漏会让浏览器进程堆积
        if (stagehand) await stagehand.close().catch(() => {});
      }
    },
  });

  // 5. Stagehand AI 页面语义观察 (browser_stagehand_observe)
  ctx.agent.registerTool({
    name: 'browser_stagehand_observe',
    description:
      '使用 Stagehand 视觉与 DOM 语义观察网页，输出所有可供执行的操作与元素列表。' +
      '会启动一个独立浏览器实例并先导航到当前会话所在页面 URL（不共享登录态与页面状态）。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '可选，本次观察希望寻找的目标操作 (如: "寻找登录或注册按钮")' },
      },
    },
    execute: async ({ goal }, session?: any) => {
      let stagehand: any = null;
      try {
        const currentUrl = (await getOrCreatePage(session?.userId)).url();
        const { Stagehand } = await import('@browserbasehq/stagehand');
        stagehand = await Stagehand.create({
          env: 'LOCAL',
          verbose: 1,
          debugDom: true,
          localBrowserLaunchOptions: {
            headless: config.headless ?? true,
          },
        } as any);
        if (currentUrl && currentUrl !== 'about:blank') {
          await stagehand.page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        const observations = await stagehand.observe(goal);

        return {
          success: true,
          goal,
          pageUrl: currentUrl,
          observations,
        };
      } catch (err: any) {
        return {
          success: false,
          goal,
          error: err.message,
        };
      } finally {
        if (stagehand) await stagehand.close().catch(() => {});
      }
    },
  });

  // 6. 顶级 Firecrawl 反爬穿透与纯净 Markdown 抓取 (browser_firecrawl_scrape)
  ctx.agent.registerTool({
    name: 'browser_firecrawl_scrape',
    description:
      '使用 Firecrawl 网页爬取引擎抓取目标网址，返回纯净的高可读性 Markdown 正文（每次最多 4000 字符）。' +
      '内容被截断时携带 offset 参数（返回值中的 nextOffset）可续读后续内容，无需换 URL 重抓。',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '需要抓取的目标网页 URL' },
        offset: { type: 'number', description: '续读偏移量：上次返回 nextOffset 时传入可读取后续内容 (可选，默认 0)' },
      },
      required: ['url'],
    },
    execute: async ({ url, offset = 0 }, session?: any) => {
      // 用户级 Key 优先（session.env 来自任务发起者的个人空间，多用户隔离）
      const apiKey = session?.env?.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY;
      if (!apiKey) {
        return {
          success: false,
          error: '未配置 FIRECRAWL_API_KEY。请在环境变量中设置 FIRECRAWL_API_KEY 即可使用 Firecrawl 爬取引擎。',
        };
      }

      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'browser_firecrawl_scrape', url },
        timestamp: Date.now(),
      });

      try {
        const firecrawl = new (FirecrawlApp as any)({ apiKey });
        const res = await firecrawl.scrapeUrl(url, { formats: ['markdown'] });

        if (!res.success) {
          throw new Error(res.error || 'Firecrawl 抓取失败');
        }

        // 与 browser_navigate 相同的窗口式返回：截断时给 nextOffset + 显式标记，支持续读
        const PAGE_WINDOW = 4000;
        const fullMarkdown: string = res.markdown || '';
        const safeOffset = Math.max(0, Number(offset) || 0);
        const markdown = fullMarkdown.slice(safeOffset, safeOffset + PAGE_WINDOW);
        const nextOffset =
          safeOffset + markdown.length < fullMarkdown.length ? safeOffset + PAGE_WINDOW : undefined;
        const truncatedNote =
          nextOffset !== undefined
            ? `\n\n…[内容过长，本次返回第 ${safeOffset}~${safeOffset + PAGE_WINDOW} 字符（共 ${fullMarkdown.length} 字符），续读请携带 offset=${nextOffset}]…`
            : '';

        return {
          success: true,
          url,
          title: res.metadata?.title || '',
          markdown: markdown + truncatedNote,
          nextOffset,
          totalLength: fullMarkdown.length,
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

  // 进程退出时妥善关闭浏览器（'dispose' 事件由 core 的 Events 增强声明）
  ctx.on('dispose', async () => {
    for (const [, context] of contexts) {
      await context.close().catch(() => {});
    }
    contexts.clear();
    pages.clear();
  });
}
