'use client';

/**
 * 小红书笔记包卡片(xhs 格式的通用渲染)
 *
 * 把 parseNotePackages 的结构化结果渲染成「字段级可复制」卡片:
 * 新格式交付物是成品——标题为 Agent 拍板的唯一终版(直接展示);历史记录的
 * 多候选标题保留点选交互。封面/正文/标签独立复制、一键整卡复制(标题→正文→标签,
 * 对齐小红书发布页粘贴顺序)。复制走 nativeBridge.copyToClipboard(Capacitor → web 降级)。
 * 底部存草稿按钮 → 续聊同一 mission;投递指令与托管门引导来自 xhs 工坊包声明的
 * draft spec(CockpitView 经 resolveArtifactDraft 解析后传入),卡片不持工域知识。
 */
import React, { useState } from 'react';
import { Copy, Check, FileText, ChevronDown, SendHorizonal } from 'lucide-react';
import { copyToClipboard } from '../../utils/nativeBridge';
import {
  buildNotePackageCopyText,
  type NotePackage,
  type NotePackageParseResult,
} from '../../workshops/xhs/note-package';
import { isDraftDelivered, type DraftDeliveryIndex } from '../../lib/draft-delivery';
import type { Mission } from '../../types/agent';

/** 卡片侧的投递声明形状(来自工坊包 ArtifactDraftSpec,结构兼容即可) */
export interface NoteDraftSpecProp {
  label: string;
  build: (pkg: NotePackage, titleIndex: number) => string;
  disabledHint?: string;
}

