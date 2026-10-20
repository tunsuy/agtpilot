import { describe, it, expect } from 'vitest';
import {
  RUNNER_PROTOCOL_VERSION,
  PAIR_CODE_LENGTH,
  PAIR_CODE_ALPHABET,
  isValidPairCodeFormat,
  isProtocolSupported,
  isTerminalRunnerState,
  canTransitionRunnerTask,
  capText,
  parsePrUrl,
  normalizeTaskPack,
  normalizeRunnerEvent,
  normalizeDeviceMeta,
  normalizeNoAction,
  normalizeRunnerUsage,
  addRunnerUsage,
  type RunnerTaskState,
} from './runner';

/** 合法任务包 fixture(雷达机会卡派发形态) */
const validPack = {
  taskId: 'rtask_abc123',
  kind: 'oss_contribution',
  repo: 'vllm-project/vllm',
  issueUrl: 'https://github.com/vllm-project/vllm/issues/12345',
  workBranch: 'contrib/oss-radar-12345',
  constraints: ['只修这个 Issue', '不动无关文件'],
  acceptance: { testCommand: 'pytest tests/test_sampling.py', note: '相关单测要绿' },
  claimDraft: '我想认领这个 Issue,预计今明两天提 PR。',
  prDraft: { title: 'fix: 采样参数解析越界', bodyTemplate: '关联 Issue: #12345\n\n## 改动说明\n' },
  executor: { name: 'claude-code' },
};

describe('normalizeTaskPack · 合法输入', () => {
  it('完整字段原样保留', () => {
    const p = normalizeTaskPack(validPack);
    expect(p).not.toBeNull();
    expect(p!.repo).toBe('vllm-project/vllm');
    expect(p!.issueUrl).toBe('https://github.com/vllm-project/vllm/issues/12345');
    expect(p!.constraints).toEqual(['只修这个 Issue', '不动无关文件']);
    expect(p!.acceptance.testCommand).toBe('pytest tests/test_sampling.py');
    expect(p!.claimDraft).toContain('认领');
    expect(p!.prDraft.title).toBe('fix: 采样参数解析越界');
  });

  it('executor 缺省档位:maxTurns 60 / timeoutMinutes 30', () => {
    const p = normalizeTaskPack(validPack)!;
    expect(p.executor).toEqual({ name: 'claude-code', maxTurns: 60, timeoutMinutes: 30 });
  });

  it('executor 越界值收敛进 [1,200]/[1,240],NaN 走缺省', () => {
    expect(normalizeTaskPack({ ...validPack, executor: { name: 'claude-code', maxTurns: 999, timeoutMinutes: 0 } })!.executor)
      .toEqual({ name: 'claude-code', maxTurns: 200, timeoutMinutes: 1 });
    expect(normalizeTaskPack({ ...validPack, executor: { name: 'claude-code', maxTurns: 'abc' } })!.executor.maxTurns).toBe(60);
    expect(normalizeTaskPack({ ...validPack, executor: { name: 'claude-code', maxTurns: 4.4 } })!.executor.maxTurns).toBe(4);
  });

  it('可选字段缺失 → constraints 空数组、acceptance 空对象、无 baseBranch/claimDraft/dispatchNote', () => {
    const minimal = {
      taskId: 't1',
      kind: 'oss_contribution',
      repo: 'owner/repo',
      issueUrl: 'https://github.com/owner/repo/issues/1',
      workBranch: 'contrib/x',
      prDraft: { title: 'fix: x' },
      executor: { name: 'claude-code' },
    };
    const p = normalizeTaskPack(minimal)!;
    expect(p).not.toBeNull();
    expect(p.constraints).toEqual([]);
    expect(p.acceptance).toEqual({ testCommand: undefined, note: undefined });
    expect(p.baseBranch).toBeUndefined();
    expect(p.claimDraft).toBeUndefined();
    expect(p.prDraft.bodyTemplate).toBe('');
  });

  it('constraints 非字符串项过滤、超 20 条截断', () => {
    const p = normalizeTaskPack({
      ...validPack,
      constraints: [...Array.from({ length: 25 }, (_, i) => `c${i}`), 42, null],
    })!;
    expect(p.constraints).toHaveLength(20);
    expect(p.constraints.every((c) => typeof c === 'string')).toBe(true);
  });

  it('viaFork(经 fork 派发):只认真正 true;false/脏值/缺省 → undefined(直连语义)', () => {
    expect(normalizeTaskPack({ ...validPack, viaFork: true })!.viaFork).toBe(true);
    expect(normalizeTaskPack({ ...validPack, viaFork: false })!.viaFork).toBeUndefined();
    expect(normalizeTaskPack({ ...validPack, viaFork: 'yes' })!.viaFork).toBeUndefined();
    expect(normalizeTaskPack({ ...validPack, viaFork: 1 })!.viaFork).toBeUndefined();
    expect(normalizeTaskPack(validPack)!.viaFork).toBeUndefined();
  });
});

