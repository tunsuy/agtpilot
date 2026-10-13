/**
 * 周报生成工坊 · 模板上下文(正文见 prompt.main.md)
 *
 * 按用户已连接的 MCP(Jira/GitHub/飞书/钉钉/腾讯会议…)动态取材,
 * 缺数据源时降级为「用户口述 + Agent 整理」。
 * 红线:周报投递先展示全文,用户确认后才允许发送(邮件/群机器人)。
 * 受众风格 / 投递方式是行内选择(不能整行消隐),以 styleNote / deliveryNote 注入。
 */

import prompt from './prompt.main.md';
import { renderTemplate } from '../engine';

// ---------- 周报生成工坊 ----------

export const WEEKLY_REPORT_PERIODS = [
  { id: 'this_week', name: '本周' },
  { id: 'last_week', name: '上周' },
] as const;

export const WEEKLY_REPORT_AUDIENCES = [
  { id: 'leader', name: '给领导' },
  { id: 'team', name: '给团队' },
  { id: 'self', name: '自己存档' },
] as const;

export const WEEKLY_REPORT_DELIVERIES = [
  { id: 'chat', name: '仅输出到对话' },
  { id: 'email', name: '确认后发邮件' },
  { id: 'webhook', name: '确认后发群机器人' },
] as const;

export type WeeklyReportPeriod = (typeof WEEKLY_REPORT_PERIODS)[number]['id'];
export type WeeklyReportAudience = (typeof WEEKLY_REPORT_AUDIENCES)[number]['id'];
export type WeeklyReportDelivery = (typeof WEEKLY_REPORT_DELIVERIES)[number]['id'];

export interface WeeklyReportInput {
  period: WeeklyReportPeriod | string;
  audience: WeeklyReportAudience | string;
  delivery: WeeklyReportDelivery | string;
  /** 可选:补充要点(口述的额外工作,数据源里没有的) */
  extras?: string;
}

const AUDIENCE_STYLE: Record<string, string> = {
  leader:
    '读者是我的直属领导:结论先行、突出业务价值与结果数据、风险要写明但附上应对方案,控制在 500 字内,不流水账',
  team:
    '读者是团队同事:突出协作事项与依赖关系、明确下周我需要谁配合什么,可以带一点轻松语气,控制在 600 字内',
  self:
    '读者是我自己(存档复盘):尽量详尽,保留过程细节与踩坑记录,便于日后回顾,不限字数',
};

const DELIVERY_NOTE: Record<string, string> = {
  email:
    '投递方式:全文经我确认后,用 email_send 发送到我的邮箱(收件人问我;主题格式「周报 | <我的名字或岗位> | <日期范围>」)。未经确认严禁发送。',
  webhook:
    '投递方式:全文经我确认后,用 notify_send_webhook 推送到我已配置的群机器人(飞书/钉钉/企微/Slack,已连哪个用哪个;都没配置就只输出到对话)。未经确认严禁推送。',
  chat: '投递方式:仅输出到对话,我自己复制。',
};

export function buildWeeklyReportPrompt({ period, audience, delivery, extras }: WeeklyReportInput): string {
  return renderTemplate(prompt, {
    periodName: period === 'last_week' ? '上周(周一至周日)' : '本周(周一至今天)',
    periodWord: period === 'last_week' ? '上周' : '本周',
    styleNote: AUDIENCE_STYLE[audience] || AUDIENCE_STYLE.leader,
    deliveryNote: DELIVERY_NOTE[delivery] || DELIVERY_NOTE.chat,
    extras: (extras || '').trim(),
  });
}
