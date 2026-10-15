'use client';

/**
 * 「派发到本地」弹窗(设计文档 §6.3 / M2b):
 * 机会卡 → 任务包 → 入队,由用户自己的本地 runner 领取执行。
 *
 * - 设备区可选择(§4「派发时选设备」):任务绑定目标设备、仅该设备可领取;
 *   离线/已吊销设备置灰不可选,无在线设备时禁用派发(交接包人工路径不受影响);
 * - 推送权限检测按**选中设备**的 gh 账号比对(它才是真正干活/推代码的身份);
 * - 交接包预览与派发同源(renderHandoffPack,协议包渲染,不另拼字符串);
 * - 「复制交接包」永远可用:T0 人工降级路径(runner 未配对/离线也能人工干);
 * - push/PR 不在本弹窗发生 —— Phase 1 产出停在本地 commit,发布走 M3 审批门。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { X, MonitorSmartphone, Send, Copy, Check, ChevronDown, TriangleAlert, GitFork } from 'lucide-react';
import { renderHandoffPack } from '@agtpilot/protocol';
import { copyToClipboard } from '../../utils/nativeBridge';
import type { OssOpportunity } from '../../workshops/oss_radar/opportunities';
import { buildTaskPackFromOpportunity, issueNoFromUrl, pickIssueUrl } from '../../lib/runner-dispatch';

interface DeviceRow {
  deviceId: string;
  hostname: string;
  platform: string;
  runnerVersion: string;
  online: boolean;
  revoked?: boolean;
  /** gh 公开登录名:undefined = 未上报(旧版 runner),null = 已上报未登录 */
  ghLogin?: string | null;
}

/** 派发防重冲突(路由 409 dispatch_conflict 回带;话术服务端拼好) */
interface DispatchConflictInfo {
  kind: 'no_action' | 'active';
  taskId: string;
  state: string;
  message: string;
  noAction?: { reason: string; label: string; evidence: string };
}

