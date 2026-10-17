import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 超长工具输出落盘存储验收(docs/design/tool-output-spill.md §5):
 * 1. 存储层:落位 v2/<uid>/tool-output/<taskId>/<callId>.txt、写读往返、原子写;
 * 2. 续读:offset 窗口 + nextOffset;跨用户 not-found(不泄漏存在性);坏 id 拒绝;
 * 3. TTL 过期:诚实报错 + 惰性清理 + 审计;
 * 4. 预算 LRU:超限淘汰最旧任务目录,当前任务受保护;
 * 5. 级联:cleanupTaskToolOutputs 删整任务目录;
 * 6. 审计:spill/read/cleanup 全部进 audit/tool-output.jsonl;
 * 7. 工具面:read_tool_output(baseline/readOnly/low)execute 往返;
 * 8. v2 关闭回退旧平铺形态(对齐 agent-notes 先例)。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录,必须在动态 import 被测模块之前设置。
 */

let tmpDir: string;
let store: typeof import('@/lib/tool-output-store');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-spill-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'spill-test-key';
  store = await import('@/lib/tool-output-store');
});

afterAll(() => {
  delete process.env.USER_DATA_DIR;
  delete process.env.AGTPILOT_TOOL_SPILL_BUDGET_MB;
  delete process.env.AGTPILOT_TOOL_SPILL_TTL_DAYS;
  delete process.env.AGTPILOT_CONTEXT_STORE_V2;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

beforeEach(() => {
  delete process.env.AGTPILOT_TOOL_SPILL_BUDGET_MB;
  delete process.env.AGTPILOT_TOOL_SPILL_TTL_DAYS;
  delete process.env.AGTPILOT_CONTEXT_STORE_V2;
});

const spillFile = (uid: string, taskId: string, callId: string) =>
  path.join(tmpDir, 'v2', uid, 'tool-output', taskId, `${callId}.txt`);
const auditLines = (uid: string) => {
  const f = path.join(tmpDir, 'v2', uid, 'audit', 'tool-output.jsonl');
  if (!fs.existsSync(f)) return [] as any[];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

describe('存储层 · 落位与写读往返', () => {
  const uid = 't_store';

  it('spill 落位 v2/<uid>/tool-output/<taskId>/<callId>.txt,返回引用 id,内容全量', () => {
    const full = 'x'.repeat(20000);
    const ref = store.spillToolOutput(uid, { taskId: 'task_1', callId: 'call_a1', toolName: 'search_web', fullText: full });
    expect(ref).toBe('call_a1');
    expect(fs.readFileSync(spillFile(uid, 'task_1', 'call_a1'), 'utf8')).toBe(full);
    const spillAudit = auditLines(uid).filter((a) => a.kind === 'spill');
    expect(spillAudit).toHaveLength(1);
    expect(spillAudit[0]).toMatchObject({ callId: 'call_a1', taskId: 'task_1', tool: 'search_web', originalChars: 20000 });
  });

  it('read 往返:全文窗口 + totalChars;offset 续读带 nextOffset/hint', () => {
    const r1 = store.readToolOutput(uid, 'call_a1', 0, 8000);
    expect(r1.success).toBe(true);
    expect(r1.totalChars).toBe(20000);
    expect(r1.content).toHaveLength(8000);
    expect(r1.nextOffset).toBe(8000);
    expect(r1.hint).toContain('offset=8000');
    const r2 = store.readToolOutput(uid, 'call_a1', 19000, 8000);
    expect(r2.content).toHaveLength(1000);
    expect(r2.nextOffset).toBeUndefined(); // 读到尾
    expect(auditLines(uid).filter((a) => a.kind === 'read' && a.hit).length).toBeGreaterThanOrEqual(2);
  });

  it('非法 id(路径穿越/绝对路径/带点)一律拒绝,不落盘不读取', () => {
    expect(store.spillToolOutput(uid, { taskId: '../evil', callId: 'call_x', toolName: 't', fullText: 'x' })).toBeNull();
    expect(store.spillToolOutput(uid, { taskId: 'task_1', callId: '/etc/passwd', toolName: 't', fullText: 'x' })).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'v2', 'evil'))).toBe(false);
    const bad = store.readToolOutput(uid, '../../etc/passwd');
    expect(bad.success).toBe(false);
    expect(auditLines(uid).some((a) => a.kind === 'read' && a.reason === 'bad-id')).toBe(true);
  });
});

