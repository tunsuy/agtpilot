import { describe, it, expect } from 'vitest';
import {
  buildPublishCommands,
  validatePublishCommand,
  extractPrUrl,
  normalizeDeviceAction,
  type FrozenCommand,
} from '../src/runner-publish';

const BASE_INPUT = {
  workBranch: 'contrib/oss-radar-123',
  baseBranch: 'main',
  prTitle: 'fix: 采样参数越界校验',
  prBody: '关联 Issue:https://github.com/owner/repo/issues/123\n\n## 改动说明\n修好了',
  issueUrl: 'https://github.com/owner/repo/issues/123',
  claimDraft: '我想认领这个 Issue(#123),预计近日内提交 PR 修复。',
};

describe('buildPublishCommands(批准时刻固化)', () => {
  it('缺省两条:git push -u origin <branch> + gh pr create 定序 10 元', () => {
    const cmds = buildPublishCommands(BASE_INPUT);
    expect(cmds).not.toBeNull();
    expect(cmds).toHaveLength(2);
    expect(cmds![0]).toEqual({ cmd: 'git', args: ['push', '-u', 'origin', 'contrib/oss-radar-123'] });
    expect(cmds![1].cmd).toBe('gh');
    expect(cmds![1].args.slice(0, 2)).toEqual(['pr', 'create']);
    expect(cmds![1].args).toContain('--head');
  });

  it('includeClaim + issueUrl + claimDraft → 追加 gh issue comment(决策项 6)', () => {
    const cmds = buildPublishCommands({ ...BASE_INPUT, includeClaim: true });
    expect(cmds).toHaveLength(3);
    expect(cmds![2]).toEqual({
      cmd: 'gh',
      args: ['issue', 'comment', BASE_INPUT.issueUrl, '--body', BASE_INPUT.claimDraft],
    });
  });

  it('includeClaim 但缺 claimDraft / issueUrl → 不追加(仍两条)', () => {
    expect(buildPublishCommands({ ...BASE_INPUT, includeClaim: true, claimDraft: undefined })).toHaveLength(2);
    expect(buildPublishCommands({ ...BASE_INPUT, includeClaim: true, issueUrl: undefined })).toHaveLength(2);
  });

  it('baseBranch 缺省 → main', () => {
    const cmds = buildPublishCommands({ ...BASE_INPUT, baseBranch: undefined });
    const baseIdx = cmds![1].args.indexOf('--base');
    expect(cmds![1].args[baseIdx + 1]).toBe('main');
  });

  it('畸形输入固化不出来:非法分支/超长标题 → null(拒绝批准,不带病固化)', () => {
    expect(buildPublishCommands({ ...BASE_INPUT, workBranch: '-rm-rf' })).toBeNull();
    expect(buildPublishCommands({ ...BASE_INPUT, workBranch: '../escape' })).toBeNull();
    expect(buildPublishCommands({ ...BASE_INPUT, prTitle: 'x'.repeat(301) })).toBeNull();
    expect(buildPublishCommands({ ...BASE_INPUT, prBody: 'y'.repeat(20001) })).toBeNull();
  });

  it('forkHead(经 fork 派发)→ PR head 固化为 owner:branch 跨仓形式;push 形状不变', () => {
    const cmds = buildPublishCommands({ ...BASE_INPUT, forkHead: 'tunsuy' });
    expect(cmds).not.toBeNull();
    expect(cmds![0]).toEqual({ cmd: 'git', args: ['push', '-u', 'origin', 'contrib/oss-radar-123'] });
    const headIdx = cmds![1].args.indexOf('--head');
    expect(cmds![1].args[headIdx + 1]).toBe('tunsuy:contrib/oss-radar-123');
    // base 仍是上游 baseBranch(不带 owner 前缀)
    expect(cmds![1].args[cmds![1].args.indexOf('--base') + 1]).toBe('main');
  });

  it('畸形 forkHead(带冒号/空格/以 - 开头)→ 整体 null,拒绝固化', () => {
    expect(buildPublishCommands({ ...BASE_INPUT, forkHead: 'a:b' })).toBeNull();
    expect(buildPublishCommands({ ...BASE_INPUT, forkHead: 'a b' })).toBeNull();
    expect(buildPublishCommands({ ...BASE_INPUT, forkHead: '-x' })).toBeNull();
  });
});