export function DispatchRunnerModal({
  opp,
  missionId,
  onClose,
  onDispatched,
}: {
  opp: OssOpportunity;
  /** 派发时所处的会话 id(设备任务 ↔ 会话互跳的关联键;随入队落库) */
  missionId?: string;
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
  /** 同 Issue 已有「无需改动」结论或在途任务(409):摆出历史结论,用户明示后才 force 重派 */
  const [conflict, setConflict] = useState<DispatchConflictInfo | null>(null);
  const [copied, setCopied] = useState(false);
  /** null = 跟随自动检测;用户手动勾选/取消后以手动为准(切换设备时重置) */
  const [viaForkOverride, setViaForkOverride] = useState<boolean | null>(null);
  /** 用户手选的目标设备;null = 未手选,默认第一台在线设备 */
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  // 派发时选设备:只有在线未吊销设备可选;手选设备掉线则回落默认
  const repoOwner = (opp.project || '').trim().split('/')[0] ?? '';
  const liveDevices = (devices ?? []).filter((d) => !d.revoked);
  const onlineDevices = liveDevices.filter((d) => d.online);
  const effectiveDeviceId =
    selectedDeviceId && onlineDevices.some((d) => d.deviceId === selectedDeviceId)
      ? selectedDeviceId
      : (onlineDevices[0]?.deviceId ?? null);
  const selectedDevice = liveDevices.find((d) => d.deviceId === effectiveDeviceId) ?? null;

  // 推送权限自动检测:仓库属主 vs **选中设备**的 gh 登录名(runner 实探上报的公开
  // 用户名——它才是真正干活/推代码的身份)。属主不一致 = 大概率无推送权限(第三方
  // 仓/非本人 org),默认改经 fork 派发;org 成员等有权限的特例可手动取消勾选直连
  // 派发(push 失败会如实上报,不静默)。
  const selGhLogin =
    typeof selectedDevice?.ghLogin === 'string' && selectedDevice.ghLogin !== '' ? selectedDevice.ghLogin : undefined;
  const ownerMatch = Boolean(selGhLogin) && selGhLogin!.toLowerCase() === repoOwner.toLowerCase();
  const forkNeeded = Boolean(selectedDevice) && Boolean(selGhLogin) && !ownerMatch;
  const viaFork = viaForkOverride ?? forkNeeded;

  const pack = useMemo(
    () => buildTaskPackFromOpportunity(opp, { workBranch, dispatchNote: note, viaFork }),
    [opp, workBranch, note, viaFork]
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

  const handleCopyHandoff = async () => {
    if (!handoff) return;
    const ok = await copyToClipboard(handoff);
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDispatch = async (force = false) => {
    if (!pack || busy || !effectiveDeviceId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/runner/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // force=true 仅在冲突面板「仍要派发」时带上(用户看过历史结论后的明示旁路)
        body: JSON.stringify({
          pack,
          deviceId: effectiveDeviceId,
          ...(missionId ? { missionId } : {}),
          ...(force ? { force: true } : {}),
        }),
      });
      const j = await r.json();
      if (r.status === 409 && j?.error === 'dispatch_conflict' && j.conflict) {
        setConflict(j.conflict as DispatchConflictInfo);
        return;
      }
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
              {/* 设备选择(§4 派发时选设备:任务绑定目标设备,仅该设备可领取) */}
              <div>
                <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">
                  本地 Runner(选择执行设备)
                </span>
                {devices === null ? (
                  <p className="text-xs text-zinc-400 mt-1">加载设备…</p>
                ) : devices.length === 0 ? (
                  <p className="text-xs text-zinc-600 mt-1 leading-relaxed">
                    还没有配对设备:本机执行 <code className="font-mono text-[11px] bg-zinc-100 px-1 rounded">npm i -g @agtpilot/runner</code>,
                    再到「设备」页生成配对码完成配对。派发前也可先用「复制交接包」人工干(T0 路径)。
                  </p>
                ) : (
                  <div className="mt-1 space-y-1">
                    {devices.map((d) => {
                      const selectable = d.online && !d.revoked;
                      const checked = d.deviceId === effectiveDeviceId;
                      return (
                        <label
                          key={d.deviceId}
                          className={`flex items-center gap-2 text-xs text-zinc-700 rounded-lg border px-2 py-1.5 transition ${
                            checked ? 'border-sky-300 bg-sky-50/70' : 'border-zinc-100'
                          } ${selectable ? 'cursor-pointer hover:border-sky-200' : 'opacity-45 cursor-not-allowed'}`}
                        >
                          <input
                            type="radio"
                            name="dispatch-target-device"
                            disabled={!selectable}
                            checked={checked}
                            onChange={() => {
                              setSelectedDeviceId(d.deviceId);
                              setViaForkOverride(null); // fork 判定跟设备走:换设备重置为自动检测
                            }}
                            className="h-3 w-3 shrink-0 accent-sky-600"
                          />
                          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${selectable ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
                          <MonitorSmartphone className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                          <span className="truncate">{d.hostname}</span>
                          <span className="text-[10px] text-zinc-400 shrink-0 ml-auto">
                            {d.revoked ? '已吊销 · 不可选' : d.online ? '在线' : '离线 · 不可选'} · v{d.runnerVersion}
                            {typeof d.ghLogin === 'string' ? ` · gh:${d.ghLogin}` : d.ghLogin === null ? ' · gh未登录' : ''}
                          </span>
                        </label>
                      );
                    })}
                    {selectedDevice ? (
                      <p className="text-[11px] text-zinc-500 mt-1">
                        任务将绑定 <span className="font-medium text-zinc-700">{selectedDevice.hostname}</span>,仅该设备可领取执行。
                      </p>
                    ) : (
                      <p className="text-[11px] text-amber-600 mt-1">
                        无在线设备,暂不能派发:先在目标机器上跑 <code className="font-mono text-[10px]">agtpilot-runner start</code>
                        (或拉起 systemd 服务)再派发;也可复制交接包人工处理(T0 路径)。
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 推送权限自动检测 → 经 fork 派发(仓库属主 ≠ 选中设备 gh 账号时默认勾选) */}
              {pack && devices !== null && selectedDevice && !ownerMatch && (
                forkNeeded ? (
                  <div className="px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 space-y-2">
                    <div className="flex items-start gap-2 text-xs text-amber-800 leading-relaxed">
                      <GitFork className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>
                        仓库属主 <code className="font-mono text-[11px]">{repoOwner}</code> 不是所选设备(
                        <span className="font-medium">{selectedDevice.hostname}</span>)的 gh 账号(
                        <code className="font-mono text-[11px]">{selGhLogin}</code>
                        ):直连派发大概率在 push 阶段因无写权限失败。若你是该组织成员且有推送权限,可取消勾选直连派发。
                      </span>
                    </div>
                    <label className="flex items-start gap-2 text-xs text-amber-900 cursor-pointer leading-relaxed">
                      <input
                        type="checkbox"
                        checked={viaFork}
                        onChange={(e) => setViaForkOverride(e.target.checked)}
                        className="mt-0.5 shrink-0"
                      />
                      <span>
                        自动 fork 后派发:runner 先把 <code className="font-mono text-[11px]">{pack.repo}</code> fork 到{' '}
                        <code className="font-mono text-[11px]">{selGhLogin}</code> 名下(已存在则复用),克隆 fork 副本干活,
                        PR 从 fork 指向上游。fork 只是公开仓副本;推代码/PR 仍逐条过审批卡。
                      </span>
                    </label>
                  </div>
                ) : (
                  <div className="px-3 py-2 rounded-lg bg-zinc-50 border border-zinc-200 text-[11px] text-zinc-500 leading-relaxed">
                    {selectedDevice.ghLogin === null
                      ? '所选设备 gh 未登录:自动 fork 不可用,发布阶段的 gh 命令也会失败。先在 runner 机器上执行 gh auth login。'
                      : '所选设备未上报 gh 登录名(runner 版本过旧):无法检测推送权限与自动 fork。升级:npm i -g @agtpilot/runner@latest。'}
                  </div>
                )
              )}

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
                push/PR 经审批卡(含手机 Web Push)批准后由 runner 逐字执行固化命令,别无对外发布路径。
              </p>
              <p className="text-[10px] text-zinc-400 leading-relaxed">
                派发后去哪看进展:顶部「设备」页点开这台设备 —— 它的任务列表里状态变化与本地 agent 的干活轨迹
                (工具调用 / 阶段文本)实时滚动,完成后审批卡会出现在驾驶舱。
              </p>

              {conflict && (
                <div className="px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 space-y-2">
                  <div className="flex items-start gap-2 text-xs text-amber-800 leading-relaxed">
                    <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{conflict.message}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleDispatch(true)}
                      disabled={busy}
                      className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white text-[11px] font-medium transition"
                    >
                      {busy ? '派发中…' : '仍要派发'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConflict(null)}
                      disabled={busy}
                      className="px-2.5 py-1 rounded-lg border border-amber-300 text-amber-800 text-[11px] font-medium hover:bg-amber-100 transition"
                    >
                      知道了,不派发
                    </button>
                  </div>
                </div>
              )}

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
            onClick={() => handleDispatch(false)}
            disabled={!pack || busy || !effectiveDeviceId || Boolean(conflict)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition shadow-xs"
          >
            <Send className="h-3.5 w-3.5" />
            {busy ? '派发中…' : pack?.viaFork ? '派发(经 fork,不发布)' : '派发(本地不发布)'}
          </button>
        </div>
      </div>
    </div>
  );
}
