import * as os from 'os';
import * as path from 'path';

/**
 * runner 本地配置。
 * workspaceRoot 默认 `~/agtpilot-workspace`(决策项 2 已拍板:专用隔离,
 * 机器人副本与个人工作区分开,可整目录删除重下);AGTPILOT_WORKSPACE_ROOT 可覆写
 * (云端设备页同步确认的本地改法,M4 提供 `config` 子命令)。
 */
export function workspaceRoot(): string {
  const fromEnv = process.env.AGTPILOT_WORKSPACE_ROOT;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), 'agtpilot-workspace');
}
