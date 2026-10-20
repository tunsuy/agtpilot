'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { copyToClipboard } from '../utils/nativeBridge';
import { Check, Copy, ExternalLink, Loader2, MessageSquare, X, Zap } from 'lucide-react';
import { renderHandoffPack } from '@agtpilot/protocol';
import {
  buildFollowUpTaskPack,
  describeDispatchConflict,
  type RunnerTaskSummary,
} from '../lib/runner-dispatch';

/**
 * 「响应 review」跟进派发弹窗(2026-10-20 PR 跟进修改):
 * done 任务(有 PR)的入口 —— 云端拉取该 PR 的 review 评论(公开 API,零凭据)
 * 回填可编辑文本框,用户取舍/补充后派发跟进任务:
 * - 复用原工作分支(runner 收编本地或 origin 上已推送的现场续跑);
 * - 评论快照装进 issueContext(Phase 1 禁网,干活依据必须随包);
 * - pack 带 prFollowUp + baseTaskId(任务链关联;审批批准后发布只固化 git push,
 *   push 即更新既有 PR);
 * - 默认派回原任务设备(现场大概率还在;换设备也可 —— runner 会收编 origin
 *   上已推送的分支),推送仍每次过 Phase 2 人工审批,红线不变。
 */
export interface FollowUpDeviceOption {
  deviceId: string;
  hostname: string;
  online: boolean;
  revoked: boolean;
}

