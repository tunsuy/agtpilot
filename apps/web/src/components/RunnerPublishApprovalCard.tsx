'use client';

/**
 * runner_publish 审批卡(M3,docs/design/local-runner-bridge.md §6.2)
 *
 * 本地贡献任务 Phase 1 完成(awaiting_approval)后的发布审批:展示 PR 终稿、
 * diffstat、测试尾部与**将要固化的命令集**;勾选「代发认领留言」(决策项 6)后
 * gh issue comment 一并进固化命令集。批准 → 云端固化命令 + 任务 finishing,
 * 本地 runner 领取逐条执行;拒绝 → cancel 指令下行,本地分支保留。
 *
 * 驾驶舱(CockpitView)与手机(MobileActivityView)共用本卡:发布是高危动作,
 * 两端都必须看得到全部细节再批 —— 不做简化版。
 */
import React, { useState } from 'react';
import { Check, ChevronDown, ExternalLink, ShieldAlert, X } from 'lucide-react';
import type { ApprovalRequest } from '../types/agent';

export interface ApprovalOpts {
  includeClaim?: boolean;
}

export type ApprovalHandler = (id: string, approved: boolean, opts?: ApprovalOpts) => void;

/** 命令展示:超长参数(PR 正文等)折叠成占位,其余原样 —— 展示即所批 */
function displayCommand(c: { cmd?: string; args?: unknown }): string {
  if (!c || typeof c.cmd !== 'string' || !Array.isArray(c.args)) return '(畸形命令,runner 将拒绝执行)';
  const args = (c.args as unknown[]).map((a) => {
    const s = String(a);
    return s.length > 80 ? `"…${s.length} 字符(见 PR 正文)"` : /\s/.test(s) ? `"${s}"` : s;
  });
  return `${c.cmd} ${args.join(' ')}`;
}

function Collapsible({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg bg-zinc-900/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-700 transition"
      >
        <span>{label}</span>
        <ChevronDown className={`h-3 w-3 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <pre className="px-2.5 pb-2 text-[11px] leading-4 text-zinc-600 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  );
}

export function RunnerPublishApprovalCard({
  req,
  onApproval,
}: {
  req: ApprovalRequest;
  onApproval: ApprovalHandler;
}) {
  const [includeClaim, setIncludeClaim] = useState(false);
  const p = (req.params || {}) as Record<string, any>;
  const commands: Array<{ cmd: string; args: string[] }> = Array.isArray(p.commands) ? p.commands : [];
  const claimDraft: string | undefined = typeof p.claimDraft === 'string' && p.claimDraft ? p.claimDraft : undefined;

  return (
    <div className="rounded-xl border border-red-200 bg-red-50/60 shadow-sm p-4 space-y-3">
      {/* 头部:高危标识 + 仓库/分支 */}
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5 text-red-500" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-zinc-900">发布本地贡献成果</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 font-medium">高危 · 对外可见</span>
          </div>
          <p className="text-xs text-zinc-600 mt-1 break-all font-mono">
            {String(p.repo || '')} · <span className="text-zinc-500">{String(p.workBranch || '')}</span> →{' '}
            {String(p.baseBranch || 'main')}
            {typeof p.forkRepo === 'string' && p.forkRepo && (
              <span className="text-zinc-500">(经 fork {p.forkRepo},PR 指向上游)</span>
            )}
          </p>
          {typeof p.issueUrl === 'string' && p.issueUrl && (
            <a
              href={p.issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-sky-700 hover:underline mt-1 break-all"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              Issue 直达
            </a>
          )}
        </div>
      </div>

      {/* PR 终稿 */}
      <div className="rounded-lg border border-zinc-200 bg-white p-3 space-y-2">
        <p className="text-xs font-semibold text-zinc-900 break-words">{String(p.prTitle || '(无标题)')}</p>
        {typeof p.commitHash === 'string' && p.commitHash && (
          <p className="text-[10px] text-zinc-400 font-mono">commit {p.commitHash.slice(0, 12)}</p>
        )}
        {typeof p.diffstat === 'string' && p.diffstat && <Collapsible label="改动统计(diffstat)" text={p.diffstat} />}
        {typeof p.testTail === 'string' && p.testTail && <Collapsible label="测试输出尾部" text={p.testTail} />}
        {typeof p.prBody === 'string' && p.prBody && <Collapsible label="PR 正文" text={p.prBody} />}
      </div>

      {/* 固化命令集预览 */}
      <div className="space-y-1.5">
        <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">
          批准后将固化执行(逐字执行,不重新规划)
        </span>
        <div className="rounded-lg bg-zinc-900 px-3 py-2 space-y-1">
          {commands.map((c, i) => (
            <p key={i} className="text-[11px] font-mono text-emerald-300 break-all">
              $ {displayCommand(c)}
            </p>
          ))}
          {includeClaim && p.claimCommand && (
            <p className="text-[11px] font-mono text-emerald-300 break-all">$ {displayCommand(p.claimCommand)}</p>
          )}
          {commands.length === 0 && <p className="text-[11px] text-zinc-400">(命令预览构建失败,批准后云端将拒绝固化)</p>}
        </div>
      </div>

      {/* 认领留言勾选(决策项 6) */}
      {claimDraft && (
        <label className="flex items-start gap-2 text-xs text-zinc-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeClaim}
            onChange={(e) => setIncludeClaim(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300 accent-red-600"
          />
          <span className="min-w-0 break-words">
            同时代发认领留言到 Issue:
            <span className="text-zinc-500">「{claimDraft.length > 80 ? `${claimDraft.slice(0, 80)}…` : claimDraft}」</span>
          </span>
        </label>
      )}

      <p className="text-[10px] text-zinc-500 leading-relaxed">
        批准后本地 runner 逐条执行固化命令集(git push / gh pr create{claimDraft ? ' / gh issue comment' : ''}),
        任何一条失败即停并上报;PR 链接自动回流任务卡。拒绝则任务取消,本地分支保留。
      </p>

      {/* 动作 */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onApproval(req.id, false)}
          className="flex-1 h-10 rounded-lg border border-zinc-200 bg-white text-sm font-medium text-zinc-600 flex items-center justify-center gap-1.5 hover:bg-zinc-50 active:bg-zinc-100 transition"
        >
          <X className="h-4 w-4" /> 拒绝
        </button>
        <button
          type="button"
          onClick={() => onApproval(req.id, true, { includeClaim })}
          className="flex-1 h-10 rounded-lg bg-red-600 text-sm font-medium text-white flex items-center justify-center gap-1.5 hover:bg-red-700 active:bg-red-800 transition"
        >
          <Check className="h-4 w-4" /> 批准并发布
        </button>
      </div>
    </div>
  );
}
