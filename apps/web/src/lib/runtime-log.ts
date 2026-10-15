/**
 * 程序运行日志(纯文本 .log,非会话记录)。
 *
 * 一行一条、本地时间戳打头、方括号级别,供人 tail -f / grep:
 *   2026-10-15 09:41:59 [ERROR] [mission_xxx] 执行异常: Failed to ...
 *
 * - 落盘 <dataDir>/logs/runtime.log(data 卷内,容器重建不丢);
 *   超过 10MB 滚动为 runtime.log.1(仅保留一代,滚动即覆盖旧代);
 * - 同步镜像到 stdout(INFO/WARN → log,ERROR → error),
 *   docker logs 即实时程序日志,文件是持久档案;
 * - 串行追加(单链 promise),并发写不会交错出半行;
 * - 全程 best-effort:磁盘失败静默降级为仅 stdout,绝不影响业务路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './user-store';

export type RuntimeLogLevel = 'INFO' | 'WARN' | 'ERROR';

const LOG_DIRNAME = 'logs';
const LOG_FILENAME = 'runtime.log';
const ROTATE_BYTES = 10 * 1024 * 1024;

let writeChain: Promise<void> = Promise.resolve();
let logFilePath: string | null = null;
/** 启动后已因落盘失败降级的标记:失败一次后不再反复尝试(避免错误日志风暴) */
let degradedToStdoutOnly = false;

function resolveLogFilePath(): string | null {
  if (logFilePath) return logFilePath;
  try {
    const dir = path.join(getDataDir(), LOG_DIRNAME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, LOG_FILENAME);
    return logFilePath;
  } catch {
    return null;
  }
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 尺寸滚动(同步 rename,失败静默——下一次写入继续追加旧文件,无副作用) */
function rotateIfNeeded(file: string): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size >= ROTATE_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // 文件尚不存在 / rename 失败:不处理
  }
}

function appendLine(file: string, line: string): Promise<void> {
  return fs.promises.appendFile(file, `${line}\n`, 'utf-8').catch(() => {
    degradedToStdoutOnly = true;
  });
}

/**
 * 记一条程序运行日志。context 可选(任务 ID / 连接器名等),拼在级别后。
 * 永不抛错、永不阻塞调用方(写入走内部串行队列,丢弃式背压:队列只在
 * 磁盘 IO 期间排队,不设上限——日志量级为生命周期+错误事件,天然有界)。
 */
export function logRuntime(level: RuntimeLogLevel, context: string, message: string): void {
  const line = `${formatTimestamp(Date.now())} [${level}]${context ? ` [${context}]` : ''} ${message}`;
  // stdout 镜像:docker logs 即实时程序日志
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);

  if (degradedToStdoutOnly) return;
  const file = resolveLogFilePath();
  if (!file) {
    degradedToStdoutOnly = true;
    return;
  }
  writeChain = writeChain
    .then(() => {
      rotateIfNeeded(file);
      return appendLine(file, line);
    })
    .catch(() => {});
}

/** 等待内部追加队列排空(测试用;业务路径无需调用) */
export function flushRuntimeLog(): Promise<void> {
  return writeChain;
}

/** 测试专用:重置模块级缓存(文件路径/降级标记/写队列) */
export function __resetRuntimeLogForTest(): void {
  writeChain = Promise.resolve();
  logFilePath = null;
  degradedToStdoutOnly = false;
}
