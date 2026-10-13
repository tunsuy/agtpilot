#!/usr/bin/env tsx
import { parseArgs, USAGE } from './args';
import { RunnerClient, RunnerAuthError, deviceMeta } from './client';
import { clearCredentials, loadCredentials, saveCredentials, credentialsFile } from './credentials';
import { pollTick, runHeartbeatLoop } from './heartbeat';
import { ClaudeCodeAdapter } from './executor';
import { runTask } from './task-run';
import { handleDeviceActions } from './publish';
import { workspaceRoot } from './config';

/**
 * agtpilot-runner —— AgtPilot 本地薄 runner(docs/design/local-runner-bridge.md)
 *
 * M3:pair(配对)/ start(心跳轮询 + FIFO 领取任务 + ClaudeCodeAdapter 本地执行
 * + 事件回流 + 审批结果动作执行:批准后逐字执行固化命令集 git push/gh pr create/
 * gh issue comment,拒绝后上报取消确认)/ status。
 * push/PR 只有云端审批固化的命令集能触发,runner 侧白名单复核,别无对外发布路径。
 *
 * 分发注记:bin 目前直指 TS 源(tsx 运行,仓内开发者路径);
 * 发 npm 前补 tsc 构建产物指向(§9,待 npmjs org 注册后与占位发布一起做)。
 */

function log(line: string) {
  console.log(`[agtpilot-runner ${new Date().toISOString()}] ${line}`);
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
  const intervalMs = Math.max(1000, Number(flags.interval) || 5000);
  const client = new RunnerClient(creds.serverUrl, { deviceId: creds.deviceId, deviceSecret: creds.deviceSecret });

  let stopped = false;
  const onSigint = () => {
    stopped = true;
    log('收到退出信号,停止轮询…');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);

  log(`开始心跳轮询 ${creds.serverUrl}(间隔 ${intervalMs}ms,Ctrl+C 退出;工作区 ${workspaceRoot()})`);
  const adapter = new ClaudeCodeAdapter();
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
            postEvents: (events) => client.postEvents(events),
            workspaceRoot: workspaceRoot(),
            log,
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
            postEvents: (events) => client.postEvents(events),
            adapter,
            workspaceRoot: workspaceRoot(),
            log,
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
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigint);
  if (outcome === 'upgrade_needed') {
    console.error('升级命令:npm i -g @agtpilot/runner@latest');
    return 2;
  }
  return 0;
}

function cmdStatus(): number {
  const creds = loadCredentials();
  if (!creds) {
    console.log(`未配对(${credentialsFile()} 不存在)`);
    return 1;
  }
  const masked = `${creds.deviceSecret.slice(0, 4)}…${creds.deviceSecret.slice(-2)}`;
  console.log(
    [
      `已配对: ${creds.serverUrl}`,
      `设备 id: ${creds.deviceId}`,
      `密钥:    ${masked}(完整值只在 ${credentialsFile()},0600)`,
      `配对于:  ${new Date(creds.pairedAt).toISOString()}`,
      `主机:    ${creds.hostname}`,
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
      console.log('M1 骨架:start 为前台进程,Ctrl+C 即停;后台守护与 stop 子命令 M4 交付。');
      break;
    case 'logs':
      console.log('M1 骨架:本地审计日志(append-only JSONL)与 logs 子命令 M4 交付。');
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
