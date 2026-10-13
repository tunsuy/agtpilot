/**
 * 命令行解析(纯函数,vitest 直测)。
 * 子命令:pair / start / status / stop / logs / config;旗标 --key value 或 --key=value,
 * 布尔旗标(--claim)值为 '1'。
 */

export interface ParsedArgs {
  command: 'pair' | 'start' | 'status' | 'stop' | 'logs' | 'config' | 'help';
  flags: Record<string, string>;
}

const COMMANDS = new Set(['pair', 'start', 'status', 'stop', 'logs', 'config', 'help']);

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] && COMMANDS.has(argv[0]) ? (argv[0] as ParsedArgs['command']) : 'help';
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[arg.slice(2)] = argv[++i];
    } else {
      flags[arg.slice(2)] = '1';
    }
  }
  return { command, flags };
}

export const USAGE = `agtpilot-runner — AgtPilot 本地薄 runner(贡献任务桥)

用法:
  agtpilot-runner pair --server https://<部署地址> --code XXXXXXXX   配对(码在 web 设备页生成,5 分钟有效)
  agtpilot-runner start [--interval 5000]                            前台运行:心跳轮询接任务(Ctrl+C 退出)
  agtpilot-runner status                                             查看本机配对状态
  agtpilot-runner stop                                               停止后台运行的实例(按 pidfile 发 SIGTERM)
  agtpilot-runner logs [--tail 50] [--json]                          查看本地审计日志(append-only JSONL)
  agtpilot-runner config                                             查看本地配置(工作区/凭据/审计/离线队列路径)

设计:docs/design/local-runner-bridge.md — 出站-only HTTPS,本机零开放端口;
push/PR 一律经云端审批门,凭据只存本机 ~/.agtpilot/runner/credentials.json (0600);
事件上行前过 redaction(密钥形态过滤),断网自动缓冲重发(eventId 幂等去重)。`;
