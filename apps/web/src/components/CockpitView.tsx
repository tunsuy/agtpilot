'use client';

import React, { useRef, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Globe,
  Terminal,
  FileText,
  Check,
  RotateCw,
  ArrowUp,
  Lock,
  Shield,
  Copy,
  CheckCheck,
  Clock,
  Sparkles,
  ExternalLink,
  ChevronRight,
  Maximize2,
} from 'lucide-react';
import {
  Mission,
  ViewportState,
  TerminalLog,
  ApprovalRequest,
  ArtifactState,
} from '../types/agent';

interface CockpitViewProps {
  missions: Mission[];
  activeMissionId: string | null;
  onSelectMission: (id: string) => void;
  viewport: ViewportState;
  terminalLogs: TerminalLog[];
  approvalRequests: ApprovalRequest[];
  onApproval: (id: string, approved: boolean) => void;
  artifact: ArtifactState | null;
  rightTab: 'browser' | 'terminal' | 'artifact';
  onRightTabChange: (tab: 'browser' | 'terminal' | 'artifact') => void;
  onRunMission: (prompt: string, title?: string) => void;
  isSubmitting: boolean;
}

export function CockpitView({
  missions,
  activeMissionId,
  onSelectMission,
  viewport,
  terminalLogs,
  approvalRequests,
  onApproval,
  artifact,
  rightTab,
  onRightTabChange,
  onRunMission,
  isSubmitting,
}: CockpitViewProps) {
  const [prompt, setPrompt] = useState('');
  const [copiedArtifact, setCopiedArtifact] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rightTab === 'terminal') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLogs, rightTab]);

  const currentMission =
    missions.find((m) => m.id === activeMissionId) || missions[0] || null;

  const handleCopyArtifact = () => {
    if (!artifact?.content) return;
    navigator.clipboard.writeText(artifact.content);
    setCopiedArtifact(true);
    setTimeout(() => setCopiedArtifact(false), 2000);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isSubmitting) return;
    onRunMission(prompt.trim());
    setPrompt('');
  };

  const suggestions = [
    { title: 'Search & Summarize', prompt: 'Browse Hacker News and summarize today’s top trending stories.' },
    { title: 'Environment Diagnostic', prompt: 'Run a sandbox environment diagnostic and check Node.js & Git setup.' },
    { title: 'GitHub Trending', prompt: 'Inspect GitHub trending repositories and extract highlights into a summary.' },
    { title: 'Market Research', prompt: 'Research recent multimodal AI agent developments and create a structured brief.' },
  ];

  return (
    <div className="flex-1 flex h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-[#fbfbfd]">
      {/* 左侧面板：任务目标、步骤拆解与指令输入 (Devin/Manus Left Stream) */}
      <section className="w-full md:w-[420px] lg:w-[460px] flex-shrink-0 flex flex-col border-r border-zinc-200 bg-white">
        {/* 目标概览 & 进度 */}
        <div className="p-4 border-b border-zinc-100 bg-[#fbfbfd]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
              Goal & Plan
            </span>
            {currentMission && (
              <span className="text-[11px] font-mono text-zinc-600 font-semibold">
                {currentMission.progress}%
              </span>
            )}
          </div>
          {currentMission ? (
            <div>
              <h2 className="text-xs font-semibold text-zinc-900 leading-snug">
                {currentMission.title}
              </h2>
              <div className="mt-2 w-full bg-zinc-200/80 h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-zinc-900 h-full transition-all duration-300 rounded-full"
                  style={{ width: `${currentMission.progress}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-400">准备就绪，随时可启动新任务。</p>
          )}
        </div>

        {/* 执行轨迹与步骤清单 (Steps Tree) */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
              Task Execution
            </span>
            {currentMission && (
              <span className="text-[11px] text-zinc-400 font-mono">
                {currentMission.steps.filter((s) => s.status === 'DONE').length} /{' '}
                {currentMission.steps.length}
              </span>
            )}
          </div>

          {currentMission && currentMission.steps.length > 0 ? (
            <div className="space-y-2">
              {currentMission.steps.map((st) => (
                <div
                  key={st.id}
                  className={`p-3 rounded-xl border text-xs transition ${
                    st.status === 'RUNNING'
                      ? 'border-blue-200 bg-blue-50/40 text-zinc-900 shadow-2xs'
                      : st.status === 'DONE'
                      ? 'border-zinc-200/80 bg-zinc-50/60 text-zinc-700'
                      : 'border-zinc-100 bg-white text-zinc-400'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 flex-shrink-0">
                      {st.status === 'DONE' ? (
                        <div className="h-4 w-4 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
                          <Check className="h-2.5 w-2.5" />
                        </div>
                      ) : st.status === 'RUNNING' ? (
                        <div className="h-4 w-4 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border border-zinc-300" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-xs leading-snug">{st.title}</p>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 mt-1 font-mono">
                        <span>{st.tool || 'orchestrator'}</span>
                        <span>
                          {st.duration || (st.status === 'RUNNING' ? 'running...' : 'queued')}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-12 text-center text-zinc-400 space-y-2">
              <div className="mx-auto w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-400">
                <Clock className="h-4 w-4" />
              </div>
              <p className="text-xs">暂无活跃任务。请在下方输入指令或在右侧选择模版。</p>
            </div>
          )}
        </div>

        {/* 历史记录快速切换 */}
        {missions.length > 1 && (
          <div className="px-4 py-2 border-t border-zinc-100 bg-[#fbfbfd]">
            <div className="flex items-center gap-1.5 overflow-x-auto py-1">
              <span className="text-[10px] text-zinc-400 uppercase font-semibold mr-1 flex-shrink-0">
                Recent:
              </span>
              {missions.slice(0, 5).map((m) => (
                <button
                  key={m.id}
                  onClick={() => onSelectMission(m.id)}
                  className={`text-[11px] px-2 py-0.5 rounded-md whitespace-nowrap truncate max-w-[120px] transition ${
                    activeMissionId === m.id
                      ? 'bg-zinc-200 text-zinc-900 font-medium'
                      : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100'
                  }`}
                >
                  {m.title}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 底部输入框 (Devin/Linear Style Command Bar) */}
        <div className="p-3 border-t border-zinc-200 bg-white">
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 bg-[#f4f4f6] border border-zinc-200 rounded-xl p-1.5 focus-within:border-zinc-400 focus-within:bg-white transition"
          >
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="指示 AgtPilot 进行网页浏览、代码运行、深入调研..."
              className="flex-1 bg-transparent border-none text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none px-2"
            />
            <button
              type="submit"
              disabled={!prompt.trim() || isSubmitting}
              className="h-7 w-7 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-20 text-white flex items-center justify-center transition flex-shrink-0"
            >
              {isSubmitting ? (
                <RotateCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
            </button>
          </form>
        </div>
      </section>

      {/* 右侧主视窗：Manus/Devin Multi-Tab Execution Canvas */}
      <main className="flex-1 flex flex-col min-w-0 bg-[#fafafa]">
        {/* 标签栏：Browser / Terminal / Deliverable */}
        <div className="h-11 border-b border-zinc-200 bg-white px-4 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              onClick={() => onRightTabChange('browser')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                rightTab === 'browser'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              <span>Browser</span>
              {viewport.status === 'navigating' && (
                <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-ping" />
              )}
            </button>

            <button
              onClick={() => onRightTabChange('terminal')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                rightTab === 'terminal'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <Terminal className="h-3.5 w-3.5" />
              <span>Terminal</span>
              {terminalLogs.length > 0 && (
                <span className="text-[10px] bg-zinc-200 text-zinc-600 px-1 rounded-sm">
                  {terminalLogs.length}
                </span>
              )}
            </button>

            <button
              onClick={() => onRightTabChange('artifact')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                rightTab === 'artifact'
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>Deliverable</span>
              {artifact && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
            </button>
          </div>

          {/* 顶栏辅助信息 */}
          {rightTab === 'browser' && viewport.url && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 font-mono truncate max-w-sm bg-zinc-50 border border-zinc-200 px-2.5 py-1 rounded-md">
              <Lock className="h-3 w-3 text-zinc-400 flex-shrink-0" />
              <span className="truncate">{viewport.url}</span>
            </div>
          )}

          {rightTab === 'artifact' && artifact && (
            <button
              onClick={handleCopyArtifact}
              className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900 border border-zinc-200 px-2.5 py-1 rounded-md bg-white transition"
            >
              {copiedArtifact ? (
                <CheckCheck className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-zinc-400" />
              )}
              <span className="text-[11px]">{copiedArtifact ? '已复制' : '复制 Markdown'}</span>
            </button>
          )}
        </div>

        {/* 人机协同安全授权横幅 (Human-in-the-Loop Sign-off Gate) */}
        {approvalRequests.length > 0 && (
          <div className="m-4 p-4 rounded-xl border border-amber-200 bg-amber-50/80 shadow-xs flex items-center justify-between animate-fadeIn">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
                <Shield className="h-4 w-4" />
              </div>
              <div>
                <span className="text-xs font-semibold text-zinc-900 block">
                  需要人工审批授权 (Human Authorization Required)
                </span>
                <p className="text-xs text-zinc-600 mt-0.5">
                  {approvalRequests[0].description} ({approvalRequests[0].action})
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => onApproval(approvalRequests[0].id, false)}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 transition"
              >
                拒绝操作
              </button>
              <button
                onClick={() => onApproval(approvalRequests[0].id, true)}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white transition shadow-xs"
              >
                授权执行
              </button>
            </div>
          </div>
        )}

        {/* 画布视图主体 */}
        <div className="flex-1 p-5 overflow-y-auto">
          {/* 1. 真实浏览器画板 (Browser View) */}
          {rightTab === 'browser' && (
            <div className="h-full flex flex-col items-center justify-center">
              {viewport.screenshotBase64 ? (
                <div className="w-full max-w-4xl rounded-2xl overflow-hidden border border-zinc-200 shadow-md bg-white">
                  <div className="h-9 bg-zinc-100 border-b border-zinc-200 px-4 flex items-center gap-2">
                    <div className="flex gap-1.5">
                      <div className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
                      <div className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
                      <div className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
                    </div>
                    <span className="text-[11px] text-zinc-500 font-mono truncate ml-2">
                      {viewport.url || 'Playwright Viewport'}
                    </span>
                  </div>
                  <img
                    src={viewport.screenshotBase64}
                    alt="Browser viewport"
                    className="w-full max-h-[580px] object-contain bg-white"
                  />
                </div>
              ) : (
                <div className="w-full max-w-xl text-center space-y-6">
                  <div className="space-y-2">
                    <h1 className="text-2xl font-semibold text-zinc-900 tracking-tight">
                      工作台实时监控就绪
                    </h1>
                    <p className="text-xs text-zinc-500 max-w-md mx-auto leading-relaxed">
                      AgtPilot 协同云端浏览器交互、沙盒执行与自动化工作流。选择一个推荐模版或在左侧输入指令开始。
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-left">
                    {suggestions.map((s, idx) => (
                      <button
                        key={idx}
                        onClick={() => onRunMission(s.prompt, s.title)}
                        className="p-3.5 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 hover:border-zinc-300 text-xs transition shadow-2xs group"
                      >
                        <span className="font-semibold text-zinc-800 group-hover:text-black block mb-1">
                          {s.title}
                        </span>
                        <p className="text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">
                          {s.prompt}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 2. 隔离沙盒终端 (Terminal View) */}
          {rightTab === 'terminal' && (
            <div className="h-full rounded-2xl bg-zinc-950 border border-zinc-800 shadow-md flex flex-col font-mono text-xs overflow-hidden">
              <div className="h-9 bg-zinc-900/90 border-b border-zinc-800/80 px-4 flex items-center justify-between text-zinc-400">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1.5">
                    <div className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
                    <div className="h-2.5 w-2.5 rounded-full bg-amber-500/80" />
                    <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
                  </div>
                  <span className="text-[11px] text-zinc-400 ml-2">sandbox: bash</span>
                </div>
                <span className="text-[10px] text-zinc-500">Node v20.x • Isolated Sandbox</span>
              </div>

              <div className="flex-1 p-4 overflow-y-auto space-y-1.5 text-zinc-300">
                {terminalLogs.length === 0 ? (
                  <p className="text-zinc-600 italic">等待沙盒命令执行...</p>
                ) : (
                  terminalLogs.map((log) => (
                    <div key={log.id} className="leading-relaxed break-words">
                      {log.type === 'command' && (
                        <span className="text-emerald-400 font-semibold">$ {log.text}</span>
                      )}
                      {log.type === 'stdout' && (
                        <span className="text-zinc-300 whitespace-pre-wrap">{log.text}</span>
                      )}
                      {log.type === 'stderr' && (
                        <span className="text-rose-400 whitespace-pre-wrap">{log.text}</span>
                      )}
                      {log.type === 'system' && (
                        <span className="text-zinc-500 italic"># {log.text}</span>
                      )}
                    </div>
                  ))
                )}
                <div ref={terminalEndRef} />
              </div>
            </div>
          )}

          {/* 3. 最终交付物成果 (Deliverable Artifact View) */}
          {rightTab === 'artifact' && (
            <div className="h-full max-w-4xl mx-auto rounded-2xl border border-zinc-200 bg-white shadow-sm flex flex-col overflow-hidden">
              <div className="h-12 border-b border-zinc-100 bg-zinc-50/50 px-6 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-zinc-600" />
                  <span className="text-xs font-semibold text-zinc-900">
                    {artifact?.title || '任务交付物'}
                  </span>
                </div>
                {artifact?.type && (
                  <span className="text-[10px] font-mono uppercase bg-zinc-200/80 text-zinc-600 px-2 py-0.5 rounded">
                    {artifact.type}
                  </span>
                )}
              </div>

              <div className="flex-1 p-6 md:p-8 overflow-y-auto prose prose-zinc prose-sm max-w-none">
                {artifact?.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {artifact.content}
                  </ReactMarkdown>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center py-16 text-zinc-400 space-y-2">
                    <FileText className="h-8 w-8 text-zinc-300" />
                    <p className="text-xs">暂无生成的结构化报告。当任务完成后，总结成果将在此展示。</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