describe('normalizeTaskPack · 拒绝畸形输入(→ null)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['非对象', null as any],
    ['缺 taskId', { ...validPack, taskId: undefined }],
    ['taskId 带非法字符', { ...validPack, taskId: 'a b/../c' }],
    ['kind 非 oss_contribution', { ...validPack, kind: 'other' }],
    ['repo 非 owner/repo', { ...validPack, repo: 'just-a-name' }],
    ['repo 空段', { ...validPack, repo: 'owner/' }],
    ['issueUrl 非 https', { ...validPack, issueUrl: 'http://github.com/o/r/issues/1' }],
    ['issueUrl 缺失', { ...validPack, issueUrl: undefined }],
    ['workBranch 缺失', { ...validPack, workBranch: '' }],
    ['workBranch 以 - 开头(参数注入形态)', { ...validPack, workBranch: '--upload-pack=evil' }],
    ['workBranch 含 ..', { ...validPack, workBranch: 'a/../b' }],
    ['prDraft 缺失', { ...validPack, prDraft: undefined }],
    ['prDraft.title 空', { ...validPack, prDraft: { title: '  ' } }],
    ['executor 缺失', { ...validPack, executor: undefined }],
    ['executor.name 非 claude-code', { ...validPack, executor: { name: 'codex' } }],
    ['baseBranch 畸形', { ...validPack, baseBranch: '-evil' }],
  ];
  for (const [name, input] of cases) {
    it(name, () => expect(normalizeTaskPack(input)).toBeNull());
  }
});

describe('normalizeRunnerEvent', () => {
  const validEvent = {
    eventId: 'ev_1',
    taskId: 'rtask_abc123',
    deviceId: 'dev_1',
    at: 1760000000000,
    type: 'progress',
    payload: { tool: 'Bash', summary: 'pytest 通过' },
  };

  it('合法事件原样通过', () => {
    const e = normalizeRunnerEvent(validEvent)!;
    expect(e.eventId).toBe('ev_1');
    expect(e.type).toBe('progress');
    expect(e.payload).toEqual({ tool: 'Bash', summary: 'pytest 通过' });
    expect(e.at).toBe(1760000000000);
  });

  it('interject_ack(插话送达回执)在白名单内,payload 透传', () => {
    const e = normalizeRunnerEvent({
      ...validEvent,
      type: 'interject_ack',
      payload: { interjectId: 'intj_1', delivered: true },
    })!;
    expect(e.type).toBe('interject_ack');
    expect(e.payload).toEqual({ interjectId: 'intj_1', delivered: true });
  });

  it('type 白名单外 → null;身份字段缺失/畸形 → null', () => {
    expect(normalizeRunnerEvent({ ...validEvent, type: 'raw_output' })).toBeNull();
    expect(normalizeRunnerEvent({ ...validEvent, eventId: '' })).toBeNull();
    expect(normalizeRunnerEvent({ ...validEvent, taskId: 'a/../b' })).toBeNull();
    expect(normalizeRunnerEvent(null)).toBeNull();
  });

  it('payload 超上限 → 截断标记,事件本体保留', () => {
    const big = { ...validEvent, payload: { blob: 'x'.repeat(200) } };
    const e = normalizeRunnerEvent(big, { maxPayloadBytes: 100 })!;
    expect(e).not.toBeNull();
    expect(e.payload).toEqual({ __truncated: true, reason: 'payload_exceeds_limit' });
  });

  it('payload 为数组/非对象 → 丢弃 payload 但保留事件', () => {
    const e = normalizeRunnerEvent({ ...validEvent, payload: [1, 2, 3] })!;
    expect(e.payload).toBeUndefined();
  });

  it('at 非法 → 用注入的 now(测试可控)/Date.now()', () => {
    const e = normalizeRunnerEvent({ ...validEvent, at: 'yesterday' }, { now: 42 })!;
    expect(e.at).toBe(42);
  });
});

