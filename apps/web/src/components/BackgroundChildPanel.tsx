'use client';

import React from 'react';
import {
  Layers,
  Loader2,
  Check,
  AlertCircle,
  RotateCw,
  Wrench,
  Search,
  Globe,
  Code,
  ChevronRight,
} from 'lucide-react';
import type { Mission, MissionStep } from '../types/agent';
import { splitStepsIntoBlocks } from '../lib/cockpit-blocks';
import { narrateStep, formatActivityDuration } from '../lib/activity-narration';

/**
 * 后台子任务折叠面板(docs/design/background-child-missions.md §5):
 * 在父会话的 launch_background_task 工具行下方,用与主对话流【同一套】
 * splitStepsIntoBlocks + narrateStep 紧凑渲染子 mission 的执行过程 ——
 * 零新 API / 零新 SSE 事件:子 mission 本就随 mission_updated 广播进
 * missions 列表,按 childMissionId find 后 props 变化自然驱动 live 更新。
 */

/** launch_background_task 工具步骤的 output → childMissionId(容忍对象/JSON 串/裸文本三形态) */
export function extractChildMissionId(step: MissionStep): string | undefined {
  const raw = step.output as unknown;
  if (raw && typeof raw === 'object') {
    const id = (raw as Record<string, unknown>).childMissionId;
    if (typeof id === 'string' && id) return id;
  }
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.childMissionId === 'string' && parsed.childMissionId) {
        return parsed.childMissionId;
      }
    } catch {
      // 非 JSON:落到裸文本 mission id 兜底
    }
    const m = raw.match(/mission_[A-Za-z0-9_]+/);
    if (m) return m[0];
  }
  return undefined;
}

/** 子任务状态 chip 元数据(侧栏 chip / 工具行 chip / 面板头三处同源) */
export function childStatusMeta(child: Mission): {
  label: string;
  cls: string;
  icon: React.ReactNode;
} {
  if (child.status === 'ACTIVE') {
    return {
      label: '执行中',
      cls: 'text-blue-600',
      icon: <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />,
    };
  }
  if (child.status === 'DONE') {
    // 执行异常的 mission 也收敛为 DONE(agent-backend error 处理器),真实
    // 信号是 step_err_ 失败尾步 —— 数据判定,不靠状态字段猜测
    const failed = (child.steps || []).some((s) => s.id?.startsWith('step_err_'));
    if (failed) {
      return {
        label: '失败',
        cls: 'text-red-500',
        icon: <AlertCircle className="h-2.5 w-2.5 shrink-0" />,
      };
    }
    return {
      label: '已完成',
      cls: 'text-emerald-600',
      icon: <Check className="h-2.5 w-2.5 shrink-0" />,
    };
  }
  if (child.status === 'INTERRUPTED') {
    // 失败/中断/被级联停止都收敛在 INTERRUPTED(Mission.status 无 FAILED 态)
    return {
      label: '已中断',
      cls: 'text-amber-500',
      icon: <AlertCircle className="h-2.5 w-2.5 shrink-0" />,
    };
  }
  return {
    label: child.status === 'WAITING_APPROVAL' ? '待审批' : '等待中',
    cls: 'text-zinc-400',
    icon: <AlertCircle className="h-2.5 w-2.5 shrink-0" />,
  };
}

function rowIcon(step: MissionStep, kind: string) {
  if (step.status === 'FAILED') return <AlertCircle className="h-3 w-3 text-red-500" />;
  if (step.status === 'RUNNING') return <RotateCw className="h-3 w-3 text-blue-600 animate-spin" />;
  if (kind === 'search') return <Search className="h-3 w-3 text-blue-500" />;
  if (kind === 'browser') return <Globe className="h-3 w-3 text-indigo-500" />;
  if (kind === 'sandbox') return <Code className="h-3 w-3 text-amber-500" />;
  return <Wrench className="h-3 w-3 text-zinc-400" />;
}