/** 单字段复制按钮:成功打勾、失败明示,不静默假成功 */
function CopyButton({ text, label }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(text);
    setState(ok ? 'ok' : 'fail');
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition"
      title="复制"
    >
      {state === 'ok' ? (
        <Check className="h-3 w-3 text-emerald-600" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      {state === 'fail' ? (
        <span className="text-red-500">复制失败</span>
      ) : (
        (state === 'ok' ? '已复制' : label || '复制')
      )}
    </button>
  );
}

function NotePackageCard({
  pkg,
  missionId,
  onRunMission,
  draft,
  draftEnabled,
  draftInFlight,
  draftDelivered,
}: {
  pkg: NotePackage;
  missionId?: string | null;
  onRunMission?: (prompt: string, title?: string, missionId?: string) => void;
  /** xhs 工坊包声明的投递指令(未解析到 = 只读卡,不出按钮) */
  draft?: NoteDraftSpecProp;
  /** 小红书托管写操作已开启(连接器页 opt-in)时才有「存草稿箱」按钮 */
  draftEnabled?: boolean;
  /** 任务在飞(ACTIVE/待审批/排队):投递轮进行中按钮禁用,防重复发指令 */
  draftInFlight?: boolean;
  /** 已落稿索引(标题/正文命中本篇 → 已投递态,不可再点) */
  draftDelivered?: DraftDeliveryIndex;
}) {
  const [selectedTitle, setSelectedTitle] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const handleCopyAll = async () => {
    const ok = await copyToClipboard(buildNotePackageCopyText(pkg, selectedTitle));
    setCopyState(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyState('idle'), 2000);
  };

  /** 存草稿箱:续聊同一 mission,Agent 按工坊声明的投递指令调存草稿工具(需我审批) */
  const handleDraft = () => {
    if (!draft) return;
    onRunMission?.(draft.build(pkg, selectedTitle), undefined, missionId || undefined);
  };

  const delivered = isDraftDelivered(draftDelivered, pkg.titles[selectedTitle], pkg.body);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      {/* 卡头:篇号 + 一键整卡复制 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-50/70 border-b border-zinc-100">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-700">
          <FileText className="h-3.5 w-3.5 text-violet-500" />
          笔记包 {pkg.index > 1 ? `#${pkg.index}` : ''}
        </span>
        <button
          type="button"
          onClick={handleCopyAll}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-[11px] font-medium transition shadow-xs"
        >
          {copyState === 'ok' ? (
            <>
              <Check className="h-3 w-3" />
              已复制整篇
            </>
          ) : copyState === 'fail' ? (
            <span className="text-red-100">复制失败</span>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              复制整篇
            </>
          )}
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* 标题:新格式为 Agent 拍板的唯一终版(直接展示);多标题仅见于历史记录,保留点选交互 */}
        {pkg.titles.length === 1 ? (
          <div className="group flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">标题</span>
              <p className="text-sm font-semibold text-zinc-900 mt-0.5 break-words">{pkg.titles[0]}</p>
            </div>
            <span className="opacity-0 group-hover:opacity-100 transition mt-3">
              <CopyButton text={pkg.titles[0]} />
            </span>
          </div>
        ) : (
          pkg.titles.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">标题候选(历史记录,点击选中)</span>
              </div>
              {pkg.titles.map((t, i) => (
                <div
                  key={i}
                  className={`group flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition ${
                    i === selectedTitle
                      ? 'bg-violet-50 border border-violet-200'
                      : 'hover:bg-zinc-50 border border-transparent'
                  }`}
                  onClick={() => setSelectedTitle(i)}
                  title="点击选为整篇复制/存草稿的标题"
                >
                  <span
                    className={`text-xs font-medium ${i === selectedTitle ? 'text-violet-700' : 'text-zinc-700'}`}
                  >
                    {t}
                  </span>
                  <span className="opacity-0 group-hover:opacity-100 transition">
                    <CopyButton text={t} />
                  </span>
                </div>
              ))}
            </div>
          )
        )}

        {/* 封面文案 */}
        {pkg.coverCopy && (
          <div className="flex items-start justify-between gap-2 group">
            <div>
              <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">封面文案</span>
              <p className="text-xs text-zinc-700 mt-0.5">{pkg.coverCopy}</p>
            </div>
            <span className="opacity-0 group-hover:opacity-100 transition mt-3">
              <CopyButton text={pkg.coverCopy} />
            </span>
          </div>
        )}

        {/* 正文 */}
        <div className="space-y-1 group">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">正文</span>
            <span className="opacity-0 group-hover:opacity-100 transition">
              <CopyButton text={pkg.body} />
            </span>
          </div>
          <p className="text-xs text-zinc-700 leading-relaxed whitespace-pre-wrap break-words">{pkg.body}</p>
        </div>

        {/* 标签 */}
        {pkg.tags.length > 0 && (
          <div className="space-y-1 group">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">标签</span>
              <span className="opacity-0 group-hover:opacity-100 transition">
                <CopyButton text={pkg.tags.map((t) => `#${t}`).join(' ')} />
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pkg.tags.map((t) => (
                <span
                  key={t}
                  className="px-2 py-0.5 rounded-md bg-violet-50 text-violet-600 text-[10px] font-medium border border-violet-100"
                >
                  #{t}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 发布建议:弱化展示,不进整卡复制 */}
        {pkg.publishAdvice && (
          <div className="flex items-start gap-1.5 px-2.5 py-2 rounded-lg bg-zinc-50 text-[10px] text-zinc-500 leading-relaxed">
            <span>💡 {pkg.publishAdvice}</span>
          </div>
        )}

        {/* 存草稿箱:续聊本 mission → Agent 按工坊声明调存草稿工具(high 审批门);发布永远人工。
            投递终态从 mission 步骤推导:已落稿 → 已投递不可再点(防重复存草稿);
            任务在飞 → 投递中禁用;审批被拒/失败 → 无 DONE 步骤,按钮回到可点(可重试) */}
        {onRunMission && draft && draftEnabled && (
          <button
            type="button"
            onClick={handleDraft}
            disabled={delivered || draftInFlight}
            className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition shadow-xs ${
              delivered
                ? 'bg-zinc-100 text-zinc-400 cursor-default'
                : draftInFlight
                  ? 'bg-emerald-300 text-white cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'
            }`}
          >
            {delivered ? (
              <>
                <Check className="h-3.5 w-3.5" />
                已存入草稿箱
              </>
            ) : draftInFlight ? (
              <>
                <span className="h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                投递中…
              </>
            ) : (
              <>
                <SendHorizonal className="h-3.5 w-3.5" />
                {draft.label}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/** 笔记包列表:多卡垂直堆叠 + 尾部「原始文本」折叠(fallback 不丢内容) */
export function NotePackageList({
  result,
  missionId,
  onRunMission,
  draft,
  draftEnabled,
  missionStatus,
  draftDelivered,
}: {
  result: NotePackageParseResult;
  missionId?: string | null;
  onRunMission?: (prompt: string, title?: string, missionId?: string) => void;
  /** xhs 工坊包声明的投递指令;未开启给一行引导 */
  draft?: NoteDraftSpecProp;
  /** 小红书托管写操作已开启时才渲染「存入草稿箱」按钮;未开启给一行引导 */
  draftEnabled?: boolean;
  /** 任务状态:ACTIVE/WAITING_APPROVAL/QUEUED 期间投递按钮禁用(投递轮在飞) */
  missionStatus?: Mission['status'];
  /** 已落稿索引(标题/正文命中 → 各卡独立转「已存入草稿箱」) */
  draftDelivered?: DraftDeliveryIndex;
}) {
  const [showFallback, setShowFallback] = useState(false);
  const draftInFlight =
    missionStatus === 'ACTIVE' || missionStatus === 'WAITING_APPROVAL' || missionStatus === 'QUEUED';

  return (
    <div className="space-y-3">
      {result.packages.map((pkg) => (
        <NotePackageCard
          key={pkg.index}
          pkg={pkg}
          missionId={missionId}
          onRunMission={onRunMission}
          draft={draft}
          draftEnabled={draftEnabled}
          draftInFlight={draftInFlight}
          draftDelivered={draftDelivered}
        />
      ))}
      {onRunMission && draft && !draftEnabled && draft.disabledHint && (
        <p className="text-[10px] text-zinc-400 leading-relaxed">{draft.disabledHint}</p>
      )}
      {result.fallback && (
        <div className="rounded-xl border border-zinc-200 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowFallback((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-2 text-[11px] font-medium text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 transition"
          >
            <span>其他输出内容</span>
            <ChevronDown className={`h-3.5 w-3.5 transition ${showFallback ? 'rotate-180' : ''}`} />
          </button>
          {showFallback && (
            <pre className="px-4 pb-3 text-[10px] leading-relaxed text-zinc-500 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {result.fallback}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
