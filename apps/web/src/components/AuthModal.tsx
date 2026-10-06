'use client';

import React, { useState } from 'react';
import { signIn } from 'next-auth/react';
import {
  X,
  Sparkles,
  Lock,
  Mail,
  User as UserIcon,
  Eye,
  EyeOff,
  RotateCw,
  ArrowRight,
  ShieldCheck,
  Github,
} from 'lucide-react';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'login' | 'register';
}

export function AuthModal({
  isOpen,
  onClose,
  initialTab = 'login',
}: AuthModalProps) {
  const [tab, setTab] = useState<'login' | 'register'>(initialTab);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await signIn('credentials', {
        email: email.trim(),
        password,
        name: tab === 'register' ? name.trim() : undefined,
        redirect: false,
      });

      if (res?.error) {
        setError('登录失败：邮箱或密码错误');
      } else {
        onClose();
      }
    } catch (err: any) {
      setError(err.message || '操作失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDemoLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await signIn('credentials', {
        isDemo: 'true',
        redirect: false,
      });

      if (res?.error) {
        setError('Demo 快速登录失败');
      } else {
        onClose();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fadeIn">
      <div
        className="relative w-full max-w-md rounded-2xl bg-white border border-zinc-200 shadow-2xl p-6 md:p-8 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Modal Header */}
        <div className="space-y-1.5 text-center mb-6">
          <div className="inline-flex h-9 w-9 rounded-xl bg-zinc-950 text-white items-center justify-center font-bold text-sm tracking-tight mb-2 shadow-sm">
            P
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-zinc-900">
            {tab === 'login' ? '欢迎回到 AgtPilot' : '创建 AgtPilot 账户'}
          </h2>
          <p className="text-xs text-zinc-500">
            {tab === 'login'
              ? '登录您的自主数字员工工作空间'
              : '注册以解锁全自主多模态 Agent 工作台'}
          </p>
        </div>

        {/* Tabs Switcher */}
        <div className="flex bg-zinc-100 p-1 rounded-xl mb-5">
          <button
            type="button"
            onClick={() => {
              setTab('login');
              setError(null);
            }}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition ${
              tab === 'login'
                ? 'bg-white text-zinc-900 shadow-2xs font-semibold'
                : 'text-zinc-600 hover:text-zinc-900'
            }`}
          >
            账号登录
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('register');
              setError(null);
            }}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition ${
              tab === 'register'
                ? 'bg-white text-zinc-900 shadow-2xs font-semibold'
                : 'text-zinc-600 hover:text-zinc-900'
            }`}
          >
            免费注册
          </button>
        </div>

        {/* One-Click Demo Login */}
        <button
          type="button"
          onClick={handleDemoLogin}
          disabled={loading}
          className="w-full mb-4 py-2 px-3 rounded-xl border border-zinc-200/90 bg-zinc-50/70 hover:bg-zinc-100 hover:border-zinc-300 text-xs text-zinc-800 font-medium flex items-center justify-center gap-2 transition group shadow-2xs"
        >
          <Sparkles className="h-3.5 w-3.5 text-amber-600 group-hover:scale-110 transition-transform" />
          <span>一键体验 Demo 开发者账号（无需密码）</span>
        </button>

        {/* Divider */}
        <div className="relative my-4 flex items-center justify-center">
          <div className="w-full border-t border-zinc-200" />
          <span className="absolute bg-white px-3 text-[10px] text-zinc-400 uppercase font-mono tracking-wider">
            或者使用邮箱
          </span>
        </div>

        {/* Error Feedback */}
        {error && (
          <div className="mb-4 p-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-600 text-center animate-shake">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5">
          {tab === 'register' && (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-zinc-700 block">
                姓名 / 昵称
              </label>
              <div className="relative">
                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：Alex Chen"
                  className="w-full pl-9 pr-3 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition"
                />
              </div>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-zinc-700 block">
              电子邮箱
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@domain.com"
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition"
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-zinc-700 block">
                登录密码
              </label>
              {tab === 'login' && (
                <button
                  type="button"
                  onClick={() => setError('请直接点击上方一键体验 Demo 账号')}
                  className="text-[10px] text-zinc-400 hover:text-zinc-600"
                >
                  忘记密码？
                </button>
              )}
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-9 pr-9 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
              >
                {showPassword ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium flex items-center justify-center gap-2 transition shadow-xs active:scale-98"
          >
            {loading ? (
              <RotateCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <span>{tab === 'login' ? '登 录' : '立即注册'}</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </>
            )}
          </button>
        </form>

        {/* Security badge */}
        <div className="mt-5 pt-3 border-t border-zinc-100 flex items-center justify-center gap-1.5 text-[10px] text-zinc-400">
          <ShieldCheck className="h-3 w-3 text-emerald-600" />
          <span>采用 NextAuth (Auth.js) 工业级会话与加密标准</span>
        </div>
      </div>
    </div>
  );
}
