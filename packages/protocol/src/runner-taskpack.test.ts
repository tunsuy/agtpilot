import { describe, it, expect } from 'vitest';
import {
  renderTaskPrompt,
  renderHandoffPack,
  extractPrFinal,
  extractNoActionFinal,
  PR_FINAL_FENCE,
  NO_ACTION_FENCE,
  NO_ACTION_REASON_LABELS,
} from './runner-taskpack';
import { normalizeTaskPack, type RunnerTaskPack } from './runner';

const basePack = normalizeTaskPack({
  taskId: 'rtask_1',
  kind: 'oss_contribution',
  repo: 'vllm-project/vllm',
  issueUrl: 'https://github.com/vllm-project/vllm/issues/12345',
  baseBranch: 'main',
  workBranch: 'contrib/oss-radar-12345',
  constraints: ['只修这个 Issue', '不动无关文件'],
  acceptance: { testCommand: 'pytest tests/test_sampling.py', note: '相关单测要绿' },
  issueContext: '【标题】采样参数越界导致崩溃\n【正文】当 temperature 传入负数时…',
  claimDraft: '我想认领这个 Issue,预计今明两天提 PR。',
  prDraft: { title: 'fix: 采样参数解析越界', bodyTemplate: '关联 Issue: #12345' },
  executor: { name: 'claude-code', maxTurns: 40, timeoutMinutes: 20 },
  dispatchNote: '优先看 sampling_params.py 的校验分支',
}) as RunnerTaskPack;

describe('renderTaskPrompt(Phase 1 执行指令)', () => {
  const prompt = renderTaskPrompt(basePack);

  it('红线前置:禁 push/禁网/只修本 Issue/产出留本地', () => {
    const head = prompt.slice(0, 600);
    expect(head).toContain('严禁 git push');
    expect(head).toContain('严禁 gh/网络访问');
    expect(head).toContain('只修这个 Issue');
    expect(head).toContain('发布由用户在云端审批');
  });

  it('任务要素齐全:仓库/分支/Issue 链接/Issue 快照/约束/补充说明/验收命令', () => {
    expect(prompt).toContain('vllm-project/vllm');
    expect(prompt).toContain('contrib/oss-radar-12345');
    expect(prompt).toContain('https://github.com/vllm-project/vllm/issues/12345');
    expect(prompt).toContain('采样参数越界导致崩溃');
    expect(prompt).toContain('- 只修这个 Issue');
    expect(prompt).toContain('优先看 sampling_params.py');
    expect(prompt).toContain('pytest tests/test_sampling.py');
    expect(prompt).toContain('相关单测要绿');
  });

  it('Phase 1 禁网 → Issue 快照必须随包(无 issueContext 时不出快照段)', () => {
    expect(prompt).toContain('你无法联网,以此为准');
    const noCtx = renderTaskPrompt({ ...basePack, issueContext: undefined });
    expect(noCtx).not.toContain('【Issue 上下文】');
  });

  it('PR 终稿输出约定:围栏名 + JSON 骨架 + 不要 push 的收尾步骤', () => {
    expect(prompt).toContain('```' + PR_FINAL_FENCE);
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('不要 push');
    expect(prompt).toContain('fix: 采样参数解析越界'); // 草稿参考
  });

  it('缺验收命令 → 指向 CONTRIBUTING 的通用测试指引', () => {
    const p = renderTaskPrompt({ ...basePack, acceptance: {} });
    expect(p).toContain('CONTRIBUTING');
    expect(p).not.toContain('pytest');
  });
});

describe('renderTaskPrompt · WIP 留痕与续跑模式(中断续作,git 记录 = 恢复点)', () => {
  it('工作步骤要求边做边小步 commit 留痕,收尾前整理成干净 commit', () => {
    const p = renderTaskPrompt(basePack);
    expect(p).toContain('小步 commit');
    expect(p).toContain('wip: 完成复现与定位');
    expect(p).toContain('续跑的恢复点');
    expect(p).toContain('git reset --soft'); // 整理手段在白名单内(只影响本地副本)
    expect(p).toContain('不要 push'); // 整理不改变发布红线
  });

  it('continuation:true → 注入【续跑模式】块:先看现场(git log/status/diff),接着断点做,不重做', () => {
    const p = renderTaskPrompt(basePack, { continuation: true });
    expect(p).toContain('【续跑模式】');
    expect(p).toContain('上次尝试的成果');
    expect(p).toContain('git log origin/main..HEAD');
    expect(p).toContain('git status / git diff');
    expect(p).toContain('已完成的工作不要重做');
  });

  it('缺省 / 空 opts / continuation:false → 无续跑块(向后兼容,旧调用方零变化)', () => {
    expect(renderTaskPrompt(basePack)).not.toContain('续跑模式');
    expect(renderTaskPrompt(basePack, {})).not.toContain('续跑模式');
    expect(renderTaskPrompt(basePack, { continuation: false })).not.toContain('续跑模式');
  });

  it('opts.baseBranch = 实探基线(master 默认仓库)→ 仓库行与续跑块都用实探值', () => {
    const p = renderTaskPrompt(basePack, { continuation: true, baseBranch: 'master' });
    expect(p).toContain('基于 master');
    expect(p).toContain('git log origin/master..HEAD');
    expect(p).not.toContain('基于 main');
  });
});

