import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * P3 验收:Agent 笔记区(context_file 工具 + agent-notes 存储)
 * —— docs/design/context-store-filesystem-paradigm.md §5 P3
 *
 * 覆盖:
 * 1. 存储层:落位 v2/<uid>/agent-notes/、读写删往返、原子写;
 * 2. 治理约束:路径锁死(穿越/绝对路径/隐藏文件/深度拒绝)、单文件 16KB、
 *    总预算 64KB(满时拒绝不自动淘汰,覆盖旧文件扣减占用);
 * 3. 审计:全部操作与拒绝都进 audit/retrieval.jsonl(kind='agent-note');
 * 4. 工具面:context_file 五个 action;开关 AGTPILOT_AGENT_NOTES=0 不暴露;
 * 5. 注入:存量笔记进 prompt 的 L0 清单(跨任务可发现),开关关闭不显示。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录,必须在动态 import 被测模块之前设置。
 */

let tmpDir: string;
let us: typeof import('@/lib/user-store');
let ms: typeof import('@/lib/memory-service');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-notes-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'notes-test-key';
  delete process.env.AGTPILOT_AGENT_NOTES;
  us = await import('@/lib/user-store');
  ms = await import('@/lib/memory-service');
});

afterAll(() => {
  delete process.env.USER_DATA_DIR;
  delete process.env.AGTPILOT_AGENT_NOTES;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

beforeEach(() => {
  delete process.env.AGTPILOT_AGENT_NOTES;
});

const notesDir = (uid: string) => path.join(tmpDir, 'v2', uid, 'agent-notes');

function noteTool(uid: string) {
  const t = ms.buildUserMemoryTools(uid).find((x) => x.name === 'context_file');
  expect(t).toBeTruthy();
  return t!;
}

describe('存储层 · agent-notes 落位与往返', () => {
  const uid = 'n_store';

  it('写入落 v2/<uid>/agent-notes/;读回全文;删除回收', () => {
    const res = us.writeAgentNote(uid, 'deploy-research.md', '# 部署调研\n步骤一…');
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(notesDir(uid), 'deploy-research.md'))).toBe(true);
    expect(us.readAgentNote(uid, 'deploy-research.md')).toBe('# 部署调研\n步骤一…');

    // 子目录(≤2 层)也允许
    const sub = us.writeAgentNote(uid, 'drafts/plan.md', 'plan');
    expect(sub.ok).toBe(true);
    expect(fs.existsSync(path.join(notesDir(uid), 'drafts', 'plan.md'))).toBe(true);

    expect(us.deleteAgentNote(uid, 'deploy-research.md')).toBe(true);
    expect(us.readAgentNote(uid, 'deploy-research.md')).toBeNull();
    expect(us.deleteAgentNote(uid, 'deploy-research.md')).toBe(false); // 再删 → not-found

    const list = us.listAgentNotes(uid);
    expect(list.map((n) => n.path)).toEqual(['drafts/plan.md']);
    expect(list[0].size).toBe(Buffer.byteLength('plan'));
  });

  it('路径锁死:穿越/绝对路径/隐藏文件/超深度一律拒绝(I2 范围不扩大)', () => {
    const evil = ['../escape.md', '../../etc/passwd', '/abs/path.md', '.hidden.md', 'a/b/c.md', '', '  '];
    for (const p of evil) {
      const res = us.writeAgentNote(uid, p, 'x');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('invalid-path');
      expect(us.readAgentNote(uid, p)).toBeNull();
    }
    expect(us.resolveAgentNotePath(uid, '../escape.md')).toBeNull();
    // 反斜杠归一后同样受控
    expect(us.writeAgentNote(uid, '..\\escape.md', 'x').ok).toBe(false);
  });

  it('覆盖写入 = update;预算占用按净变化计算', () => {
    const u2 = 'n_overwrite';
    expect(us.writeAgentNote(u2, 'a.md', 'x'.repeat(100)).ok).toBe(true);
    const res = us.writeAgentNote(u2, 'a.md', 'y'.repeat(50));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.total).toBe(50); // 覆盖不叠加
    expect(us.readAgentNote(u2, 'a.md')).toBe('y'.repeat(50));
  });
});

describe('预算硬约束 · 单文件 16KB / 总预算 64KB', () => {
  const uid = 'n_budget';

  it('单文件超限 → file-too-large 拒绝', () => {
    const res = us.writeAgentNote(uid, 'big.md', 'x'.repeat(us.AGENT_NOTES_FILE_BYTES + 1));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('file-too-large');
      expect(res.limit).toBe(us.AGENT_NOTES_FILE_BYTES);
    }
  });

  it('总预算满 → total-budget 拒绝(不自动淘汰);覆盖小文件仍可行', () => {
    const chunk = us.AGENT_NOTES_FILE_BYTES - 1024; // 15KB
    for (let i = 0; i < 4; i++) {
      expect(us.writeAgentNote(uid, `f${i}.md`, 'x'.repeat(chunk)).ok).toBe(true);
    }
    // 60KB 已用,再写 5KB → 超 64KB 拒绝
    const over = us.writeAgentNote(uid, 'f4.md', 'x'.repeat(5 * 1024));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toBe('total-budget');
      expect(over.message).toContain('delete');
    }
    // 既有文件改小 → 允许(净占用下降)
    const shrink = us.writeAgentNote(uid, 'f0.md', 'x'.repeat(1024));
    expect(shrink.ok).toBe(true);
    // 腾出空间后可再写
    expect(us.writeAgentNote(uid, 'f4.md', 'x'.repeat(4 * 1024)).ok).toBe(true);
    const total = us.listAgentNotes(uid).reduce((s, n) => s + n.size, 0);
    expect(total).toBeLessThanOrEqual(us.AGENT_NOTES_TOTAL_BYTES);
  });
});