describe('normalizeDeviceMeta', () => {
  it('合法元信息通过,platform 缺失降级 unknown', () => {
    const m = normalizeDeviceMeta({ hostname: 'my-mac', runnerVersion: '0.0.1', protocolVersion: 1 })!;
    expect(m).toEqual({ hostname: 'my-mac', platform: 'unknown', runnerVersion: '0.0.1', protocolVersion: 1 });
  });

  it('hostname 控制字符剥除', () => {
    const m = normalizeDeviceMeta({ hostname: 'a\u0000b\u001bc', runnerVersion: '0.0.1', protocolVersion: 1 })!;
    expect(m.hostname).toBe('abc');
  });

  it('缺 hostname/版本号畸形/协议版本非数 → null', () => {
    expect(normalizeDeviceMeta({ runnerVersion: '0.0.1', protocolVersion: 1 })).toBeNull();
    expect(normalizeDeviceMeta({ hostname: 'h', runnerVersion: 'a b!', protocolVersion: 1 })).toBeNull();
    expect(normalizeDeviceMeta({ hostname: 'h', runnerVersion: '0.0.1', protocolVersion: 'one' })).toBeNull();
  });

  it('ghLogin:合法登录名保留;null/空串 → null(明确未登录);畸形/缺省 → 省略字段', () => {
    const base = { hostname: 'h', runnerVersion: '0.0.3', protocolVersion: 1 };
    expect(normalizeDeviceMeta({ ...base, ghLogin: 'tunsuy' })!.ghLogin).toBe('tunsuy');
    expect(normalizeDeviceMeta({ ...base, ghLogin: 'a-b-9' })!.ghLogin).toBe('a-b-9');
    expect(normalizeDeviceMeta({ ...base, ghLogin: null })!.ghLogin).toBeNull();
    expect(normalizeDeviceMeta({ ...base, ghLogin: '' })!.ghLogin).toBeNull();
    // 畸形(空格/连字符开头结尾/超 39 位)与缺省 → undefined(路由侧沿用存量值)
    expect(normalizeDeviceMeta({ ...base, ghLogin: 'a b' })!.ghLogin).toBeUndefined();
    expect(normalizeDeviceMeta({ ...base, ghLogin: '-lead' })!.ghLogin).toBeUndefined();
    expect(normalizeDeviceMeta({ ...base, ghLogin: 'trail-' })!.ghLogin).toBeUndefined();
    expect(normalizeDeviceMeta({ ...base, ghLogin: 'x'.repeat(40) })!.ghLogin).toBeUndefined();
    expect('ghLogin' in normalizeDeviceMeta(base)!).toBe(false);
  });
});

describe('normalizeNoAction(no-action 结论清洗:证据必填,脏输入降级)', () => {
  it('合法结论原样通过;reason 枚举内四个值都认', () => {
    expect(normalizeNoAction({ reason: 'already_fixed', evidence: '修复 commit d9bef57b8f 已在基线' })).toEqual({
      reason: 'already_fixed',
      evidence: '修复 commit d9bef57b8f 已在基线',
    });
    for (const r of ['already_fixed', 'not_reproducible', 'out_of_scope', 'other']) {
      expect(normalizeNoAction({ reason: r, evidence: 'x' })!.reason).toBe(r);
    }
  });

  it('未知 reason → 归 other(降级不拒绝)', () => {
    expect(normalizeNoAction({ reason: 'fixed_maybe?', evidence: 'x' })!.reason).toBe('other');
    expect(normalizeNoAction({ evidence: 'x' })!.reason).toBe('other');
  });

  it('evidence 缺失/空串/纯空白/非字符串 → null(无证据的 no-action 不成立)', () => {
    expect(normalizeNoAction({ reason: 'already_fixed' })).toBeNull();
    expect(normalizeNoAction({ reason: 'already_fixed', evidence: '' })).toBeNull();
    expect(normalizeNoAction({ reason: 'already_fixed', evidence: '   ' })).toBeNull();
    expect(normalizeNoAction({ reason: 'already_fixed', evidence: 42 })).toBeNull();
  });

  it('超长 evidence 截断 ≤8000(截断不拒绝);非对象/null → null', () => {
    expect(normalizeNoAction({ reason: 'other', evidence: 'e'.repeat(9000) })!.evidence).toHaveLength(8000);
    expect(normalizeNoAction(null)).toBeNull();
    expect(normalizeNoAction('already_fixed')).toBeNull();
  });
});

