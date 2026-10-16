import { describe, it, expect } from 'vitest';
import {
  buildTaskPackFromOpportunity,
  pickIssueUrl,
  issueNoFromUrl,
  handoffPackFor,
  newRunnerTaskId,
} from '../runner-dispatch';
import type { OssOpportunity } from '../../workshops/oss_radar/opportunities';

const opp: OssOpportunity = {
  number: 1,
  project: 'vllm-project/vllm',
  summary: '采样参数越界导致崩溃,负数温度场景\n第二行不进 PR 标题',
  kind: 'Bug 修复',
  links: ['https://docs.example.com/guide', 'https://github.com/vllm-project/vllm/issues/12345'],
  fit: '与你后端经验匹配',
  firstStep: '先读复现步骤',
  difficulty: '低',
};

describe('pickIssueUrl / issueNoFromUrl', () => {
  it('优先 GitHub Issue 直达,其次任意 GitHub 链接,非 GitHub → null', () => {
    expect(pickIssueUrl(opp.links)).toBe('https://github.com/vllm-project/vllm/issues/12345');
    expect(pickIssueUrl(['https://github.com/o/r', 'https://example.com'])).toBe('https://github.com/o/r');
    expect(pickIssueUrl(['https://example.com/a'])).toBeNull();
    expect(pickIssueUrl([])).toBeNull();
  });

  it('issueNo 提取;/issues/ 缺失 → null', () => {
    expect(issueNoFromUrl('https://github.com/o/r/issues/12345')).toBe('12345');
    expect(issueNoFromUrl('https://github.com/o/r')).toBeNull();
  });

  it('newRunnerTaskId:协议 ID_RE 兼容且带时间序', () => {
    const id = newRunnerTaskId(1_700_000_000_000);
    expect(id).toMatch(/^rtask_[a-z0-9]+_[a-z0-9]+$/);
    expect(id.length).toBeLessThanOrEqual(128);
  });
});

describe('buildTaskPackFromOpportunity(雷达机会 → 可入库任务包)', () => {
  it('标准机会 → 清洗后的任务包:分支默认值/固定约束/雷达上下文/PR 草稿/执行器缺省', () => {
    const pack = buildTaskPackFromOpportunity(opp, { taskId: 'rtask_fixed_1' });
    expect(pack).not.toBeNull();
    expect(pack!.taskId).toBe('rtask_fixed_1');
    expect(pack!.repo).toBe('vllm-project/vllm');
    expect(pack!.issueUrl).toBe('https://github.com/vllm-project/vllm/issues/12345');
    expect(pack!.workBranch).toBe('contrib/oss-radar-12345');
    expect(pack!.constraints).toContain('只修这个 Issue,改动最小化');
    // 续跑恢复点:WIP 留痕硬约束(中断后重试/重派看 git 记录接着做)
    expect(pack!.constraints.some((c) => c.includes('边做边小步 commit 留痕') && c.includes('git 记录为恢复点'))).toBe(true);
    expect(pack!.constraints.length).toBe(4);
    // Phase 1 禁网:雷达字段全部随包(issueContext)
    expect(pack!.issueContext).toContain('【雷达摘要】采样参数越界导致崩溃');
    expect(pack!.issueContext).toContain('【为什么适合】与你后端经验匹配');
    expect(pack!.issueContext).toContain('【建议第一步】先读复现步骤');
    expect(pack!.prDraft.title).toBe('fix: 采样参数越界导致崩溃,负数温度场景');
    expect(pack!.prDraft.bodyTemplate).toContain('https://github.com/vllm-project/vllm/issues/12345');
    expect(pack!.claimDraft).toContain('#12345');
    expect(pack!.executor).toEqual({ name: 'claude-code', maxTurns: 60, timeoutMinutes: 30 });
    expect(pack!.acceptance.testCommand).toBeUndefined();
    expect(pack!.acceptance.note).toContain('CONTRIBUTING');
  });

  it('workBranch/dispatchNote 覆写生效;空串回退默认', () => {
    const p1 = buildTaskPackFromOpportunity(opp, { workBranch: 'my/branch', dispatchNote: ' 优先看校验分支 ' });
    expect(p1!.workBranch).toBe('my/branch');
    expect(p1!.dispatchNote).toBe('优先看校验分支');
    const p2 = buildTaskPackFromOpportunity(opp, { workBranch: '   ', dispatchNote: '' });
    expect(p2!.workBranch).toBe('contrib/oss-radar-12345');
    expect(p2!.dispatchNote).toBeUndefined();
  });

  it('非法 workBranch(协议拒)→ null,不带病入库', () => {
    expect(buildTaskPackFromOpportunity(opp, { workBranch: '../escape' })).toBeNull();
    expect(buildTaskPackFromOpportunity(opp, { workBranch: '-x' })).toBeNull();
  });

  it('项目名非 owner/repo 或无 GitHub 链接 → null(卡片回到纯只读)', () => {
    expect(buildTaskPackFromOpportunity({ ...opp, project: 'vllm project' })).toBeNull();
    expect(buildTaskPackFromOpportunity({ ...opp, project: '../evil' })).toBeNull();
    expect(buildTaskPackFromOpportunity({ ...opp, project: 'a/b/c' })).toBeNull();
    expect(buildTaskPackFromOpportunity({ ...opp, links: ['https://example.com'] })).toBeNull();
  });

  it('无 Issue 编号(仅仓库链接)→ 分支名退化为 taskId 后缀,仍可派发', () => {
    const p = buildTaskPackFromOpportunity(
      { ...opp, links: ['https://github.com/vllm-project/vllm'] },
      { taskId: 'rtask_abc123_x9y8z7' }
    );
    expect(p).not.toBeNull();
    expect(p!.workBranch.startsWith('contrib/oss-radar-')).toBe(true);
  });
});

