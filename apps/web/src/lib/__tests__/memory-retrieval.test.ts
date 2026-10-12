import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UserMemory } from '@/lib/memory-service';

/**
 * P2 验收:两级注入(L0 摘要清单 + 高分全文)+ 按需 L2 工具 + 检索轨迹
 * —— docs/design/context-store-filesystem-paradigm.md §5 P2
 *
 * 覆盖:
 * 1. 注入块两级结构:高分项全文、其余一行式摘要(带 id,read_memory 指引);
 * 2. 最近任务 L0 清单(read_mission 寻址入口);
 * 3. 检索轨迹 audit/retrieval.jsonl:注入/召回/按需读取都留得分明细与落选原因;
 * 4. read_memory / read_mission 工具:L2 全文按需加载 + 命中反馈;
 * 5. summary 懒生成回退(不烧模型):title/goal 首句截断。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录,必须在动态 import 被测模块之前设置。
 */

let tmpDir: string;
let ms: typeof import('@/lib/memory-service');
let us: typeof import('@/lib/user-store');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-memp2-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'memp2-test-key';
  us = await import('@/lib/user-store');
  ms = await import('@/lib/memory-service');
});

afterAll(() => {
  delete process.env.USER_DATA_DIR;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

function mem(over: Partial<UserMemory> & { id: string; title: string; content: string }): UserMemory {
  return {
    category: 'fact',
    confidence: 0.8,
    updatedAt: Date.now(),
    source: 'auto',
    subject: 'user',
    ...over,
  } as UserMemory;
}

const GOAL = '把项目部署到阿里云服务器并配置 nginx 反向代理';

describe('两级注入 · L0 摘要清单 + 高分全文', () => {
  const uid = 'p2_inject';

  it('高分项全文注入;低分项进 L0 摘要清单(带 id 与 read_memory 指引)', () => {
    // 高相关:标题/内容命中「部署/阿里云」
    us.saveUserMemory(uid, mem({ id: 'mem_rel', title: '阿里云部署习惯', content: '部署到阿里云时先跑 make context-pack,再走 agthelm 交付' }));
    // 8 条低相关(超过全文条数预算,必然部分进 L0)
    for (let i = 0; i < 8; i++) {
      us.saveUserMemory(uid, mem({ id: `mem_low_${i}`, title: `无关偏好条目${i}`, content: `一些与运维无关的日常偏好描述 ${i}`, updatedAt: Date.now() - i * 1000 }));
    }

    const block = ms.buildMemoryPromptBlock(uid, GOAL);
    // 高相关记忆全文注入(内容原文可见)
    expect(block).toContain('agthelm 交付');
    // L0 摘要清单:低分记忆以「- id 摘要」一行式出现,并指引 read_memory
    expect(block).toContain('read_memory(id)');
    const lowInL0 = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => block.includes(`- mem_low_${i} `));
    expect(lowInL0.length).toBeGreaterThan(0);
    // L0 行不带全文内容(摘要层成本可控)
    expect(block).not.toContain('一些与运维无关的日常偏好描述 7');

    // 检索轨迹落盘:入选带 reason,落选带 summary-only
    const traces = us.readRetrievalTrace(uid).filter((t) => t.kind === 'memory-inject');
    expect(traces.length).toBeGreaterThanOrEqual(1);
    const t = traces[0];
    expect(String(t.goal)).toContain('阿里云');
    const selected = t.selected as any[];
    expect(selected.some((s) => s.id === 'mem_rel' && s.reason === 'top-score')).toBe(true);
    const omitted = t.omitted as any[];
    expect(omitted.some((o) => String(o.id).startsWith('mem_low_') && o.reason === 'summary-only')).toBe(true);
    expect(omitted.every((o) => typeof o.score === 'number')).toBe(true);
  });

  it('最近任务 L0 清单注入:id + 状态 + 摘要,指引 read_mission', () => {
    us.saveUserMission(uid, {
      id: 'task_p2_a',
      goal: '整理本周周报并推送到企业微信。包含进度与风险两段',
      status: 'DONE',
      steps: [{ tool: 'browser_navigate', status: 'DONE', output: 'ok', role: 'assistant' }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const block = ms.buildMemoryPromptBlock(uid, GOAL);
    expect(block).toContain('最近任务清单');
    expect(block).toContain('read_mission(id)');
    expect(block).toContain('- task_p2_a [DONE] 整理本周周报并推送到企业微信');
    // 摘要只取首句(懒生成,不烧模型)
    expect(block).not.toContain('包含进度与风险两段');
  });

  it('rule 红线始终全文注入(两级结构不弱化治理)', () => {
    us.saveUserMemory(
      uid,
      mem({ id: 'mem_rule', title: '发布前必须过三层围栏', content: '任何对外发布先走三层围栏校验', category: 'rule' })
    );
    const block = ms.buildMemoryPromptBlock(uid, '随便聊聊天');
    expect(block).toContain('任何对外发布先走三层围栏校验');
    const t = us.readRetrievalTrace(uid).find((x) => x.kind === 'memory-inject')!;
    expect((t.selected as any[]).some((s) => s.id === 'mem_rule' && s.reason === 'rule-always')).toBe(true);
  });
});

describe('按需 L2 · read_memory / read_mission 工具', () => {
  const uid = 'p2_tools';

  it('read_memory 取全文并计一次命中;未知 id 返回失败;两者都留轨迹', async () => {
    us.saveUserMemory(uid, mem({ id: 'mem_t1', title: 'pnpm 工作区约定', content: '装依赖用 pnpm install --prefer-offline,改动 workspace 依赖后先重装再 tsc' }));
    const tools = ms.buildUserMemoryTools(uid);
    const readMemory = tools.find((t) => t.name === 'read_memory')!;

    const before = ms.listActiveMemories(uid).find((m) => m.id === 'mem_t1')!;
    const hitsBefore = before.hitCount || 0;
    const res = await readMemory.execute({ id: 'mem_t1' });
    expect(res.success).toBe(true);
    expect(res.memory.content).toContain('pnpm install --prefer-offline');
    const after = ms.listActiveMemories(uid).find((m) => m.id === 'mem_t1')!;
    expect(after.hitCount || 0).toBe(hitsBefore + 1);

    const miss = await readMemory.execute({ id: 'mem_nope' });
    expect(miss.success).toBe(false);

    const kinds = us.readRetrievalTrace(uid).filter((t) => t.kind === 'memory-read');
    expect(kinds.length).toBeGreaterThanOrEqual(2);
    expect((kinds[0].omitted as any[])[0].reason).toBe('not-found-or-inactive'); // 最近在前
  });

  it('read_mission 取任务全文(目标/步骤/统计);未知 id 失败', async () => {
    us.saveUserMission(uid, {
      id: 'task_t1',
      goal: '把设计文档提交并推送',
      status: 'DONE',
      steps: [
        { tool: 'bash', status: 'DONE', output: 'pushed', role: 'assistant' },
        { role: 'assistant', answer: '已完成推送,commit f952c34' },
      ],
      efficiency: { toolCalls: 1, failedCalls: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const tools = ms.buildUserMemoryTools(uid);
    const readMission = tools.find((t) => t.name === 'read_mission')!;
    const res = await readMission.execute({ id: 'task_t1' });
    expect(res.success).toBe(true);
    expect(res.mission.goal).toBe('把设计文档提交并推送');
    expect(res.mission.stepsCount).toBe(2);
    expect(res.mission.recentSteps.some((s: any) => s.tool === 'bash')).toBe(true);
    expect((await readMission.execute({ id: 'task_nope' })).success).toBe(false);
    expect(us.readRetrievalTrace(uid).some((t) => t.kind === 'mission-read')).toBe(true);
  });

  it('memory_recall 工具召回也写检索轨迹', async () => {
    us.saveUserMemory(uid, mem({ id: 'mem_r1', title: '部署 checklist', content: '部署前跑测试与 lint' }));
    const tools = ms.buildUserMemoryTools(uid);
    const recall = tools.find((t) => t.name === 'memory_recall')!;
    await recall.execute({ query: '部署前要做什么' });
    const t = us.readRetrievalTrace(uid).find((x) => x.kind === 'memory-recall')!;
    expect(t).toBeTruthy();
    expect(String(t.query)).toContain('部署');
  });
});

describe('summary 懒生成回退(零模型成本)', () => {
  it('memorySummary:显式 summary 优先 → title → content 首句;超长截断', () => {
    expect(ms.memorySummary({ summary: '显式摘要', title: '标题', content: '内容' } as UserMemory)).toBe('显式摘要');
    expect(ms.memorySummary({ title: '只有标题', content: '内容' } as UserMemory)).toBe('只有标题');
    const long = ms.memorySummary({ title: '', content: 'x'.repeat(100) } as UserMemory);
    expect(long.length).toBeLessThanOrEqual(41); // 40 + 省略号
    expect(long.endsWith('…')).toBe(true);
  });

  it('missionSummary:显式 summary 优先,回退 goal 首句截断', () => {
    expect(ms.missionSummary({ summary: '任务摘要', goal: 'goal' })).toBe('任务摘要');
    expect(ms.missionSummary({ goal: '第一句话。第二句话' })).toBe('第一句话');
    expect(ms.missionSummary({})).toBe('');
  });
});
