import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SubagentTranscript } from '@agtpilot/plugin-subagent';

/**
 * subagent transcript 落盘适配器测试(spec §5.3,M2):
 * JSONL 只增追加、按日分文件、读回倒序、坏行/异常静默降级。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录,必须在动态 import 被测模块之前设置。
 */

let tmpDir: string;
let mod: typeof import('@/lib/subagent-transcript');

function entryOf(i: number, dayOffset = 0): SubagentTranscript {
  return {
    subTaskId: `task-1:sub:${i}`,
    parentTaskId: 'task-1',
    userId: 'u1',
    messages: [
      { role: 'user', content: `调研子任务 q${i}` },
      { role: 'assistant', content: `报告 ${i}` },
    ],
    usage: { promptTokens: 100 + i, completionTokens: 50 + i },
    finishedAt: Date.UTC(2026, 9, 13 - dayOffset, 12, 0, i),
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-subagent-tr-'));
  process.env.USER_DATA_DIR = tmpDir;
  mod = await import('@/lib/subagent-transcript');
});

afterAll(() => {
  delete process.env.USER_DATA_DIR;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

describe('appendSubagentTranscript', () => {
  it('追加 JSONL 到 getDataDir()/subagents/transcript-<day>.jsonl,一行一条可往返', () => {
    const entry = entryOf(1);
    mod.appendSubagentTranscript(entry);
    const file = path.join(tmpDir, 'subagents', 'transcript-2026-10-13.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });

  it('同日多次追加按序增行,不重写既有内容(只增不改)', () => {
    mod.appendSubagentTranscript(entryOf(2));
    mod.appendSubagentTranscript(entryOf(3));
    const file = path.join(tmpDir, 'subagents', 'transcript-2026-10-13.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]).subTaskId).toBe('task-1:sub:2');
    expect(JSON.parse(lines[2]).subTaskId).toBe('task-1:sub:3');
  });

  it('跨日按 finishedAt 分文件', () => {
    mod.appendSubagentTranscript(entryOf(4, 1)); // 2026-10-12
    const file = path.join(tmpDir, 'subagents', 'transcript-2026-10-12.jsonl');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('序列化失败(循环引用)静默降级不抛', () => {
    const circular: any = { role: 'user', content: 'x' };
    circular.self = circular;
    expect(() =>
      mod.appendSubagentTranscript({
        subTaskId: 'task-1:sub:bad',
        parentTaskId: 'task-1',
        messages: [circular],
        finishedAt: Date.UTC(2026, 9, 13),
      }),
    ).not.toThrow();
  });
});

describe('readSubagentTranscripts', () => {
  it('跨文件按时间倒序读回,limit 生效', () => {
    const all = mod.readSubagentTranscripts();
    // 4 条有效(坏条目未落盘):sub:3, sub:2, sub:1 在 10-13;sub:4 在 10-12
    expect(all.map((e) => e.subTaskId)).toEqual([
      'task-1:sub:3',
      'task-1:sub:2',
      'task-1:sub:1',
      'task-1:sub:4',
    ]);
    expect(mod.readSubagentTranscripts(2)).toHaveLength(2);
  });

  it('坏行跳过不抛', () => {
    const file = path.join(tmpDir, 'subagents', 'transcript-2026-10-13.jsonl');
    fs.appendFileSync(file, '{broken json\n', 'utf8');
    const all = mod.readSubagentTranscripts();
    expect(all.every((e) => typeof e.subTaskId === 'string')).toBe(true);
    expect(all).toHaveLength(4);
  });

  it('目录不存在时返回空数组', () => {
    const prev = process.env.USER_DATA_DIR;
    process.env.USER_DATA_DIR = path.join(tmpDir, 'no-such-dir-x');
    try {
      // getDataDir 会创建该目录但其中无 subagents/ → 空
      expect(mod.readSubagentTranscripts()).toEqual([]);
    } finally {
      process.env.USER_DATA_DIR = prev;
    }
  });
});
