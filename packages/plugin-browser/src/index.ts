import { Context, Service } from '@deepseek-ai/cordis';
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

/** navigateAndDistill 的返回契约(登录通道/只读数据工具复用 browser_navigate 的导航+蒸馏) */
export interface DistillResult {
  url: string;
  title: string;
  content: string;
  nextOffset?: number;
  totalLength: number;
  /** JPEG base64(不带 data: 前缀;失败为空串) */
  screenshotBase64?: string;
}

/** 当前帧捕获(登录通道轮询推帧用,不导航) */
export interface FrameCapture {
  screenshotBase64: string;
  url: string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserSessionService;
  }
}

/**
 * 浏览器会话服务(scenario-loop P2 模块 0):把插件内部的持久化浏览器能力
 * 以服务形态暴露给应用层(Web 登录通道 / 托管存草稿工具),仿 plugin-cron 的 ctx.cron。
 * 应用层与任务工具共享同一 per-user Page —— 登录态天然互通,互不可见。
 */
export interface BrowserSessionService {
  /** 该用户的持久化 Page(不存在则启动浏览器) */
  acquirePage(userId?: string): Promise<Page>;
  /** 导航 + Turndown 蒸馏(4000 字符窗口续读) + 截图;事件由调用方自行决定是否发 */
  navigateAndDistill(
    userId: string | undefined,
    url: string,
    offset?: number,
    opts?: { renderWaitMs?: number }
  ): Promise<DistillResult>;
  /** 截取当前帧(不导航;登录轮询用) */
  captureFrame(userId?: string): Promise<FrameCapture>;
  /** 登录态判定:domain 下存在 names 中任一 cookie 即 true */
  hasCookies(userId: string | undefined, domain: string, names: string[]): Promise<boolean>;
  /** 当前页面 URL(浏览器未启动返回 null,不触发启动) */
  pageUrl(userId?: string): string | null;
  /** 是否存在活跃 Page(软锁查询,不触发启动) */
  hasActivePage(userId?: string): boolean;
}

class BrowserServiceImpl extends Service implements BrowserSessionService {
  // 持久化浏览器环境按用户分域(session.userId;CLI 单用户 = 'default'):
  // 每用户独立 profile 目录与 BrowserContext —— 登录态/Cookie 互不可见
  private contexts = new Map<string, BrowserContext>();
  private pages = new Map<string, Page>();
  // 初始化串行锁:并发首调 acquirePage 不重复 launch 浏览器
  private initChain: Promise<void> = Promise.resolve();
  private readonly turndown: TurndownService;

  constructor(ctx: Context, private config: BrowserPluginConfig) {
    super(ctx, 'browser');
    this.turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    // 过滤脚本、样式等干扰大模型阅读的噪音标签
    this.turndown.remove(['script', 'style', 'noscript', 'svg', 'canvas'] as any);
  }

  private userKey(userId?: string) {
    return (userId || 'default').replace(/[^\w-]/g, '_');
  }

  acquirePage(userId?: string): Promise<Page> {
    const key = this.userKey(userId);
    const existing = this.pages.get(key);
    if (existing && !existing.isClosed()) {
      return Promise.resolve(existing);
    }

    const run = async () => {
      // 'default' 沿用旧目录名(保留 CLI 单用户既有登录态)
      const defaultProfileDir = path.resolve(
        process.cwd(),
        '.cache',
        key === 'default' ? 'browser-profile' : `browser-profile-${key}`
      );
      // userDataDir 覆盖只对 default(单用户/CLI)生效;多用户各自独立目录,避免共享 profile
      const profileDir = (key === 'default' && this.config.userDataDir) || defaultProfileDir;
      if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
      }

      if (!this.contexts.has(key)) {
        const context = await chromium.launchPersistentContext(profileDir, {
          headless: this.config.headless ?? true,
          viewport: { width: 1280, height: 800 },
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          // 降低自动化特征(登录通道跑在真实站点上,裸自动化指纹易触发风控)
          args: ['--disable-blink-features=AutomationControlled'],
        });
        this.contexts.set(key, context);
      }
      const context = this.contexts.get(key)!;
      const page = context.pages()[0] || (await context.newPage());
      this.pages.set(key, page);
      return page;
    };

