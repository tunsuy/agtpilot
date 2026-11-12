import { Context, Service } from '@deepseek-ai/cordis';
import { execFile } from 'child_process';
import { promisify } from 'util';
import '@agtpilot/core';

const execFileAsync = promisify(execFile);

export const name = 'agtpilot-plugin-notify';
export const inject = ['agent'];

export class NotifyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'notify');
  }

  async sendDesktopNotification(title: string, message: string): Promise<boolean> {
    // 数组参数 execFile：不经 shell，title/message 中任何字符都不可能被解释为命令
    if (process.platform !== 'darwin') {
      return false;
    }
    try {
      // AppleScript 字符串字面量转义（\\ 与 "）—— 只影响脚本语法合法性，无注入面
      const esc = (s: string) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await execFileAsync('osascript', [
        '-e',
        `display notification "${esc(message)}" with title "${esc(title)}"`,
      ]);
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
 * 1. 任务级 session.env 注入的当前用户凭证（连接器页保存的 {CHANNEL}_WEBHOOK_URL，
 *    经 agent-backend taskEnv 白名单透传，用户间互相隔离）—— 优先级最高：
 *    模型参数是可被提示注入操纵的外部输入，绝不允许覆盖用户自己配置的地址
 *    （否则会出现「把用户私密报告转发到攻击者 webhook」的数据外传路径）；
 * 2. 调用参数显式传入的 webhookUrl（用户在对话里明确给出的地址兜底）；
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
    sessionEnv?.[`${ch}_WEBHOOK_URL`] ||
    (webhookUrl || '').trim() ||
    process.env[`${ch}_WEBHOOK_URL`] ||
    process.env[`${ch}_WEBHOOK`];
  if (url) return { url };
  return { missingEnvKey: `${ch}_WEBHOOK_URL` };
}

export function apply(ctx: Context) {
  // 工具路由自注册：prompt 命中通知/推送类关键词时挂载本插件工具组
  ctx.agent.registerToolRoute({
    id: 'notify',
    prefixes: ['notify', 'notify_'],
    test: /(通知|推送|提醒|webhook|notify)/i,
  });

  const notifyService = new NotifyService(ctx);

  // 1. notify:桌面原生弹窗(channel=desktop)或企业 IM 群机器人(feishu/dingtalk/wecom/slack/custom)
  ctx.agent.registerTool({
    name: 'notify',
    description:
      '发送用户通知。channel=desktop:在操作系统桌面发送原生系统级弹窗(仅 macOS;适用于长任务完成、定时巡检发现重要事件)。' +
      'channel=feishu/dingtalk/wecom/slack/custom:向企业即时通信群机器人推送图文卡片消息或定时巡检报告(webhookUrl 缺省时读取当前用户连接器页配置的 {渠道}_WEBHOOK_URL)。',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['desktop', 'feishu', 'dingtalk', 'wecom', 'slack', 'custom'],
          description: 'desktop = 系统桌面弹窗;其余为企业 IM 群机器人渠道',
        },
        webhookUrl: {
          type: 'string',
          description: 'channel 为企业 IM 时的机器人 Webhook URL（缺省读取连接器配置的 {渠道}_WEBHOOK_URL）',
        },
        title: { type: 'string', description: '通知标题 / 消息卡片标题' },
        content: { type: 'string', description: '通知摘要正文（企业 IM 渠道支持 Markdown）' },
      },
      required: ['channel', 'title', 'content'],
    },
    execute: async ({ channel, webhookUrl, title, content }, session?: any) => {
      if (channel === 'desktop') {
        const ok = await notifyService.sendDesktopNotification(title, content);
        return {
          success: ok,
          channel,
          message: ok
            ? `桌面原生通知已成功弹出: [${title}]`
            : `桌面通知弹出失败（当前平台: ${process.platform}，仅 macOS 支持；或系统通知服务不可用）`,
        };
      }
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
