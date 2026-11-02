/**
 * 运营流水聚合(纯函数,不碰磁盘;铁律6:vitest 真实用例见 __tests__/ops-aggregate.test.ts)。
 *
 * 输入 ops-ledger 的事件数组(时间升序与否都兼容),输出看板需要的四个视图:
 * - daily[]: 近 N 天逐日 {missions, activeUsers(DAU), tokens, failures}(空日补零)
 * - users[]: 每用户 {firstSeen, lastActive, missions, tokens, failed} + 昵称/邮箱
 *   (name/email 取该用户最近一次 user_login 事件 —— UserScopedData 不存这些,
 *   登录流水是唯一来源)
 * - totals: 窗口内汇总 + 今日快照(KPI 行)
 * - bySource / byOutcome: 渠道分布与结局分布(chips)
 *
 * 口径约定:
 * - 日界用服务器本地时区 YYYY-MM-DD(部署机为业务时区,看板按天粒度足够);
 * - DAU = 当日有 mission_started 或 usage 事件的用户(user_login 不算 —— 只登录
 *   不产生任务的用户计入「总用户」而非「活跃」);
 * - failures 只计 outcome='failed'(aborted/interrupted 是用户主动行为或进程
 *   重启,不是质量信号;它们在 byOutcome 里单列);
 * - daily/totals/bySource/byOutcome 按窗口过滤(近 N 天),users 表按全量流水
 *   (账本生命周期内的 firstSeen/累计量)——滚动截断后如实呈现,不假装完整。
 */
import type { OpsEvent, OpsSource } from './ops-ledger';

export interface OpsDailyPoint {
  /** 本地时区 YYYY-MM-DD */
  date: string;
  missions: number;
  activeUsers: number;
  tokens: number;
  failures: number;
}

export interface OpsUserRow {
  userId: string;
  name?: string;
  email?: string;
  /** 账本内该用户最早事件时刻(ms) */
  firstSeen: number;
  /** 账本内该用户最晚事件时刻(ms) */
  lastActive: number;
  /** 账本内累计:发起任务数 / tokens / 失败任务数 */
  missions: number;
  tokens: number;
  failed: number;
}

export interface OpsTotals {
  /** 账本内出现过的用户总数(含只登录未用) */
  users: number;
  /** 窗口内(近 N 天)汇总 */
  windowMissions: number;
  windowTokens: number;
  windowFailures: number;
  windowActiveUsers: number;
  /** 今日快照(KPI 行) */
  todayMissions: number;
  todayActiveUsers: number;
  todayTokens: number;
  todayFailures: number;
}

export interface OpsAggregate {
  daily: OpsDailyPoint[];
  users: OpsUserRow[];
  totals: OpsTotals;
  bySource: Record<OpsSource, number>;
  byOutcome: Record<'done' | 'failed' | 'aborted' | 'interrupted', number>;
}

/** 毫秒时间戳 → 服务器本地时区 YYYY-MM-DD */
export function opsDayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const EMPTY_SOURCES: Record<OpsSource, number> = { chat: 0, workshop: 0, cron: 0, channel: 0, background: 0 };
const EMPTY_OUTCOMES: OpsAggregate['byOutcome'] = { done: 0, failed: 0, aborted: 0, interrupted: 0 };