describe('renderTaskPrompt · no-action 例外出口(第 6 步,与 pr-final 二选一)', () => {
  const prompt = renderTaskPrompt(basePack);

  it('例外出口在场:围栏名 + 与第 5 步二选一 + reason 枚举骨架 + evidence 必填', () => {
    expect(prompt).toContain('```' + NO_ACTION_FENCE);
    expect(prompt).toContain('例外出口(与第 5 步二选一)');
    expect(prompt).toContain('already_fixed | not_reproducible | out_of_scope');
    expect(prompt).toContain('"evidence"');
  });

  it('反偷懒护栏:不要硬凑 commit + 仅确凿证据可用 + 不许当逃避出口', () => {
    expect(prompt).toContain('不要硬凑 commit');
    expect(prompt).toContain('仅在有确凿证据时使用');
    expect(prompt).toContain('不许拿这个当逃避干活的出口');
  });

  it('三种合法情形点名:上游已修复 / 无法复现 / 不在本仓库', () => {
    expect(prompt).toContain('已被上游修复(修复 commit/PR 已在当前基线)');
    expect(prompt).toContain('按 Issue 描述无法复现');
    expect(prompt).toContain('问题不在本仓库');
  });

  it('第 6 步不引入新 opts:缺省与空 opts 输出逐字节一致(additive)', () => {
    expect(renderTaskPrompt(basePack)).toBe(renderTaskPrompt(basePack, {}));
  });

  it('NO_ACTION_REASON_LABELS:四个原因标签齐全非空(runner 日志与 web 任务卡同源)', () => {
    for (const r of ['already_fixed', 'not_reproducible', 'out_of_scope', 'other'] as const) {
      expect(NO_ACTION_REASON_LABELS[r].length).toBeGreaterThan(0);
    }
  });
});

describe('renderHandoffPack(T0 离线交接包)', () => {
  const pack = renderHandoffPack(basePack);

  it('人工降级路径要素齐全:仓库/Issue/分支/约束/验收/认领留言/PR 草稿', () => {
    expect(pack.startsWith('## 开源贡献交接包 · vllm-project/vllm')).toBe(true);
    expect(pack).toContain('https://github.com/vllm-project/vllm/issues/12345');
    expect(pack).toContain('contrib/oss-radar-12345');
    expect(pack).toContain('只修这个 Issue;不动无关文件');
    expect(pack).toContain('`pytest tests/test_sampling.py`');
    expect(pack).toContain('我想认领这个 Issue');
    expect(pack).toContain('fix: 采样参数解析越界');
  });

  it('三层发布红线写进交接包(对外发送永远人工)', () => {
    expect(pack).toContain('push/PR 由人工确认后执行');
  });

  it('与执行指令同源:同一 TaskPack 渲染,关键字段两边一致', () => {
    const prompt = renderTaskPrompt(basePack);
    for (const key of ['vllm-project/vllm', 'contrib/oss-radar-12345', 'pytest tests/test_sampling.py']) {
      expect(prompt).toContain(key);
      expect(pack).toContain(key);
    }
  });
});

describe('extractPrFinal(PR 终稿围栏提取)', () => {
  it('标准围栏提取 title/body', () => {
    const text = `任务完成。已 commit。\n\n\`\`\`${PR_FINAL_FENCE}\n{"title":"fix: 越界校验","body":"关联 #12345\\n\\n改动说明"}\n\`\`\`\n\n以上是终稿。`;
    expect(extractPrFinal(text)).toEqual({ title: 'fix: 越界校验', body: '关联 #12345\n\n改动说明' });
  });

  it('畸形 JSON / 缺 title / 无围栏 → null(不抛错)', () => {
    expect(extractPrFinal('```pr-final\n{oops\n```')).toBeNull();
    expect(extractPrFinal('```pr-final\n{"body":"无标题"}\n```')).toBeNull();
    expect(extractPrFinal('没有围栏的普通回复')).toBeNull();
  });

  it('title 超长截断到 300', () => {
    const long = 'x'.repeat(400);
    const r = extractPrFinal(`\`\`\`${PR_FINAL_FENCE}\n${JSON.stringify({ title: long, body: 'b' })}\n\`\`\``)!;
    expect(r.title).toHaveLength(300);
  });
});

