/**
 * 超长工具输出全量落盘存储(docs/design/tool-output-spill.md)。
 *
 * 编排器统一截断点经 TaskOptions.spillToolOutput 回调把超过 TOOL_OUTPUT_LIMIT
 * 的工具结果全量写到这里,模型收到「4KB 头尾预览 + 指针」,截掉的部分用
 * read_tool_output(callId, offset) 窗口续读 —— 从「截断即永久丢失」变可恢复
 * (对齐仓内既有范式:read_mission/read_memory 的 L0 摘要 + L2 按需拉取)。
 *
 * 布局(对齐 context-store v2):
 *   <dataDir>/v2/<userId>/tool-output/<taskId>/<callId>.txt   全量原文
 *   <dataDir>/v2/<userId>/audit/tool-output.jsonl             只增审计
 * v2 关闭(AGTPILOT_CONTEXT_STORE_V2=0)回退旧平铺形态(对齐 agent-notes 先例):
 *   <dataDir>/<safeName>.tool-output/<taskId>/<callId>.txt
 *   <dataDir>/<safeName>.tool-output.audit.jsonl
 *
 * 多用户隔离:所有读写经 userId → userDirV2/safeName;跨用户读取一律按
 * not-found 处理(不泄漏存在性)。taskId/callId 过白名单正则防路径穿越。
 * 清理三闸:任务删除级联(user-store.deleteUserMission 触发)/ 用户预算 LRU
 * (写后执行)/ TTL 惰性过期(读取时判定并清理)。
 * 保险丝 AGTPILOT_TOOL_SPILL=0 在内核侧门控(text.ts toolSpillEnabled),
 * 本模块不感知 —— 不被调用即零落盘。
 */
import fs from 'fs';
import path from 'path';
import type { ToolDefinition } from '@agtpilot/core';
import { getDataDir } from './user-store';
import { isV2Enabled, safeName, userDirV2 } from './user-store-v2';

/** 每用户落盘总预算(MB,env 可调):超限按任务目录 mtime 从旧到新 LRU 整目录淘汰 */
export const SPILL_BUDGET_MB_DEFAULT = 20;
/** TTL(天,env 可调):过期后读取诚实报错(已清理,需要请重新执行原工具) */
export const SPILL_TTL_DAYS_DEFAULT = 7;
/** 续读单次返回上限(字符,对齐 REFERENCE_CONTENT_LIMIT —— 同受内核
 *  TOOL_OUTPUT_LIMIT 16384 约束,续读结果本身也不能再超截断线) */
export const TOOL_OUTPUT_READ_LIMIT = 14000;

/** taskId/callId 形态白名单(内核生成 id 均为 [A-Za-z0-9_-] 序列;拒绝路径穿越) */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function budgetBytes(): number {
  const mb = Number(process.env.AGTPILOT_TOOL_SPILL_BUDGET_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : SPILL_BUDGET_MB_DEFAULT) * 1024 * 1024;
}

function ttlMs(): number {
  const days = Number(process.env.AGTPILOT_TOOL_SPILL_TTL_DAYS);
  return (Number.isFinite(days) && days >= 0 ? days : SPILL_TTL_DAYS_DEFAULT) * 24 * 3600 * 1000;
}

/** 落盘根目录(v2 目录形态 / 回退平铺形态,与 agent-notes 的回退先例一致) */
export function toolOutputRoot(userId: string): string {
  const dataDir = getDataDir();
  if (isV2Enabled()) return path.join(userDirV2(dataDir, userId), 'tool-output');
  return path.join(dataDir, `${safeName(userId)}.tool-output`);
}

function auditFile(userId: string): string {
  const dataDir = getDataDir();
  if (isV2Enabled()) return path.join(userDirV2(dataDir, userId), 'audit', 'tool-output.jsonl');
  return path.join(dataDir, `${safeName(userId)}.tool-output.audit.jsonl`);
}

