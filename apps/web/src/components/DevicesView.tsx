'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../utils/nativeBridge';
import {
  MonitorSmartphone,
  Plus,
  Trash2,
  Copy,
  Check,
  RefreshCw,
  Terminal,
  Loader2,
  ChevronDown,
  ExternalLink,
} from 'lucide-react';
import {
  isRunnerTaskActive,
  runnerStateMeta,
  runnerRetryable,
  RUNNER_RETRYABLE_LABEL,
  RUNNER_RETRYABLE_HINT,
  tasksForDevice,
  type RunnerTaskEventView,
  type RunnerTaskSummary,
} from '../lib/runner-dispatch';

/**
 * 本地 Runner 设备页(docs/design/local-runner-bridge.md §4,M1)
 *
 * - 配对:生成一次性配对码(8 位 / 5 分钟),展示本地执行命令(可复制);
 * - 设备列表:在线状态(60s 心跳窗口)、版本、最近心跳;吊销 = 删密钥摘索引,
 *   该设备下次轮询即 401;
 * - 设备详情:点击设备行展开「该设备的任务列表」(派发给它的任务进展回流,
 *   5s 轮询;任务再点开可看 runner 上行事件时间线 /api/runner/tasks/detail)
 *   —— 派发到本地后,看进展的地方就是这里;
 * - 自刷新:设备 10s / 任务 5s 轮询(仅本页挂载期间)。
 */