describe('多用户隔离 · 不泄漏存在性', () => {
  it('A 用户落盘的输出,B 用户读取按不存在处理(统一措辞)', () => {
    store.spillToolOutput('t_owner_a', { taskId: 'task_9', callId: 'call_secret', toolName: 'mcp_x', fullText: '机密'.repeat(100) });
    const r = store.readToolOutput('t_thief_b', 'call_secret');
    expect(r.success).toBe(false);
    expect(r.message).toContain('不存在或已过期');
    expect(r.message).not.toContain('机密');
    expect(auditLines('t_thief_b').some((a) => a.kind === 'read' && a.reason === 'not-found')).toBe(true);
  });
});

describe('TTL 过期 · 诚实报错 + 惰性清理', () => {
  const uid = 't_ttl';

  it('过期文件读取报「已过期清理,请重新执行原工具」,文件被清,审计留痕', () => {
    store.spillToolOutput(uid, { taskId: 'task_t', callId: 'call_old', toolName: 'browser_navigate', fullText: 'y'.repeat(100) });
    // 把文件 mtime 拨回 8 天前(默认 TTL 7 天)
    const f = spillFile(uid, 'task_t', 'call_old');
    const past = new Date(Date.now() - 8 * 86400 * 1000);
    fs.utimesSync(f, past, past);
    const r = store.readToolOutput(uid, 'call_old');
    expect(r.success).toBe(false);
    expect(r.message).toContain('已过期清理');
    expect(r.message).toContain('重新执行原工具');
    expect(fs.existsSync(f)).toBe(false); // 惰性清理
    expect(auditLines(uid).some((a) => a.kind === 'cleanup' && a.reason === 'ttl')).toBe(true);
  });

  it('env 调小 TTL(AGTPILOT_TOOL_SPILL_TTL_DAYS=0)立即生效', () => {
    store.spillToolOutput(uid, { taskId: 'task_t2', callId: 'call_now', toolName: 't', fullText: 'z'.repeat(50) });
    process.env.AGTPILOT_TOOL_SPILL_TTL_DAYS = '0';
    const f = spillFile(uid, 'task_t2', 'call_now');
    const past = new Date(Date.now() - 1000);
    fs.utimesSync(f, past, past);
    expect(store.readToolOutput(uid, 'call_now').success).toBe(false);
  });
});

describe('预算 LRU · 超限淘汰最旧任务,当前任务受保护', () => {
  const uid = 't_budget';

  it('预算压到极小:写新任务后最旧任务目录被整目录淘汰,新写入不被误杀', () => {
    process.env.AGTPILOT_TOOL_SPILL_BUDGET_MB = '0.00002'; // ≈21 字节
    store.spillToolOutput(uid, { taskId: 'task_old', callId: 'call_o1', toolName: 't', fullText: 'a'.repeat(100) });
    // 把旧任务目录 mtime 拨早,保证 LRU 顺序确定
    const oldDir = path.join(tmpDir, 'v2', uid, 'tool-output', 'task_old');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(oldDir, past, past);
    store.spillToolOutput(uid, { taskId: 'task_new', callId: 'call_n1', toolName: 't', fullText: 'b'.repeat(100) });
    expect(fs.existsSync(oldDir)).toBe(false); // 最旧被淘汰
    expect(store.readToolOutput(uid, 'call_n1').success).toBe(true); // 刚写入的仍可读(保护)
    expect(auditLines(uid).some((a) => a.kind === 'cleanup' && a.reason === 'budget' && a.taskId === 'task_old')).toBe(true);
  });

  it('预算充足时不淘汰', () => {
    delete process.env.AGTPILOT_TOOL_SPILL_BUDGET_MB;
    store.spillToolOutput(uid, { taskId: 'task_keep', callId: 'call_k1', toolName: 't', fullText: 'c'.repeat(100) });
    expect(store.readToolOutput(uid, 'call_n1').success).toBe(true);
    expect(store.readToolOutput(uid, 'call_k1').success).toBe(true);
  });
});

