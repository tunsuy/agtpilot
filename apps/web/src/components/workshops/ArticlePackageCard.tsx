'use client';

/**
 * 公众号文章包卡片(scenario-loop:草稿箱直投)
 *
 * 把 parseArticlePackages 的结构化结果渲染成「字段级可复制」卡片:
 * 标题候选逐条复制+选中(投草稿用选中标题)、摘要/正文独立复制、一键整卡复制。
 * 底部「投草稿箱」→ 续聊同一 mission,指示 Agent 调 wechat_mp_create_draft
 * (dangerLevel high → 编排器审批门,用户逐次确认);发布永远人工,卡片不碰发布。
 */
import React, { useState } from 'react';
import { Copy, Check, FileText, ChevronDown, SendHorizonal } from 'lucide-react';
import { copyToClipboard } from '../../utils/nativeBridge';
import {
  buildArticlePackageCopyText,
  buildArticlePackageReplyText,
  type ArticlePackage,
  type ArticlePackageParseResult,
} from '../../lib/article-package';

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

function ArticlePackageCard({
  pkg,
  missionId,
  onRunMission,
}: {
  pkg: ArticlePackage;
  missionId?: string | null;
  onRunMission: (prompt: string, title?: string, missionId?: string) => void;
}) {
  const [selectedTitle, setSelectedTitle] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [bodyOpen, setBodyOpen] = useState(false);

  const handleCopyAll = async () => {
    const ok = await copyToClipboard(buildArticlePackageCopyText(pkg, selectedTitle));
    setCopyState(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyState('idle'), 2000);
  };

  /** 投草稿箱:续聊同一 mission,Agent 调 wechat_mp_create_draft(需我审批) */
  const handleDraft = () => {
    onRunMission(buildArticlePackageReplyText(pkg, selectedTitle), undefined, missionId || undefined);
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      {/* 卡头:篇号 + 一键整卡复制(标题→摘要→正文) */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-50/70 border-b border-zinc-100">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-700">
          <FileText className="h-3.5 w-3.5 text-violet-500" />
          文章包 {pkg.index > 1 ? `#${pkg.index}` : ''}
        </span>
        <button
          type="button"
          onClick={handleCopyAll}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-[11px] font-medium transition shadow-xs"
        >
          {copyState === 'ok' ? (
            <>
              <Check className="h-3 w-3" />
              已复制全文
            </>
          ) : copyState === 'fail' ? (
            <span className="text-red-100">复制失败</span>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              复制全文
            </>
          )}
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* 标题候选:点击选中(投草稿/复制全文用),行尾独立复制 */}
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
                title="点击选为投草稿与复制全文的标题"
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

        {/* 摘要:与笔记包的互斥锚字段,始终渲染 */}
        <div className="space-y-1 group">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">摘要</span>
            <span className="opacity-0 group-hover:opacity-100 transition">
              <CopyButton text={pkg.digest} />
            </span>
          </div>
          <p className="text-xs text-zinc-700 leading-relaxed break-words">{pkg.digest}</p>
        </div>

        {/* 正文:Markdown 原文,pre-wrap,长文折叠展开 */}
        <div className="space-y-1 group">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">正文</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setBodyOpen((v) => !v)}
                className="flex items-center gap-1 text-[10px] font-medium text-zinc-400 hover:text-zinc-700 transition"
              >
                <ChevronDown className={`h-3 w-3 transition ${bodyOpen ? 'rotate-180' : ''}`} />
                {bodyOpen ? '收起' : '展开全文'}
              </button>
              <span className="opacity-0 group-hover:opacity-100 transition">
                <CopyButton text={pkg.body} />
              </span>
            </div>
          </div>
          <pre
            className={`text-xs text-zinc-700 leading-relaxed whitespace-pre-wrap break-words ${
              bodyOpen ? '' : 'max-h-72 overflow-hidden'
            }`}
          >
            {pkg.body}
          </pre>
        </div>

        {/* 封面建议:弱化展示,不进整卡复制 */}
        {pkg.coverIdea && (
          <div className="flex items-start gap-1.5 px-2.5 py-2 rounded-lg bg-zinc-50 text-[10px] text-zinc-500 leading-relaxed">
            <span>🖼️ {pkg.coverIdea}</span>
          </div>
        )}

        {/* 发布建议:弱化展示,不进整卡复制 */}
        {pkg.publishAdvice && (
          <div className="flex items-start gap-1.5 px-2.5 py-2 rounded-lg bg-zinc-50 text-[10px] text-zinc-500 leading-relaxed">
            <span>💡 {pkg.publishAdvice}</span>
          </div>
        )}

        {/* 投草稿箱:续聊本 mission → Agent 调 create_draft(high 审批门);发布永远人工 */}
        <button
          type="button"
          onClick={handleDraft}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium transition shadow-xs"
        >
          <SendHorizonal className="h-3.5 w-3.5" />
          投草稿箱(经我审批后写入,发布由我在后台人工完成)
        </button>
      </div>
    </div>
  );
}

/** 文章包列表:多卡垂直堆叠 + 尾部「原始文本」折叠(fallback 不丢内容) */
export function ArticlePackageList({
  result,
  missionId,
  onRunMission,
}: {
  result: ArticlePackageParseResult;
  missionId?: string | null;
  onRunMission: (prompt: string, title?: string, missionId?: string) => void;
}) {
  const [showFallback, setShowFallback] = useState(false);

  return (
    <div className="space-y-3">
      {result.packages.map((pkg) => (
        <ArticlePackageCard key={pkg.index} pkg={pkg} missionId={missionId} onRunMission={onRunMission} />
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