interface DeviceView {
  deviceId: string;
  hostname: string;
  platform: string;
  runnerVersion: string;
  protocolVersion: number;
  /** 最近来源 IP(云端从心跳请求头记录;直连无反代时可能缺省) */
  lastSeenIp?: string;
  createdAt: number;
  lastSeenAt: number;
  online: boolean;
  revoked: boolean;
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/**
 * 设备任务行:状态徽章 + 仓库 + 最近一条 runner 上行事件;点开 = 事件时间线。
 * timeline 由页面层持有(同一时刻只展开一个任务,轮询原地回填不闪烁)。
 */
function DeviceTaskItem({
  task,
  timeline,
  expanded,
  onToggle,
}: {
  task: RunnerTaskSummary;
  timeline: RunnerTaskEventView[] | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = runnerStateMeta(task.state);
  const active = isRunnerTaskActive(task.state);
  const retryable = runnerRetryable(task);
  return (
    <div className={`rounded-lg border bg-white ${active ? 'border-sky-200' : 'border-zinc-200'}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-zinc-50 transition"
      >
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium border flex-shrink-0 ${meta.cls}`}
        >
          {meta.label}
        </span>
        {retryable && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium border flex-shrink-0 bg-amber-50 text-amber-700 border-amber-200"
            title={RUNNER_RETRYABLE_HINT}
          >
            {RUNNER_RETRYABLE_LABEL}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium font-mono text-zinc-900 truncate">{task.repo}</div>
          <div className="text-[11px] text-zinc-500 mt-0.5 truncate" title={task.latest?.text ?? task.error ?? task.workBranch}>
            {task.latest
              ? task.latest.text
              : task.state === 'failed' && task.error
                ? task.error.slice(0, 120)
                : `分支 ${task.workBranch}`}
            {' · '}
            {timeAgo(task.updatedAt)}
          </div>
        </div>
        {task.state === 'done' && task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 text-[11px] text-sky-600 hover:text-sky-700 hover:underline flex-shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            PR <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <ChevronDown className={`h-3.5 w-3.5 text-zinc-400 transition flex-shrink-0 ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="border-t border-zinc-100 bg-zinc-50/50 px-3 py-2.5 space-y-1.5 max-h-64 overflow-y-auto">
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <span className="font-mono text-zinc-400">{task.taskId}</span>
            <span>·</span>
            <span className="font-mono truncate">{task.workBranch}</span>
            {task.issueUrl && (
              <>
                <span>·</span>
                <a
                  href={task.issueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sky-600 hover:text-sky-700 hover:underline truncate inline-flex items-center gap-0.5"
                >
                  Issue <ExternalLink className="h-3 w-3 flex-shrink-0" />
                </a>
              </>
            )}
          </div>
          {task.error && (
            <div
              className="text-[11px] text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-words"
              title={task.error}
            >
              {task.error.slice(0, 400)}
            </div>
          )}
          {retryable && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
              {RUNNER_RETRYABLE_HINT}(重新派发即会全新克隆重跑;发布仍走审批门)
            </div>
          )}
          {timeline === null || timeline.length === 0 ? (
            <p className="text-[11px] text-zinc-400 py-2">
              {timeline === null ? '时间线加载中…' : '暂无 runner 上行事件(任务刚入队或 runner 未领取)'}
            </p>
          ) : (
            timeline.map((row, i) => (
              <div key={`${row.at}-${i}`} className="flex items-baseline gap-2 text-[11px] leading-relaxed">
                <span className="font-mono text-zinc-400 flex-shrink-0 tabular-nums">
                  {new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <span
                  className={`min-w-0 break-words ${
                    row.kind === 'state' ? 'text-sky-600 font-medium' : row.kind === 'error' ? 'text-rose-600' : 'text-zinc-600'
                  }`}
                >
                  {row.text}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function DevicesView() {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [pairCode, setPairCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 任务进展(设备详情展开用):全量摘要 + 当前点开任务的事件时间线
  const [tasks, setTasks] = useState<RunnerTaskSummary[]>([]);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<RunnerTaskEventView[] | null>(null);
  const tasksTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/runner/devices');
      const data = await res.json();
      if (data?.success) setDevices(data.devices || []);
      else setError(data?.error || '加载设备列表失败');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 10_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  // 任务摘要:5s 轮询(runner 上行事件落地即刷新;用户看设备详情时进展在滚动)
  const refreshTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/runner/tasks/mine');
      const data = await res.json();
      if (data?.success && Array.isArray(data.tasks)) setTasks(data.tasks.slice(0, 50));
    } catch {
      /* 概览失败不打扰设备主流程;下个轮询窗口重试 */
    }
  }, []);

  useEffect(() => {
    refreshTasks();
    tasksTimerRef.current = setInterval(refreshTasks, 5_000);
    return () => {
      if (tasksTimerRef.current) clearInterval(tasksTimerRef.current);
    };
  }, [refreshTasks]);

  const loadTimeline = useCallback(async (taskId: string) => {
    try {
      const res = await fetch(`/api/runner/tasks/detail?taskId=${encodeURIComponent(taskId)}`);
      const data = await res.json();
      setTimeline(data?.success ? data.timeline : []);
    } catch {
      setTimeline([]); // 明细拉取失败:置空占位,下个轮询窗口重试
    }
  }, []);

  // 展开的任务:切换时先清空再拉(避免串台闪现),之后随任务轮询原地回填(不闪烁)
  const expandedRef = useRef<string | null>(null);
  useEffect(() => {
    if (expandedTaskId !== expandedRef.current) {
      expandedRef.current = expandedTaskId;
      setTimeline(null);
    }
    if (expandedTaskId) loadTimeline(expandedTaskId);
  }, [expandedTaskId, tasks, loadTimeline]);

  // 配对码过期自动收起
  useEffect(() => {
    if (!pairCode) return;
    const t = setInterval(() => {
      if (Date.now() >= pairCode.expiresAt) setPairCode(null);
    }, 1000);
    return () => clearInterval(t);
  }, [pairCode]);

  const handleCreatePairCode = async () => {
    setPairBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/runner/pair-code', { method: 'POST' });
      const data = await res.json();
      if (data?.success) setPairCode({ code: data.code, expiresAt: data.expiresAt });
      else setError(data?.error || '生成配对码失败');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setPairBusy(false);
    }
  };

  const handleRevoke = async (deviceId: string, hostname: string) => {
    if (!window.confirm(`吊销设备「${hostname}」?该设备将立即失去连接,需重新配对。`)) return;
    try {
      const res = await fetch('/api/runner/devices', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      });
      const data = await res.json();
      if (!data?.success) setError(data?.error || '吊销失败');
      refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const copyText = async (text: string, key: string) => {
    // http 部署无 navigator.clipboard,copyToClipboard 内含 execCommand 降级
    const ok = await copyToClipboard(text);
    if (!ok) return; // 剪贴板不可用时静默(用户可手动选择复制)
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const pairCommand = pairCode
    ? `agtpilot-runner pair --server ${typeof window !== 'undefined' ? window.location.origin : 'https://<部署地址>'} --code ${pairCode.code}`
    : '';
  const countdown = pairCode ? Math.max(0, Math.ceil((pairCode.expiresAt - Date.now()) / 1000)) : 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* 头部 */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 flex items-center gap-2">
              <MonitorSmartphone className="h-5 w-5 text-zinc-700" />
              本地 Runner 设备
            </h2>
            <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
              把贡献机会「派发到本地」:你机器上的 runner 接任务后调起本地 Claude Code 干活,
              push/PR 仍须经这里审批。runner 出站-only,本机零开放端口。
            </p>
          </div>
          <button
            onClick={handleCreatePairCode}
            disabled={pairBusy}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-900 text-white text-xs font-medium hover:bg-zinc-700 transition disabled:opacity-50 flex-shrink-0"
          >
            {pairBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            配对新 Runner
          </button>
        </div>

        {error && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}

        {/* 配对码面板 */}
        {pairCode && (
          <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-600">
                一次性配对码 · <span className="text-amber-600">{countdown}s 后过期</span>
              </span>
              <span className="text-[10px] text-zinc-400">仅可核销一次</span>
            </div>
            <div className="font-mono text-2xl tracking-[0.3em] text-zinc-900 select-all">{pairCode.code}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-[11px] bg-white border border-zinc-200 rounded-lg px-3 py-2 font-mono text-zinc-700">
                {pairCommand}
              </code>
              <button
                onClick={() => copyText(pairCommand, 'pair')}
                className="p-2 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 transition flex-shrink-0"
                title="复制配对命令"
              >
                {copied === 'pair' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-zinc-500" />}
              </button>
            </div>
            <p className="text-[11px] text-zinc-500 flex items-start gap-1.5">
              <Terminal className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              在你自己的电脑上先安装 <code className="font-mono bg-white border border-zinc-200 rounded px-1">npm i -g @agtpilot/runner</code>
              (发布前为仓内开发者路径),再粘贴执行上面的配对命令。配对时请在下方列表核对设备名,防配对码钓鱼。
            </p>
          </div>
        )}

        {/* 设备列表:点击设备行展开该设备的任务(派发后的进展就在这里看) */}
        <div className="space-y-2">
          {loading ? (
            <div className="text-xs text-zinc-400 flex items-center gap-2 py-6 justify-center">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" /> 加载中…
            </div>
          ) : devices.length === 0 ? (
            <div className="text-center py-10 border border-dashed border-zinc-200 rounded-xl">
              <MonitorSmartphone className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
              <p className="text-xs text-zinc-500">还没有配对的 runner 设备</p>
              <p className="text-[11px] text-zinc-400 mt-1">点右上「配对新 Runner」,把贡献循环接到你自己的机器上</p>
            </div>
          ) : (
            devices.map((d) => {
              const deviceTasks = tasksForDevice(tasks, d.deviceId);
              const activeCount = deviceTasks.filter((t) => isRunnerTaskActive(t.state)).length;
              const deviceExpanded = expandedDeviceId === d.deviceId;
              return (
                <div
                  key={d.deviceId}
                  className={`border rounded-xl overflow-hidden ${
                    d.revoked ? 'border-zinc-200 bg-zinc-50 opacity-60' : deviceExpanded ? 'border-zinc-300 bg-white' : 'border-zinc-200 bg-white'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setExpandedDeviceId(deviceExpanded ? null : d.deviceId);
                      if (deviceExpanded) setExpandedTaskId(null); // 收起设备时连带收起任务
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 transition"
                  >
                    <span
                      className={`h-2 w-2 rounded-full flex-shrink-0 ${
                        d.revoked ? 'bg-zinc-300' : d.online ? 'bg-emerald-500' : 'bg-zinc-300'
                      }`}
                      title={d.revoked ? '已吊销' : d.online ? '在线(心跳 60s 内)' : '离线'}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-zinc-900 truncate">
                        {d.hostname}
                        {deviceTasks.length > 0 && (
                          <span
                            className={`ml-2 inline-flex items-center gap-1 align-middle px-1.5 py-0.5 rounded-md text-[10px] font-medium border ${
                              activeCount > 0 ? 'bg-sky-50 text-sky-700 border-sky-100' : 'bg-zinc-50 text-zinc-500 border-zinc-200'
                            }`}
                          >
                            {activeCount > 0 && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                            {activeCount > 0 ? `${activeCount} 个任务在跑` : `${deviceTasks.length} 个任务`}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">
                        {d.platform} · runner v{d.runnerVersion} · 协议 v{d.protocolVersion}
                        {d.lastSeenIp ? ` · IP ${d.lastSeenIp}` : ''}
                        {' · '}
                        {d.revoked ? '已吊销' : d.online ? '在线' : `最近心跳 ${timeAgo(d.lastSeenAt)}`}
                      </div>
                    </div>
                    {!d.revoked && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRevoke(d.deviceId, d.hostname);
                        }}
                        className="p-2 rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50 transition flex-shrink-0"
                        title="吊销设备"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <ChevronDown className={`h-3.5 w-3.5 text-zinc-400 transition flex-shrink-0 ${deviceExpanded ? 'rotate-180' : ''}`} />
                  </button>
                  {deviceExpanded && (
                    <div className="border-t border-zinc-100 bg-zinc-50/40 px-4 py-3 space-y-2">
                      {deviceTasks.length === 0 ? (
                        <p className="text-[11px] text-zinc-400 py-1">
                          该设备暂无派发任务 —— 工坊机会卡点「派发到本地」后,进展会在这里实时滚动
                        </p>
                      ) : (
                        deviceTasks.map((t) => (
                          <DeviceTaskItem
                            key={t.taskId}
                            task={t}
                            timeline={timeline}
                            expanded={expandedTaskId === t.taskId}
                            onToggle={() => setExpandedTaskId(expandedTaskId === t.taskId ? null : t.taskId)}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <p className="text-[10px] text-zinc-400 leading-relaxed">
          点击设备行展开它的任务列表:状态变化与本地 agent 的干活轨迹(工具调用 / 阶段文本)实时滚动,
          任务点开可看完整事件时间线;完成后审批卡出现在驾驶舱,push/PR 批准后才真正出门。
        </p>
      </div>
    </div>
  );
}