/** 只增审计(spill/read/cleanup 三类事件);失败静默 —— 审计不阻塞主路径 */
function appendAudit(userId: string, entry: Record<string, any>): void {
  try {
    const file = auditFile(userId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch {}
}

function dirSize(p: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const child = path.join(p, e.name);
      total += e.isDirectory() ? dirSize(child) : e.isFile() ? fs.statSync(child).size : 0;
    }
  } catch {}
  return total;
}

/**
 * 落盘一份超长工具输出(TaskOptions.spillToolOutput 的 web 实现)。
 * 成功返回存储引用 id(= callId);任何失败返回 null(内核回退现行截断,
 * 绝不因落盘失败工具调用)。tmp+rename 原子写(对齐 user-store 写形态)。
 */
export function spillToolOutput(
  userId: string,
  info: { taskId: string; callId: string; toolName: string; fullText: string }
): string | null {
  if (!ID_RE.test(info.taskId) || !ID_RE.test(info.callId)) return null;
  try {
    const dir = path.join(toolOutputRoot(userId), info.taskId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${info.callId}.txt`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, info.fullText, 'utf8');
    fs.renameSync(tmp, file);
    appendAudit(userId, {
      kind: 'spill',
      callId: info.callId,
      taskId: info.taskId,
      tool: info.toolName,
      originalChars: info.fullText.length,
    });
    enforceBudget(userId, info.taskId);
    return info.callId;
  } catch {
    return null;
  }
}

/** 预算 LRU:超限时按任务目录 mtime 从旧到新整目录淘汰,直到回到预算内。
 *  protectTaskId = 本次刚写入的任务,绝不淘汰(否则极端小预算下「落盘成功
 *  却被立刻清理」,指针指向空引用);其占用仍计入总量。 */
function enforceBudget(userId: string, protectTaskId?: string): void {
  try {
    const root = toolOutputRoot(userId);
    const tasks = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && ID_RE.test(d.name))
      .map((d) => {
        const p = path.join(root, d.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {}
        return { name: d.name, p, size: dirSize(p), mtime };
      });
    let total = tasks.reduce((s, t) => s + t.size, 0);
    const budget = budgetBytes();
    if (total <= budget) return;
    tasks.sort((a, b) => a.mtime - b.mtime); // 旧任务先淘汰
    for (const t of tasks) {
      if (total <= budget) break;
      if (t.name === protectTaskId) continue;
      try {
        fs.rmSync(t.p, { recursive: true, force: true });
        total -= t.size;
        appendAudit(userId, { kind: 'cleanup', reason: 'budget', taskId: t.name, freedBytes: t.size });
      } catch {}
    }
  } catch {}
}

/** 在用户的 tool-output 目录里按 callId 定位文件(任务分目录下一层扫描) */
function locate(userId: string, callId: string): string | null {
  try {
    const root = toolOutputRoot(userId);
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || !ID_RE.test(d.name)) continue;
      const p = path.join(root, d.name, `${callId}.txt`);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

export interface ReadToolOutputResult {
  success: boolean;
  tool?: string;
  totalChars?: number;
  offset?: number;
  content?: string;
  nextOffset?: number;
  hint?: string;
  message?: string;
}

/**
 * 窗口续读一份已落盘的工具输出。跨用户/不存在 → 统一的「不存在或已过期」
 * 措辞(不泄漏存在性);TTL 过期 → 惰性清理 + 诚实报错(红线:不装有)。
 */
export function readToolOutput(
  userId: string,
  callId: string,
  offset = 0,
  limit = TOOL_OUTPUT_READ_LIMIT
): ReadToolOutputResult {
  const wanted = String(callId || '').trim();
  if (!ID_RE.test(wanted)) {
    appendAudit(userId, { kind: 'read', callId: wanted.slice(0, 64), hit: false, reason: 'bad-id' });
    return { success: false, message: `引用 ${wanted || '(空)'} 无效。` };
  }
  const file = locate(userId, wanted);
  if (!file) {
    appendAudit(userId, { kind: 'read', callId: wanted, hit: false, reason: 'not-found' });
    return {
      success: false,
      message: `输出 ${wanted} 不存在或已过期清理。如需该内容请重新执行原工具获取。`,
    };
  }
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age > ttlMs()) {
      // 惰性过期:读到才算账,顺手清理(启动清扫之外不留僵尸文件)
      try {
        fs.rmSync(file, { force: true });
      } catch {}
      appendAudit(userId, { kind: 'cleanup', reason: 'ttl', callId: wanted, ageDays: Math.round(age / 86400000) });
      return {
        success: false,
        message: `输出 ${wanted} 已过期清理(保存超过 ${Math.round(ttlMs() / 86400000)} 天)。如需该内容请重新执行原工具获取。`,
      };
    }
    const full = fs.readFileSync(file, 'utf8');
    const from = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), TOOL_OUTPUT_READ_LIMIT * 4) : TOOL_OUTPUT_READ_LIMIT;
    const slice = full.slice(from, from + size);
    const end = from + slice.length;
    appendAudit(userId, { kind: 'read', callId: wanted, offset: from, hit: true, chars: slice.length });
    return {
      success: true,
      totalChars: full.length,
      offset: from,
      content: slice,
      ...(end < full.length ? { nextOffset: end, hint: `还有剩余内容,用 offset=${end} 继续读` } : {}),
    };
  } catch {
    return { success: false, message: `输出 ${wanted} 读取失败(文件损坏或不可访问)。` };
  }
}

/** 任务删除级联清理(deleteUserMission 调用;尽力而为,失败不阻塞删除) */
export function cleanupTaskToolOutputs(userId: string, taskId: string): void {
  if (!ID_RE.test(taskId)) return;
  try {
    const dir = path.join(toolOutputRoot(userId), taskId);
    if (fs.existsSync(dir)) {
      const freed = dirSize(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      appendAudit(userId, { kind: 'cleanup', reason: 'mission-delete', taskId, freedBytes: freed });
    }
  } catch {}
}

/**
 * 续读工具(仿 read_mission/read_reference_material 形态)。
 * baseline: true —— 内核路由基线自动并入:工坊白名单/关键词路由退化场景
 * 也必须挂载,否则指针文案里的 read_tool_output 指引指向不存在的工具。
 */
export function buildToolOutputTools(userId: string): ToolDefinition[] {
  return [
    {
      name: 'read_tool_output',
      description:
        '续读被全量保存的超长工具输出(只读):工具输出过长时你收到的是「头尾预览+指针」,' +
        '指针标记里有 ref=<callId> 与原始大小。传入 callId 与可选 offset 窗口续读' +
        `(默认单次 ${TOOL_OUTPUT_READ_LIMIT} 字符,返回 totalChars/nextOffset)。` +
        '只能读你自己任务产生的输出;保存有有效期,过期会明确报错(届时重新执行原工具获取)。',
      dangerLevel: 'low',
      readOnly: true, // 只读并行门控:纯读自己分区的落盘文件,无副作用
      baseline: true,
      parameters: {
        type: 'object',
        properties: {
          callId: {
            type: 'string',
            description: '输出引用 id(截断指针标记中 ref= 后面的 call_xxx)',
          },
          offset: {
            type: 'number',
            description: '起始字符位置(默认 0;上次返回 nextOffset 时用它继续)',
          },
          limit: {
            type: 'number',
            description: `本次读取字符数(默认 ${TOOL_OUTPUT_READ_LIMIT})`,
          },
        },
        required: ['callId'],
      },
      execute: async ({ callId, offset, limit }: any) =>
        readToolOutput(userId, String(callId || ''), Number(offset) || 0, Number(limit) || TOOL_OUTPUT_READ_LIMIT),
    },
  ];
}
