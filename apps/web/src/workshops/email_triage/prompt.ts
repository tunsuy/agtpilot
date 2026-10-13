/**
 * 邮件分诊工坊(三期办公场景)
 *
 * 与内容工坊同一模式:UI 收集结构化选项 → 生成 Prompt → 作为新任务交给 Agent。
 * 数据来自 email_list / email_read 工具(IMAP 收件)。
 * 红线:分诊只产出「建议与草稿」,发送回复必须经用户确认(用 email_send 前需用户点头)。
 */

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
  const focusText = (focus || '').trim();
  const focusSection = focusText
    ? `\n我特别关注:${focusText}(命中该关注点的邮件优先级自动上调一级)`
    : '';
  const draftSection = draftReplies
    ? `
4.【回复草稿】对每封「🔴 需立即处理」与「🟠 今日处理」邮件,起草一份可直接发送的中文回复(语气与我平时一致:专业、简洁、有明确下一步;需要我补充信息的地方用【待我确认:…】标出)。草稿只是给我过目,严禁未经我确认就调用 email_send 发送任何回复。`
    : '';

  return `【邮件分诊工坊】
请帮我分诊${p.desc},步骤:

1. 用 email_list 工具拉取列表(${toolArgs});对需要判断内容的邮件用 email_read 按 uid 读全文(单封正文很长时读摘要即可,不必逐封全读;总读取封数控制在 20 封以内,超出的按列表信息粗分)。${focusSection}
2. 输出「收件箱总览」:共几封、未读几封、发件人 Top3、时间跨度,一句话概括今天邮箱的整体情况。
3. 输出「分诊清单」,按四级分类,每级内按时间倒序:
   - 🔴 需立即处理:明确deadline在今天/语气紧急/重要人直接指派(列出:发件人、主题、要做什么、截止时间)
   - 🟠 今日处理:需要我回复或行动但不紧急
   - 🟡 稍后阅读:资讯/周报/通知类,给一句话摘要
   - ⚪ 可忽略:订阅营销/系统自动邮件(列出发件人即可,并给出退订建议)
   分类拿不准时读全文再定级;宁可高估优先级,不要漏掉重要邮件。${draftSection}

完成后问我:是否需要按草稿逐封确认后用 email_send 发送回复,或对某封邮件深入处理(如整理成任务、约会议)。
安全红线:未经我逐封确认,严禁发送邮件、严禁改动邮件状态(标记已读/删除/移动)。`;
}