export function BackgroundChildPanel({
  child,
  onOpenChild,
}: {
  /** 子 mission(从 missions 列表按 childMissionId find;可能尚未到达或已被历史上限挤出) */
  child?: Mission;
  /** 「打开完整子会话」逃生舱(复用 onSelectMission) */
  onOpenChild?: (childMissionId: string) => void;
}) {
  if (!child) {
    return (
      <div className="ml-6 mt-1 mb-1 rounded-lg border border-dashed border-zinc-200 px-3 py-2 text-[10px] text-zinc-400">
        子任务会话尚未同步到列表,或已被历史条数上限挤出 —— 完成时父会话仍会收到通知。
      </div>
    );
  }

  // 与主对话流同一套分块:工具块取真实动作行,回复块取最终答复文本,
  // 用户块(= 派发 goal 本身)不重复展示(父会话工具行 detail 已带标题)
  const { blocks } = splitStepsIntoBlocks(child.steps || []);
  const rows: MissionStep[] = [];
  let finalAnswer: string | undefined;
  for (const b of blocks) {
    if (b.type === 'tools') {
      rows.push(...b.steps.filter((s) => s.tool || s.status === 'FAILED'));
    } else if (b.type === 'assistant') {
      if (b.step.answer && (b.step.messageKind === 'final' || b.step.status === 'DONE')) {
        finalAnswer = b.step.answer;
      }
      if (b.step.status === 'RUNNING' || b.step.reasoning) rows.push(b.step);
    }
  }
  const status = childStatusMeta(child);

  return (
    <div className="ml-6 mt-1 mb-1 rounded-lg border border-zinc-200/80 bg-white/70 px-3 py-2 space-y-1.5">
      {/* 面板头:子任务标题 + 状态 chip + 完整会话入口 */}
      <div className="flex items-center gap-1.5 min-w-0">
        <Layers className="h-3 w-3 text-violet-500 shrink-0" />
        <span className="text-[10px] font-medium text-zinc-700 truncate">{child.title}</span>
        <span className={`flex items-center gap-0.5 text-[9px] font-mono shrink-0 ${status.cls}`}>
          {status.icon}
          {status.label}
        </span>
        {onOpenChild && (
          <button
            type="button"
            onClick={() => onOpenChild(child.id)}
            className="ml-auto flex items-center gap-0.5 text-[9px] text-zinc-400 hover:text-zinc-700 transition shrink-0"
            title="打开子任务完整会话(含全部步骤与回复)"
          >
            完整会话 <ChevronRight className="h-2.5 w-2.5" />
          </button>
        )}
      </div>

      {/* 执行过程紧凑时间线(narrateStep 与主对话流同源;无动作时给占位) */}
      {rows.length === 0 ? (
        <p className="text-[10px] text-zinc-400 pl-[18px]">
          {child.status === 'ACTIVE' ? '子任务启动中…' : '无可展示的执行步骤'}
        </p>
      ) : (
        <div className="space-y-1 pl-1">
          {rows.slice(-14).map((st) => {
            const narrated = narrateStep(st);
            if (!narrated) return null;
            const running = st.status === 'RUNNING';
            return (
              <div key={st.id} className="flex items-center gap-1.5 min-w-0">
                <span className="flex items-center justify-center h-4 w-4 shrink-0">{rowIcon(st, narrated.kind)}</span>
                <span
                  className={`text-[10px] font-medium truncate shrink-0 ${
                    st.status === 'FAILED' ? 'text-red-600' : 'text-zinc-600'
                  }`}
                >
                  {running ? `正在${narrated.label}` : narrated.label}
                </span>
                {narrated.detail && <span className="text-[9px] text-zinc-400 truncate">{narrated.detail}</span>}
                {!running && st.duration && (
                  <span className="ml-auto text-[8px] text-zinc-300 font-mono shrink-0">
                    {formatActivityDuration(st.duration)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 子任务最终答复摘录(通知卡 summary 的同源文本,面板内直接可回看) */}
      {finalAnswer && (
        <p className="text-[10px] text-zinc-500 leading-relaxed whitespace-pre-wrap break-words bg-zinc-50 rounded-md px-2 py-1.5 line-clamp-4">
          {finalAnswer}
        </p>
      )}
    </div>
  );
}
