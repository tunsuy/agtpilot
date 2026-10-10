/**
 * 工坊表单共享 UI:弹窗外壳(标题/说明/Prompt 预览/提交)、单选/多选 Chip 组、输入字段。
 * 各工坊表单只声明字段,视觉与交互节奏在这里统一。
 */
import React, { useState } from 'react';
import { X, Sparkles, ShieldCheck, Eye } from 'lucide-react';
import type { WorkshopDef, WorkshopAccent } from '../registry';

export interface AccentClasses {
  iconBg: string;
  chipActive: string;
  btn: string;
  dot: string;
  soft: string;
}

export const ACCENTS: Record<WorkshopAccent, AccentClasses> = {
  violet: {
    iconBg: 'bg-violet-100 text-violet-600',
    chipActive: 'bg-violet-600 text-white border-violet-600',
    btn: 'bg-violet-600 hover:bg-violet-700',
    dot: 'bg-violet-500',
    soft: 'bg-violet-50 text-violet-700 border-violet-200',
  },
  sky: {
    iconBg: 'bg-sky-100 text-sky-600',
    chipActive: 'bg-sky-600 text-white border-sky-600',
    btn: 'bg-sky-600 hover:bg-sky-700',
    dot: 'bg-sky-500',
    soft: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  emerald: {
    iconBg: 'bg-emerald-100 text-emerald-600',
    chipActive: 'bg-emerald-600 text-white border-emerald-600',
    btn: 'bg-emerald-600 hover:bg-emerald-700',
    dot: 'bg-emerald-500',
    soft: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  indigo: {
    iconBg: 'bg-indigo-100 text-indigo-600',
    chipActive: 'bg-indigo-600 text-white border-indigo-600',
    btn: 'bg-indigo-600 hover:bg-indigo-700',
    dot: 'bg-indigo-500',
    soft: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
};

/** 单选 Chip 组 */
export function ChipGroup<T extends string | number>({
  options,
  value,
  onChange,
  accent,
}: {
  options: Array<{ id: T; name: string }>;
  value: T;
  onChange: (v: T) => void;
  accent: WorkshopAccent;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          onClick={() => onChange(o.id)}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
            value === o.id
              ? ACCENTS[accent].chipActive
              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
          }`}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

/** 多选 Chip 组 */
export function MultiChipGroup({
  options,
  values,
  onToggle,
  accent,
}: {
  options: Array<{ id: string; name: string }>;
  values: string[];
  onToggle: (id: string) => void;
  accent: WorkshopAccent;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onToggle(o.id)}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
            values.includes(o.id)
              ? ACCENTS[accent].chipActive
              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
          }`}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

export function FieldLabel({ children, optional }: { children: React.ReactNode; optional?: boolean }) {
  return (
    <label className="text-xs font-medium text-zinc-700 block">
      {children}
      {optional && <span className="ml-1.5 text-[10px] text-zinc-400 font-normal">可选</span>}
    </label>
  );
}

export const inputClass =
  'w-full px-3 py-2 rounded-xl border border-zinc-300 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-500';
export const textareaClass = `${inputClass} resize-none`;

/**
 * 工坊弹窗外壳:标题/副标题/关闭、表单体、底部安全说明 + 可折叠 Prompt 预览 + 提交按钮。
 * 表单体与提交动作由各工坊表单提供;预览文案每次渲染实时构建,所见即所发。
 */
export function WorkshopModalShell({
  def,
  onClose,
  onSubmit,
  submitLabel,
  previewPrompt,
  children,
}: {
  def: WorkshopDef;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  /** 当前表单状态实时生成的 Prompt(buildWorkshopRun().prompt) */
  previewPrompt: string;
  children: React.ReactNode;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const Icon = def.icon;
  const accent = ACCENTS[def.accent];

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl animate-fadeIn space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={`h-9 w-9 rounded-xl flex items-center justify-center shadow-2xs ${accent.iconBg}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">{def.name}</h3>
              <p className="text-xs text-zinc-500 mt-0.5 max-w-sm leading-relaxed">{def.desc}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">{children}</div>

        <p className="text-[11px] text-zinc-400 leading-relaxed flex items-start gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 mt-px flex-shrink-0" />
          {def.note}
        </p>

        {/* Prompt 预览:高级功能(默认折叠)——把将要发给 Agent 的任务描述摊开给需要核对的用户 */}
        <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 transition"
          >
            <Eye className="h-3.5 w-3.5" />
            <span>{showPreview ? '收起任务预览' : '高级 · 查看将发给 Agent 的任务描述'}</span>
          </button>
          {showPreview && (
            <pre className="px-3 pb-3 text-[10px] leading-relaxed text-zinc-500 whitespace-pre-wrap break-all max-h-56 overflow-y-auto">
              {previewPrompt}
            </pre>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-white text-xs font-medium transition shadow-xs ${accent.btn}`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>{submitLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
