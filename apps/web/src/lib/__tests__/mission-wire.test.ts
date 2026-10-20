import { describe, it, expect } from 'vitest';
import { toWireMission, stripConversation } from '../mission-wire';

/** 构造一条终态历史会话(全量形态:会话历史 + 步骤 + 终端日志 + 视口截图) */
const doneMission = () => ({
  id: 'mission_done_1',
  userId: 'u1',
  title: '帮我查资料',
  status: 'DONE',
  progress: 100,
  startedAt: 1_000,
  steps: [
    { id: 'step_1', title: '搜索', status: 'DONE', answer: '…'.repeat(500) },
    { id: 'step_err_2', title: '出错了', status: 'FAILED' },
  ],
  conversationMessages: [{ role: 'user', content: '帮我查资料' }],
  terminalLogs: [{ id: 't1', text: 'log' }],
  viewport: { activeTab: 'browser', url: 'https://a.b', screenshotBase64: 'AAAA' },
  usage: { promptTokens: 10, completionTokens: 5 },
  artifact: { title: '交付', content: '# 正文' },
});

describe('toWireMission 终态会话 → 摘要', () => {
  it('剥掉 conversationMessages/steps/terminalLogs/viewport,列表渲染字段全保留(首屏瘦身主路径)', () => {
    const wire = toWireMission(doneMission());
    expect(wire.stripped).toBe(true);
    expect(wire.steps).toEqual([]);
    expect(wire.conversationMessages).toBeUndefined();
    expect(wire.terminalLogs).toBeUndefined();
    expect(wire.viewport).toBeUndefined();
    // 列表行/chip 依赖的元信息与交付库依赖的 artifact 必须在
    expect(wire.id).toBe('mission_done_1');
    expect(wire.title).toBe('帮我查资料');
    expect(wire.status).toBe('DONE');
    expect(wire.startedAt).toBe(1_000);
    expect(wire.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(wire.artifact).toEqual({ title: '交付', content: '# 正文' });
  });

  it('stepCount/hasErrorStep 前置计算(摘要没有 steps,子任务失败 chip 靠它判定)', () => {
    const wire = toWireMission(doneMission());
    expect(wire.stepCount).toBe(2);
    expect(wire.hasErrorStep).toBe(true);

    const ok = doneMission();
    ok.steps = [{ id: 'step_1', title: 'ok', status: 'DONE' }];
    expect(toWireMission(ok).hasErrorStep).toBe(false);
  });

  it('INTERRUPTED 同样出摘要(重启清扫后的中断会话也是历史)', () => {
    const m = { ...doneMission(), status: 'INTERRUPTED' };
    expect(toWireMission(m).stripped).toBe(true);
  });

  it('活跃会话保留 steps/terminalLogs/viewport(实时渲染需要),只剥 conversationMessages', () => {
    for (const status of ['ACTIVE', 'QUEUED', 'WAITING_APPROVAL']) {
      const wire = toWireMission({ ...doneMission(), status });
      expect(wire.stripped).toBeUndefined();
      expect(wire.steps).toHaveLength(2);
      expect(wire.terminalLogs).toHaveLength(1);
      expect(wire.viewport).toBeDefined();
      expect(wire.conversationMessages).toBeUndefined();
    }
  });

  it('只读投影:绝不修改传入对象(可能是 backend.state.missions 的内存活引用)', () => {
    const m = doneMission();
    toWireMission(m);
    expect(m.steps).toHaveLength(2);
    expect(m.conversationMessages).toHaveLength(1);
    expect(m.terminalLogs).toHaveLength(1);
    expect((m as any).stripped).toBeUndefined();
  });
});

describe('stripConversation live 帧瘦身', () => {
  it('剥 conversationMessages,其余字段原样保留(mission_updated 帧仍要驱动步骤渲染)', () => {
    const m = doneMission();
    const wire: any = stripConversation(m);
    expect(wire.conversationMessages).toBeUndefined();
    expect(wire.steps).toHaveLength(2);
    expect(wire.title).toBe('帮我查资料');
    // 不改原对象(落盘走原引用,剥线不剥盘)
    expect(m.conversationMessages).toHaveLength(1);
  });

  it('没有 conversationMessages 字段时原样返回(零开销路径)', () => {
    const m = { id: 'x', title: 't' };
    expect(stripConversation(m)).toBe(m);
  });
});
