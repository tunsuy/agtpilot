import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * gh CLI 账号探测(经 fork 派发 + 设备元信息用)。
 *
 * 红线注记:这里只查询 gh 的**公开登录名**(`gh api user`),与 detect() 查
 * claude 版本同性质 —— 不读取、不缓存、不上传任何 token/凭据文件(§7 凭据零上行)。
 */

export type GhExec = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; maxBuffer?: number }
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as unknown as GhExec;

export const defaultGhExec: GhExec = (cmd, args, opts) =>
  execFileAsync(cmd, args, { timeout: 15 * 1000, maxBuffer: 1024 * 1024, ...opts });

/** GitHub 登录名形状(1-39 位字母数字与连字符,不以连字符开头/结尾;与协议层同规则) */
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** 查询本机 gh 当前登录账号名;未装/未登录/输出畸形 → null(不抛错) */
export async function queryGhLogin(exec: GhExec = defaultGhExec): Promise<string | null> {
  try {
    const r = await exec('gh', ['api', 'user', '--jq', '.login'], { timeout: 15 * 1000 });
    const login = String(r.stdout ?? '').trim();
    return GH_LOGIN_RE.test(login) ? login : null;
  } catch {
    return null;
  }
}

// 进程级缓存:bin start/pair 时探测一次(设备元信息随心跳上报);
// 任务执行路径(repo.ts)不走缓存,每次实探(账号可能在任务间切换)
let cached: string | null | undefined;

/** 探测并缓存(bin 启动路径用;deviceMeta 同步读缓存) */
export async function ensureGhLogin(): Promise<string | null> {
  if (cached === undefined) cached = await queryGhLogin();
  return cached;
}

/** 读缓存(undefined = 本进程尚未探测过,deviceMeta 据此省略字段) */
export function getCachedGhLogin(): string | null | undefined {
  return cached;
}
