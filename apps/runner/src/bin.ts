#!/usr/bin/env tsx
import { parseArgs, USAGE } from './args';
import { RunnerClient, RunnerAuthError, deviceMeta } from './client';
import { clearCredentials, loadCredentials, saveCredentials, credentialsFile, credentialsDir } from './credentials';
import { pollTick, runHeartbeatLoop } from './heartbeat';
import { ClaudeCodeAdapter } from './executor';
import { runTask } from './task-run';
import { handleDeviceActions } from './publish';
import { workspaceRoot } from './config';
import { ReliableEventPoster, outboxFile } from './event-queue';
import { appendAudit, readAudit, rotateAuditIfNeeded, auditFile } from './audit';
import { pidFile, writePid, clearPid, readPid, isPidAlive, stopByPidfile } from './pidfile';

/**
 * agtpilot-runner —— AgtPilot 本地薄 runner(docs/design/local-runner-bridge.md)
 *
 * M4(硬化):pair / start(pidfile 单实例 + 离线事件队列 + 本地审计)/ status /
 * stop(SIGTERM 停后台实例)/ logs(审计 JSONL 尾部)/ config(本地路径一览)。
 * 事件出本机的唯一出口 client.postEvents 带 redaction(密钥形态 + deviceSecret 黑名单);
 * push/PR 只有云端审批固化的命令集能触发,runner 侧白名单复核,别无对外发布路径。
 *
 * 分发注记:bin 目前直指 TS 源(tsx 运行,仓内开发者路径;scripts/install.sh 生成
 * agtpilot-runner 包装命令);发 npm 前补 tsc 构建产物指向(§9,待 npmjs org 注册)。
 */

function log(line: string) {
  console.log(`[agtpilot-runner ${new Date().toISOString()}] ${line}`);
}

function audit(entry: Record<string, unknown>) {
  appendAudit(entry);
}

async function cmdPair(flags: Record<string, string>): Promise<number> {
  const server = flags.server;
  const code = flags.code;
  if (!server || !code) {
    console.error('缺少参数:pair 需要 --server <url> --code <8位配对码>');
    console.error(USAGE);
    return 1;
  }
  const client = new RunnerClient(server, null);
  try {
    const { deviceId, deviceSecret } = await client.pair(code, deviceMeta());
    saveCredentials({
      serverUrl: server.replace(/\/+$/, ''),
      deviceId,
      deviceSecret,
      pairedAt: Date.now(),
      hostname: deviceMeta().hostname,
    });
    audit({ kind: 'paired', deviceId, serverUrl: server.replace(/\/+$/, '') });
    log(`配对成功 · 设备 ${deviceId} · 凭据已写入 ${credentialsFile()}(0600)`);
    log('下一步:agtpilot-runner start 前台运行(心跳轮询,自动领取并执行派发的任务)');
    return 0;
  } catch (e) {
    console.error(`配对失败:${(e as Error)?.message || e}`);
    return 1;
  }
}

async function cmdStart(flags: Record<string, string>): Promise<number> {
  const creds = loadCredentials();
  if (!creds) {
    console.error(`未找到凭据(${credentialsFile()})。先执行:agtpilot-runner pair --server <url> --code <码>`);
    return 1;
  }
  // 单实例:pidfile 存活检查(死 pid 视为陈旧,直接覆盖)
  const pf = pidFile();
  const existing = readPid(pf);
  if (existing !== null && isPidAlive(existing)) {
    console.error(`已有实例在运行(pid ${existing})。如需停止:agtpilot-runner stop`);
    return 1;
  }
  writePid(pf, process.pid);

  const intervalMs = Math.max(1000, Number(flags.interval) || 5000);
  const client = new RunnerClient(creds.serverUrl, { deviceId: creds.deviceId, deviceSecret: creds.deviceSecret });
  // M4:离线事件队列(断网缓冲,恢复后补发;云端 eventId 幂等去重)+ 审计轮转
  const poster = new ReliableEventPoster({ post: (events) => client.postEvents(events), log });
  const postEvents = (events: unknown[]) => poster.post(events);
  rotateAuditIfNeeded();
  audit({ kind: 'start', serverUrl: creds.serverUrl, intervalMs, workspaceRoot: workspaceRoot() });

  let stopped = false;
  const onSigint = () => {
    stopped = true;
    log('收到退出信号,停止轮询…');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);

  log(`开始心跳轮询 ${creds.serverUrl}(间隔 ${intervalMs}ms,Ctrl+C 退出;工作区 ${workspaceRoot()})`);
  const adapter = new ClaudeCodeAdapter();
  let exitCode = 0;
  try {
    const outcome = await runHeartbeatLoop({
      intervalMs,
      shouldStop: () => stopped,
      tick: async () => {
        const r = await pollTick(client, log, { claim: true });
        if (r.outcome === 'ok' && r.actions.length > 0) {
          // 审批结果动作(M3):先于新任务处理(发布是分钟级动作,不阻塞心跳太久);
          // 单任务串行哲学下,若此刻正在执行 Phase 1,动作等本 tick 结束后自然串行
          try {
            await handleDeviceActions(r.actions, {
              deviceId: creds.deviceId,
              postEvents,
              workspaceRoot: workspaceRoot(),
              log,
              audit,
            });
          } catch (e) {
            log(`审批指令处理异常(心跳继续,云端将幂等重发指令):${(e as Error)?.message || e}`);
          }
        }
        if (r.outcome === 'ok' && r.claimed) {
          // 任务执行期间主循环被占用:另起保活轮询,维持 lastSeenAt(设备不被判离线)
          const keepAlive = setInterval(() => {
            client.poll({}).catch(() => {});
          }, intervalMs);
          try {
            await runTask(r.claimed, {
              deviceId: creds.deviceId,
              postEvents,
              adapter,
              workspaceRoot: workspaceRoot(),
              log,
              audit,
            });
          } catch (e) {
            log(`任务执行器异常(任务已在云端标记流程内,心跳继续):${(e as Error)?.message || e}`);
          } finally {
            clearInterval(keepAlive);
          }
        }
        return r;
      },
      onAuthLost: () => {
        clearCredentials(); // 401 → 本地自毁凭据(§4),需重新配对
        log('本地凭据已清除,请重新配对');
      },
    });
    audit({ kind: 'exit', outcome });
    if (outcome === 'upgrade_needed') {
      console.error('升级命令:npm i -g @agtpilot/runner@latest');
      exitCode = 2;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigint);
    clearPid(pf);
  }
  return exitCode;
}