describe('validatePublishCommand(白名单:三种完整形状,其余全拒)', () => {
  const validGit: FrozenCommand = { cmd: 'git', args: ['push', '-u', 'origin', 'contrib/x'] };
  const validPr: FrozenCommand = {
    cmd: 'gh',
    args: ['pr', 'create', '--title', 'fix: t', '--body', 'b', '--base', 'main', '--head', 'contrib/x'],
  };
  const validComment: FrozenCommand = {
    cmd: 'gh',
    args: ['issue', 'comment', 'https://github.com/o/r/issues/9', '--body', '认领'],
  };

  it('三种合法形状全过,返回值是副本(改返回值不污染原对象)', () => {
    for (const c of [validGit, validPr, validComment]) {
      const v = validatePublishCommand(c);
      expect(v).not.toBeNull();
      expect(v).toEqual(c);
      expect(v).not.toBe(c);
    }
  });

  it('注入/畸形命令全拒(§10 M3 门禁用例)', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      'git push origin main', // 字符串命令(想走 shell 拼接的形态)
      { cmd: 'git' }, // 无 args
      { cmd: 'git', args: 'push' }, // args 非数组
      { cmd: 'git', args: ['push', 42] }, // 元素非字符串
      { cmd: 'bash', args: ['-c', 'git push origin main'] }, // shell 载体
      { cmd: 'sh', args: ['push'] },
      { cmd: 'git', args: ['commit', '-m', 'x'] }, // git 但非 push
      { cmd: 'git', args: ['push', 'origin', 'main'] }, // 缺 -u 形状不符
      { cmd: 'git', args: ['push', '-u', 'origin', 'contrib/x', '--force'] }, // 追加参数
      { cmd: 'git', args: ['push', '-u', 'origin', '--force'] }, // 分支位是 flag
      { cmd: 'git', args: ['push', '-u', 'origin', '../escape'] }, // 穿越分支
      { cmd: 'git', args: ['push', '-u', 'origin', 'a\nb'] }, // 控制字符
      { cmd: 'gh', args: ['pr', 'create', '--title', 't', '--body', 'b', '--base', 'main', '--head', 'h', '--draft'] }, // 11 元
      { cmd: 'gh', args: ['pr', 'create', '--body', 'b', '--title', 't', '--base', 'main', '--head', 'h'] }, // 换序
      { cmd: 'gh', args: ['pr', 'create', '--title', '', '--body', 'b', '--base', 'main', '--head', 'h'] }, // 空标题
      { cmd: 'gh', args: ['pr', 'create', '--title', 't', '--body', 'b', '--base', '-x', '--head', 'h'] }, // base 是 flag
      { cmd: 'gh', args: ['pr', 'merge', '--squash'] }, // gh 但非 pr create/issue comment
      { cmd: 'gh', args: ['issue', 'comment', 'https://evil.example.com/o/r/issues/1', '--body', 'x'] }, // 非 GitHub
      { cmd: 'gh', args: ['issue', 'comment', 'https://github.com/o/r/pull/1', '--body', 'x'] }, // PR 链接不行
      { cmd: 'gh', args: ['issue', 'comment', 'https://github.com/o/r/issues/1', '--body'] }, // 缺正文
      { cmd: 'curl', args: ['https://evil.example.com'] }, // 其他二进制
      { cmd: 'git', args: ['push', '-u', 'origin', 'x'.repeat(201)] }, // 超长分支
    ];
    for (const m of malformed) {
      expect(validatePublishCommand(m), JSON.stringify(m)).toBeNull();
    }
  });

  it('--head 允许 owner:branch 跨仓形式(经 fork 派发 → PR 指向上游)', () => {
    const v = validatePublishCommand({
      cmd: 'gh',
      args: ['pr', 'create', '--title', 't', '--body', 'b', '--base', 'main', '--head', 'tunsuy:contrib/x'],
    });
    expect(v).not.toBeNull();
  });

  it('--head 跨仓形式的畸形全拒:多冒号/空段/owner 带 - 或 ../分支段是 flag/穿越/控制字符', () => {
    const badHeads = ['a:b:c', ':x', 'x:', '-own:x', 'ow..ner:x', 'owner:-x', 'owner:../x', 'owner:a\nb', 'owner:x'.repeat(1) + '/' + 'y'.repeat(201)];
    for (const head of badHeads) {
      expect(
        validatePublishCommand({ cmd: 'gh', args: ['pr', 'create', '--title', 't', '--body', 'b', '--base', 'main', '--head', head] }),
        head
      ).toBeNull();
    }
    // base 位不接受跨仓形式(base 永远是上游分支名)
    expect(
      validatePublishCommand({ cmd: 'gh', args: ['pr', 'create', '--title', 't', '--body', 'b', '--base', 'own:main', '--head', 'h'] })
    ).toBeNull();
  });
});

