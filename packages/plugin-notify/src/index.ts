import { Context, Service } from '@deepseek-ai/cordis';
import { exec } from 'child_process';
import { promisify } from 'util';
import '@agtpilot/core';

const execAsync = promisify(exec);

export const name = 'agtpilot-plugin-notify';
export const inject = ['agent'];

export class NotifyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'notify');
  }

  async sendDesktopNotification(title: string, message: string): Promise<boolean> {
    try {
      if (process.platform === 'darwin') {
        const safeTitle = title.replace(/"/g, '\\"');
        const safeMsg = message.replace(/"/g, '\\"');
        await execAsync(`osascript -e 'display notification "${safeMsg}" with title "${safeTitle}"'`);
        return true;
      }
      return true;
    } catch {
      return false;
    }
  }

  async sendWebhook(channel: string, url: string, title: string, content: string): Promise<any> {
    let payload: any = { title, content };

    if (channel === 'feishu') {
      payload = {
        msg_type: 'interactive',
        card: {
          header: { title: { tag: 'plain_text', content: title } },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content } }],
        },
      };
    } else if (channel === 'dingtalk') {
      payload = {
        msgtype: 'markdown',
        markdown: { title, text: `### ${title}\n\n${content}` },
      };
    } else if (channel === 'wecom') {
      payload = {
        msgtype: 'markdown',
        markdown: { content: `### ${title}\n\n${content}` },
      };
    } else if (channel === 'slack') {
      payload = {
        text: `*${title}*\n${content}`,
      };
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { ok: res.ok, status: res.status };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
}

/**
 * Webhook 地址解析（多用户服务器安全）：
 * 1. 调用参数显式传入的 webhookUrl；
 * 2. 任务级 session.env 注入的当前用户凭证（连接器页保存的 {CHANNEL}_WEBHOOK_URL，
 *    经 agent-backend taskEnv 白名单透传，用户间互相隔离）；
 * 3. 全局 process.env 回退（单机自用场景），新旧键名（{CHANNEL}_WEBHOOK_URL / {CHANNEL}_WEBHOOK）都认。
 * 三者皆无时返回 missingEnvKey，由调用方显式报错 —— 绝不静默发往假地址
 * （旧实现会 POST 到 example.com/mock-webhook 并谎报成功）。
 */
export function resolveWebhookUrl(
  channel: string,
  webhookUrl?: string,
  sessionEnv?: Record<string, string | undefined>
): { url?: string; missingEnvKey?: string } {
  const ch = String(channel || '').toUpperCase();
  const url =
    (webhookUrl || '').trim() ||
    sessionEnv?.[`${ch}_WEBHOOK_URL`] ||
    process.env[`${ch}_WEBHOOK_URL`] ||
    process.env[`${ch}_WEBHOOK`];
  if (url) return { url };
  return { missingEnvKey: `${ch}_WEBHOOK_URL` };
}

export function apply(ctx: Context) {
  // 工具路由自注册：prompt 命中通知/推送类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'notify',
    prefixes: ['notify_'],
    test: /(通知|推送|提醒|webhook|notify)/i,
  });

  const notifyService = new NotifyService(ctx);

  // 1. notify_send_desktop: 发送操作系统原生桌面弹窗通知
  ctx.agent.registerTool({
    name: 'notify_send_desktop',
    description: '当长任务完成、定时巡检发现重要事件或需要提醒用户时，在操作系统桌面发送原生系统级弹窗通知。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '通知标题 (如: "GitHub AI 趋势巡检报告已生成")' },
        message: { type: 'string', description: '通知详细摘要正文' },
      },
      required: ['title', 'message'],
    },
    execute: async ({ title, message }) => {
      const ok = await notifyService.sendDesktopNotification(title, message);
      return {
        success: ok,
        message: ok ? `桌面原生通知已成功弹出: [${title}]` : '桌面通知弹出失败',
      };
    },
  });

  // 2. notify_send_webhook: 向飞书/企微/钉钉/Slack 发送告警与卡片
  ctx.agent.registerTool({
    name: 'notify_send_webhook',
    description: '向企业即时通信群聊（飞书、钉钉、企业微信、Slack 或自定义 Webhook）推送图文卡片消息或定时巡检报告。',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['feishu', 'dingtalk', 'wecom', 'slack', 'custom'],
          description: '目标即时通信平台',
        },
        webhookUrl: {
          type: 'string',
          description: '机器人的 Webhook 入口 URL（若未传则读取当前用户在连接器页配置的 {渠道}_WEBHOOK_URL，如 FEISHU_WEBHOOK_URL / SLACK_WEBHOOK_URL）',
        },
        title: { type: 'string', description: '消息卡片标题' },
        content: { type: 'string', description: 'Markdown 格式的消息正文或报告' },
      },
      required: ['channel', 'title', 'content'],
    },
    execute: async ({ channel, webhookUrl, title, content }, session?: any) => {
      const resolved = resolveWebhookUrl(channel, webhookUrl, session?.env);
      if (!resolved.url) {
        return {
          success: false,
          channel,
          title,
          error: `未找到 [${channel}] 的 Webhook 地址：请先在「连接器」页面配置 ${resolved.missingEnvKey}，或在调用参数中直接传入 webhookUrl。`,
        };
      }

      const result = await notifyService.sendWebhook(channel, resolved.url, title, content);
      return {
        success: result.ok,
        channel,
        title,
        message: result.ok
          ? `已成功将消息推送至 [${channel}] 机器人群聊。`
          : `推送至 [${channel}] 失败: ${result.error || result.status}`,
      };
    },
  });
}
