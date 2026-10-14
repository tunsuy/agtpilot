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
    expect(pack!.constraints.length).toBe(3);
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
