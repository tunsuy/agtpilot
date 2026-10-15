import { describe, it, expect } from 'vitest';
import {
  RUNNER_PROTOCOL_VERSION,
  PAIR_CODE_LENGTH,
  PAIR_CODE_ALPHABET,
  isValidPairCodeFormat,
  isProtocolSupported,
  isTerminalRunnerState,
  canTransitionRunnerTask,
  normalizeTaskPack,
  normalizeRunnerEvent,
  normalizeDeviceMeta,
  normalizeNoAction,
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
