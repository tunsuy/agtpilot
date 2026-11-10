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
  /**
   * 内核围栏模式:
   * - best_effort(解析缺省):有 bwrap 则窄挂载包裹,缺失则降级 + 敏感路径预检;
   * - hard_requirement:无 bwrap 拒绝执行;
   * - off:显式关闭内核围栏(仅逻辑预检,不推荐)。
   */
  fence?: 'off' | 'best_effort' | 'hard_requirement';
  /** 出站网络: allow(默认) / deny(fence 生效时 bwrap --unshare-net) */
  net?: 'allow' | 'deny';
}

/** 任务未显式配置时的围栏缺省(agent-backend / decideFence 共用) */
export const DEFAULT_FENCE_MODE: NonNullable<SandboxSessionPolicy['fence']> = 'best_effort';

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
 * 缺省 / best_effort → 有 bwrap 则包裹,否则降级;off → 永不包裹;hard_requirement → 无 bwrap 拒绝。
 */
export function decideFence(
  mode: SandboxSessionPolicy['fence'] | undefined,
  bwrapAvailable: boolean,
): FenceDecision {
  const resolved = mode ?? DEFAULT_FENCE_MODE;
  if (resolved === 'off') return { wrap: false, degraded: false, blocked: false };
  if (bwrapAvailable) return { wrap: true, degraded: false, blocked: false };
  if (resolved === 'best_effort') {
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
 * 窄只读挂载集:能跑常见 /usr 工具 + TLS/DNS,刻意不挂整盘根,
 * 避免 `cat ~/.env` / 宿主 HOME / USER_DATA_DIR 对子进程可见。
 * --ro-bind-try 缺路径不失败(跨发行版 / mac 测试桩兼容)。
 */
const BWRAP_RO_BINDS: ReadonlyArray<readonly [string, string]> = [
  ['/usr', '/usr'],
  ['/bin', '/bin'],
  ['/sbin', '/sbin'],
  ['/lib', '/lib'],
  ['/lib64', '/lib64'],
  ['/etc/ssl', '/etc/ssl'],
  ['/etc/ca-certificates', '/etc/ca-certificates'],
  ['/etc/resolv.conf', '/etc/resolv.conf'],
  ['/etc/hosts', '/etc/hosts'],
  ['/etc/nsswitch.conf', '/etc/nsswitch.conf'],
  ['/etc/passwd', '/etc/passwd'],
  ['/etc/group', '/etc/group'],
];

/**
 * 生成 bwrap 参数(「--」之前的部分;调用方追加 `-- <command...>`):
 * 窄只读系统挂载 + 可写 workspace + tmpfs /tmp + --die-with-parent + 可选 --unshare-net。
 * 不再 `--ro-bind / /`(整盘只读仍可掏宿主连接配置)。
 */
export function buildBwrapArgs(opts: {
  workspaceRoot: string;
  net?: 'allow' | 'deny';
}): string[] {
  const args: string[] = [];
  for (const [src, dest] of BWRAP_RO_BINDS) {
    args.push('--ro-bind-try', src, dest);
  }
  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent');
  if (opts.net === 'deny') args.push('--unshare-net');
  args.push('--bind', opts.workspaceRoot, opts.workspaceRoot);
  return args;
}

export type CommandPathGuardResult =
  | { ok: true }
  | { ok: false; code: 'sensitive_path_blocked'; message: string; match: string };

/**
 * 无 bwrap / 围栏降级时的逻辑读盘预检(托底,不冒充根治)。
 * 拦截命令串里指向宿主敏感绝对路径、家目录密钥、云元数据、进程 environ 的字面量;
 * workspace 相对路径(如 `cat .env`)放行 —— 那是任务工作区内的项目文件。
 */
const SENSITIVE_COMMAND_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /(?:^|[\s"'`=(])(?:~|\$HOME|\$\{HOME\})\s*\/\s*\.ssh\b/i, label: '~/.ssh' },
  { re: /(?:^|[\s"'`=(])(?:~|\$HOME|\$\{HOME\})\s*\/[^\s"'`]*\.env\b/i, label: 'home .env' },
  { re: /(?:^|[\s"'`=(])\/(?:home|Users|root)\/[^\s"'`]*\.env\b/i, label: 'absolute home .env' },
  { re: /(?:^|[\s"'`=(])\/etc\/(?:shadow|sudoers)(?:\.d)?\b/i, label: '/etc/shadow|sudoers' },
  { re: /169\.254\.169\.254/, label: 'cloud metadata 169.254.169.254' },
  { re: /\/proc\/(?:self|\d+)\/environ\b/, label: '/proc/*/environ' },
  { re: /(?:^|[\s"'`=(])\/(?:etc|var|opt|usr\/local)\/[^\s"'`]*(?:\.env|credential|secrets?(?:\.json)?|token)/i, label: 'sensitive absolute config' },
  { re: /\.secret_key\b/, label: '.secret_key' },
  { re: /\bUSER_DATA_DIR\b/, label: 'USER_DATA_DIR' },
  { re: /(?:^|[\s"'`=(])\/(?:home|Users|root)\/[^\s"'`]*\/\.(?:aws|config\/gcloud|docker)\/[^\s"'`]*/i, label: 'cloud/cli credential dir' },
];

export function guardCommandSensitivePaths(command: string): CommandPathGuardResult {
  const cmd = String(command || '');
  for (const { re, label } of SENSITIVE_COMMAND_PATTERNS) {
    if (re.test(cmd)) {
      return {
        ok: false,
        code: 'sensitive_path_blocked',
        match: label,
        message: `命令疑似访问敏感路径(${label}),已拒绝执行。请改用 workspace 内路径与 sandbox_read_file。`,
      };
    }
  }
  return { ok: true };
}
