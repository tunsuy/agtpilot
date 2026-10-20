'use client';

/**
 * IM 通道运维页(独立路由)。
 *
 * 主体逻辑与 UI 已抽到 components/ChannelPanel,与桌面端右上角「IM 通道」
 * 弹窗(ChannelModal)共享同一份实现;本页只保留整页外框与标题头。
 * 移动端「我的」列表仍链接到本路由。
 */
import { ChannelPanel } from '../../components/ChannelPanel';

export default function ChannelPage() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <header>
          <h1 className="text-xl font-bold">IM 通道</h1>
          <p className="text-sm text-zinc-500 mt-1">
            微信/QQ 直连你的 AgtPilot 智能体。绑定后在 IM 里发消息即可对话。
          </p>
        </header>
        <ChannelPanel />
      </div>
    </div>
  );
}
