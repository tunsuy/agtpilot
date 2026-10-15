import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 动态 import:USER_DATA_DIR 必须先于模块首写落地(user-store.getDataDir 优先读它)
const load = async () => await import('../runtime-log');

describe('runtime-log · 程序运行日志(纯文本 .log)', () => {
  let dataDir: string;
  let logFile: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-rtlog-'));
    process.env.USER_DATA_DIR = dataDir;
    logFile = path.join(dataDir, 'logs', 'runtime.log');
    const m = await load();
    m.__resetRuntimeLogForTest();
  });

  afterEach(() => {
    delete process.env.USER_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('一行一条:时间戳 + 级别 + 上下文 + 消息,落在 <dataDir>/logs/runtime.log', async () => {
    const { logRuntime, flushRuntimeLog } = await load();
    logRuntime('ERROR', 'mission_123', '执行异常: Failed to process successful response');
    logRuntime('INFO', '', 'mission started: 测试任务');
    await flushRuntimeLog();

    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    // 纯文本格式:YYYY-MM-DD HH:MM:SS [LEVEL] [context] message
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[ERROR\] \[mission_123\] 执行异常: /);
    // 无上下文时不落空括号
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[INFO\] mission started: /);
  });

  it('串行追加:连续写不交错出半行(逐行完整、条数不丢)', async () => {
    const { logRuntime, flushRuntimeLog } = await load();
    for (let i = 0; i < 50; i++) logRuntime('INFO', 't', `line ${i}`);
    await flushRuntimeLog();
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(50);
    expect(lines[49].endsWith('line 49')).toBe(true);
  });

  it('尺寸滚动:超 10MB 滚为 runtime.log.1,继续写新文件', async () => {
    const { logRuntime, flushRuntimeLog } = await load();
    logRuntime('INFO', '', 'first');
    await flushRuntimeLog();
    // 手动把文件撑过阈值(写入真实内容,非稀疏)
    const padding = 'x'.repeat(10 * 1024 * 1024 + 1024);
    fs.appendFileSync(logFile, padding + '\n');
    logRuntime('ERROR', '', 'after rotate');
    await flushRuntimeLog();
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    const rotated = fs.readFileSync(`${logFile}.1`, 'utf-8');
    expect(rotated).toContain('first');
    expect(rotated).toContain(padding.slice(0, 100));
    const fresh = fs.readFileSync(logFile, 'utf-8');
    expect(fresh).toContain('after rotate');
    expect(fresh).not.toContain('first');
  });

  it('落盘失败静默降级:只留 stdout 镜像,不抛错不阻塞后续调用', async () => {
    const { logRuntime, flushRuntimeLog } = await load();
    // 数据目录整体换成不可写路径(删除后以文件占位,mkdir 失败 → 路径解析失败)
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.writeFileSync(dataDir, '占位文件,阻断 logs 目录创建');
    expect(() => logRuntime('ERROR', '', 'disk gone')).not.toThrow();
    await flushRuntimeLog();
    // 后续调用也不再尝试落盘(降级标记)
    expect(() => logRuntime('INFO', '', 'still alive')).not.toThrow();
    await flushRuntimeLog();
  });
});
