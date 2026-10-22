'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { copyToClipboard } from '../utils/nativeBridge';
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
  Share2,
  FileDown,
  Paperclip,
  FileUp,
} from 'lucide-react';
import { ArtifactState, Mission } from '../types/agent';
import { XiaohongshuPreviewCard } from './XiaohongshuPreviewCard';
import { OssOpportunityList, parseOssDeliverable } from './workshops/OssOpportunityCard';
import { shareToApp } from '../utils/nativeBridge';

interface DeliverablesViewProps {
  artifact: ArtifactState | null;
  missions: Mission[];
  onOpenCockpit: (missionId?: string) => void;
  onRunMission: (prompt: string, title?: string) => void;
  /** mobile：移动端 tab 内嵌时用居中简版标题（无图标/描述），desktop 为完整标题栏 */
  variant?: 'desktop' | 'mobile';
}

/** 标题栏操作按钮（分享/复制/下载），桌面标题栏与移动端简版标题共用 */
function HeaderActions({
  shared,
  copied,
  downloadLabel = '下载 .md',
  onShare,
  onCopy,
  onDownload,
}: {
  shared: boolean;
  copied: boolean;
  downloadLabel?: string;
  onShare: () => void;
  onCopy: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onShare}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-700 shadow-2xs transition"
      >
        {shared ? (
          <CheckCheck className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <Share2 className="h-3.5 w-3.5 text-zinc-400" />
        )}
        <span>{shared ? '已分享' : '分享'}</span>
      </button>

      <button
        onClick={onCopy}
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
        onClick={onDownload}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white shadow-xs transition"
      >
        <Download className="h-3.5 w-3.5" />
        <span>{downloadLabel}</span>
      </button>
    </div>
  );
}