describe('审计 · 全操作进 retrieval.jsonl(kind=agent-note)', () => {
  const uid = 'n_audit';

  it('create/view/delete 与每次拒绝都留痕', () => {
    us.writeAgentNote(uid, 't.md', 'hello');
    us.readAgentNote(uid, 't.md');
    us.writeAgentNote(uid, '../evil.md', 'x'); // 拒绝也留痕
    us.deleteAgentNote(uid, 't.md');

    const traces = us.readRetrievalTrace(uid).filter((t) => t.kind === 'agent-note');
    expect(traces.length).toBeGreaterThanOrEqual(4);
    const byOp = (op: string) => traces.filter((t) => t.op === op);
    expect(byOp('create').some((t) => t.path === 't.md' && t.size === 5)).toBe(true);
    expect(byOp('view').some((t) => t.path === 't.md')).toBe(true);
    expect(byOp('delete').some((t) => t.path === 't.md')).toBe(true);
    expect(traces.some((t) => t.reason === 'invalid-path')).toBe(true);
  });
});

describe('工具面 · context_file', () => {
  const uid = 'n_tool';

  it('create → view → str_replace → delete 全链路', async () => {
    const tool = noteTool(uid);
    const created = await tool.execute({ action: 'create', path: 'todo.md', content: '- 步骤A\n- 步骤B' });
    expect(created.success).toBe(true);
    expect(created.message).toContain('路径引用');

    const viewed = await tool.execute({ action: 'view', path: 'todo.md' });
    expect(viewed.success).toBe(true);
    expect(viewed.content).toContain('步骤A');

    const replaced = await tool.execute({ action: 'str_replace', path: 'todo.md', old_str: '步骤B', new_str: '步骤B(已完成)' });
    expect(replaced.success).toBe(true);
    expect((await tool.execute({ action: 'view', path: 'todo.md' })).content).toContain('步骤B(已完成)');

    const listed = await tool.execute({ action: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.notes.some((n: any) => n.path === 'todo.md')).toBe(true);
    expect(listed.budgetBytes).toBe(us.AGENT_NOTES_TOTAL_BYTES);

    expect((await tool.execute({ action: 'delete', path: 'todo.md' })).success).toBe(true);
    expect((await tool.execute({ action: 'view', path: 'todo.md' })).success).toBe(false);
  });

  it('str_replace 防御:old_str 缺失/多处命中都拒绝;未知 action/缺 path 拒绝', async () => {
    const tool = noteTool(uid);
    await tool.execute({ action: 'create', path: 'dup.md', content: 'aa aa' });
    expect((await tool.execute({ action: 'str_replace', path: 'dup.md', old_str: '不存在', new_str: 'x' })).success).toBe(false);
    const dup = await tool.execute({ action: 'str_replace', path: 'dup.md', old_str: 'aa', new_str: 'b' });
    expect(dup.success).toBe(false);
    expect(dup.message).toContain('不唯一');
    expect((await tool.execute({ action: 'str_replace', path: 'dup.md', old_str: '', new_str: 'x' })).success).toBe(false);
    expect((await tool.execute({ action: 'rename', path: 'dup.md' })).success).toBe(false);
    expect((await tool.execute({ action: 'view' })).success).toBe(false); // 缺 path
  });

  it('开关 AGTPILOT_AGENT_NOTES=0 → 工具不暴露;恢复后回来', () => {
    expect(ms.buildUserMemoryTools(uid).some((t) => t.name === 'context_file')).toBe(true);
    process.env.AGTPILOT_AGENT_NOTES = '0';
    try {
      expect(ms.buildUserMemoryTools(uid).some((t) => t.name === 'context_file')).toBe(false);
      // 其余记忆工具不受影响
      expect(ms.buildUserMemoryTools(uid).some((t) => t.name === 'memory_store')).toBe(true);
    } finally {
      delete process.env.AGTPILOT_AGENT_NOTES;
    }
    expect(ms.buildUserMemoryTools(uid).some((t) => t.name === 'context_file')).toBe(true);
  });
});

describe('注入 · 笔记清单进 prompt(跨任务可发现)', () => {
  const uid = 'n_inject';

  it('有笔记 → 注入「Agent 笔记区」清单(path+大小)并指引 context_file;轨迹带 notes', () => {
    us.writeAgentNote(uid, 'k8s-debug.md', '# k8s 排障记录\n…');
    const block = ms.buildMemoryPromptBlock(uid, '帮我排查 k8s pod 崩溃');
    expect(block).toContain('Agent 笔记区');
    expect(block).toContain('- k8s-debug.md (');
    expect(block).toContain('context_file view');
    // 注入轨迹记录笔记清单(观测面)
    const t = us.readRetrievalTrace(uid).find((x) => x.kind === 'memory-inject');
    expect((t as any)?.notes).toContain('k8s-debug.md');
  });

  it('开关关闭 → 清单不注入;无笔记用户不出现该节', () => {
    process.env.AGTPILOT_AGENT_NOTES = '0';
    try {
      expect(ms.buildMemoryPromptBlock(uid, '排查 k8s')).not.toContain('Agent 笔记区');
    } finally {
      delete process.env.AGTPILOT_AGENT_NOTES;
    }
    // 无笔记 + 无记忆用户 → 空串(不为笔记节凭空注入)
    expect(ms.buildMemoryPromptBlock('n_nobody', '随便聊聊')).toBe('');
  });
});
