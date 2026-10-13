import { existsSync } from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import {
  extractPrUrl,
  normalizeDeviceAction,
  validatePublishCommand,
  type FrozenCommand,
  type RunnerDeviceAction,
  type RunnerEventType,
} from '@agtpilot/protocol';
import { repoDirFor, defaultExecAsync, type ExecAsync } from './repo';

/**
 * Phase 2 发布执行(M3,docs/design/local-runner-bridge.md §6.2):
 * 审批结果随轮询下行(publish 携带批准时刻固化的命令集 / cancel 拒绝确认),
 * runner **逐字执行、不重新规划、不追加命令**:
 * - 执行前每条命令再过协议白名单 validatePublishCommand(三种完整形状),
 *   任何一条不合法 → 整组拒绝执行并上报 error(防漂移围栏的 runner 侧闸);
 * - 顺序执行,任何一条失败即停并上报;
 * - gh pr create 输出提取 PR 链接 → phase2_result 回流 → state done。
 * 拒绝(cancel):本地分支保留,只上报 state cancelled 确认。
 */

/** 单条发布命令超时(push/PR/留言都是分钟级内动作) */
const PUBLISH_CMD_TIMEOUT_MS = 5 * 60 * 1000;

export interface PublishDeps {
  deviceId: string;
  postEvents: (events: unknown[]) => Promise<{ accepted: number; rejected: number }>;
  workspaceRoot: string;
  /** 测试注入点(默认真 execFile,数组传参无 shell) */
  exec?: ExecAsync;
  log?: (line: string) => void;
  /** M4:本地审计钩子(bin 注入 appendAudit) */
  audit?: (entry: Record<string, unknown>) => void;
  now?: () => number;
  newEventId?: () => string;
}

export type PublishOutcome = { ok: true; prUrl: string | null } | { ok: false; error: string };

/** 执行一个 publish 动作的固化命令集(白名单复核 → 顺序执行 → PR 链接提取) */
export async function executePublishAction(action: RunnerDeviceAction, deps: PublishDeps): Promise<PublishOutcome> {
  const exec = deps.exec ?? defaultExecAsync;
  const log = deps.log ?? (() => {});
  const audit = deps.audit ?? (() => {});

  let repoDir: string;
  try {
    repoDir = repoDirFor(deps.workspaceRoot, action.repo);
  } catch (e) {
    return { ok: false, error: `仓库路径被围栏拒绝:${(e as Error)?.message || e}` };
  }
  if (!existsSync(path.join(repoDir, '.git'))) {
    return { ok: false, error: `本地仓库不存在(${repoDir}),Phase 1 产物已丢失 —— 拒绝发布,请重新派发任务` };
  }

  const commands = action.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    return { ok: false, error: '固化命令集缺失或为空,拒绝发布' };
  }

  // 全量白名单复核在执行任何一条之前:一条不合法,整组拒绝(不部分执行)
  const validated: FrozenCommand[] = [];
  for (const raw of commands) {
    const v = validatePublishCommand(raw);
    if (!v) {
      return {
        ok: false,
        error: `固化命令未通过白名单校验,整组拒绝执行:${JSON.stringify(raw).slice(0, 300)}`,
      };
    }
    validated.push(v);
  }

  let prUrl: string | null = null;
  for (const c of validated) {
    const label = `${c.cmd} ${c.args.slice(0, 2).join(' ')}`;
    try {
      const r = await exec(c.cmd, c.args, { cwd: repoDir, timeout: PUBLISH_CMD_TIMEOUT_MS });
      const found = extractPrUrl(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
      if (found) prUrl = found;
      // 审计(本地):固化命令逐条留痕(参数截断,PR 正文可能很长)
      audit({
        kind: 'publish_cmd',
        taskId: action.taskId,
        approvalId: action.approvalId,
        cmd: c.cmd,
        argv: c.args.map((a) => (a.length > 200 ? a.slice(0, 200) + `…(${a.length} 字符)` : a)),
        ok: true,
      });
      log(`发布命令成功:${label} …`);
    } catch (e: any) {
      const tail = String(e?.stderr || e?.message || e).slice(-500);
      audit({
        kind: 'publish_cmd',
        taskId: action.taskId,
        approvalId: action.approvalId,
        cmd: c.cmd,
        argv: c.args.slice(0, 4),
        ok: false,
        error: tail,
      });
      return { ok: false, error: `发布命令失败(${label}):${tail}` };
    }
  }
  return { ok: true, prUrl };
}

/**
 * 处理一次轮询下行的全部审批动作(串行;v1 单任务哲学)。
 * 事件上行失败只记日志(bin 侧 ReliableEventPoster 已缓冲,恢复后补发);
 * 动作由云端任务状态推导,runner 没把状态推进到终态前,下次轮询会幂等
 * 重发同一动作(git/gh 天然幂等性兜底重复执行窗口)。
 */
export async function handleDeviceActions(rawActions: unknown[], deps: PublishDeps): Promise<number> {
  const log = deps.log ?? (() => {});
  const audit = deps.audit ?? (() => {});
  const now = deps.now ?? Date.now;
  const newId = deps.newEventId ?? (() => randomUUID());
  let handled = 0;

  for (const raw of rawActions.slice(0, 10)) {
    const action = normalizeDeviceAction(raw);
    if (!action) {
      log('忽略畸形审批指令下行(normalize 拒绝)');
      continue;
    }
    handled++;

    const events: Array<Record<string, unknown>> = [];
    const push = (type: RunnerEventType, payload?: Record<string, unknown>) => {
      events.push({ eventId: newId(), taskId: action.taskId, deviceId: deps.deviceId, at: now(), type, payload });
    };

    if (action.kind === 'cancel') {
      log(`任务 ${action.taskId} 审批被拒绝:本地分支 ${action.workBranch} 保留(可自行处置),上报取消确认`);
      audit({ kind: 'action_cancel', taskId: action.taskId, approvalId: action.approvalId, workBranch: action.workBranch });
      push('state', { state: 'cancelled' });
    } else {
      log(`任务 ${action.taskId} 审批通过,执行固化命令集(${action.commands?.length ?? 0} 条)…`);
      const r = await executePublishAction(action, deps);
      if (r.ok) {
        push('phase2_result', { prUrl: r.prUrl ?? undefined, approvalId: action.approvalId });
        push('state', { state: 'done' });
        audit({ kind: 'publish_result', taskId: action.taskId, approvalId: action.approvalId, ok: true, prUrl: r.prUrl });
        log(`任务 ${action.taskId} 发布完成${r.prUrl ? ` · PR ${r.prUrl}` : ''}`);
      } else {
        push('error', { message: r.error, approvalId: action.approvalId });
        push('state', { state: 'failed' });
        audit({ kind: 'publish_result', taskId: action.taskId, approvalId: action.approvalId, ok: false, error: r.error.slice(0, 500) });
        log(`任务 ${action.taskId} 发布失败:${r.error}`);
      }
    }

    try {
      const res = await deps.postEvents(events);
      log(`事件上行:${res.accepted} 接受 / ${res.rejected} 拒绝`);
    } catch (e) {
      // ReliableEventPoster 已把事件写入离线队列(错误文案含缓冲条数),恢复后自动补发;
      // 云端会幂等重发指令,发布命令幂等性由 git/gh 兜底
      log(`事件上行失败:${(e as Error)?.message || e}`);
    }
  }
  return handled;
}
