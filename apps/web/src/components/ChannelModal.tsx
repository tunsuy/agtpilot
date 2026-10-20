'use client';

import React from 'react';
import { Unplug, X } from 'lucide-react';
import { ChannelPanel } from './ChannelPanel';

interface ChannelModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * IM 通道弹窗 —— 与「下载移动版」(DownloadAppModal)一致的弹窗形态。
 * 桌面端右上角「IM 通道」按钮唤起,不再整页跳转 /channel。
 * 主体复用 ChannelPanel;关闭即卸载面板,扫码轮询随 useEffect 清理自动停止。
 */
export function ChannelModal({ isOpen, onClose }: ChannelModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fadeIn">
      <div
        className="w-full max-w-lg max-h-[85vh] rounded-2xl bg-white border border-zinc-200/90 shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="p-5 pb-4 border-b border-zinc-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-zinc-950 text-white flex items-center justify-center shadow-xs">
              <Unplug className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">IM 通道</h3>
              <p className="text-[11px] text-zinc-500">
                微信/QQ 直连你的 AgtPilot 智能体,绑定后在 IM 里发消息即可对话
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Body(复用运维面板主体) */}
        <div className="p-5 overflow-y-auto">
          <ChannelPanel />
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-zinc-100 bg-zinc-50/80 flex items-center justify-end flex-shrink-0">
          <button onClick={onClose} className="text-[11px] text-zinc-600 hover:text-zinc-900 font-medium">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
