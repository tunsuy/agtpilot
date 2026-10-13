/**
 * 邮件分诊工坊 · 模板上下文(正文见 prompt.main.md)
 *
 * 与内容工坊同一模式:UI 收集结构化选项 → 生成 Prompt → 作为新任务交给 Agent。
 * 数据来自 email_list / email_read 工具(IMAP 收件)。
 * 红线:分诊只产出「建议与草稿」,发送回复必须经用户确认(用 email_send 前需用户点头)。
 */

import prompt from './prompt.main.md';
import { renderTemplate } from '../engine';

// ---------- 邮件分诊工坊 ----------

export const EMAIL_TRIAGE_SCOPES = [
  { id: 'unread', name: '全部未读' },
  { id: 'today', name: '今天' },
  { id: '3days', name: '最近 3 天' },
  { id: 'week', name: '本周' },
] as const;

export type EmailTriageScope = (typeof EMAIL_TRIAGE_SCOPES)[number]['id'];

export interface EmailTriageInput {
  /** 时间/未读范围(EMAIL_TRIAGE_SCOPES 之一) */
  scope: EmailTriageScope | string;
  /** 可选:用户特别关注的事项(如「老板的邮件」「合同相关」) */
  focus?: string;
  /** 是否为高优邮件起草回复 */
  draftReplies: boolean;
}

const SCOPE_PARAMS: Record<string, { unreadOnly?: boolean; sinceDays?: number; desc: string }> = {
  unread: { unreadOnly: true, desc: '收件箱全部未读邮件' },
  today: { sinceDays: 1, desc: '最近 1 天收到的邮件' },
  '3days': { sinceDays: 3, desc: '最近 3 天收到的邮件' },
  week: { sinceDays: 7, desc: '最近 7 天收到的邮件' },
};

export function buildEmailTriagePrompt({ scope, focus, draftReplies }: EmailTriageInput): string {
  const p = SCOPE_PARAMS[scope] || SCOPE_PARAMS.unread;
  const toolArgs = [
    p.unreadOnly ? 'unreadOnly=true' : '',
    p.sinceDays ? `sinceDays=${p.sinceDays}` : '',
    'limit=50',
  ]
    .filter(Boolean)
    .join(', ');
  return renderTemplate(prompt, {
    scopeDesc: p.desc,
    toolArgs,
    focus: (focus || '').trim(),
    draftReplies: Boolean(draftReplies),
  });
}
