'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Search,
  Globe,
  Code,
  FileText,
  Plug,
  ListTodo,
  BookOpen,
  Bell,
  MessageSquare,
  Brain,
  User,
  Wrench,
  Check,
  X,
  ChevronDown,
  RotateCw,
} from 'lucide-react';
import type { MissionStep } from '../types/agent';
import { narrateStep, formatActivityDuration, type ActivityKind } from '../lib/activity-narration';
import { splitStepsIntoBlocks } from '../lib/cockpit-blocks';

/**
 * 右侧工作台「执行动态」活动流：把内部 loop 翻译成用户能读懂的行动语言，
 * 实时跟随滚动。默认叙述模式；「原始模式」展示工具名与入参出参（替代旧的中栏
 * 「查看执行详情」）。执行中条目旋转图标 + 呼吸点，完成显示 ✓ 与真实耗时。
 */

const KIND_ICON: Record<ActivityKind, React.ComponentType<{ className?: string }>> = {
  user: User,
  think: Brain,
  reply: MessageSquare,
  search: Search,
  browser: Globe,
  sandbox: Code,
  artifact: FileText,
  connector: Plug,
  planner: ListTodo,
  memory: BookOpen,
  notify: Bell,
  generic: Wrench,
};

/** ms 形态的 duration 字符串解析失败时兜底显示 */
function displayDuration(st: MissionStep): string | undefined {
  return formatActivityDuration(st.duration) ?? (st.status === 'DONE' ? '完成' : undefined);
}

