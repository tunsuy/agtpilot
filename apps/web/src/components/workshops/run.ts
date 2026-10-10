/**
 * 工坊 → Agent 任务的统一出口:按工坊 id 分发到各 lib 的 Prompt 构建器。
 * 表单提交与「一键重跑」共用这一份逻辑,保证两处生成的任务完全一致。
 */
import { buildXhsWorkshopPrompt } from '../../lib/xhs-workshop';
import { buildWechatMpWorkshopPrompt } from '../../lib/wechat-mp-workshop';
import {
  buildWeiboWorkshopPrompt,
  buildVideoScriptPrompt,
} from '../../lib/content-workshops';
import { buildEmailTriagePrompt, buildWeeklyReportPrompt } from '../../lib/office-workshops';
import { buildInvestPrompt, INVEST_MODES } from '../../lib/invest-workshops';
import { buildEduPrompt, EDU_MODES } from '../../lib/edu-workshops';
import { EMAIL_TRIAGE_SCOPES, WEEKLY_REPORT_PERIODS } from '../../lib/office-workshops';
import type { WorkshopId } from './registry';
import type { ScenarioProfile } from '../../lib/scenario-profile';

export interface WorkshopRun {
  prompt: string;
  title: string;
}

/** 运行上下文:场景档案等表单之外的状态,表单与「一键重跑」共用 */
export interface WorkshopRunContext {
  scenarioProfile?: ScenarioProfile;
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 1) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export function buildWorkshopRun(
  id: WorkshopId,
  params: Record<string, unknown>,
  ctx?: WorkshopRunContext
): WorkshopRun {
  switch (id) {
    case 'xhs': {
      const style = str(params.style, '种草推荐');
      return {
        prompt: buildXhsWorkshopPrompt({
          topic: str(params.topic),
          style,
          count: num(params.count),
          ...(ctx?.scenarioProfile ? { profile: ctx.scenarioProfile } : {}),
        }),
        title: `小红书内容工坊 · ${style}`,
      };
    }
    case 'wechat_mp': {
      const style = str(params.style, '深度长文');
      return {
        prompt: buildWechatMpWorkshopPrompt({
          topic: str(params.topic),
          style,
          count: num(params.count),
          ...(ctx?.scenarioProfile ? { profile: ctx.scenarioProfile } : {}),
        }),
        title: `公众号文章工坊 · ${style}`,
      };
    }
    case 'weibo': {
      const style = str(params.style, '热点点评');
      return {
        prompt: buildWeiboWorkshopPrompt({
          topic: str(params.topic),
          style,
          count: num(params.count),
        }),
        title: `微博内容工坊 · ${style}`,
      };
    }
    case 'video_douyin':
    case 'video_bilibili': {
      const platform = id === 'video_bilibili' ? 'bilibili' : 'douyin';
      const duration = str(params.duration, '60 秒');
      return {
        prompt: buildVideoScriptPrompt({
          topic: str(params.topic),
          platform,
          duration,
          count: num(params.count),
        }),
        title: `${platform === 'bilibili' ? 'B站' : '抖音'}短视频脚本工坊 · ${duration}`,
      };
    }
    case 'email_triage': {
      const scope = str(params.scope, 'unread');
      return {
        prompt: buildEmailTriagePrompt({
          scope,
          focus: str(params.focus),
          draftReplies: params.draft !== false,
        }),
        title: `邮件分诊 · ${EMAIL_TRIAGE_SCOPES.find((s) => s.id === scope)?.name || '邮件'}`,
      };
    }
    case 'weekly': {
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
    }
    case 'invest': {
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
    }
    case 'edu': {
      const mode = str(params.mode, 'literature_review');
      return {
        prompt: buildEduPrompt({
          mode,
          topic: str(params.topic),
          focus: str(params.focus),
          paper: str(params.paper),
          subject: str(params.subject),
          grade: str(params.grade),
          duration: str(params.duration),
          extras: str(params.extras),
          material: str(params.material),
          cardType: str(params.cardType, 'mixed'),
          cardFormat: str(params.cardFormat, 'anki_csv'),
          delivery: str(params.delivery, 'chat'),
        }),
        title: `教研 · ${EDU_MODES.find((m) => m.id === mode)?.name || '教研'}`,
      };
    }
  }
}
