'use client';

/**
 * 通用确认弹窗(替代原生 window.confirm —— 后者样式各浏览器不一、
 * 移动端体验差)。结构与 ConnectorsView 风险明示弹窗同款。
 */
import { AlertTriangle } from 'lucide-react';

export function ConfirmModal({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  /** 危险操作(终止/吊销):图标与确认键转玫红 */
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  /** 支持换行(whitespace-pre-line),原生 confirm 的 \n 语义保留 */
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-fadeIn" onClick={busy ? undefined : onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
          <AlertTriangle className={`h-4 w-4 flex-shrink-0 ${danger ? 'text-rose-500' : 'text-amber-500'}`} />
          {title}
        </h3>
        <p className="text-xs text-zinc-600 leading-relaxed whitespace-pre-line">{message}</p>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`px-4 py-1.5 rounded-lg text-white text-xs font-medium transition shadow-xs disabled:opacity-50 ${
              danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-zinc-900 hover:bg-zinc-800'
            }`}
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
