'use client';

import React, { useState } from 'react';
import {
  Layers,
  Key,
  Check,
  Search,
  ExternalLink,
  ShieldCheck,
  RotateCw,
  X,
  Sparkles,
} from 'lucide-react';
import { ConnectorApp } from '../types/agent';

interface ConnectorsViewProps {
  connectors: ConnectorApp[];
  onSaveKey: (envVar: string, value: string) => Promise<void>;
}

export function ConnectorsView({ connectors, onSaveKey }: ConnectorsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [configuringApp, setConfiguringApp] = useState<ConnectorApp | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const filtered = connectors.filter(
    (c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configuringApp || !keyInput.trim()) return;
    setIsSaving(true);
    try {
      await onSaveKey(configuringApp.envVar, keyInput.trim());
      setConfiguringApp(null);
      setKeyInput('');
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const connectedCount = connectors.filter((c) => c.status === 'connected').length;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            连接器与原子能力中心 (Ecosystem Connectors)
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            为 AgtPilot 授权外部 SaaS、网络搜索和模型凭据，拓展自主行动边界。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="px-3 py-1.5 rounded-xl bg-zinc-100 text-xs text-zinc-600 font-medium border border-zinc-200">
            已就绪: <span className="font-semibold text-zinc-900">{connectedCount}</span> / {connectors.length}
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索连接器（如 GitHub, Firecrawl, Tavily）..."
          className="w-full pl-9 pr-4 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition"
        />
      </div>

      {/* Connectors Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((app) => (
          <div
            key={app.id}
            className="p-5 rounded-2xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-xs transition flex flex-col justify-between"
          >
            <div>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-zinc-50 border border-zinc-200/80 flex items-center justify-center text-xl">
                    {app.icon || '🔌'}
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-900">{app.name}</h3>
                    <span className="text-[10px] text-zinc-400 uppercase font-mono">
                      {app.category}
                    </span>
                  </div>
                </div>

                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    app.status === 'connected'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-zinc-100 text-zinc-500'
                  }`}
                >
                  {app.status === 'connected' ? '已连接' : '未配置'}
                </span>
              </div>

              <p className="text-xs text-zinc-500 leading-relaxed mb-4">
                {app.description}
              </p>
            </div>

            <div className="pt-3 border-t border-zinc-100 flex items-center justify-between">
              <span className="text-[10px] font-mono text-zinc-400 truncate max-w-[130px]">
                {app.envVar}
              </span>

              <button
                onClick={() => {
                  setConfiguringApp(app);
                  setKeyInput('');
                }}
                className="px-3 py-1 rounded-lg text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 transition"
              >
                {app.status === 'connected' ? '重新配置' : '配置密钥'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Key Config Modal */}
      {configuringApp && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl animate-fadeIn space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-zinc-100 flex items-center justify-center text-lg">
                  {configuringApp.icon || '🔑'}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">
                    配置 {configuringApp.name}
                  </h3>
                  <p className="text-xs text-zinc-500 font-mono mt-0.5">
                    环境变量: {configuringApp.envVar}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setConfiguringApp(null)}
                className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-700 block">
                  API Key / Token
                </label>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={configuringApp.keyMasked || '输入凭证密钥...'}
                  autoFocus
                  className="w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setConfiguringApp(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!keyInput.trim() || isSaving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium transition shadow-xs"
                >
                  {isSaving && <RotateCw className="h-3.5 w-3.5 animate-spin" />}
                  <span>保存连接</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