describe('extractNoActionFinal(no-action 围栏提取:证据必填,脏输入降级)', () => {
  it('标准围栏提取 reason/evidence(围栏前后有闲话也能提取)', () => {
    const text = `核实完毕:该 Issue 已被上游修复。\n\n\`\`\`${NO_ACTION_FENCE}\n{"reason":"already_fixed","evidence":"修复 commit d9bef57b8f(PR #52261)经 git merge-base 验证已在当前基线"}\n\`\`\`\n\n以上是结论。`;
    expect(extractNoActionFinal(text)).toEqual({
      reason: 'already_fixed',
      evidence: '修复 commit d9bef57b8f(PR #52261)经 git merge-base 验证已在当前基线',
    });
  });

  it('未知 reason / 缺 reason → 归 other(降级不拒绝)', () => {
    expect(extractNoActionFinal(`\`\`\`${NO_ACTION_FENCE}\n{"reason":"fixed_maybe","evidence":"x"}\n\`\`\``)!.reason).toBe('other');
    expect(extractNoActionFinal(`\`\`\`${NO_ACTION_FENCE}\n{"evidence":"x"}\n\`\`\``)!.reason).toBe('other');
  });

  it('evidence 缺失/空串/纯空白/非字符串 → null(无证据的 no-action 不成立,回落「无产出」失败)', () => {
    expect(extractNoActionFinal(`\`\`\`${NO_ACTION_FENCE}\n{"reason":"already_fixed"}\n\`\`\``)).toBeNull();
    expect(extractNoActionFinal(`\`\`\`${NO_ACTION_FENCE}\n{"reason":"already_fixed","evidence":""}\n\`\`\``)).toBeNull();
    expect(extractNoActionFinal(`\`\`\`${NO_ACTION_FENCE}\n{"reason":"already_fixed","evidence":"   "}\n\`\`\``)).toBeNull();
    expect(extractNoActionFinal(`\`\`\`${NO_ACTION_FENCE}\n{"reason":"already_fixed","evidence":42}\n\`\`\``)).toBeNull();
  });

  it('畸形 JSON / 无围栏 → null(不抛错)', () => {
    expect(extractNoActionFinal(`\`\`\`${NO_ACTION_FENCE}\n{oops\n\`\`\``)).toBeNull();
    expect(extractNoActionFinal('没有围栏的普通回复')).toBeNull();
    expect(extractNoActionFinal('')).toBeNull();
  });

  it('超长 evidence 截断到 8000(截断不拒绝)', () => {
    const long = 'e'.repeat(9000);
    const r = extractNoActionFinal(`\`\`\`${NO_ACTION_FENCE}\n${JSON.stringify({ reason: 'other', evidence: long })}\n\`\`\``)!;
    expect(r.evidence).toHaveLength(8000);
  });

  it('两围栏并存 → 各自独立提取(约定二选一;优先级裁决在 executor 层:有 commit 即 commit 赢)', () => {
    const text = `\`\`\`${PR_FINAL_FENCE}\n{"title":"t","body":"b"}\n\`\`\`\n\n\`\`\`${NO_ACTION_FENCE}\n{"reason":"other","evidence":"x"}\n\`\`\``;
    expect(extractPrFinal(text)!.title).toBe('t');
    expect(extractNoActionFinal(text)!.evidence).toBe('x');
  });
});

describe('协议增补字段(additive:只增不改)', () => {
  it('issueContext 清洗保留;repo 段为 . / .. 一律拒绝(路径穿越第一道闸)', () => {
    expect(basePack.issueContext).toContain('采样参数越界');
    expect(normalizeTaskPack({ ...basePack, repo: '../etc' })).toBeNull();
    expect(normalizeTaskPack({ ...basePack, repo: 'owner/..' })).toBeNull();
    expect(normalizeTaskPack({ ...basePack, repo: './owner' })).toBeNull();
    expect(normalizeTaskPack({ ...basePack, baseBranch: 'a/../b' })).toBeNull();
  });

  it('viaFork:清洗只认真正 true;prompt/交接包给出 fork 语境说明', () => {
    expect(normalizeTaskPack({ ...basePack, viaFork: true })!.viaFork).toBe(true);
    expect(normalizeTaskPack({ ...basePack, viaFork: false })!.viaFork).toBeUndefined();
    expect(normalizeTaskPack({ ...basePack, viaFork: 'yes' })!.viaFork).toBeUndefined();
    expect(normalizeTaskPack(basePack)!.viaFork).toBeUndefined();

    const forkPrompt = renderTaskPrompt({ ...basePack, viaFork: true });
    expect(forkPrompt).toContain('fork 副本');
    expect(forkPrompt).toContain('vllm-project/vllm');
    expect(renderTaskPrompt(basePack)).not.toContain('fork 副本');

    const forkHandoff = renderHandoffPack({ ...basePack, viaFork: true });
    expect(forkHandoff).toContain('经 fork');
    expect(renderHandoffPack(basePack)).not.toContain('经 fork');
  });
});