export function FollowUpPrModal({
  task,
  devices,
  onClose,
  onDispatched,
}: {
  task: RunnerTaskSummary;
  devices: FollowUpDeviceOption[];
  onClose: () => void;
  onDispatched: (taskId: string) => void;
}) {
  const prUrl = task.prUrl ?? task.followUp?.prUrl ?? '';
  const [reviewText, setReviewText] = useState('');
  const [fetching, setFetching] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 默认派回原任务设备(工作区现场在);该设备不可用时回落第一台在线设备
  const preferredDevice =
    devices.find((d) => d.deviceId === (task.deviceId ?? task.targetDeviceId) && !d.revoked)?.deviceId ??
    devices.find((d) => d.online && !d.revoked)?.deviceId ??
    '';
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

  useEffect(() => {
    if (!selectedDeviceId && preferredDevice) setSelectedDeviceId(preferredDevice);
  }, [preferredDevice, selectedDeviceId]);

  // 拉取 review 评论(失败不拦派发:降级为手工粘贴)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!prUrl) {
        setFetching(false);
        setFetchError('任务缺少 PR 链接,无法拉取 review');
        return;
      }
      try {
        const res = await fetch(`/api/runner/tasks/pr-review?prUrl=${encodeURIComponent(prUrl)}`);
        const data = await res.json();
        if (cancelled) return;
        if (data?.success && typeof data.context === 'string') {
          setReviewText(data.context);
        } else {
          setFetchError(data?.error || '拉取 review 评论失败');
        }
      } catch (e: any) {
        if (!cancelled) setFetchError(e?.message || String(e));
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prUrl]);

  const pack = useMemo(
    () =>
      buildFollowUpTaskPack(
        {
          repo: task.repo,
          issueUrl: task.issueUrl,
          workBranch: task.workBranch,
          baseBranch: task.baseBranch,
          prUrl,
          baseTaskId: task.taskId,
          viaFork: task.viaFork,
        },
        reviewText,
        { dispatchNote: note }
      ),
    [task, prUrl, reviewText, note]
  );

  const handleDispatch = async (force = false) => {
    if (!pack || busy) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const res = await fetch('/api/runner/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pack,
          ...(selectedDeviceId ? { deviceId: selectedDeviceId } : {}),
          ...(task.missionId ? { missionId: task.missionId } : {}),
          ...(force ? { force: true } : {}),
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data?.conflict) {
        setConflict(describeDispatchConflict(data.conflict));
        return;
      }
      if (!data?.success) {
        setError(data?.error || '派发失败');
        return;
      }
      onDispatched(String(data.taskId ?? pack.taskId));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyHandoff = async () => {
    if (!pack) return;
    const ok = await copyToClipboard(renderHandoffPack(pack));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const selectableDevices = devices.filter((d) => !d.revoked);
  const originalDeviceMissing =
    Boolean(task.deviceId ?? task.targetDeviceId) &&
    !devices.some((d) => d.deviceId === (task.deviceId ?? task.targetDeviceId));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-100">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-sky-600" />
              响应 review · 跟进派发
            </h3>
            <p className="text-[11px] text-zinc-500 mt-1 break-all">
              <span className="font-mono">{task.repo}</span> · 复用分支{' '}
              <span className="font-mono">{task.workBranch}</span>
              {prUrl && (
                <>
                  {' · '}
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-600 hover:underline inline-flex items-center gap-0.5"
                  >
                    原 PR <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50 transition">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* review 评论(可编辑:云端拉取只是初稿,取舍权在人) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-zinc-700">Review 评论(随任务包下发,可增删修改)</label>
              {fetching && (
                <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> 云端拉取中…
                </span>
              )}
            </div>
            {fetchError && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5 mb-1.5">
                {fetchError} —— 可以直接在下方手工粘贴 review 评论再派发。
              </p>
            )}
            <textarea
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              rows={10}
              placeholder={fetching ? '拉取中…' : '粘贴/整理要回应的 review 评论(留空也可派发,agent 将只看到你的补充说明)'}
              className="w-full text-[11px] font-mono rounded-lg border border-zinc-200 bg-white px-3 py-2 resize-y focus:outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-200"
            />
          </div>

          {/* 补充说明 */}
          <div>
            <label className="text-xs font-medium text-zinc-700 block mb-1.5">我的补充说明(可选)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={5000}
              placeholder="如:只处理前两条评论;第三条与仓库规范冲突,回复说明即可"
              className="w-full text-[11px] rounded-lg border border-zinc-200 bg-white px-3 py-2 resize-y focus:outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-200"
            />
          </div>

          {/* 目标设备 */}
          <div>
            <label className="text-xs font-medium text-zinc-700 block mb-1.5">执行设备</label>
            {selectableDevices.length === 0 ? (
              <p className="text-[11px] text-zinc-400">没有可用设备(先配对本机 runner)</p>
            ) : (
              <div className="space-y-1">
                {selectableDevices.map((d) => {
                  const isOriginal = d.deviceId === (task.deviceId ?? task.targetDeviceId);
                  return (
                    <label
                      key={d.deviceId}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition ${
                        selectedDeviceId === d.deviceId ? 'border-sky-300 bg-sky-50/60' : 'border-zinc-200 hover:bg-zinc-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="followup-device"
                        checked={selectedDeviceId === d.deviceId}
                        onChange={() => setSelectedDeviceId(d.deviceId)}
                        className="h-3.5 w-3.5 accent-sky-600"
                      />
                      <span className="text-xs text-zinc-800 truncate">{d.hostname}</span>
                      <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${d.online ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
                      {isOriginal && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 flex-shrink-0">原任务设备(现场在)</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
            {originalDeviceMissing && (
              <p className="text-[11px] text-amber-700 mt-1.5">
                原任务设备已不在列表(可能已吊销)。换设备也可续跑:runner 会收编 origin 上已推送的工作分支;
                未推送的本地半成品则无法恢复。
              </p>
            )}
            <p className="text-[10px] text-zinc-400 mt-1.5 leading-relaxed">
              跟进任务复用原工作分支与派发方式{task.viaFork ? '(经 fork)' : ''}。本地 agent 按 review 评论改码、追加 commit;
              完成后推送仍须过 Phase 2 人工审批(只固化 git push,推送即更新既有 PR,不会新建)。
            </p>
          </div>

          {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          {/* 防重冲突(与原派发弹窗同款:摆出历史结论,用户决定) */}
          {conflict && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-2">
              <p>{conflict}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleDispatch(true)}
                  disabled={busy}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-amber-600 text-white hover:bg-amber-700 transition disabled:opacity-50"
                >
                  仍要派发
                </button>
                <button
                  type="button"
                  onClick={() => setConflict(null)}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium border border-amber-300 text-amber-800 hover:bg-amber-100 transition"
                >
                  知道了,不派发
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 底部动作 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-zinc-100">
          <button
            type="button"
            onClick={() => void handleCopyHandoff()}
            disabled={!pack}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-200 text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition disabled:opacity-40"
            title="复制离线交接包(runner 不可用时的人工降级路径,粘进任意本地 coding agent)"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            复制交接包
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-zinc-200 text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleDispatch(false)}
              disabled={!pack || busy || fetching}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-500 transition disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
              派发跟进任务
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
