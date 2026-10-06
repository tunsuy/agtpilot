'use client';

import React, { useState } from 'react';
import { CheckCircle2, ShieldCheck, ArrowRight, Loader2 } from 'lucide-react';

export default function WeChatAuthPage() {
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || code.trim().length !== 6) {
      setErrorMsg('请输入电脑屏幕上显示的 6 位数字验证码');
      return;
    }

    setStatus('loading');
    setErrorMsg('');

    try {
      const res = await fetch('/api/wechat/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          nickname: nickname.trim() || undefined,
          mockOpenid: `wx_${nickname.trim() || 'mobile_user'}_${Math.floor(1000 + Math.random() * 9000)}`,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setStatus('error');
        setErrorMsg(data.error || '验证码无效或已过期，请核对电脑屏幕');
      } else {
        setStatus('success');
      }
    } catch (err: any) {
      setStatus('error');
      setErrorMsg(err.message || '网络请求失败，请稍后重试');
    }
  };

  return (
    <div className="min-h-screen bg-[#fbfbfd] flex flex-col justify-between p-6 antialiased font-sans">
      <div className="max-w-md w-full mx-auto my-auto py-8">
        {/* Brand Header */}
        <div className="text-center mb-8">
          <div className="inline-flex h-12 w-12 rounded-2xl bg-zinc-950 text-white items-center justify-center font-bold text-xl tracking-tight shadow-md mb-3">
            P
          </div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-900">
            AgtPilot 微信网页授权
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            快速确认并将你的微信账号与电脑工作台绑定
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-zinc-200/90 shadow-xl p-6 md:p-8">
          {status === 'success' ? (
            <div className="text-center py-6 space-y-4 animate-fadeIn">
              <div className="h-14 w-14 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto border border-emerald-100">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-zinc-900">
                  授权确认成功！
                </h3>
                <p className="text-xs text-zinc-500">
                  电脑浏览器现在已自动完成登录，你可以关闭当前手机网页。
                </p>
              </div>
            </div>
          ) : (
            <form onSubmit={handleConfirm} className="space-y-5">
              {errorMsg && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-600 text-center animate-shake">
                  {errorMsg}
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-800 block">
                  电脑屏幕上的 6 位验证码
                </label>
                <input
                  type="text"
                  maxLength={6}
                  required
                  autoFocus
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="例如：839201"
                  className="w-full text-center tracking-[0.3em] font-mono text-2xl py-3 px-4 rounded-xl border border-zinc-200 bg-zinc-50/60 focus:bg-white focus:outline-none focus:border-zinc-500 transition font-bold text-zinc-900"
                />
                <p className="text-[11px] text-zinc-400">
                  请查看电脑屏幕登录弹窗中展示的 6 位数字验证码
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-700 block">
                  设置您的昵称 (选填)
                </label>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="例如：微信用户"
                  className="w-full py-2.5 px-3.5 rounded-xl border border-zinc-200 bg-white text-xs text-zinc-900 focus:outline-none focus:border-zinc-400 transition"
                />
              </div>

              <button
                type="submit"
                disabled={status === 'loading' || code.length !== 6}
                className="w-full py-3 rounded-xl bg-zinc-950 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-medium flex items-center justify-center gap-2 transition shadow-sm active:scale-98"
              >
                {status === 'loading' ? (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                ) : (
                  <>
                    <span>确认授权并在电脑端登录</span>
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="text-center py-4 text-[11px] text-zinc-400 flex items-center justify-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
        <span>AgtPilot 个人订阅号安全确认协议</span>
      </div>
    </div>
  );
}