describe('handoffPackFor(T0 交接包与派发同源)', () => {
  it('可派发机会 → 交接包含仓库/Issue/认领留言/红线;不可派发 → null', () => {
    const text = handoffPackFor(opp);
    expect(text).not.toBeNull();
    expect(text!).toContain('开源贡献交接包 · vllm-project/vllm');
    expect(text!).toContain('https://github.com/vllm-project/vllm/issues/12345');
    expect(text!).toContain('push/PR 由人工确认后执行');
    expect(handoffPackFor({ ...opp, project: 'bad name' })).toBeNull();
  });
});

describe('buildTaskPackFromOpportunity · viaFork(经 fork 派发)', () => {
  it('只认真正 true;false/缺省 → undefined(直连语义,清洗层同规则)', () => {
    expect(buildTaskPackFromOpportunity(opp, { viaFork: true })!.viaFork).toBe(true);
    expect(buildTaskPackFromOpportunity(opp, { viaFork: false })!.viaFork).toBeUndefined();
    expect(buildTaskPackFromOpportunity(opp, {})!.viaFork).toBeUndefined();
  });
});

// ---------- 概览/时间线(mine + detail 路由与设备页任务列表的数据源) ----------

import {
  describeDispatchConflict,
  isRunnerTaskActive,
  latestTaskProgress,
  noActionLabel,
  partitionApprovalsByMission,
  RADAR_HISTORY_LIMIT,
  radarDispatchHistory,
  runnerDeletable,
  runnerRetryable,
  runnerStateMeta,
  RUNNER_RETRYABLE_LABEL,
  summarizeRunnerTask,
  taskEventTimeline,
  tasksForDevice,
  tombstoneAsHistorySource,
  type RunnerTaskSummary,
} from '../runner-dispatch';
import type { RunnerEvent, RunnerTaskRecord } from '@agtpilot/protocol';

function ev(at: number, type: RunnerEvent['type'], payload?: Record<string, unknown>): RunnerEvent {
  return { eventId: `ev_${at}`, taskId: 'rtask_1', deviceId: 'dev_1', at, type, ...(payload ? { payload } : {}) };
}

