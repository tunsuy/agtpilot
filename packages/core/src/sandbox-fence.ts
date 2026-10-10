/**
 * 沙箱围栏纯逻辑(Sandbox Fence)—— 凭据托管注入 / 端点绑定 / bwrap 围栏决策
 *
 * 设计依据 docs/design/sandbox-control-hardening.md §4.1(借鉴 OpenShell
 * 的 Provider 凭据托管与 best_effort/hard_requirement 模式,但不引入常驻
 * Gateway/Supervisor 进程 —— web 进程兼任控制面,围栏执行用宿主机 bwrap)。
 *
 * 本模块全部是纯函数(可注入 hostEnv),供 plugin-sandbox 调用、vitest 直测。
 */

/**
 * 任务级沙箱策略(经 ToolSession.sandbox 下发)。
 * 注意:web 层按任务构建后存于 taskRuntimes 活引用 —— 权限提案批准后
 * 原地修改本对象即热更新到 in-flight 任务(不重启 loop,铁律 7 不受影响)。
 */
export interface SandboxSessionPolicy {
  /** 允许进入子进程环境的 session.env 键白名单(用户显式 opt-in;默认空 = 零暴露) */
  exposeEnv?: string[];
  /** 凭据-端点绑定: envVar → 允许发往的 host 列表(默认绑定与用户自定义合并后下发) */
  credentialBindings?: Record<string, string[]>;
  /** 内核围栏模式: off(默认,逻辑围栏) / best_effort(bwrap 缺失降级继续) / hard_requirement(bwrap 缺失拒绝执行) */
  fence?: 'off' | 'best_effort' | 'hard_requirement';
  /** 出站网络: allow(默认) / deny(fence 生效时 bwrap --unshare-net) */
  net?: 'allow' | 'deny';
}

/**
 * 既有连接器 envVar → 官方 API 端点的默认凭据绑定。
 * 与 agent-backend taskEnv 注入的 8 个键一一对应;凭据只允许发往这些 host,
 * 发往陌生端点返回 credential_endpoint_mismatch(OpenShell 同名语义)。
 */
export const DEFAULT_CREDENTIAL_BINDINGS: Record<string, string[]> = {
  EXA_API_KEY: ['api.exa.ai'],
  TAVILY_API_KEY: ['api.tavily.com'],
  FIRECRAWL_API_KEY: ['api.firecrawl.dev'],
  E2B_API_KEY: ['api.e2b.dev'],
  FEISHU_WEBHOOK_URL: ['open.feishu.cn'],
  SLACK_WEBHOOK_URL: ['hooks.slack.com'],
  DINGTALK_WEBHOOK_URL: ['oapi.dingtalk.com'],
  WECOM_WEBHOOK_URL: ['qyapi.weixin.qq.com'],
};

/** 子进程环境基础白名单(命令执行必需,与凭据无关) */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const;

/**
 * 构建子进程环境:base 白名单 + 仅 policy.exposeEnv ∩ sessionEnv 的键。
 *
 * 关键不变量:session.env(用户个人空间保存的全部 Key)默认**一个都不进**
 * 子进程 —— 修复了旧实现 `...(sessionEnv || {})` 整包展开造成的凭据泄漏
 * (合法消费方都在插件 JS 进程内读 Key,子进程从不需要)。
 */
export function buildChildEnv(
  sessionEnv: Record<string, string> | undefined,
  policy: SandboxSessionPolicy | undefined,
  hostEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = { CI: 'true' };
  for (const k of BASE_ENV_KEYS) {
    const v = hostEnv[k];
    if (typeof v === 'string') env[k] = v;
  }
  if (sessionEnv && policy?.exposeEnv?.length) {
    for (const key of policy.exposeEnv) {
      const v = sessionEnv[key];
      if (typeof v === 'string' && v !== '') env[key] = v;
    }
  }
  return env;
}

export type CredentialDecision =
  | { ok: true; value: string }
  | { ok: false; code: 'credential_not_found' | 'credential_endpoint_mismatch'; message: string };

/**
 * 凭据请求裁决(端点绑定):
 * - credentialRef 不在 sessionEnv → credential_not_found;
 * - 绑定表中无该 envVar 条目,或 hostname 不在允许列表 → credential_endpoint_mismatch
 *   (fail closed,且错误信息不回显凭据值);
 * - 通过 → 返回真实值,由调用方(sandbox_http_request)在宿主进程内注入请求头。
 *
 * host 匹配为精确匹配(含端口时调用方应先剥掉端口)。
 */
export function resolveCredentialRequest(
  req: { credentialRef: string; hostname: string },
  sessionEnv: Record<string, string> | undefined,
  bindings: Record<string, string[]> = DEFAULT_CREDENTIAL_BINDINGS,
): CredentialDecision {
  const value = sessionEnv?.[req.credentialRef];
  if (typeof value !== 'string' || value === '') {
    return { ok: false, code: 'credential_not_found', message: `凭据 ${req.credentialRef} 未配置或已撤销` };
  }
  const allowed = bindings[req.credentialRef] || [];
  const host = req.hostname.toLowerCase().replace(/:\d+$/, '');
  if (!allowed.some((h) => h.toLowerCase() === host)) {
    return {
      ok: false,
      code: 'credential_endpoint_mismatch',
      message: `凭据 ${req.credentialRef} 绑定端点 [${allowed.join(', ') || '(无绑定)'}],拒绝发往 ${host}`,
    };
  }
  return { ok: true, value };
}

export interface FenceDecision {
  /** 用 bwrap 包裹子进程 */
  wrap: boolean;
  /** best_effort 下 bwrap 缺失 → 降级继续(结果必须显式标注) */
  degraded: boolean;
  /** hard_requirement 下 bwrap 缺失 → 拒绝执行 */
  blocked: boolean;
  reason?: string;
}

/**
 * 围栏模式决策(OpenShell best_effort / hard_requirement 同名语义):
 * off → 逻辑围栏(路径围栏 + 环境白名单);bwrap 可用则包裹。
 */
export function decideFence(
  mode: SandboxSessionPolicy['fence'] | undefined,
  bwrapAvailable: boolean,
): FenceDecision {
  if (!mode || mode === 'off') return { wrap: false, degraded: false, blocked: false };
  if (bwrapAvailable) return { wrap: true, degraded: false, blocked: false };
  if (mode === 'best_effort') {
    return {
      wrap: false,
      degraded: true,
      blocked: false,
      reason: '宿主机未安装 bwrap(bubblewrap),内核围栏降级为逻辑围栏(best_effort 模式)。',
    };
  }
  return {
    wrap: false,
    degraded: false,
    blocked: true,
    reason: '宿主机未安装 bwrap(bubblewrap),hard_requirement 模式下拒绝执行。',
  };
}

/**
 * 生成 bwrap 参数(「--」之前的部分;调用方追加 `-- <command...>`):
 * 只读根 + 可写 workspace(bind 顺序在 ro-bind 之后以覆盖)+ tmpfs /tmp +
 * --die-with-parent(父进程死亡即杀沙箱)+ 可选 --unshare-net。
 */
export function buildBwrapArgs(opts: {
  workspaceRoot: string;
  net?: 'allow' | 'deny';
}): string[] {
  const args = [
    '--ro-bind-try', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--die-with-parent',
  ];
  if (opts.net === 'deny') args.push('--unshare-net');
  args.push('--bind', opts.workspaceRoot, opts.workspaceRoot);
  return args;
}