    const result = this.initChain.then(run, run);
    this.initChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async navigateAndDistill(
    userId: string | undefined,
    url: string,
    offset = 0,
    opts?: { renderWaitMs?: number }
  ): Promise<DistillResult> {
    const page = await this.acquirePage(userId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // SPA 页(站内搜索/热门话题等客户端渲染)在 domcontentloaded 后内容尚未挂载:
    // 可选等待 networkidle(尽力而为,长轮询页面可能永不 idle → catch 兜底) + 固定沉降
    if (opts?.renderWaitMs && opts.renderWaitMs > 0) {
      await page.waitForLoadState('networkidle', { timeout: opts.renderWaitMs }).catch(() => {});
      await page.waitForTimeout(1200);
    }

    const title = await page.title();
    const html = await page.content();

    // 使用 Turndown 将网页转为干净的 Markdown;每次返回 4000 字符窗口,
    // 截断时给出 nextOffset + 显式标记,模型可带 offset 续读,
    // 避免"换 URL 重抓"式的步数空转
    const PAGE_WINDOW = 4000;
    const rawMarkdown = this.turndown.turndown(html);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const markdown = rawMarkdown.slice(safeOffset, safeOffset + PAGE_WINDOW);
    const nextOffset =
      safeOffset + markdown.length < rawMarkdown.length ? safeOffset + PAGE_WINDOW : undefined;
    const truncatedNote =
      nextOffset !== undefined
        ? `\n\n…[内容过长,本次返回第 ${safeOffset}~${safeOffset + PAGE_WINDOW} 字符(共 ${rawMarkdown.length} 字符),续读请携带 offset=${nextOffset}]…`
        : '';

    let screenshotBase64 = '';
    try {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 65 });
      screenshotBase64 = buffer.toString('base64');
    } catch {
      // 容错处理
    }

    return {
      url,
      title,
      content: markdown + truncatedNote,
      nextOffset,
      totalLength: rawMarkdown.length,
      screenshotBase64,
    };
  }

  async captureFrame(userId?: string): Promise<FrameCapture> {
    const page = await this.acquirePage(userId);
    const buffer = await page.screenshot({ type: 'jpeg', quality: 65 });
    return { screenshotBase64: buffer.toString('base64'), url: page.url() };
  }

  async hasCookies(userId: string | undefined, domain: string, names: string[]): Promise<boolean> {
    const page = await this.acquirePage(userId);
    const host = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const cookies = await page.context().cookies(`https://${host}`);
    return cookies.some((c) => names.includes(c.name));
  }

  pageUrl(userId?: string): string | null {
    const p = this.pages.get(this.userKey(userId));
    return p && !p.isClosed() ? p.url() : null;
  }

  hasActivePage(userId?: string): boolean {
    const p = this.pages.get(this.userKey(userId));
    return !!p && !p.isClosed();
  }

  async closeAll(): Promise<void> {
    for (const [, context] of this.contexts) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();
    this.pages.clear();
  }
}

/** 发布按钮硬围栏(scenario-loop 红线):小红书发布页上的「发布」动作一律代码级拒绝 */
const XHS_PUBLISH_URL = /creator\.xiaohongshu\.com\/publish/i;
const PUBLISH_ACTION = /发布|publish/i;

function hitPublishFence(pageUrl: string, actionText: string): boolean {
  return XHS_PUBLISH_URL.test(pageUrl) && PUBLISH_ACTION.test(actionText);
}

function publishRejected(actionText: string) {
  return {
    success: false,
    rejected: true,
    selector: actionText,
    error:
      '已拦截:发布按钮永远由用户本人点击(平台合规红线)。自动写作的终点是草稿箱 —— 请停在页面的自动保存,或使用专用存草稿工具。',
  };
}

/** 上传围栏:仅图片扩展名、至多 9 张、路径必须落在工作区内(拒绝任意路径读取) */
const UPLOAD_EXT = /\.(jpe?g|png|webp|gif)$/i;
const UPLOAD_MAX_FILES = 9;