describe('latestTaskProgress(任务列表单行:最近一条可读进展)', () => {
  it('倒序找最近一条带摘要的 progress;工具事件拼「工具 摘要」', () => {
    const events = [
      ev(1, 'state', { state: 'running' }),
      ev(2, 'progress', { kind: 'tool', tool: 'Read', summary: 'sampling_params.py' }),
      ev(3, 'progress', { kind: 'result' }), // result 无摘要,跳过
      ev(4, 'progress', { kind: 'text', summary: '定位到校验分支' }),
    ];
    expect(latestTaskProgress(events)).toEqual({ text: '定位到校验分支', at: 4 });
    expect(latestTaskProgress([ev(2, 'progress', { kind: 'tool', tool: 'Bash', summary: 'pytest -x' })])).toEqual({
      text: 'Bash pytest -x',
      at: 2,
    });
  });

  it('无 progress 摘要时兜底 error 消息;全空/缺省 → undefined', () => {
    expect(latestTaskProgress([ev(1, 'state', { state: 'failed' }), ev(2, 'error', { message: '验收命令未通过' })])).toEqual({
      text: '验收命令未通过',
      at: 2,
    });
    expect(latestTaskProgress([ev(1, 'state', { state: 'queued' })])).toBeUndefined();
    expect(latestTaskProgress([])).toBeUndefined();
    expect(latestTaskProgress(undefined)).toBeUndefined();
  });

  it('超长摘要截断到 120 字符(单行展示形状)', () => {
    const long = 'x'.repeat(300);
    const r = latestTaskProgress([ev(1, 'progress', { kind: 'text', summary: long })])!;
    expect(r.text.length).toBeLessThanOrEqual(120);
  });
});

describe('summarizeRunnerTask(云端任务记录 → 概览行)', () => {
  const record = {
    taskId: 'rtask_1',
    userId: 'u1',
    pack: {
      taskId: 'rtask_1',
      kind: 'oss_contribution' as const,
      repo: 'milvus-io/milvus',
      issueUrl: 'https://github.com/milvus-io/milvus/issues/52049',
      workBranch: 'contrib/oss-radar-52049',
      constraints: [],
      acceptance: {},
      prDraft: { title: 't', bodyTemplate: '' },
      executor: { name: 'claude-code', maxTurns: 10, timeoutMinutes: 5 },
    },
    state: 'running' as const,
    createdAt: 1,
    updatedAt: 5,
    expiresAt: 9,
    events: [ev(4, 'progress', { kind: 'tool', tool: 'Bash', summary: 'git status' })],
  } as RunnerTaskRecord;

  it('摘要字段齐 + latest 来自事件;pack 大字段(约束/草稿)不透出', () => {
    const s = summarizeRunnerTask(record);
    expect(s).toMatchObject({
      taskId: 'rtask_1',
      state: 'running',
      repo: 'milvus-io/milvus',
      workBranch: 'contrib/oss-radar-52049',
      updatedAt: 5,
      latest: { text: 'Bash git status', at: 4 },
    });
    expect(JSON.stringify(s)).not.toContain('prDraft');
    expect(JSON.stringify(s)).not.toContain('events');
  });

  it('无事件 → 无 latest 字段(不是 undefined 值的键)', () => {
    const s = summarizeRunnerTask({ ...record, events: [] });
    expect('latest' in s).toBe(false);
  });

  it('retryable 透传:记录带 retryable:true → 概览行也带(供 UI 打「可重试」);缺省 → 无该键', () => {
    expect(summarizeRunnerTask({ ...record, state: 'failed', retryable: true }).retryable).toBe(true);
    expect('retryable' in summarizeRunnerTask({ ...record, state: 'failed' })).toBe(false);
  });

  it('关联会话:missionId 透出(互跳键);缺省不含字段', () => {
    expect(summarizeRunnerTask({ ...record, missionId: 'mission-9' }).missionId).toBe('mission-9');
    expect('missionId' in summarizeRunnerTask(record)).toBe(false);
  });

  it('待送达插话:只透出条数(正文不进列表轮询,数据最小化);空队列/缺省不含字段', () => {
    const withPending = summarizeRunnerTask({
      ...record,
      pendingInterjects: [
        { id: 'intj_a', text: 'git 用户名写错了', createdAt: 4 },
        { id: 'intj_b', text: '邮箱也改一下', createdAt: 5 },
      ],
    });
    expect(withPending.pendingInterjects).toBe(2);
    expect(JSON.stringify(withPending)).not.toContain('git 用户名写错了');
    expect('pendingInterjects' in summarizeRunnerTask(record)).toBe(false);
    expect('pendingInterjects' in summarizeRunnerTask({ ...record, pendingInterjects: [] })).toBe(false);
  });
});

