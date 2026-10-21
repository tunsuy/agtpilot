import { describe, it, expect } from 'vitest';
import {
  toWireMission,
  stripConversation,
  isCronMission,
  toCronRunMeta,
  splitMissionsForWire,
  CRUISE_TITLE_PREFIX,
  CRON_RUNS_WIRE_CAP,
} from '../mission-wire';

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

describe('isCronMission 巡航会话判定(cruise-session-split)', () => {
  it('结构化标记 cronJobId 为唯一事实源', () => {
    expect(isCronMission({ id: 'a', title: '随便', cronJobId: 'cron_1' })).toBe(true);
    // 空白 cronJobId 不算(防脏数据误判)
    expect(isCronMission({ id: 'a', title: '随便', cronJobId: '  ' })).toBe(false);
  });

  it('旧数据无 cronJobId → 标题【自动巡航】前缀兜底识别(零迁移)', () => {
    expect(isCronMission({ id: 'b', title: `${CRUISE_TITLE_PREFIX}日更` })).toBe(true);
    expect(isCronMission({ id: 'c', title: '含【自动巡航】字样但不在开头' })).toBe(false);
  });

  it('手动会话 / 空值 → false', () => {
    expect(isCronMission({ id: 'd', title: '帮我查资料' })).toBe(false);
    expect(isCronMission(null)).toBe(false);
    expect(isCronMission(undefined)).toBe(false);
    expect(isCronMission('str')).toBe(false);
  });
});

describe('toCronRunMeta 执行历史行', () => {
  it('只发元信息:不带 steps/artifact 正文,hasArtifact 是布尔标记', () => {
    const row = toCronRunMeta(doneMission());
    expect(row).toEqual({
      id: 'mission_done_1',
      title: '帮我查资料',
      status: 'DONE',
      startedAt: 1_000,
      hasErrorStep: true, // step_err_ 尾步判定
      hasArtifact: true,
    });
    expect(row.jobId).toBeUndefined(); // 手动形态无 jobId
    expect((row as any).steps).toBeUndefined();
    expect((row as any).artifact).toBeUndefined();
  });

  it('cronJobId 透传为 jobId;stripped 行沿用已算好的 hasErrorStep', () => {
    const row = toCronRunMeta({
      id: 'r1',
      title: `${CRUISE_TITLE_PREFIX}日更`,
      status: 'DONE',
      startedAt: 5,
      cronJobId: 'cron_9',
      hasErrorStep: false,
    });
    expect(row.jobId).toBe('cron_9');
    expect(row.hasErrorStep).toBe(false); // 无 steps 也不误判
    expect(row.hasArtifact).toBe(false);
  });
});

describe('splitMissionsForWire 下行分流', () => {
  const manual = { id: 'm1', title: '手动会话', status: 'DONE', startedAt: 100, steps: [], artifact: { content: '正文' } };
  const cronDone = {
    id: 'c1',
    title: `${CRUISE_TITLE_PREFIX}日更`,
    status: 'DONE',
    startedAt: 300,
    cronJobId: 'cron_1',
    steps: [{ id: 's1', status: 'DONE' }],
    artifact: { title: '晨报', content: '# 晨报正文' },
  };
  const cronActive = {
    id: 'c2',
    title: `${CRUISE_TITLE_PREFIX}巡检`,
    status: 'ACTIVE',
    startedAt: 400,
    cronJobId: 'cron_2',
    steps: [{ id: 's1', status: 'RUNNING' }],
  };
  const cronNoArtifact = {
    id: 'c3',
    title: `${CRUISE_TITLE_PREFIX}旧任务`,
    status: 'INTERRUPTED',
    startedAt: 200, // 旧数据:无 cronJobId,标题前缀兜底
    steps: [],
  };

  it('missions 只装手动会话;巡航拆成 cronRuns(元信息)+ cronDeliverables(终态带交付物)', () => {
    const out = splitMissionsForWire([manual, cronDone, cronActive, cronNoArtifact]);
    expect(out.missions.map((m: any) => m.id)).toEqual(['m1']);
    // cronRuns:新前旧后,全状态收录,只有元信息
    expect(out.cronRuns.map((r: any) => r.id)).toEqual(['c2', 'c1', 'c3']);
    expect(out.cronRuns[0].jobId).toBe('cron_2');
    expect(out.cronRuns[2].jobId).toBeUndefined(); // 旧数据无 jobId,前端按任务名匹配
    expect((out.cronRuns[1] as any).artifact).toBeUndefined();
    // cronDeliverables:终态且带正文才进(ACTIVE 的 c2 与无交付物的 c3 不进)
    expect(out.cronDeliverables.map((m: any) => m.id)).toEqual(['c1']);
    expect(out.cronDeliverables[0].artifact).toEqual({ title: '晨报', content: '# 晨报正文' });
    expect(out.cronDeliverables[0].stripped).toBe(true); // 复用终态摘要投影
  });

  it('cronRuns 超上限截断(新前旧后保最近)', () => {
    const many = Array.from({ length: CRON_RUNS_WIRE_CAP + 30 }, (_, i) => ({
      id: `x${i}`,
      title: `${CRUISE_TITLE_PREFIX}刷量`,
      status: 'DONE',
      startedAt: i,
      cronJobId: 'cron_x',
      steps: [],
    }));
    const out = splitMissionsForWire(many);
    expect(out.cronRuns).toHaveLength(CRON_RUNS_WIRE_CAP);
    expect(out.cronRuns[0].id).toBe(`x${CRON_RUNS_WIRE_CAP + 29}`); // 最新的留下
  });

  it('空输入 → 三路全空(不 throw)', () => {
    expect(splitMissionsForWire([])).toEqual({ missions: [], cronRuns: [], cronDeliverables: [] });
  });
});
