'use client';

/**
 * 移动端对话态固定输入框(写路径):对当前会话(含 DONE 历史)续聊。
 *
 * 只在对话态渲染(动态态的回复入口已由问题卡/审批/选题卡承担,避免双
 * 路径)。定位:fixed 坐在 MobileTabBar 之上(tab bar 总高 3.5rem +
 * safe-area,z-40 < tab bar 的 z-50);Enter 发送 / Shift+Enter 换行 /
 * IME 组词回车不误发,textarea 随内容自增高。发送必须显式传 mission.id
 * —— 回退场景 activeMissionId 可能为 null,undefined 会被 handleRun
 * 回落逻辑误开新会话。
 */
import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Square } from 'lucide-react';
import type { Mission } from '../../types/agent';
import { SkillPackPicker } from '../SkillPackPicker';

interface MobileChatComposerProps {
  mission: Mission;
  /** 发送防重入(page.tsx isSubmitting) */
  isSubmitting: boolean;
  /** 发送:prompt + 显式 mission.id(续聊当前会话,绝不回落新会话)+ 显式技能包引用 */
  onRunMission: (
    prompt: string,
    title?: string,
    missionId?: string,
    workshop?: any,
    skillPacks?: string[]
  ) => void;
  /** 停止执行中任务(mission 未终态时显示停止钮) */
  onStopMission?: (missionId: string) => void;
}

export function MobileChatComposer({
  mission,
  isSubmitting,
  onRunMission,
  onStopMission,
}: MobileChatComposerProps) {
  const [draft, setDraft] = useState('');
  const [selectedPacks, setSelectedPacks] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 有 prefill 宿主:切换会话时从任务记录预填引用;SSE 更新(mission 对象
  // 变化但 id 不变)不重填,不打断用户正在进行的编辑
  useEffect(() => {
    setSelectedPacks(mission.skillPacks || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission.id]);

  // 输入框随内容自动长高(多行自适应,上限后内部滚动)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || isSubmitting) return;
    // 显式传 mission.id:回退会话(activeMissionId 为 null)也能续对,
    // undefined 会被 handleRun 回落逻辑误开新会话。发送后不收键盘
    // (继续跟进流式输出,不打断输入节奏)。
    // 技能包总是显式发送(prefill 宿主 WYSIWYG:[]=清空继承值)
    onRunMission(draft.trim(), undefined, mission.id, undefined, selectedPacks);
    setDraft('');
  };

  /** 多行输入:Enter 发送、Shift+Enter 换行;中文输入法组词期间的回车不触发发送 */
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(e);
    }
  };

  return (
    <div
      className="fixed inset-x-0 z-40 bg-white/95 backdrop-blur border-t border-zinc-200/80"
      style={{ bottom: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <form onSubmit={submit} className="mx-auto max-w-lg px-3 py-2.5 flex items-end gap-2">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleInputKeyDown}
          enterKeyHint="send"
          placeholder="继续这个会话…"
          className="flex-1 resize-none bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-400 focus:bg-white leading-relaxed max-h-[140px] overflow-y-auto"
        />
        <div className="flex items-center gap-1.5 flex-shrink-0 pb-0.5">
          <SkillPackPicker
            selected={selectedPacks}
            onChange={setSelectedPacks}
            variant="sheet"
            compact
          />
          {/* 执行中停止键常驻(桌面同口径:status !== 'DONE' 显示) */}
          {mission.status !== 'DONE' && onStopMission && (
            <button
              type="button"
              onClick={() => onStopMission(mission.id)}
              className="h-9 w-9 rounded-full bg-red-50 text-red-600 border border-red-200 flex items-center justify-center active:bg-red-100 transition"
              title="终止执行当前任务"
            >
              <Square className="h-3.5 w-3.5 fill-red-600" />
            </button>
          )}
          <button
            type="submit"
            disabled={!draft.trim() || isSubmitting}
            className="h-9 w-9 rounded-full bg-zinc-900 text-white flex items-center justify-center disabled:opacity-20 active:bg-zinc-700 transition shadow-2xs"
            title="发送 (Enter)"
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
