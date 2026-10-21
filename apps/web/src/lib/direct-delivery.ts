/**
 * 工坊直连投递(「文档+脚本」模式的服务端执行体)
 *
 * 背景(生产实例 2026-10-11):旧「投草稿箱」按钮走续聊 —— 把整篇正文内嵌进
 * 消息重新过一遍模型,模型再把正文逐字回显成工具参数。正文双向过模型,token
 * 白花;且模型偶发不守「纯执行」边界(重跑检索/重拟标题)。定稿正文其实早已
 * 落在 mission.artifact(服务端文档),投递只是「按文档调工具」的机械步骤 ——
 * 于是把执行体沉到服务端:卡片按钮 → POST /api/workshops/deliver → 本模块
 * 直调既有落稿工具(与模型路径同一实现、同一审计),正文全程不过模型。
 *
 * HIL 边界:前端点击前有确认弹窗(工坊包 confirmText 文案);工具自身的
 * dangerLevel/审批语义不变 —— 直连路径由「用户点按钮+弹窗确认」承担审批,
 * 等价于旧编排审批门的逐次放行。
 *
 * 安全约束:
 * - 平台白名单:只认注册表里的三个落稿工具,未知平台直接拒绝;
 * - 参数白名单:每个平台只挑自己工具契约内的键,多余键(含恶意注入)丢弃;
 * - 复用既有工具实现:每日频控/凭证读取/审计日志(appendBrowserAudit 带
 *   missionId)全部原样生效,本模块不另开后门。
 */
import type { ToolDefinition } from '@agtpilot/core';
import type { Mission, MissionStep } from '../types/agent';
import { WECHAT_MD_THEMES } from './wechat-md-themes';

/** 支持直连投递的平台(与工坊包 draft.direct.platform 一一对应) */
export type DirectDeliveryPlatform = 'wechat_mp' | 'zhihu' | 'xhs';

export interface DirectDeliverySuccess {
  success: true;
  tool: string;
  /** 净化/补参后实际传给工具的参数(台账步骤记录用,与审计一致) */
  args: Record<string, unknown>;
  /** 工具原始返回(含 message/配额提示等,前端可展示) */
  result: unknown;
}

export interface DirectDeliveryFailure {
  success: false;
  /** true = 工具被托管门/浏览器缺失挡住(未配置),前端展示引导文案 */
  gated?: boolean;
  error: string;
  tool?: string;
}

export type DirectDeliveryResult = DirectDeliverySuccess | DirectDeliveryFailure;

/** 单平台投递器声明(注册表条目;测试可注入假实现) */
export interface PlatformDeliverer {
  /** 落稿工具名(与工坊 draft.deliverTool 一致) */
  toolName: string;
  /** 该工具必填参数(缺任一 → 直接拒绝,不进工具) */
  required: string[];
  /** 参数白名单挑拣 + 类型净化(丢多余键,防注入) */
  sanitizeArgs: (args: Record<string, unknown>) => Record<string, unknown>;
  /** 工具工厂(与 tool-providers 同一实现;browser 缺失时托管类工厂自然不吐写工具) */
  buildTools: (userId: string, browser?: unknown) => ToolDefinition[];
  /** 工具未就绪(托管门未开/浏览器缺失)时的用户引导文案 */
  gatedHint: string;
  /**
   * 可选的服务端上下文补参:直连 payload 只带定稿字段,其余执行参数
   * (如公众号排版主题)由服务端从 mission 文档侧取,不劳前端/模型。
   */
  enrichArgs?: (
    args: Record<string, unknown>,
    mission: Mission | undefined,
  ) => Record<string, unknown>;
}