function cmdStatus(): number {
  const creds = loadCredentials();
  if (!creds) {
    console.log(`未配对(${credentialsFile()} 不存在)`);
    return 1;
  }
  const masked = `${creds.deviceSecret.slice(0, 4)}…${creds.deviceSecret.slice(-2)}`;
  const pid = readPid(pidFile());
  const running = pid !== null && isPidAlive(pid);
  console.log(
    [
      `已配对: ${creds.serverUrl}`,
      `设备 id: ${creds.deviceId}`,
      `密钥:    ${masked}(完整值只在 ${credentialsFile()},0600)`,
      `配对于:  ${new Date(creds.pairedAt).toISOString()}`,
      `主机:    ${creds.hostname}`,
      `实例:    ${running ? `运行中(pid ${pid})` : '未运行'}`,
    ].join('\n')
  );
  return 0;
}

async function cmdStop(): Promise<number> {
  const r = await stopByPidfile();
  if (r.ok) {
    audit({ kind: 'stop', pid: r.stopped });
    log(`已停止实例(pid ${r.stopped})`);
    return 0;
  }
  if (r.error === 'stale') {
    log(`没有在运行的实例(pidfile 残留 pid ${r.detail},已清理)`);
    return 0;
  }
  if (r.error === 'not_running') {
    console.log('没有在运行的实例(无 pidfile)。start 为前台进程时 Ctrl+C 即停。');
    return 1;
  }
  console.error(`停止失败:${r.detail || r.error}`);
  return 1;
}

function cmdLogs(flags: Record<string, string>): number {
  const limit = Math.max(1, Number(flags.tail) || 50);
  const entries = readAudit({ limit });
  if (entries.length === 0) {
    console.log(`审计日志为空(${auditFile()})`);
    return 0;
  }
  for (const e of entries) {
    if (flags.json === '1') {
      console.log(JSON.stringify(e));
      continue;
    }
    const { at, kind, ...rest } = e;
    const detail = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
    console.log(`${new Date(Number(at)).toISOString()} ${String(kind)}${detail}`);
  }
  return 0;
}

function cmdConfig(): number {
  console.log(
    [
      `工作区:      ${workspaceRoot()}   (覆写:AGTPILOT_WORKSPACE_ROOT=<路径>,改后请重新派发任务验证)`,
      `凭据目录:    ${credentialsDir()}   (credentials.json 0600)`,
      `审计日志:    ${auditFile()}   (agtpilot-runner logs 查看)`,
      `离线队列:    ${outboxFile()}   (事件上行失败自动缓冲,恢复后补发)`,
      `pidfile:     ${pidFile()}   (stop 子命令据此停止实例)`,
    ].join('\n')
  );
  return 0;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'pair':
      process.exitCode = await cmdPair(flags);
      break;
    case 'start':
      process.exitCode = await cmdStart(flags);
      break;
    case 'status':
      process.exitCode = cmdStatus();
      break;
    case 'stop':
      process.exitCode = await cmdStop();
      break;
    case 'logs':
      process.exitCode = cmdLogs(flags);
      break;
    case 'config':
      process.exitCode = cmdConfig();
      break;
    default:
      console.log(USAGE);
  }
}

// RunnerAuthError 在心跳内已处置;这里兜底未捕获异常,退出码可辨
main().catch((e) => {
  if (e instanceof RunnerAuthError) {
    clearCredentials();
    console.error(`${e.message} —— 本地凭据已清除,请重新配对`);
    process.exitCode = 1;
    return;
  }
  console.error(`[agtpilot-runner] 未处理错误:${(e as Error)?.message || e}`);
  process.exitCode = 1;
});