export function ActivityFeedView({ steps }: { steps: MissionStep[] }) {
  const [rawMode, setRawMode] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  /** 智能跟随：贴底才自动滚动，上翻阅读不被拽回（对齐对话流行为） */
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    if (steps.length > 0 && atBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [steps.length, rawMode]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  // 原始模式的执行效率摘要（复用 cockpit-blocks 的分块纯函数）
  const { effNotes } = splitStepsIntoBlocks(steps);
  const entries = steps
    .map((st) => ({ step: st, narrated: narrateStep(st) }))
    .filter((e) => e.narrated !== null);

  return (
    <div className="h-full w-full rounded-2xl border border-zinc-200/90 bg-white shadow-sm flex flex-col overflow-hidden animate-fadeIn">
      {/* 头部：模式切换（叙述 / 原始） */}
      <div className="h-11 border-b border-zinc-200/80 bg-zinc-50/70 px-4 flex items-center justify-between gap-3 select-none flex-shrink-0">
        <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 min-w-0">
          <RotateCw className="h-3.5 w-3.5 text-blue-500" />
          <span>执行动态</span>
          <span className="text-[10px] text-zinc-400 font-mono">{entries.length} 条</span>
        </div>
        <div className="flex items-center bg-zinc-200/60 p-0.5 rounded-lg text-[11px] font-medium text-zinc-600 flex-shrink-0">
          <button
            type="button"
            onClick={() => setRawMode(false)}
            className={`px-2 py-0.5 rounded-md transition ${
              !rawMode ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'hover:text-zinc-900'
            }`}
          >
            叙述模式
          </button>
          <button
            type="button"
            onClick={() => setRawMode(true)}
            className={`px-2 py-0.5 rounded-md transition ${
              rawMode ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'hover:text-zinc-900'
            }`}
            title="展示工具名与入参出参（开发者视图）"
          >
            原始模式
          </button>
        </div>
      </div>

      {/* 活动流主体 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5"
      >
        {entries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-16 space-y-3 max-w-xs mx-auto">
            <div className="h-10 w-10 rounded-2xl bg-zinc-100 border border-zinc-200/80 flex items-center justify-center text-zinc-400 shadow-2xs">
              <RotateCw className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-zinc-800">暂无执行动态</p>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                任务开始后，这里会实时展示智能体的每一步动作：正在思考、搜索了什么、打开了哪个网页、运行了什么命令。
              </p>
            </div>
          </div>
        ) : (
          entries.map(({ step: st, narrated }) => {
            const item = narrated!;
            const Icon = KIND_ICON[item.kind];
            const isRunning = st.status === 'RUNNING';
            const isFailed = st.status === 'FAILED';
            const isUser = item.kind === 'user';
            const dur = displayDuration(st);
            const isExpanded = Boolean(expandedIds[st.id]);
            const hasRawDetail = Boolean(st.args || st.output || st.tool);

            return (
              <div key={st.id} className={isUser ? 'pt-2' : ''}>
                <button
                  type="button"
                  disabled={!hasRawDetail}
                  onClick={() => setExpandedIds((prev) => ({ ...prev, [st.id]: !isExpanded }))}
                  className={`w-full text-left flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition ${
                    isUser
                      ? 'cursor-default bg-zinc-50/60'
                      : hasRawDetail
                        ? 'hover:bg-zinc-50 cursor-pointer'
                        : 'cursor-default'
                  }`}
                >
                  {/* 状态图标：执行中旋转 / 完成 ✓ / 失败 ✗ / 用户提问弱化 */}
                  <div className="flex-shrink-0 mt-0.5 h-4 w-4 flex items-center justify-center">
                    {isUser ? (
                      <Icon className="h-3 w-3 text-zinc-400" />
                    ) : isRunning ? (
                      <RotateCw className="h-3.5 w-3.5 text-blue-500 animate-spin" />
                    ) : isFailed ? (
                      <X className="h-3.5 w-3.5 text-red-500" />
                    ) : (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <span
                        className={`text-xs leading-relaxed truncate ${
                          isUser
                            ? 'text-zinc-400 font-normal'
                            : isRunning
                              ? 'text-zinc-800 font-medium'
                              : isFailed
                                ? 'text-red-600 font-medium'
                                : 'text-zinc-600'
                        }`}
                      >
                        {isUser ? item.label : isRunning ? `正在${item.label}` : item.label}
                      </span>
                      {dur && !isUser && (
                        <span className="text-[10px] text-zinc-400 font-mono flex-shrink-0">{dur}</span>
                      )}
                      {isRunning && (
                        <span className="h-1 w-1 rounded-full bg-blue-500 animate-pulse flex-shrink-0" />
                      )}
                    </div>
                    {item.detail && (
                      <p className="text-[11px] text-zinc-400 truncate mt-0.5 font-mono">{item.detail}</p>
                    )}
                  </div>

                  {hasRawDetail && !isUser && (
                    <ChevronDown
                      className={`h-3 w-3 text-zinc-300 flex-shrink-0 mt-1 transition-transform ${
                        isExpanded ? 'rotate-180' : ''
                      }`}
                    />
                  )}
                </button>

                {/* 展开的原始入参/出参（两种模式通用，叙述模式下也可点开核对） */}
                {isExpanded && (
                  <div className="mx-2 mb-1.5 mt-0.5 pl-6 space-y-1.5 text-[10px] font-mono animate-fadeIn">
                    {rawMode && st.tool && (
                      <p className="text-zinc-500">
                        工具: <span className="text-zinc-700 font-semibold">{st.tool}</span>
                      </p>
                    )}
                    {st.args && (
                      <div>
                        <span className="text-zinc-400 uppercase text-[9px]">输入 (Args)</span>
                        <pre className="mt-0.5 p-1.5 rounded bg-zinc-900 text-zinc-200 overflow-x-auto max-h-36">
                          {JSON.stringify(st.args, null, 2)}
                        </pre>
                      </div>
                    )}
                    {st.output && (
                      <div>
                        <span className="text-zinc-400 uppercase text-[9px]">输出 (Output)</span>
                        <pre className="mt-0.5 p-1.5 rounded bg-zinc-900 text-emerald-400 overflow-x-auto max-h-36 whitespace-pre-wrap">
                          {typeof st.output === 'string' ? st.output : JSON.stringify(st.output, null, 2)}
                        </pre>
                      </div>
                    )}
                    {!st.args && !st.output && st.tool && (
                      <p className="text-zinc-400 italic">无入参出参记录</p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      {/* 原始模式下的执行效率摘要（原中栏「查看执行详情」迁移至此） */}
      {rawMode && effNotes.length > 0 && (
        <div className="border-t border-zinc-100 px-4 py-2 space-y-0.5 flex-shrink-0">
          {effNotes.map((note, i) => (
            <p key={`eff_${i}`} className="text-[10px] font-mono text-zinc-400 leading-relaxed text-right">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
