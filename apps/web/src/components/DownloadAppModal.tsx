'use client';

import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import {
  Smartphone,
  QrCode,
  Check,
  Copy,
  X,
  Apple,
  Share2,
  Zap,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { copyToClipboard } from '../utils/nativeBridge';

interface DownloadAppModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DownloadAppModal({ isOpen, onClose }: DownloadAppModalProps) {
  const [activeTab, setActiveTab] = useState<'qrcode' | 'android' | 'ios' | 'pwa'>('qrcode');
  const [copiedLink, setCopiedLink] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://agtpilot.app';

  // 动态生成二维码（指向当前网站域名/局域网IP，手机扫码即可直接直达）
  useEffect(() => {
    if (isOpen) {
      QRCode.toDataURL(currentOrigin, {
        width: 220,
        margin: 1,
        color: {
          dark: '#18181b', // zinc-900
          light: '#ffffff',
        },
      })
        .then((url: string) => setQrDataUrl(url))
        .catch((err: Error) => console.error('Failed to generate QR code:', err));
    }
  }, [isOpen, currentOrigin]);

  if (!isOpen) return null;

  const handleCopyLink = async () => {
    await copyToClipboard(currentOrigin);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fadeIn">
      <div
        className="w-full max-w-lg rounded-2xl bg-white border border-zinc-200/90 shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="p-5 pb-4 border-b border-zinc-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-zinc-950 text-white flex items-center justify-center shadow-xs">
              <Smartphone className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">
                获取 AgtPilot 移动端
              </h3>
              <p className="text-[11px] text-zinc-500">
                在手机上直接唤起已登录 App，免密直通与原生系统分享
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

        {/* Platform Selector Tabs */}
        <div className="px-5 pt-3 border-b border-zinc-100 flex items-center gap-2 bg-zinc-50/50 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('qrcode')}
            className={`pb-2.5 text-xs font-medium border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'qrcode'
                ? 'border-zinc-900 text-zinc-900 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <QrCode className="h-3.5 w-3.5 text-rose-500" />
            <span>手机扫码获取</span>
          </button>
          <button
            onClick={() => setActiveTab('android')}
            className={`pb-2.5 text-xs font-medium border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'android'
                ? 'border-zinc-900 text-zinc-900 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <Smartphone className="h-3.5 w-3.5 text-emerald-600" />
            <span>Android 安装包</span>
          </button>
          <button
            onClick={() => setActiveTab('ios')}
            className={`pb-2.5 text-xs font-medium border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'ios'
                ? 'border-zinc-900 text-zinc-900 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <Apple className="h-3.5 w-3.5 text-zinc-900" />
            <span>iOS 苹果版</span>
          </button>
          <button
            onClick={() => setActiveTab('pwa')}
            className={`pb-2.5 text-xs font-medium border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'pwa'
                ? 'border-zinc-900 text-zinc-900 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <Zap className="h-3.5 w-3.5 text-amber-500" />
            <span>免安装直用</span>
          </button>
        </div>

        {/* Tab Contents */}
        <div className="p-5 space-y-4">
          {/* 扫码获取专属 Tab（默认首屏） */}
          {activeTab === 'qrcode' && (
            <div className="flex flex-col items-center text-center space-y-4 py-2">
              <div className="relative p-3.5 rounded-2xl bg-white border border-zinc-200 shadow-sm flex items-center justify-center">
                {qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={qrDataUrl}
                    alt="Scan to access AgtPilot Mobile"
                    className="h-44 w-44 rounded-lg object-contain"
                  />
                ) : (
                  <div className="h-44 w-44 flex items-center justify-center text-zinc-400">
                    <RefreshCw className="h-6 w-6 animate-spin" />
                  </div>
                )}
                {/* 中心 Logo 浮标 */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="h-10 w-10 rounded-xl bg-zinc-950 border-2 border-white shadow-md overflow-hidden flex items-center justify-center p-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/logo.svg"
                      alt="AgtPilot Logo"
                      className="h-full w-full object-contain"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-1 max-w-sm">
                <h4 className="text-xs font-semibold text-zinc-900">
                  使用手机微信 / 相机 / 浏览器扫一扫
                </h4>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  扫码即可在手机端直接打开，登录后与电脑端目标、记忆、任务实时双向同步。
                </p>
              </div>

              <div className="w-full flex items-center justify-between p-2.5 rounded-xl bg-zinc-50 border border-zinc-200 text-left">
                <span className="text-[11px] font-mono text-zinc-500 truncate mr-2">
                  {currentOrigin}
                </span>
                <button
                  onClick={handleCopyLink}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white text-[11px] font-medium transition shadow-2xs flex-shrink-0"
                >
                  {copiedLink ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedLink ? '已复制' : '复制网址'}</span>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'android' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl border border-zinc-200/80 bg-zinc-50 flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-xl bg-white border border-zinc-200 shadow-2xs flex items-center justify-center flex-shrink-0 text-emerald-600">
                  <Smartphone className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-zinc-900">
                      Android 安装方式
                    </span>
                    <span className="text-[10px] font-mono text-zinc-400">
                      PWA 已支持
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    在 Chrome / Edge 中打开本站，菜单中选择<strong>“添加到主屏幕 / 安装应用”</strong>，
                    即获得带独立图标、全屏运行、支持推送通知的 App 体验。独立 APK 安装包在规划中，发布后此处提供下载。
                  </p>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-zinc-50 border border-zinc-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-800">
                    Chrome 安装步骤
                  </span>
                  <span className="text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                    约 10 秒
                  </span>
                </div>
                <ol className="text-[11px] text-zinc-500 leading-relaxed list-decimal pl-4 space-y-0.5">
                  <li>用手机 Chrome 打开 {currentOrigin.replace(/^https?:\/\//, '')}</li>
                  <li>点右上角  菜单 → “添加到主屏幕”或“安装应用”</li>
                  <li>从桌面图标打开 → 我的 → 消息通知 → 开启推送</li>
                </ol>
              </div>

              {/* 核心亮点 */}
              <div className="pt-2 border-t border-zinc-100 grid grid-cols-2 gap-2 text-[11px] text-zinc-600">
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                  <span>与网页端账号数据实时同步</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Share2 className="h-3.5 w-3.5 text-blue-500" />
                  <span>系统分享面板直达微信/小红书</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'ios' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl border border-zinc-200/80 bg-zinc-50 flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-xl bg-white border border-zinc-200 shadow-2xs flex items-center justify-center flex-shrink-0 text-zinc-900">
                  <Apple className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-zinc-900">
                      iPhone / iPad 安装方式
                    </span>
                    <span className="text-[10px] font-mono text-zinc-400">
                      PWA 已支持
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    通过 Safari 添加到主屏幕，全屏沉浸式运行，iOS 16.4+ 支持锁屏推送通知。无需 App Store、无需开发者账号。
                  </p>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-zinc-50 border border-zinc-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-800">
                    Safari 添加到主屏幕步骤
                  </span>
                  <span className="text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                    约 10 秒
                  </span>
                </div>
                <ol className="text-[11px] text-zinc-500 leading-relaxed list-decimal pl-4 space-y-0.5">
                  <li>用 <strong>Safari</strong> 打开 {currentOrigin.replace(/^https?:\/\//, '')}（微信内打开需先点 ⋯ → 在 Safari 中打开）</li>
                  <li>点底部中间的分享按钮（方框带向上箭头）</li>
                  <li>下滑选择<strong>“添加到主屏幕”</strong> → 右上角“添加”</li>
                  <li>从桌面 AgtPilot 图标打开 → 我的 → 消息通知 → 开启推送</li>
                </ol>
                <p className="text-[10px] text-amber-600 leading-relaxed">
                  注意：iOS 的推送通知只在从主屏幕图标打开时才可用（苹果系统限制）。
                </p>
              </div>
            </div>
          )}

          {activeTab === 'pwa' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl border border-zinc-200/80 bg-amber-50/30 border-amber-200/60 flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-xl bg-white border border-amber-200 shadow-2xs flex items-center justify-center flex-shrink-0 text-amber-600">
                  <Zap className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <span className="text-xs font-semibold text-zinc-900">
                    手机浏览器免安装即用
                  </span>
                  <p className="text-[11px] text-zinc-600 leading-relaxed">
                    在任意手机浏览器中访问当前网址，点击菜单选择“添加到主屏幕”，即可像原生 App 一样常驻桌面使用！
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 border border-zinc-200">
                <span className="text-xs font-mono text-zinc-600 truncate mr-2">
                  {currentOrigin}
                </span>
                <button
                  onClick={handleCopyLink}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium transition shadow-2xs flex-shrink-0"
                >
                  {copiedLink ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedLink ? '已复制' : '复制网址在手机打开'}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-zinc-100 bg-zinc-50/80 flex items-center justify-between text-[11px] text-zinc-400">
          <span>跨设备同步：网页端与手机端数据通过统一账号实时同步</span>
          <button
            onClick={onClose}
            className="text-zinc-600 hover:text-zinc-900 font-medium"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
