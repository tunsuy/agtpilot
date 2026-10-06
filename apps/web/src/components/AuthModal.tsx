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
  QrCode,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Check,
  MessageSquare,
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
  const [authMethod, setAuthMethod] = useState<'social' | 'wechat_qr' | 'email'>('social');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configuredOAuth, setConfiguredOAuth] = useState<{
    github: boolean;
    google: boolean;
    apple: boolean;
    wechat: boolean;
  }>({ github: false, google: false, apple: false, wechat: false });
  const [unconfiguredNotice, setUnconfiguredNotice] = useState<'github' | 'google' | 'apple' | 'wechat' | null>(null);

  // 微信个人订阅号 6 位验证码轮询机制
  const [wechatCode, setWechatCode] = useState<string>('');
  const [wechatSecondsLeft, setWechatSecondsLeft] = useState<number>(300);
  const [copiedCode, setCopiedCode] = useState(false);
  const [mockVerifying, setMockVerifying] = useState(false);

  const fetchWechatCode = async () => {
    try {
      const res = await fetch('/api/wechat/code');
      const data = await res.json();
      if (data.code) {
        setWechatCode(data.code);
        setWechatSecondsLeft(300);
      }
    } catch (e) {
      console.error(e);
    }
  };

  React.useEffect(() => {
    fetch('/api/auth/configured')
      .then((res) => res.json())
      .then((data) => setConfiguredOAuth(data))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (authMethod === 'wechat_qr' && isOpen) {
      fetchWechatCode();
    }
  }, [authMethod, isOpen]);

  // 轮询核销状态与倒计时
  React.useEffect(() => {
    if (authMethod !== 'wechat_qr' || !wechatCode || !isOpen) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/wechat/code?code=${wechatCode}`);
        const data = await res.json();
        if (data.status === 'VERIFIED') {
          clearInterval(interval);
          await signIn('credentials', {
            socialProvider: 'wechat',
            socialName: data.user?.name || '微信订阅号用户',
            redirect: false,
          });
          onClose();
        }
      } catch (err) {
        console.error(err);
      }
    }, 1500);

    const countdown = setInterval(() => {
      setWechatSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => {
      clearInterval(interval);
      clearInterval(countdown);
    };
  }, [authMethod, wechatCode, isOpen]);

  const handleCopyCode = () => {
    if (!wechatCode) return;
    navigator.clipboard.writeText(wechatCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleMockWechatVerify = async () => {
    if (!wechatCode) return;
    setMockVerifying(true);
    try {
      await fetch('/api/wechat/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: wechatCode }),
      });
    } catch (e) {
      console.error(e);
    } finally {
      setMockVerifying(false);
    }
  };

  if (!isOpen) return null;

  const handleSocialLogin = async (
    provider: 'github' | 'google' | 'apple' | 'wechat',
    forceMock = false
  ) => {
    setError(null);
    setUnconfiguredNotice(null);
    setSocialLoading(provider);

    const isRealConfigured = configuredOAuth[provider];

    // 若配置了真实 Client ID/Secret，直接重定向至官方授权中心 (真实调用)
    if (isRealConfigured && !forceMock) {
      await signIn(provider);
      return;
    }

    // 若未配置真实凭证，且未显式选择沙盒体验，弹出真实配置提示
    if (!isRealConfigured && !forceMock) {
      setSocialLoading(null);
      setUnconfiguredNotice(provider);
      return;
    }

    try {
      // 本地开发者全功能联调沙盒体验
      const res = await signIn('credentials', {
        socialProvider: provider,
        redirect: false,
      });

      if (res?.error) {
        setError(`${provider} 认证未成功，请重试`);
      } else {
        onClose();
      }
    } catch (err: any) {
      setError(err.message || '认证失败');
    } finally {
      setSocialLoading(null);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
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
            {tab === 'login' ? '欢迎登录 AgtPilot' : '创建 AgtPilot 账户'}
          </h2>
          <p className="text-xs text-zinc-500">
            {tab === 'login'
              ? '支持国内外主流通行证一键登录与授权'
              : '注册以解锁全自主多模态 Agent 工作台'}
          </p>
        </div>

        {/* Error Feedback */}
        {error && (
          <div className="mb-4 p-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-600 text-center animate-shake">
            {error}
          </div>
        )}

        {/* 尚未配置 Client ID 时的真实指引卡片 */}
        {unconfiguredNotice && (
          <div className="mb-4 p-4 rounded-xl bg-amber-50/90 border border-amber-200 text-xs text-zinc-800 space-y-2.5 animate-fadeIn">
            <div className="flex items-start justify-between">
              <span className="font-semibold text-amber-900 flex items-center gap-1.5">
                <span>⚠️</span>
                <span>真实 {unconfiguredNotice.toUpperCase()} OAuth 接入指引</span>
              </span>
              <button
                type="button"
                onClick={() => setUnconfiguredNotice(null)}
                className="text-zinc-400 hover:text-zinc-700 text-xs"
              >
                ✕
              </button>
            </div>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              底层已接入官方真实的 NextAuth 认证提供商。要发起真实的官方登录跳转，需在本地 <code className="bg-amber-100/80 px-1 py-0.5 rounded font-mono text-[10px]">.env.local</code> 中配置对应的密钥并重启服务：
            </p>
            <div className="p-2 bg-white/90 rounded-lg border border-amber-200/60 font-mono text-[10px] text-zinc-700 space-y-0.5 select-all">
              <div>AUTH_{unconfiguredNotice.toUpperCase()}_ID=your_client_id</div>
              <div>AUTH_{unconfiguredNotice.toUpperCase()}_SECRET=your_client_secret</div>
            </div>
            <div className="pt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleSocialLogin(unconfiguredNotice, true)}
                className="flex-1 py-1.5 px-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white font-medium text-[11px] transition"
              >
                使用本地开发者联调会话 (Mock)
              </button>
            </div>
          </div>
        )}

        {/* 微信个人订阅号 扫码回复验证码模式 */}
        {authMethod === 'wechat_qr' ? (
          <div className="space-y-4 text-center animate-fadeIn">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100">
              <button
                type="button"
                onClick={() => setAuthMethod('social')}
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 transition"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>返回其他方式</span>
              </button>
              <span className="text-xs font-medium text-emerald-600 flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>微信订阅号通道已就绪</span>
              </span>
            </div>

            <div className="p-4 bg-zinc-50/80 rounded-2xl border border-zinc-200/80 space-y-3">
              {/* 二维码图片展示区 */}
              <div className="h-40 w-40 bg-white p-2 rounded-xl border border-zinc-200 shadow-2xs mx-auto flex flex-col items-center justify-center relative overflow-hidden group">
                <img
                  src="/wechat-qr.jpg"
                  alt="微信公众号二维码"
                  className="h-full w-full object-contain rounded-lg"
                />
              </div>

              {/* 6 位大字验证码卡片 */}
              <div className="bg-white p-3 rounded-xl border border-zinc-200/90 shadow-2xs space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span>在公众号对话框发送下方验证码：</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-zinc-400">
                      {Math.floor(wechatSecondsLeft / 60)}:
                      {(wechatSecondsLeft % 60).toString().padStart(2, '0')}
                    </span>
                    <button
                      type="button"
                      onClick={fetchWechatCode}
                      className="text-emerald-600 hover:text-emerald-700 font-medium"
                    >
                      刷新
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between bg-zinc-50 px-3 py-2 rounded-lg border border-zinc-200/80">
                  <span className="text-xl font-mono font-bold tracking-widest text-zinc-900 select-all">
                    {wechatCode || '839215'}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyCode}
                    className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900 bg-white px-2 py-1 rounded border border-zinc-200 transition shadow-2xs"
                  >
                    {copiedCode ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedCode ? '已复制' : '复制'}</span>
                  </button>
                </div>
              </div>

              {/* 操作说明三步走 */}
              <div className="text-left text-[11px] text-zinc-500 space-y-1.5 pt-1 font-sans">
                <p>1. 使用手机微信扫描上方二维码关注公众号；</p>
                <p>2. 在公众号后台发送 <code className="bg-zinc-200/70 px-1 py-0.5 rounded font-mono text-zinc-800 font-semibold">登录</code> 即可获取验证入口；</p>
                <p>3. 填入当前验证码 <code className="bg-emerald-100 text-emerald-800 px-1 py-0.5 rounded font-mono font-bold">{wechatCode || '839215'}</code> 完成确认，电脑端将自动登录。</p>
              </div>
            </div>
          </div>
        ) : (
          /* 主界面：支持国内外 OAuth 登录 + 邮箱表单 */
          <div className="space-y-4">
            {/* 海外 Google / GitHub / Apple + 国内 微信登录按钮组 */}
            <div className="space-y-2">
              {/* 1. Google 登录 */}
              <button
                type="button"
                onClick={() => handleSocialLogin('google')}
                disabled={Boolean(socialLoading)}
                className="w-full py-2.5 px-4 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-xs font-medium text-zinc-800 flex items-center justify-center gap-2.5 transition shadow-2xs group"
              >
                {socialLoading === 'google' ? (
                  <RotateCw className="h-4 w-4 animate-spin text-zinc-500" />
                ) : (
                  <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24Z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 10.03 0 12s.45 3.82 1.25 5.42l4.03-3.15Z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98Z"
                    />
                  </svg>
                )}
                <span>通过 Google 账号继续</span>
              </button>

              {/* 2. GitHub 登录 */}
              <button
                type="button"
                onClick={() => handleSocialLogin('github')}
                disabled={Boolean(socialLoading)}
                className="w-full py-2.5 px-4 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-xs font-medium text-zinc-800 flex items-center justify-center gap-2.5 transition shadow-2xs group"
              >
                {socialLoading === 'github' ? (
                  <RotateCw className="h-4 w-4 animate-spin text-zinc-500" />
                ) : (
                  <svg className="h-4 w-4 flex-shrink-0 fill-current text-zinc-900" viewBox="0 0 24 24">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
                  </svg>
                )}
                <span>通过 GitHub 账号继续</span>
              </button>

              <div className="grid grid-cols-2 gap-2">
                {/* 3. Apple 登录 */}
                <button
                  type="button"
                  onClick={() => handleSocialLogin('apple')}
                  disabled={Boolean(socialLoading)}
                  className="py-2.5 px-3 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-xs font-medium text-zinc-800 flex items-center justify-center gap-2 transition shadow-2xs group"
                >
                  {socialLoading === 'apple' ? (
                    <RotateCw className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                  ) : (
                    <svg className="h-3.5 w-3.5 flex-shrink-0 fill-current text-zinc-900" viewBox="0 0 24 24">
                      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.37c.62-.75 1.04-1.8 0.93-2.85-.9.04-1.98.6-2.62 1.35-.57.65-1.06 1.72-.93 2.74 1 .08 2-.49 2.62-1.24Z" />
                    </svg>
                  )}
                  <span>Apple 账号</span>
                </button>

                {/* 4. 微信登录 (国内最常用) */}
                <button
                  type="button"
                  onClick={() => setAuthMethod('wechat_qr')}
                  className="py-2.5 px-3 rounded-xl border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-50 text-xs font-medium text-emerald-800 flex items-center justify-center gap-2 transition shadow-2xs group"
                >
                  <svg className="h-3.5 w-3.5 flex-shrink-0 fill-current text-emerald-600" viewBox="0 0 24 24">
                    <path d="M8.69 2.5C3.89 2.5 0 5.86 0 10.01c0 2.26 1.15 4.3 2.97 5.67-.13.91-.77 3.32-.8 3.44-.06.27.1.34.27.24.23-.13 3.23-2.11 3.75-2.49.8.21 1.64.32 2.5.32.32 0 .64-.02.95-.05-.41-.98-.65-2.06-.65-3.19 0-4.66 4.33-8.45 9.69-8.45.18 0 .36 0 .54.02C17.78 4.67 13.56 2.5 8.69 2.5Zm10.05 6.95c-4.42 0-8.01 3.13-8.01 6.99 0 3.87 3.59 7 8.01 7 .74 0 1.45-.09 2.13-.27.42.31 2.89 1.94 3.08 2.05.14.08.27.02.22-.2-.02-.1-.54-2.09-.64-2.85 1.5-1.14 2.45-2.83 2.45-4.73 0-3.86-3.59-6.99-8.01-6.99ZM6.16 6.5c.67 0 1.21.54 1.21 1.21s-.54 1.21-1.21 1.21S4.95 8.38 4.95 7.71c0-.67.54-1.21 1.21-1.21Zm5.06 0c.67 0 1.21.54 1.21 1.21s-.54 1.21-1.21 1.21-1.21-.54-1.21-1.21.54-1.21 1.21-1.21Zm5.06 6.99c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1Zm4.17 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1Z" />
                  </svg>
                  <span>微信扫码登录</span>
                </button>
              </div>
            </div>

            {/* 一键体验 Demo 开发者账号 */}
            <button
              type="button"
              onClick={handleDemoLogin}
              disabled={loading || Boolean(socialLoading)}
              className="w-full py-2 px-3 rounded-xl border border-zinc-200 bg-zinc-50/70 hover:bg-zinc-100 hover:border-zinc-300 text-xs text-zinc-700 font-medium flex items-center justify-center gap-2 transition group shadow-2xs"
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-600 group-hover:scale-110 transition-transform" />
              <span>免密体验 Demo 开发者账号</span>
            </button>

            {/* Divider */}
            <div className="relative my-3 flex items-center justify-center">
              <div className="w-full border-t border-zinc-200" />
              <button
                type="button"
                onClick={() => setAuthMethod(authMethod === 'email' ? 'social' : 'email')}
                className="absolute bg-white px-3 text-[10px] text-zinc-400 hover:text-zinc-600 uppercase font-mono tracking-wider transition"
              >
                {authMethod === 'email' ? '收起邮箱表单 ▲' : '或者使用邮箱密码 ▼'}
              </button>
            </div>

            {/* 可展开的邮箱密码表单 (Email & Password Form) */}
            {authMethod === 'email' && (
              <form onSubmit={handleEmailSubmit} className="space-y-3 pt-1 animate-fadeIn">
                <div className="flex bg-zinc-100 p-1 rounded-xl mb-3">
                  <button
                    type="button"
                    onClick={() => setTab('login')}
                    className={`flex-1 py-1 rounded-lg text-xs font-medium transition ${
                      tab === 'login' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-600'
                    }`}
                  >
                    账号登录
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('register')}
                    className={`flex-1 py-1 rounded-lg text-xs font-medium transition ${
                      tab === 'register' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-600'
                    }`}
                  >
                    免费注册
                  </button>
                </div>

                {tab === 'register' && (
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-zinc-700 block">姓名 / 昵称</label>
                    <div className="relative">
                      <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
                      <input
                        type="text"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="例如：Marshal"
                        className="w-full pl-9 pr-3 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:border-zinc-400 transition"
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-700 block">电子邮箱</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@domain.com"
                      className="w-full pl-9 pr-3 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:border-zinc-400 transition"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-medium text-zinc-700 block">登录密码</label>
                    {tab === 'login' && (
                      <span className="text-[10px] text-zinc-400">支持任意模拟密码</span>
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
                      className="w-full pl-9 pr-9 py-2 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:border-zinc-400 transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                    >
                      {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
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
            )}
          </div>
        )}

        {/* Security badge */}
        <div className="mt-5 pt-3 border-t border-zinc-100 flex items-center justify-center gap-1.5 text-[10px] text-zinc-400">
          <ShieldCheck className="h-3 w-3 text-emerald-600" />
          <span>支持 Google、GitHub、Apple 与微信 OAuth 2.0 安全协议</span>
        </div>
      </div>
    </div>
  );
}
