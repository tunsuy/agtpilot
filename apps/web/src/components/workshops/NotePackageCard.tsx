'use client';

/**
 * 小红书笔记包卡片(scenario-loop §3)
 *
 * 把 parseNotePackages 的结构化结果渲染成「字段级可复制」卡片:
 * 标题候选逐条复制+选中、封面/正文/标签独立复制、一键整卡复制(标题→正文→标签,
 * 对齐小红书发布页粘贴顺序)。复制走 nativeBridge.copyToClipboard(Capacitor → web 降级)。
 */
import React, { useState } from 'react';
import { Copy, Check, FileText, ChevronDown } from 'lucide-react';
import { copyToClipboard } from '../../utils/nativeBridge';
import {
  buildNotePackageCopyText,
  type NotePackage,
  type NotePackageParseResult,
} from '../../lib/note-package';

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

function NotePackageCard({ pkg }: { pkg: NotePackage }) {
  const [selectedTitle, setSelectedTitle] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const handleCopyAll = async () => {
    const ok = await copyToClipboard(buildNotePackageCopyText(pkg, selectedTitle));
    setCopyState(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyState('idle'), 2000);
  };

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
        {/* 标题候选:点击选中(整卡复制用),行尾独立复制 */}
        {pkg.titles.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">标题候选</span>
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
                title="点击选为整篇复制的标题"
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
      </div>
    </div>
  );
}

/** 笔记包列表:多卡垂直堆叠 + 尾部「原始文本」折叠(fallback 不丢内容) */
export function NotePackageList({ result }: { result: NotePackageParseResult }) {
  const [showFallback, setShowFallback] = useState(false);

  return (
    <div className="space-y-3">
      {result.packages.map((pkg) => (
        <NotePackageCard key={pkg.index} pkg={pkg} />
      ))}
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
