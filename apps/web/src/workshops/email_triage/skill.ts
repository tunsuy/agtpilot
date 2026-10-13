/**
 * 邮件分诊工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 */
import { Inbox } from 'lucide-react';
import { buildEmailTriagePrompt, EMAIL_TRIAGE_SCOPES } from './context';
import { str } from '../shared/params';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'email_triage',
    name: '邮件分诊',
    category: 'office',
    desc: '收件箱自动分四级优先级,高优邮件草拟回复,发送前逐封经你确认',
    icon: Inbox,
    accent: 'sky',
    deps: [{ id: 'email_imap', name: '邮箱收件 (IMAP)', required: true }],
    note: '生成后跳转任务页,Agent 用 email_list/email_read 读取收件箱,输出总览 + 四级分诊清单(🔴立即/🟠今日/🟡稍后/⚪可忽略)与回复草稿。发送任何回复、改动邮件状态都需你逐封确认。需先在「电子邮件收件 (IMAP)」配置凭证(或已配 SMTP 会自动复用)。',
  },
  run: (params) => {
    const scope = str(params.scope, 'unread');
    return {
      prompt: buildEmailTriagePrompt({
        scope,
        focus: str(params.focus),
        draftReplies: params.draft !== false,
      }),
      title: `邮件分诊 · ${EMAIL_TRIAGE_SCOPES.find((s) => s.id === scope)?.name || '邮件'}`,
    };
  },
};
