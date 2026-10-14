/**
 * 工坊提示词 · 服务端覆盖目录(热修,services 端专属)
 *
 * 目的:提示词迁 .md 模板后,生产上发现措辞/红线问题可以在不改代码、不发版的情况下
 * 紧急修正 —— 往覆盖目录放一个 `<workshopId>.md`(全文替换该工坊服务端渲染的 prompt)
 * 即生效;移除文件即回落到打包模板。
 *
 * 约定镜像 plugin-skill 的 loadScriptSkills:
 * - 目录:env AGTPILOT_WORKSHOP_OVERRIDE_DIR 优先,缺省 cwd/skills/workshop-overrides
 *   (dev/test = apps/web/skills/workshop-overrides,生产镜像 = /app/skills/workshop-overrides);
 * - 只认 `<workshopId>.md`,workshopId 必须在注册表内;坏文件/未知 id 只记错误并跳过,
 *   绝不抛出(缺省 = 没有覆盖,打包模板兜底);
 * - 60s TTL 缓存:热修不必重启,但也不至于每次渲染都扫盘。
 *
 * 作用范围:仅 /api/agent/run 的工坊任务(workshopId+params 服务端权威渲染);
 * cron 场景触发走 CRON_SCENARIOS 注册表重建(本就是服务端现读档案),不经此处。
 * 客户端预览仍渲染打包模板;存在覆盖时 API 暴露 overridden 名单,预览处提示
 * 「服务端存在覆盖版本,以实际发送为准」—— 不隐藏分歧。
 */
import * as fs from 'fs';
import * as path from 'path';
import { getWorkshop } from './registry';

/** 单文件大小上限(防误放大文件拖慢渲染) */
const MAX_OVERRIDE_BYTES = 256 * 1024;
/** 单次加载的覆盖文件数上限 */
const MAX_OVERRIDE_FILES = 20;
/** TTL:目录扫描结果缓存时长 */
const OVERRIDE_TTL_MS = 60_000;

/** 覆盖目录:env 优先;缺省 cwd/skills/workshop-overrides */
export function workshopOverridesDir(): string {
  return process.env.AGTPILOT_WORKSHOP_OVERRIDE_DIR || path.join(process.cwd(), 'skills', 'workshop-overrides');
}

export interface WorkshopOverrideLoadResult {
  /** workshopId → 覆盖全文(原文,不做模板渲染:热修要的是对最终文本的完全掌控) */
  byId: Record<string, string>;
  /** 每个被跳过文件的错误描述(带文件名;记日志,绝不抛出) */
  errors: string[];
}

/** 扫描覆盖目录(纯函数,测试可指目录;坏文件跳过不抛) */
export function loadWorkshopOverrides(dir: string = workshopOverridesDir()): WorkshopOverrideLoadResult {
  const out: WorkshopOverrideLoadResult = { byId: {}, errors: [] };
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(0, MAX_OVERRIDE_FILES);
  } catch {
    return out; // 目录不存在/不可读 = 没有覆盖,不是错误(打包模板兜底)
  }
  for (const f of files) {
    const full = path.join(dir, f);
    // 文件名即 workshopId(xhs.md → xhs);不在注册表内的 id 只记错误并跳过
    const id = f.slice(0, -3);
    if (!getWorkshop(id)) {
      out.errors.push(`${f}: 文件名不是注册表内的工坊 id(${id}),已忽略`);
      continue;
    }
    let content: string;
    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_OVERRIDE_BYTES) {
        out.errors.push(`${f}: 超过 ${MAX_OVERRIDE_BYTES} 字节上限,已忽略`);
        continue;
      }
      content = fs.readFileSync(full, 'utf8');
    } catch (e: any) {
      out.errors.push(`${f}: 读取失败(${e?.message || e})`);
      continue;
    }
    if (!content.trim()) {
      out.errors.push(`${f}: 内容为空,已忽略(移除文件即回落打包模板)`);
      continue;
    }
    out.byId[id] = content;
  }
  if (out.errors.length) {
    console.warn(`[WORKSHOP-OVERRIDES] 跳过 ${out.errors.length} 个无效覆盖文件:`, out.errors.join(' | '));
  }
  return out;
}

// ---- TTL 缓存(放文件即生效,60s 内收敛) ----

let cache: { at: number; dir: string; data: WorkshopOverrideLoadResult } | null = null;

/** 取当前覆盖集(60s TTL;目录变了自动重扫) */
export function getWorkshopOverrides(dir: string = workshopOverridesDir()): WorkshopOverrideLoadResult {
  const now = Date.now();
  if (cache && cache.dir === dir && now - cache.at < OVERRIDE_TTL_MS) return cache.data;
  const data = loadWorkshopOverrides(dir);
  cache = { at: now, dir, data };
  return data;
}

/** 清缓存(测试用:绕过 TTL 立即重扫;生产热修靠 60s TTL 自然收敛) */
export function resetWorkshopOverrideCache(): void {
  cache = null;
}

/** 预览诚实:该工坊在服务端是否存在覆盖版本 */
export function isWorkshopOverridden(id: string, dir: string = workshopOverridesDir()): boolean {
  return getWorkshopOverrides(dir).byId[id] !== undefined;
}
