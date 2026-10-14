'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../utils/nativeBridge';
import {MonitorSmartphone, Plus, Trash2, Copy, Check, RefreshCw, Terminal, Loader2 } from 'lucide-react';

/**
 * 本地 Runner 设备页(docs/design/local-runner-bridge.md §4,M1)
 *
 * - 配对:生成一次性配对码(8 位 / 5 分钟),展示本地执行命令(可复制);
 * - 设备列表:在线状态(60s 心跳窗口)、版本、最近心跳;吊销 = 删密钥摘索引,
 *   该设备下次轮询即 401;
 * - 自刷新:10s 轮询设备列表(仅本页挂载期间)。
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

export function DevicesView() {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [pairCode, setPairCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

        {/* 设备列表 */}
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
            devices.map((d) => (
              <div
                key={d.deviceId}
                className={`flex items-center gap-3 border rounded-xl px-4 py-3 ${
                  d.revoked ? 'border-zinc-200 bg-zinc-50 opacity-60' : 'border-zinc-200 bg-white'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full flex-shrink-0 ${
                    d.revoked ? 'bg-zinc-300' : d.online ? 'bg-emerald-500' : 'bg-zinc-300'
                  }`}
                  title={d.revoked ? '已吊销' : d.online ? '在线(心跳 60s 内)' : '离线'}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-zinc-900 truncate">{d.hostname}</div>
                  <div className="text-[11px] text-zinc-500 mt-0.5">
                    {d.platform} · runner v{d.runnerVersion} · 协议 v{d.protocolVersion}
                    {d.lastSeenIp ? ` · IP ${d.lastSeenIp}` : ''}
                    {' · '}
                    {d.revoked ? '已吊销' : d.online ? '在线' : `最近心跳 ${timeAgo(d.lastSeenAt)}`}
                  </div>
                </div>
                {!d.revoked && (
                  <button
                    onClick={() => handleRevoke(d.deviceId, d.hostname)}
                    className="p-2 rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50 transition flex-shrink-0"
                    title="吊销设备"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
