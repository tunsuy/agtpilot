/**
 * 周报生成工坊(三期办公场景)
 *
 * 按用户已连接的 MCP(Jira/GitHub/飞书/钉钉/腾讯会议…)动态取材,
 * 缺数据源时降级为「用户口述 + Agent 整理」。
 * 红线:周报投递先展示全文,用户确认后才允许发送(邮件/群机器人)。
 */

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

export function buildWeeklyReportPrompt({ period, audience, delivery, extras }: WeeklyReportInput): string {
  const periodName = period === 'last_week' ? '上周(周一至周日)' : '本周(周一至今天)';
  const style = AUDIENCE_STYLE[audience] || AUDIENCE_STYLE.leader;
  const extrasText = (extras || '').trim();
  const extrasSection = extrasText
    ? `\n我口述的补充要点(数据源里可能没有,直接纳入周报):\n${extrasText}\n`
    : '';
  const deliverySection =
    delivery === 'email'
      ? `
投递方式:全文经我确认后,用 email_send 发送到我的邮箱(收件人问我;主题格式「周报 | <我的名字或岗位> | <日期范围>」)。未经确认严禁发送。`
      : delivery === 'webhook'
      ? `
投递方式:全文经我确认后,用 notify_send_webhook 推送到我已配置的群机器人(飞书/钉钉/企微/Slack,已连哪个用哪个;都没配置就只输出到对话)。未经确认严禁推送。`
      : `
投递方式:仅输出到对话,我自己复制。`;

  return `【周报生成工坊】
请为我生成${periodName}的工作周报。

第一步 · 自动取材(只用我已连接的平台,未连接/无数据的直接跳过,不要提示我去配置):
- Jira/Atlassian MCP(若已连):我经手的 issue 状态流转、完成/新增工单
- GitHub MCP(若已连):我的 commits、PR(创建/评审/合并)
- 飞书/钉钉 MCP(若已连):我的日程会议、完成与新增待办、日志/审批
- 腾讯会议 MCP(若已连):我参与的会议
- 邮箱(email_list/email_read,若已配置):${period === 'last_week' ? '上周' : '本周'}我发出/收到的关键工作邮件(只提取工作事项,忽略订阅与通知)
- 以上工具单次查询失败就跳过该来源,继续用其余来源,不要卡住重试${extrasSection}
第二步 · 生成周报,Markdown 结构:
1. **本周概览**:两三句话总结核心进展(结果导向,有数字用数字)
2. **重点工作**(3-6 条):每条「做了什么 → 结果/进展 → 下一步」,标注来源(如 [Jira] [GitHub] [会议]);素材不足的条目宁可少写,严禁编造工作内容
3. **数据看板**(有数据才输出):完成工单数 / 合并 PR 数 / 会议时长等,用小表格
4. **风险与求助**:延期风险、被阻塞事项、需要谁支持(没有就写「无」)
5. **下周计划**:3-5 条,与本周未尽事项和日程衔接

写作要求:${style}。
若所有数据源都不可用:基于我的补充要点整理成同样结构的周报,并在开头注明「素材来自口述,未接入自动数据源」。

第三步 · 交付:先把周报全文展示给我;${deliverySection.trim()}`;
}