describe('extractPrUrl(PR 链接回流)', () => {
  it('gh 输出混有警告行也能提取第一条 PR 链接', () => {
    const out = 'Warning: something\nhttps://github.com/owner/repo/pull/456\n';
    expect(extractPrUrl(out)).toBe('https://github.com/owner/repo/pull/456');
  });
  it('无 PR 链接 → null;空串 → null', () => {
    expect(extractPrUrl('Everything up-to-date')).toBeNull();
    expect(extractPrUrl('')).toBeNull();
  });
});

describe('normalizeDeviceAction(下行动作清洗)', () => {
  const publish = {
    taskId: 'rtask_1',
    approvalId: 'rappr_1',
    kind: 'publish',
    repo: 'owner/repo',
    workBranch: 'contrib/x',
    commands: [validCmd()],
  };
  function validCmd(): FrozenCommand {
    return { cmd: 'git', args: ['push', '-u', 'origin', 'contrib/x'] };
  }

  it('publish/cancel 合法形状通过', () => {
    expect(normalizeDeviceAction(publish)).toEqual(publish);
    const { commands: _drop, ...cancel } = { ...publish, kind: 'cancel' as const };
    expect(normalizeDeviceAction(cancel)).toEqual(cancel);
  });

  it('畸形拒绝:缺 id/kind 非法/缺 repo/publish 无命令/命令形状坏/命令超 3 条', () => {
    expect(normalizeDeviceAction(null)).toBeNull();
    expect(normalizeDeviceAction({ ...publish, approvalId: undefined })).toBeNull();
    expect(normalizeDeviceAction({ ...publish, kind: 'exec' })).toBeNull();
    expect(normalizeDeviceAction({ ...publish, repo: 42 })).toBeNull();
    expect(normalizeDeviceAction({ ...publish, commands: [] })).toBeNull();
    expect(normalizeDeviceAction({ ...publish, commands: undefined })).toBeNull();
    expect(normalizeDeviceAction({ ...publish, commands: [{ cmd: 'git' }] })).toBeNull();
    expect(normalizeDeviceAction({ ...publish, commands: [validCmd(), validCmd(), validCmd(), validCmd()] })).toBeNull();
  });

  it('forkRepo(经 fork 派发)合法透传;畸形拒绝;cancel 不携带', () => {
    const withFork = normalizeDeviceAction({ ...publish, forkRepo: 'tunsuy/repo' });
    expect(withFork!.forkRepo).toBe('tunsuy/repo');
    expect(normalizeDeviceAction({ ...publish, forkRepo: 42 })).toBeNull();
    expect(normalizeDeviceAction({ ...publish, forkRepo: 'just-name' })).toBeNull();
    expect(normalizeDeviceAction({ ...publish, forkRepo: '../evil' })).toBeNull(); // 段为 '..'
    expect(normalizeDeviceAction({ ...publish, forkRepo: 'a/../../b' })).toBeNull(); // 多段穿越
    const cancel = normalizeDeviceAction({ ...publish, kind: 'cancel', forkRepo: 'tunsuy/repo', commands: undefined });
    expect(cancel!.kind).toBe('cancel');
    expect('forkRepo' in cancel!).toBe(false);
  });
});