export function aggregateOps(events: OpsEvent[], nowMs: number, days = 30): OpsAggregate {
  const windowDays = Math.max(1, Math.min(365, Math.round(days) || 30));

  // 窗口起点 = 本地今日零点往前推 (windowDays-1) 天(含今日共 windowDays 个点)
  const now = new Date(nowMs);
  const startCal = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (windowDays - 1));
  const windowStartMs = startCal.getTime();

  // 预生成连续日期桶(空日补零,柱状图不断档)
  const dateOrder: string[] = [];
  const dailyByKey = new Map<string, OpsDailyPoint>();
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(startCal.getFullYear(), startCal.getMonth(), startCal.getDate() + i);
    const key = opsDayKey(d.getTime());
    dateOrder.push(key);
    dailyByKey.set(key, { date: key, missions: 0, activeUsers: 0, tokens: 0, failures: 0 });
  }

  const bySource: Record<OpsSource, number> = { ...EMPTY_SOURCES };
  const byOutcome: OpsAggregate['byOutcome'] = { ...EMPTY_OUTCOMES };

  // 每用户累计(全量流水,不窗口过滤)
  interface UserAcc {
    userId: string;
    name?: string;
    email?: string;
    firstSeen: number;
    lastActive: number;
    missions: number;
    tokens: number;
    failed: number;
  }
  const userAcc = new Map<string, UserAcc>();
  // 日活去重:`${dayKey}|${userId}`,只认 started/usage
  const dailyActive = new Set<string>();
  // mission_started 去重(理论上同 mission 只创建一次;防流水异常双计)
  const countedMissions = new Set<string>();
  // 窗口内活跃用户去重(totals.windowActiveUsers)
  const windowActiveUsers = new Set<string>();

  let windowMissions = 0;
  let windowTokens = 0;
  let windowFailures = 0;
  let todayMissions = 0;
  let todayTokens = 0;
  let todayFailures = 0;
  const todayKey = opsDayKey(nowMs);

  for (const ev of events) {
    if (!ev || typeof ev.at !== 'number') continue;
    const inWindow = ev.at >= windowStartMs && ev.at <= nowMs;
    const day = dailyByKey.get(opsDayKey(ev.at)); // 窗口外为 undefined
    const userId = (ev as { userId?: string }).userId;

    if (userId) {
      let acc = userAcc.get(userId);
      if (!acc) {
        acc = { userId, firstSeen: ev.at, lastActive: ev.at, missions: 0, tokens: 0, failed: 0 };
        userAcc.set(userId, acc);
      }
      if (ev.at < acc.firstSeen) acc.firstSeen = ev.at;
      if (ev.at > acc.lastActive) acc.lastActive = ev.at;
      if (ev.t === 'user_login') {
        // 最近一次登录的昵称/邮箱覆盖旧值(改名/换邮箱后看板跟上)
        if (ev.name) acc.name = ev.name;
        if (ev.email) acc.email = ev.email;
      }
    }

    switch (ev.t) {
      case 'mission_started': {
        const acc = userId ? userAcc.get(userId) : undefined;
        if (acc && !countedMissions.has(ev.missionId)) acc.missions++;
        if (countedMissions.has(ev.missionId)) break;
        countedMissions.add(ev.missionId);
        if (inWindow) {
          if (bySource[ev.source] === undefined) bySource[ev.source] = 0;
          bySource[ev.source]++;
        }
        if (inWindow && day && userId) {
          day.missions++;
          windowMissions++;
          windowActiveUsers.add(userId);
          const k = `${day.date}|${userId}`;
          if (!dailyActive.has(k)) {
            dailyActive.add(k);
            day.activeUsers++;
          }
          if (day.date === todayKey) todayMissions++;
        }
        break;
      }
      case 'usage': {
        const tokens = Math.max(0, ev.promptTokens || 0) + Math.max(0, ev.completionTokens || 0);
        const acc = userId ? userAcc.get(userId) : undefined;
        if (acc) acc.tokens += tokens;
        if (inWindow && day && userId) {
          day.tokens += tokens;
          windowTokens += tokens;
          windowActiveUsers.add(userId);
          const k = `${day.date}|${userId}`;
          if (!dailyActive.has(k)) {
            dailyActive.add(k);
            day.activeUsers++;
          }
          if (day.date === todayKey) todayTokens += tokens;
        }
        break;
      }
      case 'mission_finished': {
        const isFailure = ev.outcome === 'failed';
        const acc = userId ? userAcc.get(userId) : undefined;
        if (acc && isFailure) acc.failed++;
        if (inWindow && day) {
          if (EMPTY_OUTCOMES[ev.outcome] !== undefined) byOutcome[ev.outcome]++;
          else byOutcome[ev.outcome] = 1;
          if (isFailure) {
            day.failures++;
            windowFailures++;
            if (day.date === todayKey) todayFailures++;
          }
        }
        break;
      }
      case 'user_login':
        // 登录不计 DAU(口径见文件头);firstSeen/lastActive 已在上面更新
        break;
    }
  }

  const daily = dateOrder.map((k) => dailyByKey.get(k)!);
  const today = dailyByKey.get(todayKey);
  const users: OpsUserRow[] = Array.from(userAcc.values())
    .map(({ userId, name, email, firstSeen, lastActive, missions, tokens, failed }) => ({
      userId,
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      firstSeen,
      lastActive,
      missions,
      tokens,
      failed,
    }))
    .sort((a, b) => b.lastActive - a.lastActive);

  return {
    daily,
    users,
    totals: {
      users: userAcc.size,
      windowMissions,
      windowTokens,
      windowFailures,
      windowActiveUsers: windowActiveUsers.size,
      todayMissions: today && today.date === todayKey ? todayMissions : 0,
      todayActiveUsers: today && today.date === todayKey ? today.activeUsers : 0,
      todayTokens: today && today.date === todayKey ? todayTokens : 0,
      todayFailures: today && today.date === todayKey ? todayFailures : 0,
    },
    bySource,
    byOutcome,
  };
}