/** 只留非空字符串键(白名单挑拣的公共基元) */
function pickStrings(
  args: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = args?.[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

/**
 * 默认注册表:懒构建 + 动态 import —— 只有真正走直连投递的请求才会拉起
 * 三个工具模块(它们背后是浏览器服务/凭证读取等重依赖),测试注入假注册表
 * 时完全不触碰。
 */
export async function getDefaultDeliverers(): Promise<
  Record<DirectDeliveryPlatform, PlatformDeliverer>
> {
  const [{ buildWechatMpTools }, { buildZhihuManagedTools }, { buildXhsManagedTools }] =
    await Promise.all([
      import('./wechat-mp'),
      import('./zhihu-managed'),
      import('./xhs-managed'),
    ]);
  return {
    wechat_mp: {
      toolName: 'wechat_mp_create_draft',
      required: ['title', 'markdown'],
      sanitizeArgs: (args) =>
        pickStrings(args, [
          'title',
          'markdown',
          'digest',
          'theme',
          'author',
          'cover_url',
          'cover_keywords',
          'content_source_url',
        ]),
      buildTools: (userId, browser) =>
        buildWechatMpTools(userId, browser as never) as ToolDefinition[],
      gatedHint:
        '公众号草稿工具未就绪:请到连接器页「微信公众号(草稿箱直连)」卡片配置 AppID:AppSecret(需已认证公众号 + IP 白名单)后重试。',
      enrichArgs: (args, mission) => {
        if (args.theme || !mission) return args;
        const theme = extractThemeFromMission(mission);
        return theme ? { ...args, theme } : args;
      },
    },
    zhihu: {
      toolName: 'zhihu_save_article_draft',
      required: ['title', 'body'],
      sanitizeArgs: (args) => pickStrings(args, ['title', 'body']),
      buildTools: (userId, browser) =>
        buildZhihuManagedTools(userId, browser as never) as ToolDefinition[],
      gatedHint:
        '知乎托管写工具未注入:需先在连接器页「知乎」卡片扫码登录并开启托管模式,且服务端浏览器已就绪,然后重试。',
    },
    xhs: {
      toolName: 'xhs_save_note_draft',
      required: ['title', 'body'],
      sanitizeArgs: (args) => {
        const out = pickStrings(args, ['title', 'body']);
        // tags:只留字符串、去 # 前缀、剔空、截断到 10(工具 schema 上限的二次防线)
        if (Array.isArray(args?.tags)) {
          const tags = (args.tags as unknown[])
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim().replace(/^#+/, '').trim())
            .filter((t) => t.length > 0)
            .slice(0, 10);
          if (tags.length) out.tags = tags;
        }
        return out;
      },
      buildTools: (userId, browser) =>
        buildXhsManagedTools(userId, browser as never) as ToolDefinition[],
      gatedHint:
        '小红书托管写工具未注入:需先在连接器页「小红书创作者服务」扫码登录并开启托管写操作,且服务端浏览器已就绪,然后重试。',
    },
  };
}

/**
 * 从 mission 首条用户 prompt 提取排版主题(公众号工坊表单把「排版主题:<id>」
 * 写进任务指令,prompt.main.md 约定格式)。只认注册过的主题 id,提取失败返回
 * undefined(工具侧自会回退默认主题)。
 */
export function extractThemeFromMission(mission: Mission | undefined): string | undefined {
  const steps = mission?.steps;
  if (!Array.isArray(steps)) return undefined;
  for (const s of steps) {
    if (s.role !== 'user' || typeof s.userPrompt !== 'string') continue;
    const m = s.userPrompt.match(/排版主题[:：]\s*([A-Za-z0-9_-]+)/);
    if (!m) return undefined;
    const id = m[1];
    return WECHAT_MD_THEMES.some((t) => t.id === id) ? id : undefined;
  }
  return undefined;
}

export interface ExecuteDirectDeliveryInput {
  platform: DirectDeliveryPlatform | string;
  userId: string;
  args: Record<string, unknown>;
  /** 关联任务(审计 missionId + 主题提取 + 步骤回写);可缺省(裸投递) */
  mission?: Mission;
  /** 服务端托管浏览器(zhihu/xhs 写工具注入必需;wechat 仅封面检索用) */
  browser?: unknown;
  /** 注册表注入点(测试用;缺省 getDefaultDeliverers()) */
  deliverers?: Record<string, PlatformDeliverer>;
}

/**
 * 执行直连投递:白名单校验 → 参数净化/补参 → 工厂建工具 → 直调 execute。
 * 合成 ToolSession 只带 taskId(审计用 missionId)/userId/env —— 三个落稿
 * 工具对 session 的依赖仅 taskId(appendBrowserAudit),与编排器路径同契约。
 */
export async function executeDirectDelivery(
  input: ExecuteDirectDeliveryInput,
): Promise<DirectDeliveryResult> {
  const { platform, userId, mission, browser } = input;
  const registry = input.deliverers ?? (await getDefaultDeliverers());
  const spec = registry[platform as DirectDeliveryPlatform];
  if (!spec) {
    return { success: false, error: `未知投递平台: ${String(platform)}` };
  }

  let args = spec.sanitizeArgs(input.args ?? {});
  if (spec.enrichArgs) args = spec.enrichArgs(args, mission);

  const missing = spec.required.filter(
    (k) => typeof args[k] !== 'string' || !(args[k] as string).trim(),
  );
  if (missing.length) {
    return {
      success: false,
      error: `投递参数缺失: ${missing.join(', ')}(定稿内容可能未就绪,请重跑工坊)`,
      tool: spec.toolName,
    };
  }

  let tool: ToolDefinition | undefined;
  try {
    tool = spec.buildTools(userId, browser).find((t) => t.name === spec.toolName);
  } catch (e: any) {
    return { success: false, error: `投递工具构建失败: ${e?.message || e}`, tool: spec.toolName };
  }
  if (!tool) {
    // 托管门未开 / 浏览器服务未就绪:工厂静默不吐写工具(与模型路径同一门控)
    return { success: false, gated: true, error: spec.gatedHint, tool: spec.toolName };
  }

  try {
    const result = await tool.execute(args, {
      taskId: mission?.id || `direct_${Date.now()}`,
      step: 0,
      userId,
      env: {},
    } as any);
    if (result && result.success === false) {
      return {
        success: false,
        error: String(result.message || result.error || '投递失败(工具返回)'),
        tool: spec.toolName,
      };
    }
    return { success: true, tool: spec.toolName, args, result };
  } catch (e: any) {
    return { success: false, error: `投递执行异常: ${e?.message || e}`, tool: spec.toolName };
  }
}

// ---------- 投递台账:合成工具步骤回写 mission(文档优先契约) ----------

/**
 * 合成一条与真实工具步骤同形的 DONE 步骤(id/title/tool/role/status/args/
 * startedAt,见 lib/tool-steps.ts)—— buildDraftDeliveryIndex 的防重复投递
 * 检测与活动流叙述(activity-narration 按 tool 名匹配)都无需感知直连/续聊
 * 路径差异,刷新后按钮终态照旧从 mission 步骤推导。
 */
export function buildDeliveryStep(input: {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
}): MissionStep {
  const r = input.result as any;
  const answer =
    (typeof r?.message === 'string' && r.message) ||
    (typeof r?.error === 'string' && r.error) ||
    '已投递';
  return {
    id: `step_direct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: `执行工具: ${input.toolName}`,
    tool: input.toolName,
    role: 'tool',
    status: 'DONE',
    startedAt: Date.now(),
    args: input.args,
    answer,
  };
}

export interface AppendDeliveryStepInput {
  mission: Mission;
  step: MissionStep;
  /** 落盘归属用户(缺省 mission.userId;路由层已按会话用户查得 mission) */
  userId?: string;
  /** 落盘回调(缺省 saveUserMission;测试注入假实现) */
  save?: (userId: string, mission: Mission) => void;
  /** 广播回调(缺省不广播;路由层注入 backend.broadcast 让在线 UI 即时见步骤) */
  broadcast?: (event: { type: string; data: unknown }) => void;
}

/**
 * 步骤回写 + 落盘 + 广播。mission_updated 事件与 agent-backend 的广播同形
 * (data 带 userId → 后端节流合并落盘;SSE 转发到前端后活动流即时刷新)。
 */
export async function appendDeliveryStepToMission(
  input: AppendDeliveryStepInput,
): Promise<void> {
  const { mission, step } = input;
  mission.steps = [...(mission.steps || []), step];
  const save =
    input.save ??
    ((await import('./user-store')).saveUserMission as (userId: string, m: Mission) => void);
  const owner = input.userId ?? mission.userId;
  if (!owner) throw new Error('投递步骤回写失败:无法确定归属用户');
  save(owner, mission);
  input.broadcast?.({ type: 'mission_updated', data: mission });
}
