'use client';

import React from 'react';
import { Home, Package, Activity, User } from 'lucide-react';

export type MobileTab = 'home' | 'deliverables' | 'activity' | 'profile';

interface MobileTabBarProps {
  activeTab: MobileTab;
  onChange: (tab: MobileTab) => void;
  /** 待审批数量，显示在"动态"角标上 */
  approvalCount?: number;
  /** 有任务正在执行时，"首页"上显示呼吸点 */
  hasActiveMission?: boolean;
}

const TABS: Array<{ key: MobileTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'home', label: '首页', icon: Home },
  { key: 'deliverables', label: '交付物', icon: Package },
  { key: 'activity', label: '动态', icon: Activity },
  { key: 'profile', label: '我的', icon: User },
];

/**
 * 移动端底部导航栏（原生 App 风格）。
 * - 固定底部、毛玻璃背景、适配 iOS 安全区（viewport-fit=cover 时生效）
 * - 角标：动态 tab 显示待审批数量；首页 tab 显示执行中呼吸点
 */
export function MobileTabBar({ activeTab, onChange, approvalCount = 0, hasActiveMission = false }: MobileTabBarProps) {
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-50 bg-white/92 backdrop-blur-lg border-t border-zinc-200/70 select-none"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="h-14 flex items-stretch">
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = activeTab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors active:bg-zinc-100/60 ${
                active ? 'text-zinc-900' : 'text-zinc-400'
              }`}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
            >
              <span className="relative">
                <Icon className={`h-[22px] w-[22px] ${active ? 'stroke-[2.4px]' : 'stroke-[1.8px]'}`} />
                {key === 'activity' && approvalCount > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-4 text-center">
                    {approvalCount > 99 ? '99+' : approvalCount}
                  </span>
                )}
                {key === 'home' && hasActiveMission && (
                  <span className="absolute -top-0.5 -right-1.5 h-2 w-2 rounded-full bg-blue-600 animate-pulse" />
                )}
              </span>
              <span className={`text-[10px] leading-none ${active ? 'font-semibold' : 'font-normal'}`}>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
