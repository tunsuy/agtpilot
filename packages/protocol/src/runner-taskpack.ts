import type { RunnerTaskPack } from './runner';

/**
 * 任务包渲染器(docs/design/local-runner-bridge.md §8「任务包格式」行;纯函数):
 *
 * - renderTaskPrompt:TaskPack → 本地 coding agent 的执行指令(claude -p 的 prompt)。
 *   Phase 1 红线写进 prompt 头部,但**不依赖 prompt 约束安全** —— 真正的围栏是
 *   spawn 时的 --allowedTools/--disallowedTools 白名单(executor.ts)与云端审批门。
 * - renderHandoffPack:TaskPack → T0 离线交接包(markdown,§6.3)。机会卡「复制交接包」
 *   按钮永远可用:runner 未配对/离线/执行失败时的人工降级路径,两者同源不漂移。
 */

/** PR 终稿回传约定:agent 完成后在最终回复里输出该围栏 JSON 块,runner 解析回流 */
export const PR_FINAL_FENCE = 'pr-final';

/** renderTaskPrompt 可选项(additive:缺省行为与旧版逐字节一致) */
export interface RenderTaskPromptOptions {
  /**
   * 续跑模式:工作分支上已有上次尝试的成果(WIP commit 或未提交改动)。
   * true → prompt 注入【续跑模式】块:agent 先看 git log/status/diff 认清现场,
   * 接着上次断点继续,已完成的不重做(git 记录 = 断点续作的恢复点)。
   */
  continuation?: boolean;
  /** 实探生效的基线分支名(prepareRepo 回流;缺省 pack.baseBranch ?? 'main') */
  baseBranch?: string;
}

export function renderTaskPrompt(pack: RunnerTaskPack, opts?: RenderTaskPromptOptions): string {
  const base = opts?.baseBranch || pack.baseBranch || 'main';
  const lines: string[] = [];
  lines.push(`【开源贡献任务 · 本地执行】`);
  lines.push('');
  lines.push('你在用户本机的一份仓库副本里工作。红线(必须遵守):');
  lines.push('- 只修这个 Issue 涉及的代码,不动无关文件,不顺手重构;');
  lines.push('- 严禁 git push、严禁 gh/网络访问、严禁任何对外副作用(工具白名单已禁,勿尝试绕过);');
  lines.push('- 遵循仓库 CONTRIBUTING 的代码风格与提交规范;');
  lines.push('- 一切产出留在本地:commit 到指定分支即止,发布由用户在云端审批后另行执行。');
  lines.push('');
  lines.push(`仓库:${pack.repo}(已检出分支 ${pack.workBranch},基于 ${base})`);
  if (opts?.continuation) {
    lines.push('');
    lines.push('【续跑模式】本次是中断后的续跑,工作分支上可能已有上次尝试的成果(WIP commit 或未提交改动):');
    lines.push(`- 动手前先看清现场:git log origin/${base}..HEAD 看已有哪些提交,git status / git diff 看未提交的改动;`);
    lines.push('- 在上次的基础上继续,已完成的工作不要重做、不要回退既有改动(确认是错的除外);');
    lines.push('- 未提交的半成品与你的计划冲突时,可以清理后重新组织,但保留已完成工作的意图;');
    lines.push('- 收尾要求同工作步骤:整理成符合仓库规范的干净 commit。');
  }
  if (pack.viaFork) {
    lines.push(`说明:本地克隆是你对 ${pack.repo} 的 fork 副本(origin 指向 fork);改动最终以 PR 从 fork 提交给上游,与你的工作方式无关——照常改码、commit 即可。`);
  }
  lines.push(`Issue:${pack.issueUrl}`);
  if (pack.issueContext) {
    lines.push('');
    lines.push('【Issue 上下文】(派发时抓取的快照,你无法联网,以此为准)');
    lines.push(pack.issueContext);
  }
  if (pack.constraints.length > 0) {
    lines.push('');
    lines.push('【任务约束】');
    for (const c of pack.constraints) lines.push(`- ${c}`);
  }
  if (pack.dispatchNote) {
    lines.push('');
    lines.push('【用户补充说明】');
    lines.push(pack.dispatchNote);
  }
  lines.push('');
  lines.push('【工作步骤】');
  lines.push('1. 读 Issue 上下文与相关代码,先弄清再动手;');
  lines.push('2. 实现修复/改进,保持改动最小;**边做边小步 commit 到工作分支**(WIP 信息即可,如 `wip: 完成复现与定位`)——git 记录是中断后续跑的恢复点,每完成一个阶段就落一次;');
  if (pack.acceptance.testCommand) {
    lines.push(`3. 运行验收命令并保证通过:${pack.acceptance.testCommand}`);
  } else {
    lines.push('3. 运行仓库相关测试并保证通过(按 CONTRIBUTING 指引)');
  }
  if (pack.acceptance.note) lines.push(`   验收说明:${pack.acceptance.note}`);
  lines.push('4. 收尾前把 WIP commit 整理成符合仓库规范的干净 commit(git reset --soft 到基线后重新提交即可),信息关联 Issue;不要 push;');
  lines.push('5. 在最终回复末尾输出 PR 终稿,格式严格如下(围栏名不可改):');
  lines.push('');
  lines.push('```' + PR_FINAL_FENCE);
  lines.push(JSON.stringify({ title: 'PR 标题(遵循仓库规范,如 fix: …)', body: 'PR 正文 markdown:改动说明/关联 Issue/测试情况' }, null, 2));
  lines.push('```');
  if (pack.prDraft?.title) {
    lines.push('');
    lines.push(`PR 草稿参考(以你按实际改动补全的终稿为准):标题「${pack.prDraft.title}」`);
    if (pack.prDraft.bodyTemplate) lines.push(`正文模板:\n${pack.prDraft.bodyTemplate}`);
  }
  return lines.join('\n');
}

