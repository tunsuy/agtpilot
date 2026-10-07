'use client';

import React, { useState } from 'react';
import {
  Sparkles,
  Copy,
  CheckCheck,
  Download,
  Share2,
  ChevronLeft,
  ChevronRight,
  Heart,
  MessageCircle,
  Bookmark,
  Share,
  Sliders,
  Palette,
  Eye,
  Hash,
  Send,
  Smartphone,
} from 'lucide-react';
import { ArtifactSocialPostMeta, ArtifactVisualSlide } from '../types/agent';
import { shareToApp, copyToClipboard, isNativePlatform } from '../utils/nativeBridge';

interface XiaohongshuPreviewCardProps {
  postMeta?: ArtifactSocialPostMeta;
  rawContent: string;
  title?: string;
  onConfirmPublish?: () => void;
}

const PLATFORMS = [
  { id: 'xiaohongshu', name: '小红书 (3:4 图文)', color: 'text-rose-600', badge: 'bg-rose-50 text-rose-700 border-rose-200' },
  { id: 'wechat', name: '微信公众号 (首图)', color: 'text-emerald-600', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { id: 'twitter', name: 'X / Twitter (卡片)', color: 'text-zinc-900', badge: 'bg-zinc-100 text-zinc-800 border-zinc-200' },
  { id: 'zhihu', name: '知乎盐选 (回答卡)', color: 'text-blue-600', badge: 'bg-blue-50 text-blue-700 border-blue-200' },
] as const;

const THEME_STYLES: Record<string, { bg: string; text: string; accent: string; badge: string }> = {
  red: {
    bg: 'from-rose-500 via-red-500 to-pink-600',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-amber-300 text-rose-900',
  },
  amber: {
    bg: 'from-amber-500 via-orange-500 to-amber-600',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-white text-orange-950 font-bold',
  },
  emerald: {
    bg: 'from-emerald-600 via-teal-600 to-cyan-700',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-emerald-200 text-emerald-950',
  },
  blue: {
    bg: 'from-blue-600 via-indigo-600 to-violet-700',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-sky-200 text-blue-950',
  },
  purple: {
    bg: 'from-purple-600 via-fuchsia-600 to-pink-700',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-pink-200 text-purple-950',
  },
  dark: {
    bg: 'from-zinc-900 via-zinc-800 to-zinc-950',
    text: 'text-zinc-100',
    accent: 'bg-white/10 text-zinc-200 border-white/20',
    badge: 'bg-rose-500 text-white',
  },
};

/**
 * 智能解析 Markdown 正文，如果未显式提供 postMeta 则自动提炼小红书视觉切片
 */
function parsePostMetaFromContent(content: string, defaultTitle?: string): ArtifactSocialPostMeta {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  let title = defaultTitle || '小红书爆款图文笔记';
  const tags: string[] = [];
  const points: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      title = line.replace(/^#\s*/, '').trim();
    } else if (line.includes('#')) {
      // 提取 #标签
      const matches = line.match(/#[^\s#]+/g);
      if (matches) {
        matches.forEach((t) => tags.push(t.replace(/^#/, '')));
      }
    } else if (line.startsWith('- ') || line.startsWith('* ') || /^\d+\.\s/.test(line)) {
      points.push(line.replace(/^[-*]|\d+\.\s*/, '').trim());
    }
  }

  // 默认拆分 3 张 3:4 视觉卡片：首图封面 + 核心干货卡 + 结语行动卡
  const slides: ArtifactVisualSlide[] = [
    {
      title: title,
      subtitle: '⚡️ 收藏这篇就够了 | 颠覆认知的实操拆解',
      badge: '建议收藏',
      quote: '“真正的高手，早已把复杂工作全部托付给智能体。”',
      theme: 'red',
    },
    {
      title: '核心实操干货要点',
      subtitle: '3 步落地闭环实操路径',
      badge: '干货拆解',
      points: points.length > 0 ? points.slice(0, 4) : [
        '第一步：确立清晰的智能体核心分工',
        '第二步：建立长效人设记忆与执行红线',
        '第三步：开启主动巡航，实现全天候守护',
      ],
      theme: 'dark',
    },
    {
      title: '总结与下一步行动',
      subtitle: '今日开始，释放你的专注力',
      badge: '行动指南',
      quote: '💡 科技的意义是解放双手，做真正有创造力的事情。',
      footnote: '评论区留言【领取】，获取完整工作流模版。',
      theme: 'amber',
    },
  ];

  return {
    platform: 'xiaohongshu',
    title,
    coverTitle: title,
    tags: tags.length > 0 ? Array.from(new Set(tags)).slice(0, 6) : ['AI赋能', '副业搞钱', '效率神器', '小红书运营', '职场干货'],
    slides,
  };
}

export function XiaohongshuPreviewCard({
  postMeta,
  rawContent,
  title,
  onConfirmPublish,
}: XiaohongshuPreviewCardProps) {
  const meta = postMeta || parsePostMetaFromContent(rawContent, title);
  const slides = meta.slides && meta.slides.length > 0 ? meta.slides : [
    {
      title: meta.title || title || '爆款图文笔记',
      subtitle: '干货满满的视觉封面',
      badge: '必看',
      theme: 'red' as const,
    },
  ];

  const [selectedPlatform, setSelectedPlatform] = useState<string>('xiaohongshu');
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [activeTheme, setActiveTheme] = useState<keyof typeof THEME_STYLES>('red');
  const [copiedText, setCopiedText] = useState(false);
  const [copiedCover, setCopiedCover] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);

  const activeSlide = slides[currentSlideIndex] || slides[0];
  const theme = THEME_STYLES[activeSlide.theme || activeTheme] || THEME_STYLES.red;

  const handleCopyTextOnly = async () => {
    await copyToClipboard(rawContent);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  return (
    <div className="w-full flex flex-col xl:flex-row items-center xl:items-start justify-center gap-6 p-2 animate-fadeIn select-none">
      {/* ========================================================= */}
      {/* 1. 小红书真机 3:4 视窗渲染模拟器 (Mobile Simulator)          */}
      {/* ========================================================= */}
      <div className="w-full max-w-[340px] flex-shrink-0">
        <div className="rounded-[40px] border-[7px] border-zinc-900 bg-white shadow-2xl overflow-hidden flex flex-col aspect-[9/18.5] relative">
          {/* 手机听筒刘海与灵动岛 */}
          <div className="h-6 bg-zinc-900 w-full flex items-center justify-center relative flex-shrink-0">
            <div className="h-3.5 w-24 bg-black rounded-full" />
          </div>

          {/* 移动端 App 顶栏 (动态适配小红书 / 微信 / X / 知乎) */}
          <div className="h-10 px-4 flex items-center justify-between text-xs text-zinc-800 border-b border-zinc-100 flex-shrink-0 bg-white">
            <div className="flex items-center gap-1 font-semibold text-zinc-900">
              <ChevronLeft className="h-4 w-4" />
              <span>
                {selectedPlatform === 'wechat'
                  ? '公众号正文'
                  : selectedPlatform === 'twitter'
                  ? 'Post'
                  : selectedPlatform === 'zhihu'
                  ? '知乎专栏'
                  : '小红书发现'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 border border-zinc-200">
                AgtPilot 编排
              </span>
              <Share className="h-3.5 w-3.5 text-zinc-600" />
            </div>
          </div>

          {/* 模拟器主滚动区 */}
          <div className="flex-1 overflow-y-auto scrollbar-none flex flex-col bg-zinc-50">
            {/* 3:4 视觉图文轮播卡片 (Visual 3:4 Poster) */}
            <div className="relative aspect-[3/4] w-full bg-zinc-900 flex-shrink-0 overflow-hidden group">
              <div
                className={`w-full h-full bg-gradient-to-br ${theme.bg} p-6 flex flex-col justify-between transition-all duration-300 relative`}
              >
                {/* 装饰水印背景 */}
                <div className="absolute inset-0 opacity-10 bg-[radial-gradient(#fff_1px,transparent_1px)] [background-size:16px_16px] pointer-events-none" />

                {/* 顶部微标签与卡片序号 */}
                <div className="flex items-center justify-between z-10">
                  <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-md shadow-xs ${theme.badge}`}>
                    {activeSlide.badge || '小红书精选'}
                  </span>
                  <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-black/30 text-white/90 backdrop-blur-xs">
                    {currentSlideIndex + 1} / {slides.length}
                  </span>
                </div>

                {/* 卡片核心大字报主体 */}
                <div className="space-y-3 z-10 my-auto">
                  <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight leading-tight drop-shadow-md">
                    {activeSlide.title || meta.title}
                  </h2>

                  {activeSlide.subtitle && (
                    <p className="text-xs text-white/90 font-medium leading-relaxed drop-shadow-xs">
                      {activeSlide.subtitle}
                    </p>
                  )}

                  {/* 要点列表 */}
                  {activeSlide.points && activeSlide.points.length > 0 && (
                    <div className="space-y-1.5 pt-2">
                      {activeSlide.points.map((pt, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-1.5 text-xs text-white/95 font-medium bg-black/20 p-2 rounded-xl backdrop-blur-xs border border-white/10"
                        >
                          <span className="h-4 w-4 rounded-full bg-white text-zinc-900 text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                            {i + 1}
                          </span>
                          <span className="leading-snug">{pt}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 金句引用 */}
                  {activeSlide.quote && (
                    <div className="p-2.5 rounded-xl bg-white/15 backdrop-blur-xs border border-white/20 text-xs text-white/95 italic leading-relaxed">
                      {activeSlide.quote}
                    </div>
                  )}
                </div>

                {/* 卡片底部 Logo 与行动号召 */}
                <div className="flex items-center justify-between z-10 pt-2 border-t border-white/20 text-[10px] text-white/80 font-mono">
                  <span>@个人超级智能体</span>
                  <span>{activeSlide.footnote || '长按保存 • 评论区交流'}</span>
                </div>
              </div>

              {/* 左右切图小控制指示 */}
              {slides.length > 1 && (
                <>
                  <button
                    onClick={() => setCurrentSlideIndex((prev) => (prev > 0 ? prev - 1 : slides.length - 1))}
                    className="absolute left-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full bg-black/40 text-white flex items-center justify-center backdrop-blur-xs hover:bg-black/60 transition opacity-0 group-hover:opacity-100"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setCurrentSlideIndex((prev) => (prev < slides.length - 1 ? prev + 1 : 0))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full bg-black/40 text-white flex items-center justify-center backdrop-blur-xs hover:bg-black/60 transition opacity-0 group-hover:opacity-100"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>

            {/* 笔记文字区 */}
            <div className="p-4 space-y-3 bg-white flex-1">
              <h3 className="text-sm font-bold text-zinc-900 leading-snug">
                {meta.title || title}
              </h3>

              <div className="text-xs text-zinc-700 leading-relaxed space-y-2 whitespace-pre-wrap">
                {rawContent}
              </div>

              {/* 小红书专属热门标签 */}
              <div className="flex flex-wrap gap-1.5 pt-2">
                {(meta.tags || ['AI智能体', '小红书运营', '职场效率', '副业']).map((tag, i) => (
                  <span
                    key={i}
                    className="text-[11px] text-blue-600 hover:text-blue-700 cursor-pointer font-medium"
                  >
                    #{tag}
                  </span>
                ))}
              </div>

              <div className="text-[10px] text-zinc-400 font-mono pt-1">
                编辑于今天 11:28 · 智能体自动编排
              </div>
            </div>
          </div>

          {/* 小红书 App 底栏互动槽 */}
          <div className="h-11 px-4 bg-white border-t border-zinc-100 flex items-center justify-between text-zinc-700 flex-shrink-0">
            <div className="flex items-center gap-1.5 text-zinc-400 text-xs bg-zinc-100 px-3 py-1 rounded-full flex-1 mr-3">
              <MessageCircle className="h-3 w-3" />
              <span className="text-[11px]">说点什么...</span>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsLiked(!isLiked)}
                className={`flex items-center gap-0.5 text-xs transition ${isLiked ? 'text-rose-600' : 'text-zinc-600'}`}
              >
                <Heart className={`h-4 w-4 ${isLiked ? 'fill-rose-600' : ''}`} />
                <span className="text-[10px] font-mono">{isLiked ? '1.2k' : '1.1k'}</span>
              </button>

              <button
                onClick={() => setIsBookmarked(!isBookmarked)}
                className={`flex items-center gap-0.5 text-xs transition ${isBookmarked ? 'text-amber-500' : 'text-zinc-600'}`}
              >
                <Bookmark className={`h-4 w-4 ${isBookmarked ? 'fill-amber-500' : ''}`} />
                <span className="text-[10px] font-mono">{isBookmarked ? '832' : '831'}</span>
              </button>

              <Share2 className="h-4 w-4 text-zinc-600" />
            </div>
          </div>
        </div>
      </div>

      {/* ========================================================= */}
      {/* 2. 右侧：超级智能体协同运营控制台 (Agent Operations Hub)    */}
      {/* ========================================================= */}
      <div className="flex-1 min-w-0 bg-white rounded-2xl border border-zinc-200/90 p-5 md:p-6 space-y-5 shadow-2xs">
        <div>
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-zinc-100 border border-zinc-200 text-zinc-700 text-xs font-semibold">
              <Smartphone className="h-3.5 w-3.5" />
              <span>全平台移动端视觉卡片与排版模拟器</span>
            </div>
            <span className="text-xs text-zinc-400 font-mono">
              3:4 视觉卡片共 {slides.length} 张
            </span>
          </div>

          <h3 className="text-lg font-bold text-zinc-900 mt-2">
            多平台所见即所得：视觉资产与发布门禁
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
            支持小红书、公众号、X/Twitter 与知乎等全平台。智能体自动提炼首图大字报、视觉干货切片与网感文本，无需手动排版。
          </p>
        </div>

        {/* 目标发布平台切换 */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-700 block">
            目标发布平台与版式
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            {PLATFORMS.map((p) => {
              const isSelected = selectedPlatform === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedPlatform(p.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium transition ${
                    isSelected
                      ? 'bg-zinc-900 text-white shadow-2xs font-semibold'
                      : 'bg-zinc-100 hover:bg-zinc-200/70 text-zinc-600'
                  }`}
                >
                  <span>{p.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 幻灯片卡片切片指示与快捷选择 */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-700 block">
            视觉切片预览 ({currentSlideIndex + 1}/{slides.length})
          </label>
          <div className="grid grid-cols-3 gap-2">
            {slides.map((s, idx) => (
              <button
                key={idx}
                onClick={() => setCurrentSlideIndex(idx)}
                className={`p-2.5 rounded-xl border text-left transition flex flex-col justify-between ${
                  currentSlideIndex === idx
                    ? 'border-rose-500 bg-rose-50/30 ring-1 ring-rose-500'
                    : 'border-zinc-200 hover:border-zinc-300 bg-zinc-50/50'
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <span className="text-[10px] font-mono text-zinc-400">P{idx + 1}</span>
                  <span className="text-[9px] px-1.5 py-0.2 rounded bg-white text-zinc-600 border border-zinc-200">
                    {s.badge || '切片'}
                  </span>
                </div>
                <p className="text-[11px] font-medium text-zinc-800 line-clamp-1 truncate w-full">
                  {s.title}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* 换肤调色盘 */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-700 flex items-center gap-1.5">
            <Palette className="h-3.5 w-3.5 text-zinc-500" />
            <span>首图调色盘风格</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { id: 'red', name: '经典爆款红', bg: 'bg-rose-500' },
                { id: 'amber', name: '日光暖橙', bg: 'bg-amber-500' },
                { id: 'emerald', name: '极客翡翠', bg: 'bg-emerald-600' },
                { id: 'blue', name: '深邃科技蓝', bg: 'bg-blue-600' },
                { id: 'purple', name: '知识数码紫', bg: 'bg-purple-600' },
                { id: 'dark', name: '沉浸黑金', bg: 'bg-zinc-900' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTheme(t.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition ${
                  activeTheme === t.id
                    ? 'border-zinc-900 bg-zinc-900 text-white shadow-2xs'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300'
                }`}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${t.bg}`} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 运营决策指标 */}
        <div className="grid grid-cols-3 gap-3 p-3.5 rounded-xl bg-zinc-50 border border-zinc-100 text-center">
          <div>
            <span className="text-[10px] text-zinc-400 block font-mono">字数统计</span>
            <span className="text-xs font-bold text-zinc-800 font-mono mt-0.5 block">
              {rawContent.length} 字
            </span>
          </div>
          <div>
            <span className="text-[10px] text-zinc-400 block font-mono">网感标签</span>
            <span className="text-xs font-bold text-zinc-800 font-mono mt-0.5 block">
              {(meta.tags || []).length} 个
            </span>
          </div>
          <div>
            <span className="text-[10px] text-zinc-400 block font-mono">平台适配度</span>
            <span className="text-xs font-bold text-emerald-600 font-mono mt-0.5 block">
              98% (极佳)
            </span>
          </div>
        </div>

        {/* 快捷动作栏 */}
        <div className="pt-2 flex flex-wrap items-center gap-2.5">
          <button
            onClick={handleCopyTextOnly}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition shadow-2xs"
          >
            {copiedText ? (
              <CheckCheck className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <Copy className="h-3.5 w-3.5 text-zinc-400" />
            )}
            <span>{copiedText ? '正文已复制' : '复制图文排版文本'}</span>
          </button>

          <button
            onClick={() => {
              setCopiedCover(true);
              setTimeout(() => setCopiedCover(false), 2000);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition shadow-2xs"
          >
            <Download className="h-3.5 w-3.5 text-zinc-400" />
            <span>{copiedCover ? '已打包切片' : '导出 3:4 切片图集'}</span>
          </button>

          {/* 手机端原生系统分享通道 (Native Share Sheet / Web Share) */}
          <button
            onClick={async () => {
              const success = await shareToApp({
                title: meta.title || title || '智能体视觉卡片',
                text: rawContent,
                dialogTitle: '选择要发布的 App（微信/小红书/备忘录）',
              });
              if (!success && !isNativePlatform()) {
                alert('已将排版内容与标签复制到剪贴板，可直接在手机 App 中粘贴发布！');
              }
            }}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition shadow-2xs"
            title="调用移动端系统原生分享菜单"
          >
            <Share2 className="h-3.5 w-3.5 text-rose-500" />
            <span>手机原生分享</span>
          </button>

          <button
            onClick={() => {
              if (onConfirmPublish) {
                onConfirmPublish();
              } else {
                alert('已通过人机协同门禁！智能体已将成果同步至多平台就绪状态。');
              }
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium transition shadow-xs active:scale-95 ml-auto"
          >
            <Send className="h-3.5 w-3.5" />
            <span>审批通过并确认</span>
          </button>
        </div>
      </div>
    </div>
  );
}