describe('状态机(§5.2)', () => {
  it('正向链路全通:queued→dispatched→running→awaiting_approval→finishing→done', () => {
    const chain: RunnerTaskState[] = ['queued', 'dispatched', 'running', 'awaiting_approval', 'finishing', 'done'];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(canTransitionRunnerTask(chain[i], chain[i + 1])).toBe(true);
    }
  });

  it('任何非终态可撤销/过期;终态不可再迁移', () => {
    for (const s of ['queued', 'dispatched', 'running', 'awaiting_approval', 'finishing'] as RunnerTaskState[]) {
      expect(canTransitionRunnerTask(s, 'cancelled')).toBe(true);
      expect(isTerminalRunnerState(s)).toBe(false);
    }
    for (const s of ['done', 'failed', 'no_action', 'cancelled', 'expired'] as RunnerTaskState[]) {
      expect(isTerminalRunnerState(s)).toBe(true);
      expect(canTransitionRunnerTask(s, 'cancelled')).toBe(false);
      expect(canTransitionRunnerTask(s, 'running')).toBe(false);
    }
  });

  it('no_action 例外终态:running→no_action 合法(云端 ingest 升级);其余来源一律拒绝', () => {
    expect(canTransitionRunnerTask('running', 'no_action')).toBe(true);
    expect(canTransitionRunnerTask('queued', 'no_action')).toBe(false);
    expect(canTransitionRunnerTask('dispatched', 'no_action')).toBe(false);
    expect(canTransitionRunnerTask('awaiting_approval', 'no_action')).toBe(false);
  });

  it('越级跳跃拒绝:queued 直达 done / running 直达 finishing', () => {
    expect(canTransitionRunnerTask('queued', 'done')).toBe(false);
    expect(canTransitionRunnerTask('running', 'finishing')).toBe(false);
    expect(canTransitionRunnerTask('awaiting_approval', 'done')).toBe(false);
  });

  it('finishing 可 failed(固化命令集某条失败即停)', () => {
    expect(canTransitionRunnerTask('finishing', 'failed')).toBe(true);
  });
});