export function apply(ctx: Context, config: BrowserPluginConfig = { headless: true }) {
  // 工具路由自注册:prompt 命中网页/浏览类关键词时挂载本插件工具组(内核不维护前缀表)
  ctx.agent.registerToolRoute({
    id: 'browser',
    prefixes: ['browser_'],
    test: /(网页|网站|浏览|抓取|爬取|打开链接|https?:\/\/|www\.|\.(com|cn|org|net|io)\b|browser|webpage|scrape|crawl)/i,
  });

  const svc = new BrowserServiceImpl(ctx, config);
  const getOrCreatePage = (userId?: string) => svc.acquirePage(userId);

  // 执行后补一帧 viewport_update 截图(输入类工具的视觉确认)
  const emitViewport = async (page: Page) => {
    try {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 65 });
      ctx.agent.emitEvent({
        type: 'viewport_update',
        payload: {
          url: page.url(),
          title: await page.title().catch(() => ''),
          screenshotBase64: `data:image/jpeg;base64,${buffer.toString('base64')}`,
        },
        timestamp: Date.now(),
      });
    } catch {
      // 页面关闭等场景下截图失败不阻断工具结果
    }
  };

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
        const result = await svc.navigateAndDistill(session?.userId, url, offset);
        const dataUri = result.screenshotBase64 ? `data:image/jpeg;base64,${result.screenshotBase64}` : '';

        ctx.agent.emitEvent({
          type: 'viewport_update',
          payload: { url: result.url, title: result.title, screenshotBase64: dataUri },
          timestamp: Date.now(),
        });

        ctx.agent.emitEvent({
          type: 'tool_result',
          payload: { tool: 'browser_navigate', success: true, url },
          timestamp: Date.now(),
        });

        return {
          success: true,
          url: result.url,
          title: result.title,
          content: result.content,
          nextOffset: result.nextOffset,
          totalLength: result.totalLength,
          screenshotBase64: dataUri || undefined,
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

  // 2. 真实元素点击 (browser_click) —— 带发布按钮硬围栏
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
        // 发布按钮硬围栏:小红书发布页上的「发布」点击永远拒绝(红线是代码级,不靠 prompt)
        if (hitPublishFence(page.url(), String(selector))) {
          return publishRejected(String(selector));
        }
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
        // 文件名围栏:basename 清洗 + 固定落截图缓存目录,拒绝任意路径写入
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

  // 4. Stagehand AI 语义化动作操控 (browser_stagehand_act) —— 带发布按钮硬围栏
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
        // 附着:以当前会话页面的 URL 为起点(独立实例),保证动作发生在
        // 模型认为的"当前页面"上,而不是空白页
        const currentUrl = (await getOrCreatePage(session?.userId)).url();
        // 发布按钮硬围栏:发布页上的「发布」语义指令一律拒绝
        if (hitPublishFence(currentUrl, String(instruction))) {
          return publishRejected(String(instruction));
        }
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
        // 失败路径同样关闭:独立实例泄漏会让浏览器进程堆积
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

        // 与 browser_navigate 相同的窗口式返回:截断时给 nextOffset + 显式标记,支持续读
        const PAGE_WINDOW = 4000;
        const fullMarkdown: string = res.markdown || '';
        const safeOffset = Math.max(0, Number(offset) || 0);
        const markdown = fullMarkdown.slice(safeOffset, safeOffset + PAGE_WINDOW);
        const nextOffset =
          safeOffset + markdown.length < fullMarkdown.length ? safeOffset + PAGE_WINDOW : undefined;
        const truncatedNote =
          nextOffset !== undefined
            ? `\n\n…[内容过长,本次返回第 ${safeOffset}~${safeOffset + PAGE_WINDOW} 字符(共 ${fullMarkdown.length} 字符),续读请携带 offset=${nextOffset}]…`
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

  // 7. 表单/富文本填写 (browser_fill) —— scenario-loop P2:发布页直填、搜索框等
  ctx.agent.registerTool({
    name: 'browser_fill',
    description:
      '在当前页面的输入框/文本域填入内容。三种模式:fill(普通 input/textarea,直接覆盖)' +
      '、insertText(富文本 contenteditable,先聚焦再插入 —— 小红书发布页正文属于此类)' +
      '、pressEnter(向指定元素发送回车)。执行后返回最新页面截图。',
    dangerLevel: 'medium',
    compensation: {
      kind: 'partially-reversible',
      undoHint: '输入内容可通过再次 fill 空值或清空输入框撤销;若已触发表单提交则需在对应平台内处理',
    },
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '目标元素的 CSS 选择器' },
        value: { type: 'string', description: '要填入的文本内容' },
        mode: {
          type: 'string',
          enum: ['fill', 'insertText', 'pressEnter'],
          description: '填写模式(可选,默认 fill;富文本正文用 insertText)',
        },
      },
      required: ['selector', 'value'],
    },
    execute: async ({ selector, value, mode = 'fill' }, session?: any) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'browser_fill', selector, mode },
        timestamp: Date.now(),
      });
      try {
        const page = await getOrCreatePage(session?.userId);
        const text = String(value ?? '');
        if (mode === 'insertText') {
          // contenteditable 不能用 fill:先点击聚焦,再整体插入(不受输入法/逐键延迟影响)
          try {
            await page.click(selector, { timeout: 10000 });
          } catch {
            await page.locator(selector).first().focus({ timeout: 5000 });
          }
          await page.keyboard.insertText(text);
        } else if (mode === 'pressEnter') {
          await page.press(selector, 'Enter', { timeout: 10000 });
        } else {
          await page.fill(selector, text, { timeout: 10000 });
        }
        await emitViewport(page);
        ctx.agent.emitEvent({
          type: 'tool_result',
          payload: { tool: 'browser_fill', success: true, selector, mode },
          timestamp: Date.now(),
        });
        return {
          success: true,
          selector,
          mode,
          length: text.length,
          message: `已按 ${mode} 模式填入 ${text.length} 字符`,
        };
      } catch (err: any) {
        ctx.agent.emitEvent({
          type: 'tool_result',
          payload: { tool: 'browser_fill', success: false, selector, error: err.message },
          timestamp: Date.now(),
        });
        return {
          success: false,
          selector,
          mode,
          error: err.message,
        };
      }
    },
  });

  // 8. 键盘输入 (browser_type) —— 向当前焦点元素(或指定元素)逐键输入
  ctx.agent.registerTool({
    name: 'browser_type',
    description:
      '模拟键盘向当前焦点元素逐键输入文本(可选先聚焦指定元素,可选输入后回车)。' +
      '适合短文本(搜索词/验证码/评论);大段正文请用 browser_fill 的 insertText 模式。',
    dangerLevel: 'medium',
    compensation: {
      kind: 'partially-reversible',
      undoHint: '输入内容可通过退格或清空输入框撤销;若已触发表单提交则需在对应平台内处理',
    },
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
        selector: { type: 'string', description: '可选:先聚焦的元素 CSS 选择器(缺省在当前焦点处输入)' },
        pressEnter: { type: 'boolean', description: '可选:输入完成后按回车' },
      },
      required: ['text'],
    },
    execute: async ({ text, selector, pressEnter }, session?: any) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'browser_type', hasSelector: !!selector },
        timestamp: Date.now(),
      });
      try {
        const page = await getOrCreatePage(session?.userId);
        if (selector) {
          try {
            await page.click(selector, { timeout: 10000 });
          } catch {
            await page.locator(selector).first().focus({ timeout: 5000 });
          }
        }
        await page.keyboard.type(String(text ?? ''), { delay: 10 });
        if (pressEnter) {
          await page.keyboard.press('Enter');
        }
        await emitViewport(page);
        return {
          success: true,
          length: String(text ?? '').length,
          message: `已输入 ${String(text ?? '').length} 字符${pressEnter ? ' 并回车' : ''}`,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
        };
      }
    },
  });

  // 9. 文件上传 (browser_upload) —— 带路径围栏与数量/类型限制
  ctx.agent.registerTool({
    name: 'browser_upload',
    description:
      '向当前页面的文件上传控件(file input)上传本地图片。限制:仅 jpg/jpeg/png/webp/gif,至多 9 张,' +
      '文件路径必须位于本服务工作区内。上传成功后返回最新页面截图。',
    dangerLevel: 'medium',
    compensation: {
      kind: 'partially-reversible',
      undoHint: '已上传的图片可通过页面上的删除控件移除;若页面已保存,可在草稿箱中编辑删除',
    },
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '文件输入控件的 CSS 选择器(input[type=file])' },
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: '本地图片文件的绝对路径列表(至多 9 个)',
        },
      },
      required: ['selector', 'filePaths'],
    },
    execute: async ({ selector, filePaths }, session?: any) => {
      ctx.agent.emitEvent({
        type: 'tool_call',
        payload: { tool: 'browser_upload', count: Array.isArray(filePaths) ? filePaths.length : 0 },
        timestamp: Date.now(),
      });
      try {
        const page = await getOrCreatePage(session?.userId);
        const list = (Array.isArray(filePaths) ? filePaths : [filePaths]).map(String);
        if (list.length === 0) {
          return { success: false, error: 'filePaths 不能为空' };
        }
        if (list.length > UPLOAD_MAX_FILES) {
          return { success: false, error: `一次至多上传 ${UPLOAD_MAX_FILES} 张图片(收到 ${list.length} 个)` };
        }
        // 路径围栏:必须落在工作区内且为图片扩展名 —— 拒绝任意路径读取
        const workspaceRoot = path.resolve(process.cwd());
        const resolved = list.map((p) => path.resolve(p));
        for (let i = 0; i < resolved.length; i++) {
          const p = resolved[i];
          if (!p.startsWith(workspaceRoot + path.sep)) {
            return { success: false, error: `文件路径越界(仅允许工作区内文件): ${list[i]}` };
          }
          if (!UPLOAD_EXT.test(p)) {
            return { success: false, error: `仅支持图片文件(jpg/jpeg/png/webp/gif): ${list[i]}` };
          }
          if (!fs.existsSync(p)) {
            return { success: false, error: `文件不存在: ${list[i]}` };
          }
        }
        await page.setInputFiles(selector, resolved, { timeout: 30000 });
        // 上传后等图片处理渲染再截图
        await page.waitForTimeout(1500);
        await emitViewport(page);
        return {
          success: true,
          uploaded: resolved.length,
          message: `已上传 ${resolved.length} 张图片`,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
        };
      }
    },
  });

  // 10. 页面等待 (browser_wait) —— 等待加载/元素/文本/超时
  ctx.agent.registerTool({
    name: 'browser_wait',
    description:
      '在当前页面等待条件满足:load(整页加载完成)、selector(元素出现)、text(文本出现)、timeout(固定时长)。' +
      '超时上限 30 秒。适合等待页面跳转、动态内容或自动保存指示出现。',
    dangerLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        for: {
          type: 'string',
          enum: ['load', 'selector', 'text', 'timeout'],
          description: '等待条件(可选,默认 timeout)',
        },
        selector: { type: 'string', description: 'for=selector 时的 CSS 选择器' },
        text: { type: 'string', description: 'for=text 时等待出现的文本' },
        timeoutMs: { type: 'number', description: '最长等待毫秒数(可选,默认 10000,上限 30000)' },
      },
    },
    execute: async (params: any, session?: any) => {
      const waitKind = String(params?.for || 'timeout');
      const timeoutMs = Math.min(30000, Math.max(1000, Number(params?.timeoutMs) || 10000));
      try {
        const page = await getOrCreatePage(session?.userId);
        if (waitKind === 'selector') {
          if (!params?.selector) {
            return { success: false, error: 'for=selector 需要提供 selector 参数' };
          }
          await page.waitForSelector(String(params.selector), { timeout: timeoutMs });
        } else if (waitKind === 'text') {
          if (!params?.text) {
            return { success: false, error: 'for=text 需要提供 text 参数' };
          }
          await page.getByText(String(params.text)).first().waitFor({ timeout: timeoutMs });
        } else if (waitKind === 'load') {
          await page.waitForLoadState('load', { timeout: timeoutMs });
        } else {
          await page.waitForTimeout(timeoutMs);
        }
        return {
          success: true,
          waited: waitKind,
          url: page.url(),
          message: `已等待 ${waitKind} 完成(${timeoutMs}ms 上限)`,
        };
      } catch (err: any) {
        return {
          success: false,
          waited: waitKind,
          error: `等待 ${waitKind} 失败(超时 ${timeoutMs}ms): ${err.message}`,
        };
      }
    },
  });

  // 进程退出时妥善关闭浏览器('dispose' 事件由 core 的 Events 增强声明)
  ctx.on('dispose', async () => {
    await svc.closeAll();
  });
}
