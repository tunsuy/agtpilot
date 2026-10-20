import type { NoActionFinal, NoActionReason, RunnerTaskPack } from './runner';

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

/**
 * no-action 围栏:agent 核实「无需改动」(上游已修复/无法复现/超出范围)时的
 * 例外出口,与 pr-final 二选一。生产背景(2026-10-15 milvus #52049):修复 PR
 * 已合并但 issue 没人关,agent 核验后正确地不产出 commit,却只能被判「无产出」
 * 失败 → 云端反复重派同一 issue。有了结构化结论,一次核验沉淀成永久资产。
 */
export const NO_ACTION_FENCE = 'no-action';

/** no-action 原因 → 展示文案(runner 日志/事件消息与 web 任务卡共用,同源不漂移) */
export const NO_ACTION_REASON_LABELS: Record<NoActionReason, string> = {
  already_fixed: '上游已修复',
  not_reproducible: '无法复现',
  out_of_scope: '不属于本仓库',
  other: '无需改动(其它)',
};

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
  if (pack.prFollowUp) {
    lines.push('');
    lines.push(`【PR 跟进模式】工作分支已有关联 PR:${pack.prFollowUp.prUrl}`);
    lines.push('本轮任务是回应 review 意见(评论快照在下方【Issue 上下文】里):');
    lines.push('- 先看清现场:git log 查看分支既有提交(PR 就是它们做的),再逐条对照 review 意见处理;');
    lines.push('- 改动聚焦 review 指出的范围,不顺手重构无关代码;');
    lines.push('- 既有提交已推送,**禁止 rebase/reset 改写已推送历史**:新修改用追加 commit 落(上游合并时自会 squash);');
    lines.push('- 完成后本地 commit 即止:推送到该分支会自动更新 PR,不需要也不能新建 PR(发布门只固化 git push);');
    lines.push('- 最终回复照常输出 pr-final 围栏:标题沿用原 PR,body 列出本轮按 review 改了什么;');
    lines.push('- review 意见确实无法满足(与仓库规范冲突/超出本 Issue 范围)时不要硬凑:在最终回复里如实说明理由,能做的部分照常做完。');
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
  if (pack.prFollowUp) {
    // 跟进任务:已推送历史不可改写(上方【PR 跟进模式】块的红线),第 4 步换追加式收尾
    lines.push('4. 收尾:新修改整理成符合仓库规范的追加 commit(不要 git reset --soft 重排已推送的既有提交),信息关联 Issue 与 review 意见;不要 push;');
  } else {
    lines.push('4. 收尾前把 WIP commit 整理成符合仓库规范的干净 commit(git reset --soft 到基线后重新提交即可),信息关联 Issue;不要 push;');
  }
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
  lines.push('');
  lines.push(`6. 例外出口(与第 5 步二选一):若核实后确认该 Issue 无需改动本仓库——已被上游修复(修复 commit/PR 已在当前基线)、按 Issue 描述无法复现、或问题不在本仓库——**不要硬凑 commit**,改为在最终回复末尾输出 no-action 围栏,格式严格如下(围栏名不可改):`);
  lines.push('');
  lines.push('```' + NO_ACTION_FENCE);
  lines.push(JSON.stringify({ reason: 'already_fixed | not_reproducible | out_of_scope', evidence: '确凿证据:修复 commit/PR 编号与验证方式,或复现步骤与结果' }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('仅在有确凿证据时使用(如 git log 找到修复 commit 并用 merge-base 验证已在基线、写复现测试跑过确认不复现),证据写进 evidence;拿不准就如实说明情况——不许拿这个当逃避干活的出口。');
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
  if (pack.prFollowUp) lines.push(`- PR 跟进:既有 PR ${pack.prFollowUp.prUrl},回应 review 意见改码;推送该分支即自动更新 PR,不要新建 PR、不要改写已推送历史`);
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

/**
 * 从 agent 最终回复里提取 ```no-action 围栏 JSON(容错同 extractPrFinal)。
 * evidence 必填非空 —— 无证据的 no-action 不成立(返回 null,回落「无产出」失败);
 * 未知 reason 归 'other';超长 evidence 截断(≤8000)。
 */
export function extractNoActionFinal(text: string): NoActionFinal | null {
  const re = new RegExp('```' + NO_ACTION_FENCE + '\\s*\\n([\\s\\S]*?)```');
  const m = text.match(re);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    const evidence = typeof parsed?.evidence === 'string' ? parsed.evidence.trim() : '';
    if (!evidence) return null;
    const reason: NoActionReason = ['already_fixed', 'not_reproducible', 'out_of_scope'].includes(parsed?.reason)
      ? parsed.reason
      : 'other';
    return { reason, evidence: evidence.slice(0, 8000) };
  } catch {
    return null;
  }
}
