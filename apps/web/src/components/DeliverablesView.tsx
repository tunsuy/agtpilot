'use client';

import React, { useState, useMemo } from 'react';
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
  Search,
  Code2,
  PieChart,
  Globe,
  SlidersHorizontal,
  Smartphone,
  Eye,
} from 'lucide-react';
import { ArtifactState, Mission } from '../types/agent';
import { XiaohongshuPreviewCard } from './XiaohongshuPreviewCard';

interface DeliverablesViewProps {
  artifact: ArtifactState | null;
  missions: Mission[];
  onOpenCockpit: (missionId?: string) => void;
  onRunMission: (prompt: string, title?: string) => void;
}

export function DeliverablesView({
  artifact,
  missions,
  onOpenCockpit,
  onRunMission,
}: DeliverablesViewProps) {
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'markdown' | 'code' | 'chart'>('all');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [deliverableViewMode, setDeliverableViewMode] = useState<'doc' | 'social'>('doc');

  // 1. 汇总所有会话中的交付物列表（去除重复内容）
  const allArtifacts = useMemo(() => {
    const list: Array<{
      id: string;
      title: string;
      type: string;
      content: string;
      missionId?: string;
      missionTitle?: string;
      timestamp: number;
    }> = [];

    const seenContents = new Set<string>();

    missions.forEach((m) => {
      if (m.artifact?.content && !seenContents.has(m.artifact.content)) {
        seenContents.add(m.artifact.content);
        list.push({
          id: `art_${m.id}`,
          title: m.artifact.title || m.title || '交付成果',
          type: m.artifact.type || 'markdown',
          content: m.artifact.content,
          missionId: m.id,
          missionTitle: m.title,
          timestamp: m.startedAt,
        });
      }
    });

    if (artifact?.content && !seenContents.has(artifact.content)) {
      list.unshift({
        id: 'art_active',
        title: artifact.title || '当前最新成果',
        type: artifact.type || 'markdown',
        content: artifact.content,
        timestamp: Date.now(),
      });
    }

    return list;
  }, [missions, artifact]);

  // 2. 根据搜索词与类型筛选
  const filteredArtifacts = useMemo(() => {
    return allArtifacts.filter((item) => {
      const matchSearch =
        !searchQuery.trim() ||
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.content.toLowerCase().includes(searchQuery.toLowerCase());
      const matchType = filterType === 'all' || item.type === filterType;
      return matchSearch && matchType;
    });
  }, [allArtifacts, searchQuery, filterType]);

  // 3. 当前选中的交付成果
  const activeItem = useMemo(() => {
    if (selectedArtifactId) {
      const found = allArtifacts.find((a) => a.id === selectedArtifactId);
      if (found) return found;
    }
    return filteredArtifacts[0] || allArtifacts[0] || null;
  }, [selectedArtifactId, allArtifacts, filteredArtifacts]);

  const handleCopy = () => {
    if (!activeItem?.content) return;
    navigator.clipboard.writeText(activeItem.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!activeItem?.content) return;
    const blob = new Blob([activeItem.content], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${activeItem.title || 'deliverable'}.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getTypeIcon = (type: string) => {
    if (type === 'code') return <Code2 className="h-3.5 w-3.5 text-blue-500" />;
    if (type === 'chart') return <PieChart className="h-3.5 w-3.5 text-purple-500" />;
    return <FileText className="h-3.5 w-3.5 text-zinc-600" />;
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn">
      {/* 顶部标题栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-200/60 shadow-2xs">
              <FileText className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              交付库与知识资产
            </h1>
            <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-zinc-100 border border-zinc-200/80 text-zinc-600">
              共 {allArtifacts.length} 份资产
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl leading-relaxed">
            由 AgtPilot 在多步执行中沉淀的结构化研究报告、工程代码产物与设计图表。
          </p>
        </div>

        {activeItem && (
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

      {allArtifacts.length === 0 ? (
        /* 空状态 */
        <div className="rounded-2xl border border-dashed border-zinc-300 p-16 text-center space-y-4 bg-white/50">
          <div className="mx-auto h-12 w-12 rounded-2xl bg-zinc-100 flex items-center justify-center text-zinc-400">
            <FolderOpen className="h-6 w-6" />
          </div>
          <div className="space-y-1 max-w-sm mx-auto">
            <h3 className="text-sm font-semibold text-zinc-800">暂无可交付成果</h3>
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
      ) : (
        /* 主体双栏资产库布局 (Master-Detail Layout) */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* 左侧：资产目录索引栏 (占 4 列) */}
          <div className="lg:col-span-4 bg-white rounded-2xl border border-zinc-200/80 p-3.5 space-y-3.5 shadow-2xs">
            {/* 搜索框 */}
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索交付物标题或正文..."
                className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-zinc-200 bg-zinc-50/50 text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:bg-white focus:border-zinc-400 transition"
              />
            </div>

            {/* 类型过滤标签 */}
            <div className="flex items-center gap-1 text-[11px] font-medium overflow-x-auto pb-1 scrollbar-none">
              {(
                [
                  { id: 'all', label: '全部' },
                  { id: 'markdown', label: '文档' },
                  { id: 'code', label: '代码' },
                  { id: 'chart', label: '图表' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setFilterType(tab.id)}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap ${
                    filterType === tab.id
                      ? 'bg-zinc-900 text-white shadow-2xs font-semibold'
                      : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* 纵向资产列表 (无限滚动容器) */}
            <div className="space-y-1.5 max-h-[calc(100vh-22rem)] overflow-y-auto pr-1">
              {filteredArtifacts.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-400">
                  没有找到匹配的资产
                </div>
              ) : (
                filteredArtifacts.map((item) => {
                  const isSelected = activeItem?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSelectedArtifactId(item.id)}
                      className={`w-full text-left p-3 rounded-xl border transition flex flex-col gap-1.5 ${
                        isSelected
                          ? 'bg-zinc-900 text-white border-zinc-900 shadow-sm'
                          : 'bg-white hover:bg-zinc-50 text-zinc-700 border-zinc-200/70 hover:border-zinc-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {getTypeIcon(item.type)}
                          <span className="text-xs font-medium truncate leading-tight">
                            {item.title}
                          </span>
                        </div>
                        <span
                          className={`text-[9px] font-mono uppercase px-1.5 py-0.2 rounded ${
                            isSelected
                              ? 'bg-zinc-800 text-zinc-300'
                              : 'bg-zinc-100 text-zinc-500'
                          }`}
                        >
                          {item.type}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[10px] font-mono opacity-70">
                        <span className="truncate max-w-[140px]">
                          {item.missionTitle || '自主会话'}
                        </span>
                        <span>
                          {new Date(item.timestamp).toLocaleDateString([], {
                            month: 'numeric',
                            day: 'numeric',
                          })}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* 右侧：沉浸式阅读画布 (占 8 列) */}
          <div className="lg:col-span-8 bg-white rounded-2xl border border-zinc-200/80 shadow-sm overflow-hidden flex flex-col">
            {activeItem ? (
              <>
                {/* 画布顶部元信息栏 */}
                <div className="p-4 md:p-5 border-b border-zinc-100 bg-[#fbfbfd] flex items-center justify-between gap-3">
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-semibold text-zinc-900 truncate">
                        {activeItem.title}
                      </span>
                      <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-zinc-200/80 text-zinc-600">
                        {activeItem.type}
                      </span>
                    </div>
                    {activeItem.missionTitle && (
                      <p className="text-xs text-zinc-400 truncate">
                        来源会话: {activeItem.missionTitle}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* 视窗展现模式切换 */}
                    <div className="flex items-center bg-zinc-200/60 p-0.5 rounded-lg text-[11px] font-medium text-zinc-600">
                      <button
                        onClick={() => setDeliverableViewMode('doc')}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition ${
                          deliverableViewMode === 'doc'
                            ? 'bg-white text-zinc-900 shadow-2xs font-semibold'
                            : 'hover:text-zinc-900'
                        }`}
                      >
                        <Eye className="h-3 w-3" />
                        <span>文档研报</span>
                      </button>
                      <button
                        onClick={() => setDeliverableViewMode('social')}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition ${
                          deliverableViewMode === 'social'
                            ? 'bg-white text-zinc-900 shadow-2xs font-semibold'
                            : 'hover:text-zinc-900'
                        }`}
                        title="切换至移动端与社交媒体 3:4 视觉切片卡片排版模拟器"
                      >
                        <Smartphone className="h-3 w-3 text-zinc-700" />
                        <span>移动端卡片</span>
                      </button>
                    </div>

                    {activeItem.missionId && (
                      <button
                        onClick={() => onOpenCockpit(activeItem.missionId)}
                        className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900 font-medium px-2.5 py-1.5 rounded-lg border border-zinc-200 hover:bg-zinc-50 transition"
                      >
                        <span>定位会话</span>
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>

                {/* 正文呈现区 */}
                {deliverableViewMode === 'social' ? (
                  <div className="p-4 md:p-6 bg-zinc-50/50">
                    <XiaohongshuPreviewCard
                      rawContent={activeItem.content}
                      title={activeItem.title}
                    />
                  </div>
                ) : (
                  <div className="p-6 md:p-8 prose prose-zinc prose-sm max-w-none leading-relaxed min-h-[500px]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {activeItem.content}
                    </ReactMarkdown>
                  </div>
                )}
              </>
            ) : (
              <div className="p-16 text-center text-xs text-zinc-400">
                请在左侧选择一份资产查阅
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
