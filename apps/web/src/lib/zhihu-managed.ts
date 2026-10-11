/**
 * 知乎托管模式 · 用户级任务工具(仿 xhs-managed;知乎无官方写 API,只能走浏览器)
 *
 * 背景:developer.zhihu.com 开放平台只读(搜索/热榜);站内草稿 API 有 x-zse-96
 * 签名墙,逆向脆弱不可维护。因此走浏览器托管:扫码登录 → Agent 填专栏编辑器
 * (zhuanlan.zhihu.com/write)→ 停在服务端自动保存的草稿 —— 知乎草稿跨端可见
 * (App 创作中心 / 网页草稿箱),用户人工完成发布。
 *
 * 三层红线(与小红书一致):① plugin-browser 的 browser_click/stagehand 发布围栏;
 * ② 本文件的选择器配置表里根本不存在发布按钮;
 * ③ 系统 prompt「托管终点是草稿箱」。Agent 永远不碰「发布」。
 */
import type { ToolDefinition } from '@agtpilot/core';
import {
  getZhihuManaged,
  getBrowserAudit,
  appendBrowserAudit,
  type BrowserAuditEntry,
  type ZhihuManagedRecord,
} from './user-store';

/**
 * ⚠️ 知乎专栏编辑器选择器配置表 —— 全部待真实账号实测。
 * 实测后只改这里,不改逻辑。表里刻意没有「发布」按钮。
 */
export const ZHIHU_EDITOR_SELECTORS = {
  /** 知乎专栏写作页(登录后直达编辑器;未登录会被重定向去 signin,由登录门兜住) */
  writeUrl: 'https://zhuanlan.zhihu.com/write',
  /** 标题输入框(专栏编辑器为 textarea,placeholder 含「标题」) */
  titleInput: 'textarea[placeholder*="标题"]',
  /** 正文 contenteditable(Draft.js 根节点) */
  bodyEditor: 'div[contenteditable="true"]',
  /** 自动保存指示文案(等它出现 = 服务端草稿已落;仅作附注不是成败判据) */
  autosaveIndicator: /草稿|已保存|自动保存/,
};

/** 知乎主站(登录门 cookie 判定域;登录态 cookie = z_c0) */
export const ZHIHU_HOME = 'https://www.zhihu.com/';
export const ZHIHU_LOGIN_COOKIE_NAMES = ['z_c0'];