export function DeliverablesView({
  artifact,
  missions,
  onOpenCockpit,
  onRunMission,
  variant = 'desktop',
}: DeliverablesViewProps) {
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'markdown' | 'code' | 'chart' | 'html' | 'file'>('all');
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
      fileMeta?: { fileId: string; fileName: string; mime: string; sizeBytes: number };
      /** 工坊参考资料引用(mission.materialRefs 透传;输入↔产出闭环展示) */
      materialRefs?: Array<{ id: string; title: string }>;
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
          fileMeta: m.artifact.fileMeta,
          materialRefs: m.materialRefs,
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
        fileMeta: artifact.fileMeta,
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

  // 机会清单交付物分支:正文能解析出有效清单则渲可派发卡片(与会话流/画布同分支),
  // 否则按原类型渲染(markdown / html / file)
  const activeOss = activeItem ? parseOssDeliverable(activeItem.content) : null;

  // 上传资料现存清单(upl_ 引用徽章:kind 标注 + 已删除判定)。null = 未加载
  // 或加载失败(此时不判「已删除」,链接照给 —— 下载口自会 404 给人话)。
  const hasUploadRefs = useMemo(
    () => missions.some((m) => m.materialRefs?.some((r) => r.id.startsWith('upl_'))),
    [missions]
  );
  const [uploadMeta, setUploadMeta] = useState<Map<string, { kind?: string; fileName?: string }> | null>(null);
  useEffect(() => {
    if (!hasUploadRefs) return;
    let cancelled = false;
    fetch('/api/workshops/materials')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !Array.isArray(d?.items)) return;
        setUploadMeta(
          new Map(
            (d.items as Array<{ id: string; kind?: string; fileName?: string }>).map((it) => [
              it.id,
              { kind: it.kind, fileName: it.fileName },
            ])
          )
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasUploadRefs]);

  const handleCopy = async () => {
    if (!activeItem?.content) return;
    // http 部署无 navigator.clipboard,copyToClipboard 内含 execCommand 降级
    if (!(await copyToClipboard(activeItem.content))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!activeItem?.content) return;
    // file 产物(如 .pptx):本体在服务端文件库,走下载路由(cookie 鉴权)
    if (activeItem.type === 'file' && activeItem.fileMeta?.fileId) {
      const link = document.createElement('a');
      link.href = `/api/artifacts/file?fileId=${encodeURIComponent(activeItem.fileMeta.fileId)}`;
      link.setAttribute('download', activeItem.fileMeta.fileName || '');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }
    // html 产物(如 bento 演示页)按网页下载,其余仍为 Markdown 文档
    const isHtml = activeItem.type === 'html';
    const blob = new Blob([activeItem.content], {
      type: isHtml ? 'text/html;charset=utf-8;' : 'text/markdown;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const baseTitle = activeItem.title || 'deliverable';
    link.href = url;
    link.setAttribute(
      'download',
      isHtml
        ? /\.html?$/i.test(baseTitle)
          ? baseTitle
          : `${baseTitle}.bento.html`
        : `${baseTitle}.md`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // 原生分享：App 内唤起系统分享面板（微信/小红书/备忘录等），Web 端降级为 Web Share / 复制
  const [shared, setShared] = useState(false);
  const handleShare = async () => {
    if (!activeItem?.content) return;
    const ok = await shareToApp({
      title: activeItem.title || 'AgtPilot 交付物',
      text: `${activeItem.title ? activeItem.title + '\n\n' : ''}${activeItem.content}`.slice(0, 4000),
      dialogTitle: '分享交付物到',
    });
    if (ok) {
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    }
  };

  // 下载按钮文案随产物类型:file → 下载文件名,html → 下载演示页,其余 .md
  const downloadLabel = !activeItem
    ? '下载 .md'
    : activeItem.type === 'file'
      ? `下载 ${activeItem.fileMeta?.fileName || '文件'}`
      : activeItem.type === 'html'
        ? '下载演示页'
        : '下载 .md';

  const getTypeIcon = (type: string) => {
    if (type === 'code') return <Code2 className="h-3.5 w-3.5 text-blue-500" />;
    if (type === 'chart') return <PieChart className="h-3.5 w-3.5 text-purple-500" />;
    if (type === 'html') return <Globe className="h-3.5 w-3.5 text-emerald-500" />;
    if (type === 'file') return <FileDown className="h-3.5 w-3.5 text-sky-500" />;
    return <FileText className="h-3.5 w-3.5 text-zinc-600" />;
  };

  return (
    <div
      className={
        variant === 'mobile'
          ? // 移动端与「动态」页同款容器:px-4 pt-4 pb-28 max-w-lg,标题位置对齐
            'w-full max-w-lg mx-auto px-4 pt-4 pb-28 space-y-8 animate-fadeIn'
          : 'w-full max-w-5xl mx-auto px-4 py-8 md:py-12 space-y-8 animate-fadeIn'
      }
    >
      {/* 顶部标题栏：移动端居中简版（无图标/描述），桌面完整版；操作按钮两种布局共用 */}
      {variant === 'mobile' ? (
        <header className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">交付物</h1>
          {activeItem && (
            <div className="mt-3 flex items-center justify-center gap-2">
              <HeaderActions
                shared={shared}
                copied={copied}
                downloadLabel={downloadLabel}
                onShare={handleShare}
                onCopy={handleCopy}
                onDownload={handleDownload}
              />
            </div>
          )}
        </header>
      ) : (
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
          <HeaderActions
            shared={shared}
            copied={copied}
            downloadLabel={downloadLabel}
            onShare={handleShare}
            onCopy={handleCopy}
            onDownload={handleDownload}
          />
        )}
      </div>
      )}

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
                  { id: 'html', label: '演示页' },
                  { id: 'file', label: '文件' },
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

                {/* 参考资料区(工坊任务):输入↔产出闭环。upl_ = 上传件(可下载
                    原件,已删的灰显不留死链);art_ = 其他会话交付物(内链跳转) */}
                {activeItem.materialRefs && activeItem.materialRefs.length > 0 && (
                  <div className="px-4 md:px-5 py-2.5 border-b border-zinc-100 bg-white flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] text-zinc-400 flex items-center gap-1 mr-1">
                      <Paperclip className="h-3 w-3" />
                      参考资料
                    </span>
                    {activeItem.materialRefs.map((ref) => {
                      if (ref.id.startsWith('upl_')) {
                        const meta = uploadMeta?.get(ref.id);
                        const gone = uploadMeta !== null && !meta;
                        const kindLabel = meta?.kind === 'pdf' ? 'PDF' : meta?.kind === 'docx' ? 'Word' : '上传';
                        return gone ? (
                          <span
                            key={ref.id}
                            title="上传文件已被删除,原件不可下载"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-200 bg-zinc-50 text-[11px] text-zinc-400 max-w-[220px]"
                          >
                            <FileUp className="h-3 w-3 shrink-0" />
                            <span className="truncate">{ref.title}</span>
                            <span className="text-[9px] px-1 py-px rounded bg-zinc-200/70 text-zinc-500 shrink-0">已删除</span>
                          </span>
                        ) : (
                          <a
                            key={ref.id}
                            href={`/api/workshops/materials/file?id=${encodeURIComponent(ref.id)}`}
                            title="下载上传原件"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-sky-200 bg-sky-50/70 text-[11px] text-sky-800 hover:bg-sky-100 hover:border-sky-300 transition max-w-[240px]"
                          >
                            <FileUp className="h-3 w-3 shrink-0 text-sky-500" />
                            <span className="truncate">{meta?.fileName || ref.title}</span>
                            <span className="text-[9px] px-1 py-px rounded bg-sky-100 text-sky-600 border border-sky-200/70 shrink-0">{kindLabel}</span>
                            <Download className="h-3 w-3 shrink-0 text-sky-500" />
                          </a>
                        );
                      }
                      // art_<missionId>:目标交付物在当前列表里 → 内链跳转;
                      // 不在(旧任务/未产出/超出保留窗口)→ 灰芯片不留死链
                      const refMissionId = ref.id.startsWith('art_') ? ref.id.slice(4) : '';
                      const target = refMissionId
                        ? allArtifacts.find((a) => a.missionId === refMissionId)
                        : undefined;
                      return target ? (
                        <button
                          key={ref.id}
                          type="button"
                          onClick={() => setSelectedArtifactId(target.id)}
                          title="跳转到该交付物"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-200 bg-emerald-50/70 text-[11px] text-emerald-800 hover:bg-emerald-100 hover:border-emerald-300 transition max-w-[240px]"
                        >
                          <FileText className="h-3 w-3 shrink-0 text-emerald-600" />
                          <span className="truncate">{ref.title}</span>
                          <ArrowRight className="h-3 w-3 shrink-0 text-emerald-600" />
                        </button>
                      ) : (
                        <span
                          key={ref.id}
                          title="来源会话交付物不在当前列表(旧任务或已清理)"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-200 bg-zinc-50 text-[11px] text-zinc-400 max-w-[220px]"
                        >
                          <FileText className="h-3 w-3 shrink-0" />
                          <span className="truncate">{ref.title}</span>
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* 正文呈现区 */}
                {deliverableViewMode === 'social' ? (
                  <div className="p-4 md:p-6 bg-zinc-50/50">
                    <XiaohongshuPreviewCard
                      rawContent={activeItem.content}
                      title={activeItem.title}
                    />
                  </div>
                ) : activeItem.type === 'file' ? (
                  /* file 产物(ppt-master 真 .pptx 等二进制):下载卡片 + 摘要 */
                  <div className="p-4 md:p-6 min-w-0 space-y-4">
                    <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-6 flex flex-col sm:flex-row items-center gap-4 shadow-2xs">
                      <div className="h-14 w-14 rounded-2xl bg-sky-50 border border-sky-200/70 flex items-center justify-center flex-shrink-0">
                        <FileDown className="h-7 w-7 text-sky-600" />
                      </div>
                      <div className="min-w-0 text-center sm:text-left">
                        <p className="text-sm font-semibold text-zinc-900 truncate max-w-full">
                          {activeItem.fileMeta?.fileName || activeItem.title || '交付文件'}
                        </p>
                        <p className="text-[11px] text-zinc-400 mt-0.5 font-mono">
                          {activeItem.fileMeta
                            ? `${(activeItem.fileMeta.sizeBytes / 1024).toFixed(0)} KB · ${activeItem.fileMeta.mime.split('/').pop()}`
                            : '文件产物'}
                        </p>
                      </div>
                      <a
                        href={`/api/artifacts/file?fileId=${encodeURIComponent(activeItem.fileMeta?.fileId || '')}`}
                        download={activeItem.fileMeta?.fileName || undefined}
                        className={`ml-auto flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium shadow-xs transition ${
                          activeItem.fileMeta?.fileId
                            ? 'bg-zinc-900 hover:bg-zinc-800 text-white'
                            : 'bg-zinc-100 text-zinc-400 pointer-events-none'
                        }`}
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>下载文件</span>
                      </a>
                    </div>
                    <div className="prose prose-zinc prose-sm max-w-none leading-relaxed">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {activeItem.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                ) : activeItem.type === 'html' ? (
                  /* html 产物(bento 演示页/自包含网页):iframe srcDoc 沙箱放映。
                     不给 allow-same-origin —— 演示页脚本运行在独立源,拿不到主站
                     cookie/storage;allow-scripts 保证其翻页/动画/图表可用。 */
                  <div className="p-4 md:p-6 min-w-0">
                    <iframe
                      title={activeItem.title || '演示页'}
                      srcDoc={activeItem.content}
                      sandbox="allow-scripts allow-popups"
                      className="w-full aspect-video rounded-xl border border-zinc-200 bg-white shadow-2xs"
                    />
                    <p className="mt-2 text-[11px] text-zinc-400 leading-relaxed">
                      网页演示页:画面内可翻页放映;下载保存 .bento.html 后双击即可离线放映,浏览器内可继续编辑。
                    </p>
                  </div>
                ) : activeOss ? (
                  /* 机会清单交付物(开源雷达):可派发卡片,派发/起草审批与会话流同源 */
                  <div className="p-4 md:p-6 min-w-0">
                    <OssOpportunityList result={activeOss} missionId={activeItem.missionId || undefined} />
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
