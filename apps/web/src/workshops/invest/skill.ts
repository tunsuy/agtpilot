/**
 * 投研工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 */
import { TrendingUp } from 'lucide-react';
import { buildInvestPrompt, INVEST_MODES } from './context';
import { str } from '../shared/params';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'invest',
    name: '投研工坊',
    category: 'invest',
    desc: '个股/基金体检 · 持仓组合体检 · 盘后复盘,数据带来源与时间戳',
    icon: TrendingUp,
    accent: 'emerald',
    deps: [
      { id: 'tushare', name: 'Tushare' },
      { id: 'a_stock', name: 'A股实时行情' },
      { id: 'alphavantage_mcp', name: 'Alpha Vantage' },
      { id: 'coingecko_mcp', name: 'CoinGecko' },
      { id: 'newsnow', name: '财经热榜' },
    ],
    // 工具白名单 D 层(docs §9.1):报告经确认后邮件投递;行情/热榜 MCP 由 deps
    // 自动映射,调研走缺省 full 档(含 research_subagent)
    activeTools: ['email_send'],
    note: '生成后跳转任务页,Agent 通过你已连接的行情连接器拉取实时行情与估值,财经热榜/网络搜索取新闻与市场热点,输出带来源与时间戳的结构化投研报告。全程只读:不执行任何交易、不动资金;报告经邮件/群机器人发送前需你确认。输出仅供参考,不构成投资建议。',
  },
  run: (params) => {
    const mode = str(params.mode, 'stock_check');
    return {
      prompt: buildInvestPrompt({
        mode,
        symbols: str(params.symbols),
        focus: str(params.focus),
        holdings: str(params.holdings),
        riskProfile: str(params.riskProfile, 'balanced'),
        markets: Array.isArray(params.markets) ? (params.markets as string[]) : ['a_share'],
        delivery: str(params.delivery, 'chat'),
      }),
      title: `投研 · ${INVEST_MODES.find((m) => m.id === mode)?.name || '投研'}`,
    };
  },
};
