/**
 * 投研工坊 · 模板上下文(三模式各一个模板文件 + 两段共享正文)
 *
 * 与办公工坊(weekly/email_triage 包)同一模式:UI 收集结构化选项 → 生成 Prompt →
 * onRunPrompt 作为新任务交给 Agent 执行。行情数据全部来自用户已连接的 MCP 连接器:
 * - Tushare(A股/基金/财务/宏观)、Alpha Vantage(美股/外汇/大宗商品/加密货币)、
 *   CoinGecko(加密货币)、A股实时行情 AkShare(本地 stdio);
 * - 消息面热榜:全网热榜 NewsNow(mcp_newsnow,含财联社/金十数据等财经榜);
 * - 缺数据源时用网络搜索尽力而为并明示,绝不编造行情数字。
 *
 * 模板拆分:prompt.stock_check / portfolio_check / daily_review 三模式模板;
 * 数据源规则与合规红线为三模式共享单源(prompt.data-sources.md / prompt.compliance.md,
 * 无变量,渲染即剥惯例尾行)。关注点/投递方式为行内选择,经变量注入。
 *
 * 合规红线:所有输出仅供参考、不构成投资建议;关键数据必须标注来源与时间戳;
 * 不承诺收益;工坊全程只读投研,不调用任何交易接口、不下单、不动资金;
 * 报告投递(邮件/群机器人)必须先展示全文、经用户确认。
 */
import stockTpl from './prompt.stock_check.md';
import portfolioTpl from './prompt.portfolio_check.md';
import dailyTpl from './prompt.daily_review.md';
import dataSourcesTpl from './prompt.data-sources.md';
import complianceTpl from './prompt.compliance.md';
import { renderTemplate } from '../engine';

// ---------- 工坊模式 ----------

export const INVEST_MODES = [
  { id: 'stock_check', name: '个股/基金体检' },
  { id: 'portfolio_check', name: '组合体检' },
  { id: 'daily_review', name: '盘后复盘' },
] as const;

export type InvestMode = (typeof INVEST_MODES)[number]['id'];

// ---------- 盘后复盘:覆盖市场(可多选) ----------

export const REVIEW_MARKETS = [
  { id: 'a_share', name: 'A股' },
  { id: 'hk_us', name: '港股美股' },
  { id: 'crypto', name: '加密货币' },
] as const;

export type ReviewMarket = (typeof REVIEW_MARKETS)[number]['id'];

// ---------- 组合体检:风险偏好 ----------

export const RISK_PROFILES = [
  { id: 'conservative', name: '保守型' },
  { id: 'balanced', name: '平衡型' },
  { id: 'aggressive', name: '进取型' },
] as const;

export type RiskProfile = (typeof RISK_PROFILES)[number]['id'];

// ---------- 报告投递方式(与周报工坊一致) ----------

export const INVEST_DELIVERIES = [
  { id: 'chat', name: '仅输出到对话' },
  { id: 'email', name: '确认后发邮件' },
  { id: 'webhook', name: '确认后发群机器人' },
] as const;

export type InvestDelivery = (typeof INVEST_DELIVERIES)[number]['id'];

export interface InvestWorkshopInput {
  mode: InvestMode | string;
  /** stock_check:标的代码列表(逗号/空格分隔) */
  symbols?: string;
  /** stock_check:额外关注点(如「重点看分红」「对比同行业」) */
  focus?: string;
  /** portfolio_check:持仓描述(代码+数量或占比+成本,自由格式) */
  holdings?: string;
  /** portfolio_check:风险偏好 */
  riskProfile?: RiskProfile | string;
  /** daily_review:覆盖市场(多选) */
  markets?: string[];
  /** 报告投递方式 */
  delivery?: InvestDelivery | string;
}

const RISK_NAMES: Record<string, string> = {
  conservative: '保守型(重视本金安全与低波动)',
  balanced: '平衡型(可承受中等波动换取长期增值)',
  aggressive: '进取型(愿承担高波动追求高弹性)',
};

const DELIVERY_NOTE: Record<string, string> = {
  email:
    '投递方式:报告先完整展示给我;经我确认后用 email_send 发送到我指定的邮箱(收件地址向我确认后再发,未经确认严禁发送)。',
  webhook:
    '投递方式:报告先完整展示给我;经我确认后用 notify_send_webhook 推送到我已配置的群机器人(飞书/钉钉/企微/Slack,未经确认严禁发送)。',
  chat: '投递方式:直接输出到对话即可。',
};

export function buildInvestPrompt(input: InvestWorkshopInput): string {
  const mode = String(input.mode || 'stock_check');
  const delivery = String(input.delivery || 'chat');
  // 共享段:模板无变量,渲染即剥惯例尾行
  const dataSources = renderTemplate(dataSourcesTpl, {});
  const complianceFooter = renderTemplate(complianceTpl, {});
  const deliveryNote = DELIVERY_NOTE[delivery] || DELIVERY_NOTE.chat;

  if (mode === 'portfolio_check') {
    const holdings = (input.holdings || '').trim();
    const risk = RISK_NAMES[String(input.riskProfile || 'balanced')] || RISK_NAMES.balanced;
    return renderTemplate(portfolioTpl, {
      dataSources,
      complianceFooter,
      deliveryNote,
      holdings: holdings || '(未填写——先向我询问持仓明细,拿到后再继续)',
      risk,
    });
  }

  if (mode === 'daily_review') {
    const markets = (input.markets && input.markets.length ? input.markets : ['a_share']).map(String);
    const marketLines: string[] = [];
    if (markets.includes('a_share')) {
      marketLines.push(
        '   - A股:上证/深成/创业板指数收盘与涨跌幅、两市成交额、涨跌家数、领涨领跌行业前三、重要盘后公告'
      );
    }
    if (markets.includes('hk_us')) {
      marketLines.push(
        '   - 港股美股:恒生指数与恒生科技、纳斯达克/标普500(注明是最近收盘还是盘前)、中概股亮点、隔夜重要事件'
      );
    }
    if (markets.includes('crypto')) {
      marketLines.push(
        '   - 加密货币:BTC/ETH 最新价与 24h 涨跌、总市值变化、资金费率或链上异动等值得注意的信号'
      );
    }
    return renderTemplate(dailyTpl, {
      dataSources,
      complianceFooter,
      deliveryNote,
      marketNames: markets.map((m) => REVIEW_MARKETS.find((x) => x.id === m)?.name || m).join('、'),
      marketLines: marketLines.join('\n'),
    });
  }

  // stock_check(默认)
  const symbols = (input.symbols || '').trim();
  const focusText = (input.focus || '').trim();
  return renderTemplate(stockTpl, {
    dataSources,
    complianceFooter,
    deliveryNote,
    symbols: symbols || '(未填写——先向我询问要体检哪些标的,拿到后再继续)',
    focusSection: focusText ? `\n我的额外关注点:${focusText}(体检时优先展开这一维度)` : '',
  });
}