describe('taskEventTimeline(事件 → 展示时间线,旧→新,截最近 limit 条)', () => {
  const events: RunnerEvent[] = [
    ev(1, 'state', { state: 'dispatched' }),
    ev(2, 'progress', { kind: 'tool', tool: 'Read', summary: 'sampling.py' }),
    ev(3, 'progress', { kind: 'text', summary: '开始修复' }),
    ev(4, 'phase1_result', { commitHash: 'abc', diffstat: 'big', testTail: 'ok' }),
    ev(5, 'state', { state: 'awaiting_approval' }),
    ev(6, 'error', { message: '发布失败' }),
  ];

  it('state/progress/error 进时间线;phase1_result 产出细节不透出(走审批卡)', () => {
    const rows = taskEventTimeline(events);
    expect(rows.map((r) => r.kind)).toEqual(['state', 'progress', 'progress', 'state', 'error']);
    expect(rows[0].text).toBe('状态 → 已被 runner 领取');
    expect(rows[1].text).toBe('Read · sampling.py');
    expect(rows[2].text).toBe('开始修复');
    expect(rows[4].text).toBe('发布失败');
    expect(rows.map((r) => r.at)).toEqual([1, 2, 3, 5, 6]);
    expect(JSON.stringify(rows)).not.toContain('commitHash');
  });

  it('只取最近 limit 条(尾部窗口);空/缺省 → []', () => {
    const rows = taskEventTimeline(events, 2);
    expect(rows.map((r) => r.kind)).toEqual(['state', 'error']);
    expect(taskEventTimeline(undefined)).toEqual([]);
    expect(taskEventTimeline([])).toEqual([]);
  });

  it('interject_ack → 送达状态行(成功 progress / 未送达 error + 中文原因);正文不回传也不展示', () => {
    const rows = taskEventTimeline([
      ev(1, 'interject_ack', { interjectId: 'intj_a', delivered: true }),
      ev(2, 'interject_ack', { interjectId: 'intj_b', delivered: false, reason: 'finishing' }),
      ev(3, 'interject_ack', { interjectId: 'intj_c', delivered: false, reason: 'not_started' }),
      ev(4, 'interject_ack', { interjectId: 'intj_d', delivered: false }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['progress', 'error', 'error', 'error']);
    expect(rows[0].text).toBe('插话已注入正在执行的会话');
    expect(rows[1].text).toBe('插话未送达(会话已收尾)');
    expect(rows[2].text).toBe('插话未送达(会话尚未启动)');
    expect(rows[3].text).toBe('插话未送达'); // 无 reason 不裸挂括号
  });
});

describe('runnerStateMeta / isRunnerTaskActive(话术与在途判定共用)', () => {
  it('10 态全覆盖;未知态 zinc 兜底不裸奔', () => {
    for (const s of ['queued', 'dispatched', 'running', 'awaiting_approval', 'finishing', 'done', 'failed', 'no_action', 'cancelled', 'expired']) {
      expect(runnerStateMeta(s).label.length).toBeGreaterThan(0);
    }
    expect(runnerStateMeta('mystery').label).toBe('mystery');
    // no-action 例外终态:teal 中性收敛(不是失败 rose 误导,也不是完成 emerald)
    expect(runnerStateMeta('no_action').label).toBe('无需改动');
    expect(runnerStateMeta('no_action').cls).toContain('teal');
  });

  it('终态五兄弟不在途,其余在途', () => {
    expect(isRunnerTaskActive('running')).toBe(true);
    expect(isRunnerTaskActive('awaiting_approval')).toBe(true);
    for (const s of ['done', 'failed', 'no_action', 'cancelled', 'expired']) expect(isRunnerTaskActive(s)).toBe(false);
  });
});

describe('runnerRetryable(「可重试」琥珀徽章判定,加固 ②)', () => {
  it('仅 failed + retryable:true → true(话术常量非空)', () => {
    expect(runnerRetryable({ state: 'failed', retryable: true })).toBe(true);
    expect(RUNNER_RETRYABLE_LABEL).toBe('可重试');
  });

  it('非 failed 态 / 无标记 / 显式 false → false(不误挂徽章)', () => {
    expect(runnerRetryable({ state: 'done', retryable: true })).toBe(false);
    expect(runnerRetryable({ state: 'running', retryable: true })).toBe(false);
    expect(runnerRetryable({ state: 'failed' })).toBe(false);
    expect(runnerRetryable({ state: 'failed', retryable: false })).toBe(false);
  });
});

describe('runnerDeletable(删除记录入口门控:仅终态)', () => {
  it('五个终态可删', () => {
    for (const state of ['done', 'failed', 'no_action', 'cancelled', 'expired']) {
      expect(runnerDeletable({ state }), state).toBe(true);
    }
  });

  it('在途/待审批不可删(先终止或审批卡拒绝落终态)', () => {
    for (const state of ['queued', 'dispatched', 'running', 'awaiting_approval', 'finishing']) {
      expect(runnerDeletable({ state }), state).toBe(false);
    }
    expect(runnerDeletable({ state: 'bogus_state' })).toBe(false);
  });
});

describe('tombstoneAsHistorySource(墓碑 → 雷达黑名单数据源)', () => {
  it('deletedAt 当 updatedAt 参与排序;issueUrl/reason 完整映射', () => {
    const src = tombstoneAsHistorySource({
      taskId: 'rtask_t1',
      issueUrl: 'https://github.com/o/r/issues/1',
      state: 'no_action',
      noActionReason: 'already_fixed',
      deletedAt: 999,
    });
    expect(src).toEqual({
      state: 'no_action',
      updatedAt: 999,
      pack: { issueUrl: 'https://github.com/o/r/issues/1' },
      noAction: { reason: 'already_fixed' },
    });
  });

  it('墓碑与在档任务混合:同 Issue 留最近一次,新墓碑盖旧结局', () => {
    const live = {
      state: 'failed',
      updatedAt: 100,
      pack: { issueUrl: 'https://github.com/o/r/issues/9' },
    };
    const tomb = tombstoneAsHistorySource({
      taskId: 'rtask_t2',
      issueUrl: 'https://github.com/o/r/issues/9',
      state: 'done',
      deletedAt: 200,
    });
    const h = radarDispatchHistory([live, tomb]);
    expect(h).toEqual([{ issueUrl: 'https://github.com/o/r/issues/9', outcome: '已派发并完成(PR 已发布)' }]);
  });
});

describe('tasksForDevice(设备详情归属:领取绑定或派发指定)', () => {
  const tasks = [
    { taskId: 'a', device: undefined, target: 'dev_1' }, // 排队中:派发指定,还未被领取
    { taskId: 'b', device: 'dev_1', target: 'dev_1' }, // 领取后绑定
    { taskId: 'c', device: 'dev_2', target: undefined }, // 其他设备
  ];
  const asTasks = tasks.map((t) => ({ taskId: t.taskId, deviceId: t.device, targetDeviceId: t.target })) as RunnerTaskSummary[];

  it('排队任务按 targetDeviceId 归入目标设备(刚派发、runner 未领取时也能在设备详情看到)', () => {
    expect(tasksForDevice(asTasks, 'dev_1').map((t) => t.taskId)).toEqual(['a', 'b']);
  });

  it('别的设备的任务不串门;无归属任务不进任何设备详情', () => {
    expect(tasksForDevice(asTasks, 'dev_2').map((t) => t.taskId)).toEqual(['c']);
    const orphan = [{ taskId: 'x' }] as RunnerTaskSummary[];
    expect(tasksForDevice(orphan, 'dev_1')).toEqual([]);
  });
});

// ---------- no-action 例外终态话术 + 派发防重话术 + 雷达派发历史 ----------

function mkTask(
  taskId: string,
  state: string,
  issueUrl: string,
  updatedAt: number,
  extra: Partial<RunnerTaskRecord> = {}
): RunnerTaskRecord {
  return {
    taskId,
    userId: 'u1',
    pack: {
      taskId,
      kind: 'oss_contribution',
      repo: 'milvus-io/milvus',
      issueUrl,
      workBranch: 'contrib/x',
      constraints: [],
      acceptance: {},
      prDraft: { title: 't', bodyTemplate: '' },
      executor: { name: 'claude-code', maxTurns: 10, timeoutMinutes: 5 },
    },
    state,
    createdAt: updatedAt,
    updatedAt,
    expiresAt: updatedAt + 1,
    ...extra,
  } as RunnerTaskRecord;
}

describe('noActionLabel / summarize noAction / describeDispatchConflict(结论与防重话术)', () => {
  it('reason → 中文标签(protocol 同源词表);未知枚举兜底「无需改动」', () => {
    expect(noActionLabel('already_fixed')).toBe('上游已修复');
    expect(noActionLabel('not_reproducible')).toBe('无法复现');
    expect(noActionLabel('out_of_scope')).toBe('不属于本仓库');
    expect(noActionLabel('other')).toBe('无需改动(其它)');
    expect(noActionLabel('mystery')).toBe('无需改动');
  });

  it('summarizeRunnerTask:带 noAction → 概览行含 reason/label/证据摘要(截 500);无标记不含键', () => {
    const s = summarizeRunnerTask(
      mkTask('rtask_1', 'no_action', 'https://github.com/milvus-io/milvus/issues/52049', 5, {
        noAction: { reason: 'already_fixed', evidence: 'e'.repeat(900) },
      })
    );
    expect(s.noAction!.reason).toBe('already_fixed');
    expect(s.noAction!.label).toBe('上游已修复');
    expect(s.noAction!.evidence).toHaveLength(500);
    expect('noAction' in summarizeRunnerTask(mkTask('rtask_2', 'failed', 'u', 5))).toBe(false);
  });

  it('describeDispatchConflict:no_action 摆结论与证据摘要;无证据不带空尾巴;active 提醒并行', () => {
    const noAct = describeDispatchConflict({
      kind: 'no_action',
      state: 'no_action',
      noAction: { reason: 'already_fixed', evidence: 'commit d9bef57b8f 已在基线' },
    });
    expect(noAct).toContain('无需改动');
    expect(noAct).toContain('上游已修复');
    expect(noAct).toContain('d9bef57b8f');
    expect(noAct).toContain('重复派发大概率再次得到同样结论');
    expect(describeDispatchConflict({ kind: 'no_action', state: 'no_action' })).not.toContain('证据:');
    const active = describeDispatchConflict({ kind: 'active', state: 'running' });
    expect(active).toContain('本地执行中');
    expect(active).toContain('并行执行两份');
  });
});

describe('radarDispatchHistory(雷达去重黑名单数据源)', () => {
  it('按 updatedAt 新→旧;同 issueUrl 只留最近一次;expired 不占名单', () => {
    const tasks = [
      mkTask('t1', 'failed', 'https://github.com/o/r/issues/1', 100),
      mkTask('t2', 'no_action', 'https://github.com/o/r/issues/1', 300, {
        noAction: { reason: 'already_fixed', evidence: 'e' },
      }),
      mkTask('t3', 'done', 'https://github.com/o/r/issues/2', 200),
      mkTask('t4', 'expired', 'https://github.com/o/r/issues/3', 400),
    ];
    const h = radarDispatchHistory(tasks);
    expect(h.map((e) => e.issueUrl)).toEqual([
      'https://github.com/o/r/issues/1',
      'https://github.com/o/r/issues/2',
    ]);
    expect(h[0].outcome).toContain('已核实无需改动');
    expect(h[0].outcome).toContain('上游已修复');
    expect(h[1].outcome).toBe('已派发并完成(PR 已发布)');
  });

  it('各状态结局话术:failed/cancelled/在途/no_action 缺标记兜底', () => {
    expect(radarDispatchHistory([mkTask('a', 'failed', 'u1', 1)])[0].outcome).toBe('已派发但失败');
    expect(radarDispatchHistory([mkTask('a', 'cancelled', 'u1', 1)])[0].outcome).toBe('已派发后被终止');
    expect(radarDispatchHistory([mkTask('a', 'running', 'u1', 1)])[0].outcome).toBe('已派发,进行中');
    expect(radarDispatchHistory([mkTask('a', 'no_action', 'u1', 1)])[0].outcome).toBe('已核实无需改动(无需改动(其它))');
  });

  it('空/缺 issueUrl 跳过;新→旧截断 limit(缺省 50)', () => {
    expect(radarDispatchHistory([])).toEqual([]);
    expect(radarDispatchHistory([mkTask('a', 'done', '', 1)])).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) =>
      mkTask(`t${i}`, 'done', `https://github.com/o/r/issues/${i}`, i)
    );
    const h = radarDispatchHistory(many);
    expect(h).toHaveLength(RADAR_HISTORY_LIMIT);
    expect(h[0].issueUrl).toBe('https://github.com/o/r/issues/79');
    expect(radarDispatchHistory(many, 3)).toHaveLength(3);
  });
});