/** T0 离线交接包:十几行 markdown,粘进任意本地 coding agent 会话即可人工走完全程 */
export function renderHandoffPack(pack: RunnerTaskPack): string {
  const lines: string[] = [];
  lines.push(`## 开源贡献交接包 · ${pack.repo}`);
  lines.push('');
  lines.push(`- Issue:${pack.issueUrl}`);
  lines.push(`- 基线分支:${pack.baseBranch ?? 'main'}(工作分支建议 \`${pack.workBranch}\`)`);
  if (pack.viaFork) lines.push(`- 派发方式:经 fork —— 先 fork 上游 ${pack.repo} 到你的账号,在 fork 里改,PR 从 fork 指向上游`);
  if (pack.constraints.length > 0) lines.push(`- 约束:${pack.constraints.join(';')}`);
  if (pack.acceptance.testCommand) lines.push(`- 验收:\`${pack.acceptance.testCommand}\`${pack.acceptance.note ? `(${pack.acceptance.note})` : ''}`);
  if (pack.issueContext) lines.push('');
  if (pack.issueContext) lines.push(`【Issue 上下文】\n${pack.issueContext}`);
  if (pack.dispatchNote) lines.push('');
  if (pack.dispatchNote) lines.push(`【我的补充说明】\n${pack.dispatchNote}`);
  lines.push('');
  lines.push('【流程提醒】clone → 切工作分支 → 最小改动修复 → 跑验收测试 → 本地 commit;');
  lines.push('push/PR 由人工确认后执行(三层发布红线:对外发送永远人工)。');
  if (pack.claimDraft) {
    lines.push('');
    lines.push('【认领留言草稿】(是否发送由你决定)');
    lines.push(pack.claimDraft);
  }
  if (pack.prDraft?.title) {
    lines.push('');
    lines.push(`【PR 草稿】标题:${pack.prDraft.title}`);
    if (pack.prDraft.bodyTemplate) lines.push(pack.prDraft.bodyTemplate);
  }
  return lines.join('\n');
}

/** 从 agent 最终回复里提取 ```pr-final 围栏 JSON(容错:围栏前后有闲话也能提取) */
export function extractPrFinal(text: string): { title: string; body: string } | null {
  const re = new RegExp('```' + PR_FINAL_FENCE + '\\s*\\n([\\s\\S]*?)```');
  const m = text.match(re);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (typeof parsed?.title === 'string' && parsed.title.trim() && typeof parsed?.body === 'string') {
      return { title: parsed.title.trim().slice(0, 300), body: parsed.body.slice(0, 20000) };
    }
    return null;
  } catch {
    return null;
  }
}