describe('版本与配对码', () => {
  it('协议兼容:仅当前版本放行(字段只增不改,破坏性变更走大版本)', () => {
    expect(isProtocolSupported(RUNNER_PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolSupported(RUNNER_PROTOCOL_VERSION + 1)).toBe(false);
    expect(isProtocolSupported(0)).toBe(false);
    expect(isProtocolSupported('1')).toBe(false);
  });

  it('配对码格式:8 位、限用无易混字符集、大小写不敏感', () => {
    expect(PAIR_CODE_LENGTH).toBe(8);
    expect(PAIR_CODE_ALPHABET).not.toMatch(/[0O1IL]/);
    expect(isValidPairCodeFormat('ABCDEFGH')).toBe(true);
    expect(isValidPairCodeFormat(' abcd2345 ')).toBe(true); // 小写+空白容错(字符集内)
    expect(isValidPairCodeFormat('ABC0O1IL')).toBe(false); // 含易混字符
    expect(isValidPairCodeFormat('ABC')).toBe(false);
    expect(isValidPairCodeFormat(12345678)).toBe(false);
  });
});

describe('capText(内容型字段超限:截断+标记,不静默丢弃)', () => {
  it('限额内原样(trim 后)', () => {
    expect(capText('  hello  ', 100)).toBe('hello');
    expect(capText('x'.repeat(8000), 8000)).toBe('x'.repeat(8000));
  });

  it('超限 → 截断到限额内,尾部带原长标记(不再整字段消失)', () => {
    const out = capText('y'.repeat(9000), 8000);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(8000);
    expect(out!.endsWith('…[截断 9000→8000]')).toBe(true);
    expect(out!.startsWith('yyyy')).toBe(true);
  });

  it('极小限额(标记本身超限)→ 不炸、结果不超限额', () => {
    const out = capText('z'.repeat(100), 5);
    expect(out!.length).toBeLessThanOrEqual(5);
  });

  it('非字符串/空串 → undefined(可选字段缺省语义不变)', () => {
    expect(capText(undefined, 100)).toBeUndefined();
    expect(capText(42, 100)).toBeUndefined();
    expect(capText('   ', 100)).toBeUndefined();
  });
});

describe('normalizeTaskPack · 超限内容字段截断而非静默丢弃(2026-10-20 审计修复)', () => {
  it('issueContext 超 8000 → 截断+标记保留(agent 不再盲跑),旧行为是整字段消失', () => {
    const p = normalizeTaskPack({ ...validPack, issueContext: 'C'.repeat(9000) })!;
    expect(p.issueContext).toBeDefined();
    expect(p.issueContext!.length).toBeLessThanOrEqual(8000);
    expect(p.issueContext).toContain('…[截断 9000→8000]');
  });

  it('claimDraft/dispatchNote/acceptance.note/bodyTemplate 同口径截断', () => {
    const p = normalizeTaskPack({
      ...validPack,
      claimDraft: 'D'.repeat(6000),
      dispatchNote: 'E'.repeat(6000),
      acceptance: { note: 'F'.repeat(3000) },
      prDraft: { title: 'fix: t', bodyTemplate: 'G'.repeat(30000) },
    })!;
    expect(p.claimDraft!.length).toBeLessThanOrEqual(5000);
    expect(p.dispatchNote!.length).toBeLessThanOrEqual(5000);
    expect(p.acceptance.note!.length).toBeLessThanOrEqual(2000);
    expect(p.prDraft.bodyTemplate.length).toBeLessThanOrEqual(20000);
    expect(p.prDraft.bodyTemplate).toContain('截断');
  });

  it('constraints 单条超 500 → 截断保留(不整条丢)', () => {
    const p = normalizeTaskPack({ ...validPack, constraints: ['H'.repeat(600)] })!;
    expect(p.constraints).toHaveLength(1);
    expect(p.constraints[0].length).toBeLessThanOrEqual(500);
    expect(p.constraints[0]).toContain('…[截断 600→500]');
  });

  it('命令/标题类字段仍严格拒绝:超限 testCommand 整字段丢弃、prTitle 超限整包 null(截断命令可能变成另一条命令)', () => {
    const p = normalizeTaskPack({ ...validPack, acceptance: { testCommand: 'pytest ' + 'x'.repeat(600) } })!;
    expect(p.acceptance.testCommand).toBeUndefined();
    expect(normalizeTaskPack({ ...validPack, prDraft: { title: 'T'.repeat(301) } })).toBeNull();
  });
});

describe('normalizeRunnerUsage(本地 CLI 用量清洗)', () => {
  it('合法字段保留;整数取整;totalCostUsd 保 6 位小数', () => {
    expect(
      normalizeRunnerUsage({
        inputTokens: 1200.4,
        outputTokens: 340,
        cacheReadTokens: 99000,
        cacheCreationTokens: 100,
        totalCostUsd: 0.00431249,
        numTurns: 7,
        durationMs: 45000,
      })
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 99000,
      cacheCreationTokens: 100,
      totalCostUsd: 0.004312,
      numTurns: 7,
      durationMs: 45000,
    });
  });

  it('脏值(负数/NaN/Infinity/字符串/多余键)逐字段剔除,合法字段不受牵连', () => {
    expect(
      normalizeRunnerUsage({ inputTokens: -5, outputTokens: '900', numTurns: NaN, durationMs: Infinity, cacheReadTokens: 42, hacked: true })
    ).toEqual({ cacheReadTokens: 42 });
  });

  it('无一合法字段 / 非对象 → undefined(事件不带 usage 的语义)', () => {
    expect(normalizeRunnerUsage({})).toBeUndefined();
    expect(normalizeRunnerUsage({ inputTokens: -1 })).toBeUndefined();
    expect(normalizeRunnerUsage(null)).toBeUndefined();
    expect(normalizeRunnerUsage('1200')).toBeUndefined();
  });
});

