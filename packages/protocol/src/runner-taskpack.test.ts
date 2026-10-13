import { describe, it, expect } from 'vitest';
import { renderTaskPrompt, renderHandoffPack, extractPrFinal, PR_FINAL_FENCE } from './runner-taskpack';
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

describe('协议增补字段(additive:只增不改)', () => {
  it('issueContext 清洗保留;repo 段为 . / .. 一律拒绝(路径穿越第一道闸)', () => {
    expect(basePack.issueContext).toContain('采样参数越界');
    expect(normalizeTaskPack({ ...basePack, repo: '../etc' })).toBeNull();
    expect(normalizeTaskPack({ ...basePack, repo: 'owner/..' })).toBeNull();
    expect(normalizeTaskPack({ ...basePack, repo: './owner' })).toBeNull();
    expect(normalizeTaskPack({ ...basePack, baseBranch: 'a/../b' })).toBeNull();
  });
});
