'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import {
  User as UserIcon,
  LogOut,
  Settings,
  Key,
  Shield,
  Zap,
  ChevronDown,
  Sparkles,
} from 'lucide-react';

interface UserMenuProps {
  onOpenAuth: (tab: 'login' | 'register') => void;
}

export function UserMenu({ onOpenAuth }: UserMenuProps) {
  const { data: session, status } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (status === 'loading') {
    return <div className="h-7 w-16 bg-zinc-100 animate-pulse rounded-xl" />;
  }

  const user = session?.user;

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => onOpenAuth('login')}
          className="px-3 py-1.5 rounded-xl text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 transition"
        >
          登录
        </button>
        <button
          onClick={() => onOpenAuth('register')}
          className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-zinc-900 hover:bg-zinc-800 text-white shadow-xs transition"
        >
          注册
        </button>
      </div>
    );
  }

  const userTier = (user as any).tier || 'Pro';
  const tokensUsed = (user as any).tokensUsed ?? 42800;
  const tokensLimit = (user as any).tokensLimit ?? 200000;
  const quotaPercent = Math.min(
    100,
    Math.round((tokensUsed / (tokensLimit || 1)) * 100)
  );

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 p-1 pl-1.5 pr-2 rounded-full border border-zinc-200 bg-white hover:bg-zinc-50 transition shadow-2xs group"
      >
        {user.image ? (
          <img
            src={user.image}
            alt={user.name || 'User'}
            className="h-6 w-6 rounded-full object-cover border border-zinc-200"
          />
        ) : (
          <div className="h-6 w-6 rounded-full bg-zinc-900 text-white flex items-center justify-center font-bold text-[11px]">
            {(user.name || user.email || 'U').charAt(0).toUpperCase()}
          </div>
        )}
        <span className="text-xs font-medium text-zinc-800 max-w-[80px] truncate">
          {user.name || user.email?.split('@')[0]}
        </span>
        <ChevronDown className="h-3 w-3 text-zinc-400 group-hover:text-zinc-600 transition" />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 rounded-2xl bg-white border border-zinc-200 shadow-xl p-3 z-50 animate-fadeIn space-y-3">
          {/* User Info */}
          <div className="p-2 border-b border-zinc-100 pb-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-900 truncate">
                {user.name || 'AgtPilot User'}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-zinc-100 text-zinc-700 border border-zinc-200">
                {userTier} Plan
              </span>
            </div>
            <p className="text-[11px] text-zinc-400 truncate mt-0.5">{user.email}</p>
          </div>

          {/* Token Usage Bar */}
          <div className="p-2 bg-zinc-50/80 rounded-xl space-y-1.5 border border-zinc-100">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-zinc-500 flex items-center gap-1">
                <Zap className="h-3 w-3 text-amber-500" />
                算力额度
              </span>
              <span className="font-mono text-zinc-700 font-medium">
                {quotaPercent}%
              </span>
            </div>
            <div className="w-full bg-zinc-200 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-zinc-800 h-full rounded-full transition-all"
                style={{ width: `${quotaPercent}%` }}
              />
            </div>
            <p className="text-[10px] text-zinc-400 font-mono">
              {tokensUsed.toLocaleString()} / {tokensLimit.toLocaleString()} Tokens
            </p>
          </div>

          {/* Quick Menu Items */}
          <div className="space-y-0.5 text-xs text-zinc-700">
            <button
              onClick={() => setIsOpen(false)}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-zinc-100 transition text-left"
            >
              <Settings className="h-3.5 w-3.5 text-zinc-400" />
              <span>偏好与设置</span>
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-zinc-100 transition text-left"
            >
              <Key className="h-3.5 w-3.5 text-zinc-400" />
              <span>API 访问令牌</span>
            </button>
          </div>

          {/* Logout */}
          <div className="pt-2 border-t border-zinc-100">
            <button
              onClick={async () => {
                setIsOpen(false);
                try {
                  await fetch('/api/agent/stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                  });
                } catch (e) {
                  console.error('Failed to stop missions on logout:', e);
                }
                signOut({ redirect: false });
              }}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-red-50 text-red-600 transition text-xs text-left"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>退出登录</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