describe('addRunnerUsage(用量累加:runner 侧加重试轮、云端侧加重派轮)', () => {
  it('两侧字段求和(含 cost 小数)', () => {
    expect(
      addRunnerUsage(
        { inputTokens: 100, outputTokens: 20, totalCostUsd: 0.001 },
        { inputTokens: 50, outputTokens: 30, numTurns: 2, totalCostUsd: 0.002 }
      )
    ).toEqual({ inputTokens: 150, outputTokens: 50, numTurns: 2, totalCostUsd: 0.003 });
  });

  it('任一侧缺省安全(首跑无 usage / 重试轮无 usage 都不炸)', () => {
    expect(addRunnerUsage(undefined, { inputTokens: 9 })).toEqual({ inputTokens: 9 });
    expect(addRunnerUsage({ inputTokens: 9 }, undefined)).toEqual({ inputTokens: 9 });
    expect(addRunnerUsage(undefined, undefined)).toBeUndefined();
  });

  it('脏侧先清洗再相加(事件重放/伪造字段不污染账本)', () => {
    expect(addRunnerUsage({ inputTokens: 10 }, { inputTokens: -999, outputTokens: 5 } as any)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('和为 0 的字段不落键(0 值不占存储)', () => {
    expect(addRunnerUsage({ inputTokens: 0 }, { inputTokens: 0 })).toBeUndefined();
  });
});

describe('parsePrUrl(PR 直达链接解析,prFollowUp 校验与云端拉评论共用)', () => {
  it('精确形状 → owner/repo/prNumber', () => {
    expect(parsePrUrl('https://github.com/vllm-project/vllm/pull/123')).toEqual({
      owner: 'vllm-project',
      repo: 'vllm',
      prNumber: 123,
    });
    // 前后空白容忍(用户粘贴常见)
    expect(parsePrUrl('  https://github.com/a/b/pull/1  ')!.prNumber).toBe(1);
  });

  it('非 PR 直达/issues 链接/带尾巴/非 github → null', () => {
    expect(parsePrUrl('https://github.com/a/b/issues/12')).toBeNull();
    expect(parsePrUrl('https://github.com/a/b/pull/12?diff=1')).toBeNull();
    expect(parsePrUrl('https://github.com/a/b/pull/12#issuecomment-1')).toBeNull();
    expect(parsePrUrl('https://github.com/a/b/pull/')).toBeNull();
    expect(parsePrUrl('https://gitlab.com/a/b/pull/1')).toBeNull();
    expect(parsePrUrl('http://github.com/a/b/pull/1')).toBeNull();
    expect(parsePrUrl(42)).toBeNull();
    expect(parsePrUrl(undefined)).toBeNull();
  });

  it("owner/repo 段为 '.'/'..' → null(路径穿越防线)", () => {
    expect(parsePrUrl('https://github.com/../x/pull/1')).toBeNull();
    expect(parsePrUrl('https://github.com/./x/pull/1')).toBeNull();
  });
});

describe('normalizeTaskPack · prFollowUp(PR 跟进标记:出现即任务身份,畸形整包拒绝)', () => {
  const fu = { prUrl: 'https://github.com/vllm-project/vllm/pull/999', baseTaskId: 'rtask_base_1' };

  it('合法 prFollowUp 原样保留', () => {
    const p = normalizeTaskPack({ ...validPack, prFollowUp: fu });
    expect(p!.prFollowUp).toEqual(fu);
  });

  it('baseTaskId 缺省 → 只留 prUrl(手工构包可用)', () => {
    const p = normalizeTaskPack({ ...validPack, prFollowUp: { prUrl: fu.prUrl } });
    expect(p!.prFollowUp).toEqual({ prUrl: fu.prUrl });
  });

  it('prUrl 畸形 → 整包 null(不静默降级为普通派发:降级会固化 gh pr create 对已有 PR 必败)', () => {
    expect(normalizeTaskPack({ ...validPack, prFollowUp: { prUrl: 'https://github.com/a/b/issues/1' } })).toBeNull();
    expect(normalizeTaskPack({ ...validPack, prFollowUp: { prUrl: 'https://github.com/a/b/pull/1?x=1' } })).toBeNull();
    expect(normalizeTaskPack({ ...validPack, prFollowUp: { prUrl: '' } })).toBeNull();
    expect(normalizeTaskPack({ ...validPack, prFollowUp: { prUrl: 42 } })).toBeNull();
    expect(normalizeTaskPack({ ...validPack, prFollowUp: {} })).toBeNull();
  });

  it('baseTaskId 畸形 → 整包 null', () => {
    expect(normalizeTaskPack({ ...validPack, prFollowUp: { ...fu, baseTaskId: 'a b' } })).toBeNull();
    expect(normalizeTaskPack({ ...validPack, prFollowUp: { ...fu, baseTaskId: 'x'.repeat(129) } })).toBeNull();
  });

  it('prFollowUp 非对象(字符串/null 除外)→ 整包 null', () => {
    expect(normalizeTaskPack({ ...validPack, prFollowUp: fu.prUrl })).toBeNull();
    // null/undefined = 未使用跟进语义,不是畸形 → 正常通过且无该字段
    expect(normalizeTaskPack({ ...validPack, prFollowUp: null })!.prFollowUp).toBeUndefined();
    expect(normalizeTaskPack(validPack)!.prFollowUp).toBeUndefined();
  });
});