describe('partitionApprovalsByMission(审批卡按会话归属分区)', () => {
  const mk = (id: string, missionId?: string) => ({ id, action: 'runner_publish', missionId });

  it('带 missionId 的只在所属会话可见,其他会话进 hidden', () => {
    const reqs = [mk('a', 'msn_1'), mk('b', 'msn_2')];
    expect(partitionApprovalsByMission(reqs, 'msn_1')).toEqual({
      visible: [reqs[0]],
      hidden: [reqs[1]],
    });
    expect(partitionApprovalsByMission(reqs, 'msn_2')).toEqual({
      visible: [reqs[1]],
      hidden: [reqs[0]],
    });
  });

  it('不带 missionId(会话内安全审批/历史单)恒可见,行为与旧版一致', () => {
    const reqs = [mk('a'), mk('b', 'msn_1')];
    const { visible, hidden } = partitionApprovalsByMission(reqs, 'msn_9');
    expect(visible).toEqual([reqs[0]]);
    expect(hidden).toEqual([reqs[1]]);
  });

  it('无选中会话(null/undefined)→ 带 missionId 的全部进 hidden', () => {
    const reqs = [mk('a', 'msn_1'), mk('b')];
    expect(partitionApprovalsByMission(reqs, null)).toEqual({ visible: [reqs[1]], hidden: [reqs[0]] });
    expect(partitionApprovalsByMission(reqs, undefined)).toEqual({ visible: [reqs[1]], hidden: [reqs[0]] });
  });

  it('空列表 → 双空;不改动入参数组', () => {
    expect(partitionApprovalsByMission([], 'msn_1')).toEqual({ visible: [], hidden: [] });
    const reqs = [mk('a', 'msn_1')];
    const { visible } = partitionApprovalsByMission(reqs, 'msn_1');
    expect(visible[0]).toBe(reqs[0]);
    expect(reqs).toHaveLength(1);
  });
});
