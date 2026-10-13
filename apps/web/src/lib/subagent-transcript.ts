/**
 * subagent transcript 落盘适配器(docs/design/subagent-plugin-spec.md §5.3,M2)。
 *
 * - 只增 JSONL:`getDataDir()/subagents/transcript-YYYY-MM-DD.jsonl`,一行一个子 run;
 * - 与 user-store 的浏览器审计(appendBrowserAudit)同一哲学:只增不改不重写;
 * - 写失败静默降级(审计是旁路,绝不影响子 agent 主流程,与 compaction 未挂载同款语义);
 * - 红线(spec §4.1):此文件仅供审计与(M3)续聊唤醒,任何代码路径不得将其自动回灌主上下文。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { SubagentTranscript } from '@agtpilot/plugin-subagent';
import { getDataDir } from './user-store';

/** transcript 存储根目录(getDataDir() 下,与用户数据同域) */
export function subagentTranscriptDir(): string {
  return path.join(getDataDir(), 'subagents');
}

function dayStamp(ts: number): string {
  return new Date(ts || Date.now()).toISOString().slice(0, 10);
}

const FILE_PATTERN = /^transcript-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** 追加一条子 run 完整 transcript(插件在 run 成功后调用;任何失败不抛) */
export function appendSubagentTranscript(entry: SubagentTranscript): void {
  try {
    const dir = subagentTranscriptDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `transcript-${dayStamp(entry?.finishedAt)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 静默降级:落盘失败不影响子 agent 返回 final report
  }
}

/** 审计/调试用:按时间倒序读取最近 limit 条 transcript(跨日文件;坏行跳过) */
export function readSubagentTranscripts(limit = 50): SubagentTranscript[] {
  const out: SubagentTranscript[] = [];
  try {
    const dir = subagentTranscriptDir();
    if (!fs.existsSync(dir)) return out;
    const files = fs
      .readdirSync(dir)
      .filter((f) => FILE_PATTERN.test(f))
      .sort()
      .reverse();
    for (const f of files) {
      const lines = fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .reverse();
      for (const line of lines) {
        try {
          out.push(JSON.parse(line));
        } catch {
          // 坏行跳过
        }
        if (out.length >= limit) return out;
      }
    }
  } catch {
    // 目录不可读视为空
  }
  return out;
}
