'use client';

/**
 * 小红书每周选题勾选卡(scenario-loop P1 · docs/design/workshop-scenario-loop.md §4.1)
 *
 * 把 parseTopicPicks 的结构化结果渲染成「可勾选」卡片:勾 1-3 条 → 「成稿选中」
 * 续聊同一 mission(buildTopicPickReplyText 组装回复,内嵌笔记包字段规格,
 * 续答可被 NotePackageList 渲染)。这是选题→成稿多步工作流的人工确认点,
 * 也是移动端对 DONE 任务的唯一回复入口。compact 模式适配移动端小屏。
 */
import React, { useState } from 'react';
import { Check, ChevronDown, Lightbulb, Send } from 'lucide-react';
import {
  MAX_TOPIC_PICKS,
  buildTopicPickReplyText,
  type TopicPick,
  type TopicPickParseResult,
} from '../../lib/topic-picks';

function TopicPickCard({
  pick,
  checked,
  onToggle,
  compact,
}: {
  pick: TopicPick;
  checked: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full text-left rounded-xl border transition overflow-hidden ${
        checked
          ? 'border-violet-300 bg-violet-50/60 ring-1 ring-violet-200'
          : 'border-zinc-200 bg-white hover:border-zinc-300'
      }`}
      title={checked ? '取消勾选' : '勾选这条选题'}
    >
      <div className={compact ? 'p-3 space-y-2' : 'p-4 space-y-2.5'}>
        {/* 卡头:编号 + 方向 + 勾选框 */}
        <div className="flex items-start gap-2.5">
          <span
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold transition ${
              checked ? 'bg-violet-600 text-white' : 'bg-zinc-100 text-zinc-500'
            }`}
          >
            {checked ? <Check className="h-3 w-3" /> : pick.number}
          </span>
          <p className={`text-xs leading-snug font-semibold ${checked ? 'text-violet-800' : 'text-zinc-800'}`}>
            {pick.direction}
          </p>
        </div>

        {/* 标题钩子 */}
        {pick.hooks.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pl-8">
            {pick.hooks.map((h, i) => (
              <span
                key={i}
                className="px-2 py-0.5 rounded-md bg-white border border-zinc-200 text-[10px] font-medium text-zinc-700"
              >
                {h}
              </span>
            ))}
          </div>
        )}

        {/* 依据:真实数据来源是选题可信度的关键,单列强调 */}
        {pick.basis && (
          <p className="pl-8 text-[10px] leading-relaxed text-zinc-500">
            <span className="font-medium text-zinc-400">依据 · </span>
            {pick.basis}
          </p>
        )}

        {/* 次要字段:紧凑模式折叠成一行摘要 */}
        {compact ? (
          <p className="pl-8 text-[10px] text-zinc-400 truncate">
            {[pick.angle, pick.imageIdea, pick.publishDay].filter(Boolean).join(' · ')}
          </p>
        ) : (
          <div className="pl-8 space-y-1 text-[10px] leading-relaxed text-zinc-500">
            {pick.angle && <p>切入:{pick.angle}</p>}
            {pick.imageIdea && <p>配图:{pick.imageIdea}</p>}
            {pick.publishDay && <p>📅 {pick.publishDay}</p>}
          </div>
        )}
      </div>
    </button>
  );
}

/** 选题列表:勾选(上限 3)+ 成稿选中 + 尾部 fallback 折叠(总评不丢) */
export function TopicPickList({
  result,
  missionId,
  onRunMission,
  compact,
}: {
  result: TopicPickParseResult;
  missionId?: string | null;
  onRunMission: (prompt: string, title?: string, missionId?: string) => void;
  compact?: boolean;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [overLimitHint, setOverLimitHint] = useState(false);
  const [showFallback, setShowFallback] = useState(false);

  const toggle = (number: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(number)) {
        next.delete(number);
        return next;
      }
      if (next.size >= MAX_TOPIC_PICKS) {
        setOverLimitHint(true);
        setTimeout(() => setOverLimitHint(false), 2000);
        return prev;
      }
      next.add(number);
      return next;
    });
  };

  const selectedPicks = result.picks.filter((p) => selected.has(p.number));

  const handleDraft = () => {
    if (selectedPicks.length === 0) return;
    onRunMission(buildTopicPickReplyText(selectedPicks), undefined, missionId || undefined);
  };

  if (result.picks.length === 0) return null;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-600">
          <Lightbulb className="h-3.5 w-3.5 text-violet-500" />
          本周选题 · 勾选后一键成稿
        </span>
        <span className="text-[10px] text-zinc-400">
          {selected.size}/{MAX_TOPIC_PICKS}
        </span>
      </div>

      {result.picks.map((pick) => (
        <TopicPickCard
          key={`${pick.number}-${pick.direction}`}
          pick={pick}
          checked={selected.has(pick.number)}
          onToggle={() => toggle(pick.number)}
          compact={compact}
        />
      ))}

      {overLimitHint && (
        <p className="text-[10px] text-amber-600 text-center">至多勾选 {MAX_TOPIC_PICKS} 条</p>
      )}

      <button
        type="button"
        onClick={handleDraft}
        disabled={selectedPicks.length === 0}
        className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:bg-zinc-200 disabled:text-zinc-400 text-white text-xs font-medium transition shadow-xs"
      >
        <Send className="h-3.5 w-3.5" />
        成稿选中{selectedPicks.length > 0 ? `(${selectedPicks.length})` : ''}
      </button>

      {result.fallback && (
        <div className="rounded-xl border border-zinc-200 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowFallback((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-2 text-[11px] font-medium text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 transition"
          >
            <span>总评与其他内容</span>
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
