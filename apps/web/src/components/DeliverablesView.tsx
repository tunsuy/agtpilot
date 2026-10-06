'use client';

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  FileText,
  Copy,
  CheckCheck,
  Download,
  Calendar,
  Sparkles,
  ArrowRight,
  FolderOpen,
} from 'lucide-react';
import { ArtifactState, Mission } from '../types/agent';

interface DeliverablesViewProps {
  artifact: ArtifactState | null;
  missions: Mission[];
  onOpenCockpit: () => void;
  onRunMission: (prompt: string, title?: string) => void;
}

export function DeliverablesView({
  artifact,
  missions,
  onOpenCockpit,
  onRunMission,
}: DeliverablesViewProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!artifact?.content) return;
    navigator.clipboard.writeText(artifact.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!artifact?.content) return;
    const blob = new Blob([artifact.content], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${artifact.title || 'deliverable'}.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            交付物与资产归档
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            由 AgtPilot 在自主执行周期中沉淀的结构化研究报告、代码产物与设计文档。
          </p>
        </div>

        {artifact && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 shadow-2xs transition"
            >
              {copied ? (
                <CheckCheck className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-zinc-400" />
              )}
              <span>{copied ? '已复制' : '复制 Markdown'}</span>
            </button>

            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white shadow-xs transition"
            >
              <Download className="h-3.5 w-3.5" />
              <span>下载 .md</span>
            </button>
          </div>
        )}
      </div>

      {/* Main Deliverable Card */}
      {artifact ? (
        <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
          {/* Card Topbar */}
          <div className="p-6 border-b border-zinc-100 bg-[#fbfbfd] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-zinc-900">
                  {artifact.title || '最新交付报告'}
                </span>
                {artifact.type && (
                  <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-zinc-200/80 text-zinc-600">
                    {artifact.type}
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400">
                自主智能体根据多源检索、沙盒测试与多步规划自动合成。
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono">
              <Calendar className="h-3.5 w-3.5 text-zinc-400" />
              <span>今天</span>
            </div>
          </div>

          {/* Markdown Content */}
          <div className="p-6 md:p-10 prose prose-zinc prose-sm max-w-none leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {artifact.content}
            </ReactMarkdown>
          </div>
        </div>
      ) : (
        /* Empty State */
        <div className="rounded-2xl border border-dashed border-zinc-300 p-12 text-center space-y-4 bg-white/50">
          <div className="mx-auto h-12 w-12 rounded-2xl bg-zinc-100 flex items-center justify-center text-zinc-400">
            <FolderOpen className="h-6 w-6" />
          </div>
          <div className="space-y-1 max-w-sm mx-auto">
            <h3 className="text-sm font-semibold text-zinc-800">
              暂无可交付成果
            </h3>
            <p className="text-xs text-zinc-500">
              启动一个调研或开发任务，AgtPilot 将在任务完成后自动汇总生成正式的报告与成果物。
            </p>
          </div>
          <div className="pt-2">
            <button
              onClick={() =>
                onRunMission(
                  '请调研最新的 AI Agent 架构演进，并整理生成一份高可读性的结构化分析报告。',
                  'AI Agent 架构深度调研'
                )
              }
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium shadow-xs transition"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>立即生成一份示范调研报告</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