/** 每日存草稿上限(opt-in 承诺的一部分;可用 env 调整) */
export function dailyDraftLimit(): number {
  const n = Number(process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/** 今日(本地时区)已尝试的存草稿次数(成败都计,保守限频) */
export function countTodayDraftSaves(audit: BrowserAuditEntry[], now = new Date()): number {
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  return audit.filter((e) => {
    if (e.tool !== 'zhihu_save_article_draft') return false;
    const d = new Date(e.at);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === dayKey;
  }).length;
}

/** 写工具注入门槛:显式 opt-in + 已阅读风险明示(与小红书同规则) */
export function shouldInjectWriteTool(record: ZhihuManagedRecord | undefined): boolean {
  return !!record?.enabled && !!record?.riskAckAt;
}

/** 浏览器服务依赖(与 plugin-browser 的 ctx.browser 同构;测试可 mock) */
export interface ZhihuBrowserService {
  acquirePage(userId?: string): Promise<any>;
  hasCookies(userId: string | undefined, domain: string, names: string[]): Promise<boolean>;
}

const NOT_LOGGED_IN_HINT =
  '知乎网页版尚未登录或登录态已失效。请引导用户到「连接器页 → 知乎 → 网页版扫码登录」,用知乎 App 扫码完成登录后重试。';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 构建用户级知乎托管工具。
 * browser 服务由 agent-backend 传入(this.ctx.browser);缺省时(插件未就绪)不注入。
 */
export function buildZhihuManagedTools(userId: string, browser?: ZhihuBrowserService): ToolDefinition[] {
  const record = getZhihuManaged(userId);
  const tools: ToolDefinition[] = [];

  // 存草稿工具:显式 opt-in + 风险已读 → 注入;dangerLevel high = 编排器审批门
  if (shouldInjectWriteTool(record) && browser) {
    tools.push({
      name: 'zhihu_save_article_draft',
      description:
        '把一篇知乎专栏文章(标题/正文)填进网页版专栏编辑器(zhuanlan.zhihu.com/write),' +
        '依赖知乎的服务端自动保存停进草稿箱 —— 绝不发布(发布按钮被代码级围栏永久拦截),' +
        '发布由用户经「接管浏览器」或在知乎草稿箱亲自完成。知乎草稿存服务端、跨端可见' +
        '(知乎 App「创作中心 → 草稿」/ 网页 zhihu.com/creator 草稿箱)。' +
        '正文以纯文本填入,Markdown 记号不会自动排版(复杂格式由用户接管后调整)。' +
        '调用前需要用户审批确认。每次调用计入每日上限。',
      dangerLevel: 'high',
      compensation: {
        kind: 'partially-reversible',
        undoHint: '内容存为知乎账号草稿箱内的草稿,用户可在草稿箱直接删除;未发布前对外不可见',
      },
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文章标题' },
          body: { type: 'string', description: '文章正文(纯文本/Markdown 原文,建议 1500 字以上)' },
        },
        required: ['title', 'body'],
      },
      execute: async (args: any, session: any) => {
        const title = String(args?.title || '').trim();
        const body = String(args?.body || '');
        if (!title || body.length < 20) {
          return { success: false, error: 'title 与 body 必填(正文至少 20 字)' };
        }

        // ① 限频前置:今日尝试次数(成败都计)达到上限直接拒绝,不开浏览器、不落审计
        const todayCount = countTodayDraftSaves(getBrowserAudit(userId));
        if (todayCount >= dailyDraftLimit()) {
          return {
            success: false,
            rejected: true,
            error: `已达今日存草稿上限(${dailyDraftLimit()} 次)。明天再试,或复制文章内容手动粘贴。`,
          };
        }

        const missionId = session?.taskId;
        const auditFailure = (error: string) =>
          appendBrowserAudit(userId, {
            at: Date.now(),
            tool: 'zhihu_save_article_draft',
            action: 'save_article_draft',
            title,
            result: 'failure',
            error,
            missionId,
          });

        try {
          // ② 登录门在导航前:未登录不开编辑器、不烧流程(与小红书同语义,引导扫码)
          if (!(await browser.hasCookies(userId, ZHIHU_HOME, ZHIHU_LOGIN_COOKIE_NAMES))) {
            auditFailure('not_logged_in');
            return { success: false, error: NOT_LOGGED_IN_HINT };
          }

          const page = await browser.acquirePage(userId);

          // ③ 打开专栏编辑器(SPA,首屏渲染数秒:轮询等标题框出现)
          await page.goto(ZHIHU_EDITOR_SELECTORS.writeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          let editorReady = false;
          for (let i = 0; i < 12; i++) {
            await sleep(2000);
            if ((await page.locator(ZHIHU_EDITOR_SELECTORS.titleInput).count()) > 0) {
              editorReady = true;
              break;
            }
            // 被重定向回登录页 = 登录态在导航后才失效
            if (/signin|login/i.test(String(page.url?.() || ''))) {
              auditFailure('not_logged_in');
              return { success: false, error: NOT_LOGGED_IN_HINT };
            }
          }
          if (!editorReady) {
            throw new Error(
              '专栏编辑器未渲染:标题输入框始终未出现(页面改版或结构变化,需人工核查 zhuanlan.zhihu.com/write)'
            );
          }

          // ④ 标题(编辑器可能带旧草稿:fill 整体覆盖)
          await page.fill(ZHIHU_EDITOR_SELECTORS.titleInput, title, { timeout: 20000 });

          // ⑤ 正文(Draft.js contenteditable:聚焦→全选清旧→整体插入纯文本)
          try {
            await page.click(ZHIHU_EDITOR_SELECTORS.bodyEditor, { timeout: 10000 });
          } catch {
            await page.locator(ZHIHU_EDITOR_SELECTORS.bodyEditor).first().focus({ timeout: 5000 });
          }
          await page.keyboard.press('Control+a');
          await page.keyboard.insertText(body);

          // ⑥ 顺带看一眼自动保存指示(仅作结果附注;知乎草稿存服务端,
          //    10s 等不到就走 —— 别烧任务时长,用户可接管核对)
          let saved = false;
          try {
            await page
              .getByText(ZHIHU_EDITOR_SELECTORS.autosaveIndicator)
              .first()
              .waitFor({ timeout: 10000 });
            saved = true;
          } catch {
            saved = false;
          }

          // 截图随结果返回(用户在审批/任务页可肉眼核对)
          let screenshotBase64 = '';
          try {
            const buffer = await page.screenshot({ type: 'jpeg', quality: 65 });
            screenshotBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
          } catch {}

          // ⑦ 审计(填完即成功;自动保存是否确认只是附加信息)
          appendBrowserAudit(userId, {
            at: Date.now(),
            tool: 'zhihu_save_article_draft',
            action: 'save_article_draft',
            title,
            result: 'success',
            error: saved ? undefined : '未等到自动保存指示(页面内容不受影响)',
            missionId,
          });

          return {
            success: true,
            title,
            message:
              '文章已填入知乎专栏编辑器 —— 知乎草稿存服务端、跨端可见:' +
              (saved ? '平台已自动保存进草稿箱。' : '自动保存未确认,请接管浏览器核对内容后再离开页面。') +
              '发布由你本人完成:到连接器页点「接管浏览器」核对并亲自发布,或在知乎 App「创作中心 → 草稿」/ 网页草稿箱里发布。' +
              `今日已用 ${todayCount + 1}/${dailyDraftLimit()} 次。`,
            screenshotBase64: screenshotBase64 || undefined,
          };
        } catch (err: any) {
          const message = err?.message || String(err);
          auditFailure(message);
          return { success: false, error: `存草稿失败:${message}` };
        }
      },
    });
  }

  return tools;
}
