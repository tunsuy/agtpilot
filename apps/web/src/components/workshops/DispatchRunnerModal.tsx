'use client';

/**
 * 「派发到本地」弹窗(设计文档 §6.3 / M2b):
 * 机会卡 → 任务包 → 入队,由用户自己的本地 runner 领取执行。
 *
 * - 设备区只读展示配对/在线状态(任务入用户队列,FIFO 由在线 runner 领取);
 * - 交接包预览与派发同源(renderHandoffPack,协议包渲染,不另拼字符串);
 * - 「复制交接包」永远可用:T0 人工降级路径(runner 未配对/离线也能人工干);
 * - push/PR 不在本弹窗发生 —— Phase 1 产出停在本地 commit,发布走 M3 审批门。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { X, MonitorSmartphone, Send, Copy, Check, ChevronDown, TriangleAlert } from 'lucide-react';
import { renderHandoffPack } from '@agtpilot/protocol';
import { copyToClipboard } from '../../utils/nativeBridge';
import type { OssOpportunity } from '../../lib/oss-opportunities';
import { buildTaskPackFromOpportunity, issueNoFromUrl, pickIssueUrl } from '../../lib/runner-dispatch';

interface DeviceRow {
  deviceId: string;
  hostname: string;
  platform: string;
  runnerVersion: string;
  online: boolean;
  revoked?: boolean;
}

export function DispatchRunnerModal({
  opp,
  onClose,
  onDispatched,
}: {
  opp: OssOpportunity;
  onClose: () => void;
  onDispatched: (taskId: string) => void;
}) {
  const issueUrl = pickIssueUrl(opp.links);
  const issueNo = issueUrl ? issueNoFromUrl(issueUrl) : null;

  const [workBranch, setWorkBranch] = useState(`contrib/oss-radar-${issueNo ?? 'issue'}`);
  const [note, setNote] = useState('');
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const pack = useMemo(
    () => buildTaskPackFromOpportunity(opp, { workBranch, dispatchNote: note }),
    [opp, workBranch, note]
  );
  const handoff = useMemo(() => (pack ? renderHandoffPack(pack) : null), [pack]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/runner/devices');
        const j = await r.json();
        if (!cancelled && j?.success) setDevices(j.devices as DeviceRow[]);
        else if (!cancelled) setDevices([]);
      } catch {
        if (!cancelled) setDevices([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onlineDevices = (devices ?? []).filter((d) => d.online && !d.revoked);

  const handleCopyHandoff = async () => {
    if (!handoff) return;
    const ok = await copyToClipboard(handoff);
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDispatch = async () => {
    if (!pack || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/runner/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack }),
      });
      const j = await r.json();
      if (!r.ok || !j?.success) {
        setError(String(j?.error || `派发失败(HTTP ${r.status})`));
        return;
      }
      onDispatched(String(j.taskId ?? pack.taskId));
    } catch (e) {
      setError(`派发失败:${(e as Error)?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 sticky top-0 bg-white z-10">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900">派发到本地 Runner</h2>
            <p className="text-[11px] text-zinc-500 truncate font-mono mt-0.5">
              {opp.project}
              {issueNo ? ` · Issue #${issueNo}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-4">
          {!pack ? (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-rose-50 border border-rose-100 text-xs text-rose-700">
              <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                该机会暂不能派发:项目名需为 owner/repo 格式,且至少一条 GitHub 链接。可用「复制整条」人工处理。
              </span>
            </div>
          ) : (
            <>
              {/* 设备状态(只读;任务入队后由在线 runner FIFO 领取) */}
              <div>
                <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">本地 Runner</span>
                {devices === null ? (
                  <p className="text-xs text-zinc-400 mt-1">加载设备…</p>
                ) : devices.length === 0 ? (
                  <p className="text-xs text-zinc-600 mt-1 leading-relaxed">
                    还没有配对设备:本机执行 <code className="font-mono text-[11px] bg-zinc-100 px-1 rounded">npm i -g @agtpilot/runner</code>,
                    再到「设备」页生成配对码完成配对。派发前也可先用「复制交接包」人工干(T0 路径)。
                  </p>
                ) : (
                  <div className="mt-1 space-y-1">
                    {devices.map((d) => (
                      <div key={d.deviceId} className="flex items-center gap-2 text-xs text-zinc-700">
                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${d.online && !d.revoked ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
                        <MonitorSmartphone className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                        <span className="truncate">{d.hostname}</span>
                        <span className="text-[10px] text-zinc-400 shrink-0">
                          {d.revoked ? '已吊销' : d.online ? '在线' : '离线'} · v{d.runnerVersion}
                        </span>
                      </div>
                    ))}
                    {onlineDevices.length === 0 && (
                      <p className="text-[11px] text-amber-600 mt-1">
                        当前无在线设备:任务会排队(7 天有效),runner 上线后自动领取;也可复制交接包人工处理。
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 工作分支 */}
              <div>
                <label className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide block mb-1">工作分支</label>
                <input
                  value={workBranch}
                  onChange={(e) => setWorkBranch(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-sky-200 focus:border-sky-400"
                  placeholder="contrib/oss-radar-12345"
                />
              </div>

              {/* 补充说明 */}
              <div>
                <label className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide block mb-1">
                  补充说明(可选,进本地 agent 指令)
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 text-xs focus:outline-none focus:ring-2 focus:ring-sky-200 focus:border-sky-400 resize-none"
                  placeholder="如:优先看 xxx 模块的校验分支;保持向后兼容"
                />
              </div>

              {/* 交接包预览(与派发同源) */}
              <div className="rounded-lg border border-zinc-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-medium text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 transition"
                >
                  <span>交接包预览(本地 agent 收到同源任务指令)</span>
                  <ChevronDown className={`h-3.5 w-3.5 transition ${showPreview ? 'rotate-180' : ''}`} />
                </button>
                {showPreview && handoff && (
                  <pre className="px-3 pb-3 text-[10px] leading-relaxed text-zinc-600 whitespace-pre-wrap break-words max-h-56 overflow-y-auto border-t border-zinc-100 pt-2">
                    {handoff}
                  </pre>
                )}
              </div>

              <p className="text-[10px] text-zinc-400 leading-relaxed">
                红线:本地 agent 只修这个 Issue、禁 push/禁网(工具白名单固化);产出停在本地 commit,
                push/PR 需在云端审批后由 runner 执行(审批门 M3 交付,当前 Phase 1 产出先留本地)。
              </p>

              {error && (
                <div className="px-3 py-2 rounded-lg bg-rose-50 border border-rose-100 text-xs text-rose-700">{error}</div>
              )}
            </>
          )}
        </div>

        {/* 底部动作 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-100 sticky bottom-0 bg-white">
          {handoff && (
            <button
              type="button"
              onClick={handleCopyHandoff}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? '已复制' : '复制交接包'}
            </button>
          )}
          <button
            type="button"
            onClick={handleDispatch}
            disabled={!pack || busy}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition shadow-xs"
          >
            <Send className="h-3.5 w-3.5" />
            {busy ? '派发中…' : '派发(本地不发布)'}
          </button>
        </div>
      </div>
    </div>
  );
}
