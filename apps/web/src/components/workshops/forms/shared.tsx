/**
 * 工坊表单共享 UI:弹窗外壳(标题/说明/Prompt 预览/提交)、单选/多选 Chip 组、输入字段。
 * 各工坊表单只声明字段,视觉与交互节奏在这里统一。
 */
import React, { useEffect, useRef, useState } from 'react';
import { X, Sparkles, ShieldCheck, Eye, TriangleAlert, FileText, ChevronDown, Upload, Trash2 } from 'lucide-react';
import type { WorkshopDef, WorkshopAccent } from '../registry';
import type { MaterialOption } from '@/workshops/shared/materials';

// ---- 服务端覆盖标志(预览诚实) ----

/** 会话级缓存:多个弹窗共享一次 /api/workshops/overrides 请求 */
let overrideListPromise: Promise<string[]> | null = null;

function fetchOverriddenWorkshops(): Promise<string[]> {
  if (!overrideListPromise) {
    overrideListPromise = fetch('/api/workshops/overrides')
      .then((r) => (r.ok ? r.json() : { overridden: [] }))
      .then((j) => (Array.isArray(j?.overridden) ? j.overridden as string[] : []))
      .catch(() => []);
  }
  return overrideListPromise;
}

/** 该工坊在服务端是否存在覆盖版本(拿不到名单按无覆盖处理,不阻塞预览) */
function useServerWorkshopOverride(workshopId: string): boolean {
  const [overridden, setOverridden] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchOverriddenWorkshops().then((ids) => {
      if (alive) setOverridden(ids.includes(workshopId));
    });
    return () => {
      alive = false;
    };
  }, [workshopId]);
  return overridden;
}

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

/**
 * 参考资料选择器:把平时会话的交付物 + 本地上传文件勾选为本次工坊任务的背景资料。
 * 交付物与上传混排共享 maxCount 上限;上传条目带「上传」徽章与删除按钮。
 * uploadSection 传入即启用「本地上传」区(此时无交付物也不再整节隐藏 ——
 * 上传本身就是资料来源);不传则维持旧行为(无交付物整节隐藏)。
 */
export function DeliverablePicker({
  options,
  selectedIds,
  onToggle,
  maxCount,
  uploadSection,
}: {
  options: MaterialOption[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  maxCount: number;
  uploadSection?: {
    busy?: boolean;
    error?: string | null;
    /** 选完文件即上传(钩子内部串行处理并刷新列表);回调负责把新 id 自动勾选 */
    onUpload: (files: File[]) => void;
    onRemove: (id: string) => void;
    /** file input 的 accept(与 material-uploads 白名单一致,由调用方给出) */
    accept?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  if (options.length === 0 && !uploadSection) return null;
  const countHint =
    selectedIds.length > 0
      ? ` · 已选 ${selectedIds.length}`
      : uploadSection
        ? ' · 可选 · 交付物或本地上传'
        : ` · 会话交付物${options.length}份`;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-900 transition"
      >
        <span>
          参考资料
          <span className="ml-1.5 text-[10px] text-zinc-400 font-normal">可选{countHint}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 text-zinc-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="rounded-xl border border-zinc-200">
          {uploadSection && (
            <div className="px-3 py-2 border-b border-zinc-100">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={uploadSection.busy}
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-300 text-xs text-zinc-700 hover:bg-zinc-50 transition disabled:opacity-50"
                >
                  <Upload className="h-3 w-3" />
                  {uploadSection.busy ? '处理中…' : '上传本地文件'}
                </button>
                <span className="text-[10px] text-zinc-400">
                  文本/代码 ≤2MB · PDF/Word(.docx)≤20MB;上传后自动勾选,存你名下可跨任务复用
                </span>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept={uploadSection.accept}
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = ''; // 同名文件可重选
                    if (files.length > 0) uploadSection.onUpload(files);
                  }}
                />
              </div>
              {uploadSection.error && (
                <p className="mt-1.5 text-[10px] text-rose-600 break-all">{uploadSection.error}</p>
              )}
            </div>
          )}
          {options.length === 0 ? (
            <p className="px-3 py-3 text-[10px] text-zinc-400">
              还没有可选资料:平时会话的交付物会出现在这里,也可以直接上传本地文件。
            </p>
          ) : (
            <div className="max-h-44 overflow-y-auto divide-y divide-zinc-100">
              {options.map((o) => {
                const checked = selectedIds.includes(o.id);
                const disabled = !checked && selectedIds.length >= maxCount;
                const isUpload = o.id.startsWith('upl_');
                return (
                  <div
                    key={o.id}
                    className={`flex items-start gap-2 px-3 py-2 transition ${
                      disabled ? 'opacity-40' : 'hover:bg-zinc-50'
                    } ${checked ? 'bg-zinc-50' : ''}`}
                  >
                    <label className="flex items-start gap-2 cursor-pointer min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => onToggle(o.id)}
                        className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300"
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-xs text-zinc-800 font-medium truncate">
                          <FileText className="h-3 w-3 shrink-0 text-zinc-400" />
                          <span className="truncate">{o.title}</span>
                          {isUpload && (
                            <span className="shrink-0 px-1 py-px rounded bg-sky-50 text-sky-600 text-[9px] font-medium">
                              上传{o.type === 'pdf' ? ' · PDF' : o.type === 'docx' ? ' · Word' : ''}
                            </span>
                          )}
                        </span>
                        {o.missionTitle && o.missionTitle !== o.title && (
                          <span className="block text-[10px] text-zinc-400 truncate mt-0.5">
                            来自任务「{o.missionTitle}」
                          </span>
                        )}
                      </span>
                    </label>
                    {isUpload && uploadSection && (
                      <button
                        type="button"
                        title="删除该上传文件"
                        disabled={uploadSection.busy}
                        onClick={() => {
                          if (checked) onToggle(o.id); // 先取消勾选(删掉的资料不能再被引用)
                          uploadSection.onRemove(o.id);
                        }}
                        className="mt-0.5 p-1 rounded text-zinc-300 hover:text-rose-500 hover:bg-rose-50 transition disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
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
  const serverOverridden = useServerWorkshopOverride(def.id);
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
            <>
              {serverOverridden && (
                <p className="mx-3 mb-2 px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-[10px] leading-relaxed text-amber-700 flex items-start gap-1.5">
                  <TriangleAlert className="h-3.5 w-3.5 mt-px flex-shrink-0" />
                  服务端存在该工坊的覆盖版本,实际发送以服务端为准(下方预览为打包模板,仅供参考)。
                </p>
              )}
              <pre className="px-3 pb-3 text-[10px] leading-relaxed text-zinc-500 whitespace-pre-wrap break-all max-h-56 overflow-y-auto">
                {previewPrompt}
              </pre>
            </>
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