describe('任务删除级联清理', () => {
  const uid = 't_cascade';

  it('cleanupTaskToolOutputs 删整任务目录并留审计;非法 taskId 拒绝;不存在时静默', () => {
    store.spillToolOutput(uid, { taskId: 'task_del', callId: 'call_d1', toolName: 't', fullText: 'd'.repeat(100) });
    store.spillToolOutput(uid, { taskId: 'task_del', callId: 'call_d2', toolName: 't', fullText: 'e'.repeat(100) });
    store.cleanupTaskToolOutputs(uid, 'task_del');
    expect(fs.existsSync(path.join(tmpDir, 'v2', uid, 'tool-output', 'task_del'))).toBe(false);
    expect(store.readToolOutput(uid, 'call_d1').success).toBe(false);
    expect(auditLines(uid).some((a) => a.kind === 'cleanup' && a.reason === 'mission-delete' && a.taskId === 'task_del')).toBe(true);
    // 非法/不存在:不抛
    store.cleanupTaskToolOutputs(uid, '../escape');
    store.cleanupTaskToolOutputs(uid, 'task_never_exists');
  });
});

describe('工具面 · read_tool_output', () => {
  const uid = 't_tool';

  it('声明形态:baseline(白名单/路由退化场景必挂)+ readOnly + dangerLevel low', () => {
    const tools = store.buildToolOutputTools(uid);
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t.name).toBe('read_tool_output');
    expect(t.baseline).toBe(true);
    expect(t.readOnly).toBe(true);
    expect(t.dangerLevel).toBe('low');
    expect(t.parameters.required).toEqual(['callId']);
  });

  it('execute 往返:落盘 → 工具续读窗口;不存在的 callId 诚实报错', async () => {
    store.spillToolOutput(uid, { taskId: 'task_tool', callId: 'call_t1', toolName: 'mcp_big', fullText: '全文'.repeat(6000) });
    const t = store.buildToolOutputTools(uid)[0];
    const r: any = await t.execute({ callId: 'call_t1', offset: 0, limit: 100 } as any, {} as any);
    expect(r.success).toBe(true);
    expect(r.content).toHaveLength(100);
    expect(r.nextOffset).toBe(100);
    const miss: any = await t.execute({ callId: 'call_nope' } as any, {} as any);
    expect(miss.success).toBe(false);
    expect(miss.message).toContain('不存在或已过期');
  });
});

describe('v2 关闭 · 回退旧平铺形态', () => {
  const uid = 't_flat';

  it('AGTPILOT_CONTEXT_STORE_V2=0 → <safeName>.tool-output/ 平铺,写读往返一致', () => {
    process.env.AGTPILOT_CONTEXT_STORE_V2 = '0';
    const ref = store.spillToolOutput(uid, { taskId: 'task_f', callId: 'call_f1', toolName: 't', fullText: 'f'.repeat(300) });
    expect(ref).toBe('call_f1');
    const flat = path.join(tmpDir, `${uid}.tool-output`, 'task_f', 'call_f1.txt');
    expect(fs.existsSync(flat)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'v2', uid, 'tool-output'))).toBe(false);
    expect(store.readToolOutput(uid, 'call_f1').success).toBe(true);
    // 平铺形态审计同样落盘
    const auditF = path.join(tmpDir, `${uid}.tool-output.audit.jsonl`);
    expect(fs.existsSync(auditF)).toBe(true);
  });
});
