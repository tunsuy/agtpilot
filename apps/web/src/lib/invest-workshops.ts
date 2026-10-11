/**
 * 投研工坊 · 个股/基金体检 · 持仓组合体检 · 每日盘后复盘(投资理财场景)
 *
 * 与办公工坊(office-workshops.ts)同一模式:UI 收集结构化选项 → 生成 Prompt →
 * onRunPrompt 作为新任务交给 Agent 执行。行情数据全部来自用户已连接的 MCP 连接器:
 * - Tushare(A股/基金/财务/宏观)、Alpha Vantage(美股/外汇/大宗商品/加密货币)、
 *   CoinGecko(加密货币)、A股实时行情 AkShare(本地 stdio);
 * - 消息面热榜:全网热榜 NewsNow(mcp_newsnow,含财联社/金十数据等财经榜);
 * - 缺数据源时用网络搜索尽力而为并明示,绝不编造行情数字。
 *
 * 合规红线:所有输出仅供参考、不构成投资建议;关键数据必须标注来源与时间戳;
 * 不承诺收益;工坊全程只读投研,不调用任何交易接口、不下单、不动资金;
 * 报告投递(邮件/群机器人)必须先展示全文、经用户确认。
 */

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

/** 数据源使用规则(所有模式共用):按已连连接器取材,缺失降级为网络搜索并明示 */
const DATA_SOURCE_RULES = `数据源使用规则(只用已连接的,缺失的直接跳过,不要反复重试):
- A股/基金行情、财务报表、宏观数据:优先 Tushare 工具与 A股实时行情工具(a_stock 开头)
- 美股/外汇/大宗商品/加密货币行情与基本面:Alpha Vantage 工具(alphavantage 开头)
- 加密货币价格/市值/链上数据:CoinGecko 工具(coingecko 开头)
- 新闻、公告、研报观点、市场热点:若已连接全网热榜 NewsNow(mcp_newsnow_*,含财联社/金十数据/华尔街见闻等财经热榜)优先用它取热点,配合网络搜索工具交叉补充
若以上行情连接器一个都没配置,用网络搜索尽力完成,并在报告开头注明「未配置行情连接器,数据可能有延迟;建议到连接器页配置 Tushare / Alpha Vantage / CoinGecko / A股实时行情以获得精确实时数据」。`;

const COMPLIANCE_FOOTER = `合规红线(必须遵守):
- 所有输出仅供参考,不构成投资建议;报告末尾附一行免责声明。
- 每个关键数据标注来源与数据时间戳;拿不到实时数据就明确标注延迟或缺失,严禁编造数字。
- 不承诺、不暗示收益;给出看多/看空观点时必须同时列出反向风险。
- 本次任务为只读投研:严禁调用任何交易类接口、严禁下单、严禁划转资金。`;

function deliverySection(delivery: string): string {
  if (delivery === 'email') {
    return `投递方式:报告先完整展示给我;经我确认后用 email_send 发送到我指定的邮箱(收件地址向我确认后再发,未经确认严禁发送)。`;
  }
  if (delivery === 'webhook') {
    return `投递方式:报告先完整展示给我;经我确认后用 notify_send_webhook 推送到我已配置的群机器人(飞书/钉钉/企微/Slack,未经确认严禁发送)。`;
  }
  return `投递方式:直接输出到对话即可。`;
}

export function buildInvestPrompt(input: InvestWorkshopInput): string {
  const mode = String(input.mode || 'stock_check');
  const delivery = String(input.delivery || 'chat');

  if (mode === 'portfolio_check') {
    const holdings = (input.holdings || '').trim();
    const risk = RISK_NAMES[String(input.riskProfile || 'balanced')] || RISK_NAMES.balanced;
    return `【投研工坊 · 持仓组合体检】
${DATA_SOURCE_RULES}

我的持仓(自由格式,含代码/数量或占比/成本,信息不全时按可得信息分析):
${holdings || '(未填写——先向我询问持仓明细,拿到后再继续)'}

我的风险偏好:${risk}

步骤:
1. 解析持仓清单;代码或数量含义不明确的地方,先列出你的理解向我确认,不要猜。
2. 拉取各标的最新价格,计算:总市值、每笔持仓占比、浮动盈亏(提供了成本时)。
3. 组合诊断:
   - 配置结构:股票/基金/加密/现金类权重分布;单一持仓占比超 30% 的集中度提示
   - 市场与行业暴露:A股/港美股/加密比例,行业集中度,重仓标的之间的相关性(同涨同跌风险)
   - 风险评估:组合整体波动特征与我的风险偏好(${risk})是否匹配;给一个压力情景推演(如单一市场急跌 20% 时组合预计回撤)
   - 优化方向:再平衡建议只给方向与理由(如「降低单一行业暴露」「补充防御性资产」),不给具体买卖指令
4. 输出结构化体检报告,末尾给组合健康评分(0-100)与分项得分(分散度/风险匹配/流动性)。
${deliverySection(delivery)}

${COMPLIANCE_FOOTER}`;
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
    return `【投研工坊 · 每日盘后复盘】
${DATA_SOURCE_RULES}

覆盖市场:${markets
      .map((m) => REVIEW_MARKETS.find((x) => x.id === m)?.name || m)
      .join('、')}
${marketLines.length ? `\n步骤:\n1. 分市场拉取今日(非交易日则最近一个交易日,并注明日期)核心数据:\n${marketLines.join(
      '\n'
    )}\n2. 「今日要闻」3-5 条:每条一句话事实 + 一句话对市场的影响分析,标注来源与时间。\n3. 「明日关注」:即将公布的宏观数据、财报、解禁、重要会议等日历事件。\n4. 收尾问我:是否需要把本复盘设置为每个交易日收盘后自动执行并推送(用平台的定时任务能力),需要的话跟我确认执行时间与推送渠道。` : ''}
${deliverySection(delivery)}

${COMPLIANCE_FOOTER}`;
  }

  // stock_check(默认)
  const symbols = (input.symbols || '').trim();
  const focusText = (input.focus || '').trim();
  const focusSection = focusText ? `\n我的额外关注点:${focusText}(体检时优先展开这一维度)` : '';
  return `【投研工坊 · 个股/基金体检】
${DATA_SOURCE_RULES}

体检标的:${symbols || '(未填写——先向我询问要体检哪些标的,拿到后再继续)'}
(代码格式参考:A股 600519 或 600519.SH、港股 00700、美股 AAPL、公募基金 110022、加密货币 BTC)${focusSection}

步骤:
1. 逐个解析标的所属市场与标准代码,拉取数据(拉不到的部分明确标注,不要编造)。
2. 每个标的输出一张「体检卡」:
   - 基本信息:名称/市场/行业(基金则给类型/规模/管理人)
   - 行情快照:最新价、当日涨跌、近 5 日/20 日/年初至今表现(标注数据时间戳)
   - 估值水位:PE/PB/股息率(股票)或净值/阶段回报/最大回撤(基金),与自身历史区间和同业对比,给出「低估/合理/偏高」判断
   - 基本面速览:最近一期营收与利润增速、ROE、负债率(股票);持仓风格与集中度(基金);市值排名与热度(加密货币)
   - 近期动态:最新新闻/公告/研报观点 3 条以内,各标注来源与日期
   - 综合信号:🟢 健康 / 🟡 需关注 / 🔴 有风险,一句话理由 + 主要反向风险
3. 标的多于一个时,末尾输出横向对比表(估值/成长/风险三维度)。
${deliverySection(delivery)}

${COMPLIANCE_FOOTER}`;
}
