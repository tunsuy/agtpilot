/**
 * 周报生成工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 */
import { ClipboardList } from 'lucide-react';
import { buildWeeklyReportPrompt, WEEKLY_REPORT_PERIODS } from './context';
import { str } from '../shared/params';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'weekly',
    name: '周报生成',
    category: 'office',
    desc: '从已连接的 Jira/GitHub/飞书/邮箱自动取材,结构化周报一键成稿',
    icon: ClipboardList,
    accent: 'sky',
    deps: [
      { id: 'atlassian_mcp', name: 'Jira' },
      { id: 'github_mcp', name: 'GitHub' },
      { id: 'lark_suite', name: '飞书' },
      { id: 'dingtalk_mcp', name: '钉钉' },
      { id: 'email', name: '邮箱' },
    ],
    // 工具白名单(docs §9.1):封闭数据源工坊 —— 不挂检索组(none);Jira/飞书/钉钉
    // MCP 由 deps 自动映射,email 三件走特例映射;GitHub MCP 整台禁入(大 schema
    // 放大器),周报取材只需只读 5 个精确名
    searchGroup: 'none',
    activeTools: [
      'mcp_github_mcp_list_commits',
      'mcp_github_mcp_search_issues',
      'mcp_github_mcp_list_pull_requests',
      'mcp_github_mcp_get_pull_request',
      'mcp_github_mcp_get_file_contents',
    ],
    note: '生成后跳转任务页,Agent 从你已连接的 Jira/GitHub/飞书/钉钉/腾讯会议/邮箱自动取材,输出结构化周报(概览/重点工作/数据看板/风险/下周计划)。先展示全文,投递(邮件/群机器人)需你确认;数据源都不可用时按补充要点整理。',
  },
  run: (params) => {
    const period = str(params.period, 'this_week');
    return {
      prompt: buildWeeklyReportPrompt({
        period,
        audience: str(params.audience, 'leader'),
        delivery: str(params.delivery, 'chat'),
        extras: str(params.extras),
      }),
      title: `周报生成 · ${WEEKLY_REPORT_PERIODS.find((p) => p.id === period)?.name || '周报'}`,
    };
  },
};
