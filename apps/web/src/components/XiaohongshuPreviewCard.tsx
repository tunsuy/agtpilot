'use client';

import React, { useRef, useState } from 'react';
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
  Smartphone,
  ThumbsUp,
  Repeat2,
  Star,
} from 'lucide-react';
import { ArtifactSocialPostMeta, ArtifactVisualSlide } from '../types/agent';
import { openAppScheme, copyToClipboard, isNativePlatform } from '../utils/nativeBridge';
import { useIsMobile } from './mobile/useIsMobile';

interface XiaohongshuPreviewCardProps {
  postMeta?: ArtifactSocialPostMeta;
  rawContent: string;
  title?: string;
}

const PLATFORMS = [
  { id: 'xiaohongshu', name: '小红书 (3:4 图文)', short: '小红书', color: 'text-rose-600', badge: 'bg-rose-50 text-rose-700 border-rose-200' },
  { id: 'wechat', name: '微信公众号 (首图)', short: '公众号', color: 'text-emerald-600', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { id: 'twitter', name: 'X / Twitter (卡片)', short: 'X', color: 'text-zinc-900', badge: 'bg-zinc-100 text-zinc-800 border-zinc-200' },
  { id: 'zhihu', name: '知乎盐选 (回答卡)', short: '知乎', color: 'text-blue-600', badge: 'bg-blue-50 text-blue-700 border-blue-200' },
] as const;

/**
 * 手机端 → 目标平台「内容创建页」直跳配置。
 * 平台能力差异(硬约束):只有 X/Twitter 提供可携带正文的公开发布 intent
 * (twitter.com/intent/tweet),能真正预填充;小红书/微信/知乎均未开放
 * 「带内容进创作页」的外部 scheme——业界通行做法即「自动复制排版内容 +
 * 唤起 App/网页创作页」,用户在平台编辑框粘贴一下即可。
 */
const PLATFORM_JUMP: Record<
  string,
  { name: string; scheme?: string; web?: string; intent?: (text: string) => string; extraHint?: string }
> = {
  xiaohongshu: {
    name: '小红书',
    scheme: 'xhsdiscover://',
    web: 'https://creator.xiaohongshu.com/publish/publish',
  },
  wechat: {
    name: '微信',
    scheme: 'weixin://',
    web: 'https://mp.weixin.qq.com',
    extraHint: '公众号图文请在「订阅号助手 / 公众平台」中粘贴。',
  },
  twitter: {
    name: 'X / Twitter',
    intent: (text) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`,
  },
  zhihu: {
    name: '知乎',
    scheme: 'zhihu://',
    web: 'https://zhuanlan.zhihu.com/write',
  },
};

/** 各平台正文字数上限;null = 无硬上限(X 按加权计数:CJK 记 2,其余记 1) */
const PLATFORM_CHAR_LIMITS: Record<string, number | null> = {
  xiaohongshu: 1000,
  wechat: 20000,
  twitter: 280,
  zhihu: null,
};

/** X/Twitter 加权字数:CJK 全角字符按 2 计,其余按 1 计 */
function weightedCharCount(s: string): number {
  let n = 0;
  for (const ch of s) {
    n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  }
  return n;
}

const THEME_STYLES: Record<string, { bg: string; text: string; accent: string; badge: string; colors: [string, string, string] }> = {
  red: {
    bg: 'from-rose-500 via-red-500 to-pink-600',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-amber-300 text-rose-900',
    colors: ['#f43f5e', '#ef4444', '#db2777'],
  },
  amber: {
    bg: 'from-amber-500 via-orange-500 to-amber-600',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-white text-orange-950 font-bold',
    colors: ['#f59e0b', '#f97316', '#d97706'],
  },
  emerald: {
    bg: 'from-emerald-600 via-teal-600 to-cyan-700',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-emerald-200 text-emerald-950',
    colors: ['#059669', '#0d9488', '#0e7490'],
  },
  blue: {
    bg: 'from-blue-600 via-indigo-600 to-violet-700',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-sky-200 text-blue-950',
    colors: ['#2563eb', '#4f46e5', '#6d28d9'],
  },
  purple: {
    bg: 'from-purple-600 via-fuchsia-600 to-pink-700',
    text: 'text-white',
    accent: 'bg-white/20 text-white border-white/30',
    badge: 'bg-pink-200 text-purple-950',
    colors: ['#9333ea', '#c026d3', '#be185d'],
  },
  dark: {
    bg: 'from-zinc-900 via-zinc-800 to-zinc-950',
    text: 'text-zinc-100',
    accent: 'bg-white/10 text-zinc-200 border-white/20',
    badge: 'bg-rose-500 text-white',
    colors: ['#18181b', '#27272a', '#09090b'],
  },
};

/** canvas 圆角矩形路径 */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** canvas 逐字符折行(CJK 无空格也能正确断行) */
function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    if (line && ctx.measureText(line + ch).width > maxWidth) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * 把一张视觉切片用 canvas 画成 PNG 海报并触发下载(纯前端,无依赖)。
 * 版式与模拟器封面同源:渐变底 + badge + 页码 + 折行大标题 + 副题 +(3:4 时)要点/金句 + 页脚。
 */
function exportSlidePng(
  slide: ArtifactVisualSlide,
  themeStyle: { colors: [string, string, string] },
  aspect: '3:4' | '16:9',
  index: number,
  total: number,
  fallbackTitle?: string
) {
  const W = 1080;
  const H = aspect === '3:4' ? 1440 : 608;
  const isTall = aspect === '3:4';
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';

  // 背景:与 Tailwind bg-gradient-to-br from/via/to 同款三色对角渐变
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, themeStyle.colors[0]);
  grad.addColorStop(0.5, themeStyle.colors[1]);
  grad.addColorStop(1, themeStyle.colors[2]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const pad = isTall ? 72 : 48;

  // 顶部:badge 胶囊(左) + 页码(右)
  const bh = isTall ? 52 : 42;
  const badgeText = slide.badge || (isTall ? '智能体精选' : '智能体生成');
  ctx.font = `700 ${isTall ? 30 : 24}px ${FONT}`;
  const bw = ctx.measureText(badgeText).width + 36;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  roundRectPath(ctx, pad, pad, bw, bh, 12);
  ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.fillStyle = themeStyle.colors[2];
  ctx.fillText(badgeText, pad + 18, pad + bh / 2 + 1);
  const idxText = `${index + 1} / ${total}`;
  ctx.font = `500 ${isTall ? 26 : 22}px ui-monospace,monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(idxText, W - pad - ctx.measureText(idxText).width, pad + bh / 2);

  // 页脚:分隔线 + 署名 + 行动号召
  const footY = H - pad;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, footY - 30);
  ctx.lineTo(W - pad, footY - 30);
  ctx.stroke();
  ctx.font = `400 ${isTall ? 26 : 22}px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText('@个人超级智能体', pad, footY - 8);
  const foot = slide.footnote || (isTall ? '长按保存 • 评论区交流' : '智能体自动编排');
  ctx.fillText(foot, W - pad - ctx.measureText(foot).width, footY - 8);

  // 主体:大标题(top 基线逐行推进)
  ctx.textBaseline = 'top';
  let y = pad + bh + (isTall ? 80 : 44);
  ctx.fillStyle = '#ffffff';
  const titleSize = isTall ? 76 : 52;
  ctx.font = `900 ${titleSize}px ${FONT}`;
  const titleLines = wrapCanvasText(ctx, slide.title || fallbackTitle || '智能体交付物', W - pad * 2);
  for (const line of titleLines.slice(0, isTall ? 3 : 2)) {
    ctx.fillText(line, pad, y);
    y += titleSize * 1.32;
  }
  if (slide.subtitle) {
    y += 10;
    const subSize = isTall ? 34 : 26;
    ctx.font = `500 ${subSize}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const line of wrapCanvasText(ctx, slide.subtitle, W - pad * 2).slice(0, 2)) {
      ctx.fillText(line, pad, y);
      y += subSize * 1.4;
    }
  }

  // 3:4 详细模式:要点列表或金句
  if (isTall && slide.points && slide.points.length > 0) {
    y += 28;
    slide.points.slice(0, 4).forEach((pt, i) => {
      ctx.font = `600 32px ${FONT}`;
      const lines = wrapCanvasText(ctx, pt, W - pad * 2 - 120);
      const boxH = Math.max(lines.length * 44 + 28, 76);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      roundRectPath(ctx, pad, y, W - pad * 2, boxH, 20);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(pad + 42, y + boxH / 2, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.textBaseline = 'middle';
      ctx.fillStyle = themeStyle.colors[2];
      ctx.font = '700 26px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), pad + 42, y + boxH / 2 + 1);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.font = `600 32px ${FONT}`;
      lines.forEach((line, li) => ctx.fillText(line, pad + 84, y + boxH / 2 - ((lines.length - 1) * 44) / 2 + li * 44));
      ctx.textBaseline = 'top';
      y += boxH + 16;
    });
  } else if (isTall && slide.quote) {
    y += 28;
    ctx.font = `600 34px ${FONT}`;
    const lines = wrapCanvasText(ctx, slide.quote, W - pad * 2 - 72);
    const boxH = lines.length * 48 + 36;
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    roundRectPath(ctx, pad, y, W - pad * 2, boxH, 20);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    lines.forEach((line, li) => ctx.fillText(line, pad + 36, y + 18 + li * 48));
  }

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `视觉切片-${index + 1}of${total}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
}

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
  // 调色盘覆盖:null = 跟随切片自带主题;用户点选调色盘后全局换肤(优先级最高)
  const [themeOverride, setThemeOverride] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedCover, setCopiedCover] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  // 移动版判定:「去平台发布」移动版直跳所选平台创作页,Web 桌面版提示到手机端操作
  const { isMobile } = useIsMobile();
  // 直跳后的内联提示(替代 alert,不打断跳转)
  const [jumpHint, setJumpHint] = useState<string | null>(null);

  const activeSlide = slides[currentSlideIndex] || slides[0];
  // 用户点过调色盘 → 全局换肤;否则跟随当前切片自带主题
  const activeThemeKey = themeOverride || activeSlide.theme || 'red';
  const theme = THEME_STYLES[activeThemeKey] || THEME_STYLES.red;

  // 运营指标:跟随所选平台的真实限制(X 按加权字数;Twitter 标签只用前 3 个)
  const charLimit = PLATFORM_CHAR_LIMITS[selectedPlatform] ?? null;
  const charCount = selectedPlatform === 'twitter' ? weightedCharCount(rawContent) : rawContent.length;
  const overLimit = charLimit !== null && charCount > charLimit;
  const tagCount = selectedPlatform === 'twitter'
    ? Math.min((meta.tags || []).length, 3)
    : (meta.tags || []).length;

  const handleCopyTextOnly = async () => {
    await copyToClipboard(rawContent);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  // 真·导出切片图集:每张切片用 canvas 画成 PNG 依次下载(错峰触发避免浏览器拦截)
  const exportAspect: '3:4' | '16:9' = selectedPlatform === 'xiaohongshu' ? '3:4' : '16:9';
  const [exporting, setExporting] = useState(false);
  const handleExportSlides = () => {
    if (exporting) return;
    setExporting(true);
    slides.forEach((s, i) => {
      setTimeout(
        () => exportSlidePng(s, theme, exportAspect, i, slides.length, meta.title || title),
        i * 400
      );
    });
    setTimeout(() => {
      setExporting(false);
      setCopiedCover(true);
      setTimeout(() => setCopiedCover(false), 2500);
    }, slides.length * 400 + 300);
  };

  /**
   * 手机端一键去所选平台发布:
   * - 先把排版内容放上剪贴板(所有平台通用);
   * - X/Twitter 走公开 intent,正文直接预填充进发布页;
   * - 其余平台唤起 App(未装则回退网页创作页),粘贴即发;
   * - Web 桌面版不做静默降级,直接提示到手机端操作。
   */
  const handlePlatformJump = async () => {
    const jump = PLATFORM_JUMP[selectedPlatform] || PLATFORM_JUMP.xiaohongshu;
    if (!isMobile && !isNativePlatform()) {
      alert(`跳转「${jump.name}」发布仅移动版支持——请在手机 App 或手机页面打开该交付物再操作。`);
      return;
    }
    await copyToClipboard(rawContent);
    const composerText = [
      meta.title || title || '',
      rawContent.slice(0, 400),
      (meta.tags || []).map((t: string) => (t.startsWith('#') ? t : `#${t}`)).join(' '),
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 900);
    setJumpHint(
      jump.intent
        ? `已打开 ${jump.name} 发布页,标题/正文摘要/标签已预填充,确认后直接发布。`
        : `排版内容已复制并打开 ${jump.name} —— 在内容创建页粘贴即可。${jump.extraHint || ''}`
    );
    setTimeout(() => setJumpHint(null), 8000);
    if (jump.intent) {
      window.location.href = jump.intent(composerText);
    } else {
      await openAppScheme(jump.scheme!, jump.web);
    }
  };

  /**
   * 通用视觉切片封面:同一份 slides/theme 资产按平台复用——
   * 小红书用 3:4 大字报(带要点/金句),公众号/X/知乎用 16:9 首图(只留标题/副题)。
   * 触屏可左右滑动切换切片(移动端没有 hover,箭头也常显)。
   */
  const touchStartX = useRef<number | null>(null);
  const handleCoverTouchEnd = (dx: number) => {
    if (Math.abs(dx) < 40) return;
    if (dx < 0) {
      setCurrentSlideIndex((prev) => (prev < slides.length - 1 ? prev + 1 : 0));
    } else {
      setCurrentSlideIndex((prev) => (prev > 0 ? prev - 1 : slides.length - 1));
    }
  };
  const renderVisualCover = (aspect: string, detailed: boolean) => (
    <div
      className={`relative ${aspect} w-full bg-zinc-900 flex-shrink-0 overflow-hidden group`}
      onTouchStart={(e) => {
        touchStartX.current = e.touches[0].clientX;
      }}
      onTouchEnd={(e) => {
        if (touchStartX.current === null) return;
        handleCoverTouchEnd(e.changedTouches[0].clientX - touchStartX.current);
        touchStartX.current = null;
      }}
    >
      <div
        className={`w-full h-full bg-gradient-to-br ${theme.bg} ${detailed ? 'p-6' : 'p-4'} flex flex-col justify-between transition-all duration-300 relative`}
      >
        {/* 装饰水印背景 */}
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(#fff_1px,transparent_1px)] [background-size:16px_16px] pointer-events-none" />

        {/* 顶部微标签与卡片序号 */}
        <div className="flex items-center justify-between z-10">
          <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-md shadow-xs ${theme.badge}`}>
            {activeSlide.badge || (detailed ? '小红书精选' : '智能体生成')}
          </span>
          <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-black/30 text-white/90 backdrop-blur-xs">
            {currentSlideIndex + 1} / {slides.length}
          </span>
        </div>

        {/* 卡片主体:大字报(详细模式含要点/金句,紧凑模式只留标题副题) */}
        <div className="space-y-3 z-10 my-auto">
          <h2
            className={`${detailed ? 'text-xl sm:text-2xl' : 'text-base'} font-black text-white tracking-tight leading-tight drop-shadow-md`}
          >
            {activeSlide.title || meta.title}
          </h2>

          {activeSlide.subtitle && (
            <p className="text-xs text-white/90 font-medium leading-relaxed drop-shadow-xs">
              {activeSlide.subtitle}
            </p>
          )}

          {detailed && activeSlide.points && activeSlide.points.length > 0 && (
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

          {detailed && activeSlide.quote && (
            <div className="p-2.5 rounded-xl bg-white/15 backdrop-blur-xs border border-white/20 text-xs text-white/95 italic leading-relaxed">
              {activeSlide.quote}
            </div>
          )}
        </div>

        {/* 卡片底部 Logo 与行动号召 */}
        <div className="flex items-center justify-between z-10 pt-2 border-t border-white/20 text-[10px] text-white/80 font-mono">
          <span>@个人超级智能体</span>
          <span>{activeSlide.footnote || (detailed ? '长按保存 • 评论区交流' : '智能体自动编排')}</span>
        </div>
      </div>

      {/* 左右切图小控制指示 */}
      {slides.length > 1 && (
        <>
          <button
            onClick={() => setCurrentSlideIndex((prev) => (prev > 0 ? prev - 1 : slides.length - 1))}
            className="absolute left-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full bg-black/40 text-white flex items-center justify-center backdrop-blur-xs hover:bg-black/60 transition opacity-70 xl:opacity-0 xl:group-hover:opacity-100"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => setCurrentSlideIndex((prev) => (prev < slides.length - 1 ? prev + 1 : 0))}
            className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full bg-black/40 text-white flex items-center justify-center backdrop-blur-xs hover:bg-black/60 transition opacity-70 xl:opacity-0 xl:group-hover:opacity-100"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className="w-full flex flex-col xl:flex-row items-center xl:items-start justify-center gap-6 p-2 animate-fadeIn select-none">
      {/* ========================================================= */}
      {/* 1. 全平台真机视窗渲染模拟器(排版随选中平台切换)             */}
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

          {/* 模拟器主滚动区:排版随选中平台切换(小红书笔记 / 公众号文章 / X 推文 / 知乎专栏) */}
          <div className="flex-1 overflow-y-auto scrollbar-none flex flex-col bg-zinc-50">
            {selectedPlatform === 'wechat' ? (
              /* 微信公众号文章页:16:9 首图 + 大标题 + 账号行 + 正文 */
              <>
                {renderVisualCover('aspect-video', false)}
                <div className="p-4 space-y-3 bg-white flex-1">
                  <h3 className="text-base font-bold text-zinc-900 leading-snug">
                    {meta.title || title}
                  </h3>
                  <div className="flex items-center gap-2">
                    <span className={`h-7 w-7 rounded-md bg-gradient-to-br ${theme.bg} flex-shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-semibold text-zinc-900">AgtPilot 智能体</p>
                      <p className="text-[10px] text-zinc-400">今天 11:28 · 原创</p>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 font-medium">
                      已关注
                    </span>
                  </div>
                  <div className="text-xs text-zinc-700 leading-relaxed space-y-2 whitespace-pre-wrap">
                    {rawContent}
                  </div>
                  <p className="text-[10px] text-zinc-400 pt-1">
                    首图与排版由智能体自动生成 · 阅读 10万+
                  </p>
                </div>
              </>
            ) : selectedPlatform === 'twitter' ? (
              /* X/Twitter 推文详情页:作者行 + 推文文本 + 话题 + 媒体卡片 + 指标行 */
              <div className="p-4 space-y-3 bg-white flex-1">
                <div className="flex items-center gap-2">
                  <span className={`h-9 w-9 rounded-full bg-gradient-to-br ${theme.bg} flex-shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-zinc-900">AgtPilot</p>
                    <p className="text-[10px] text-zinc-400">@agtpilot_ai · 2h</p>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-zinc-300 text-zinc-600 font-semibold">
                    Follow
                  </span>
                </div>
                <div className="text-xs text-zinc-800 leading-relaxed whitespace-pre-wrap">
                  <span className="font-bold">{meta.title || title}</span>
                  {'\n\n'}
                  {rawContent.slice(0, 200)}
                  {rawContent.length > 200 ? '…' : ''}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(meta.tags || ['AI智能体']).slice(0, 3).map((tag, i) => (
                    <span key={i} className="text-[11px] text-blue-500 font-medium">
                      #{tag}
                    </span>
                  ))}
                </div>
                {renderVisualCover('aspect-video', false)}
                <div className="flex items-center justify-between text-zinc-400 text-[10px] font-mono pt-2 border-t border-zinc-100">
                  <span className="flex items-center gap-1">
                    <MessageCircle className="h-3 w-3" /> 12
                  </span>
                  <span className="flex items-center gap-1">
                    <Repeat2 className="h-3 w-3" /> 34
                  </span>
                  <span className="flex items-center gap-1">
                    <Heart className="h-3 w-3" /> 128
                  </span>
                  <span className="flex items-center gap-1">
                    <Eye className="h-3 w-3" /> 5.6K
                  </span>
                </div>
              </div>
            ) : selectedPlatform === 'zhihu' ? (
              /* 知乎专栏文章:大标题 + 作者行 + 16:9 封面 + 正文 + 话题标签 */
              <div className="p-4 space-y-3 bg-white flex-1">
                <h3 className="text-base font-bold text-zinc-900 leading-snug">
                  {meta.title || title}
                </h3>
                <div className="flex items-center gap-2">
                  <span className={`h-7 w-7 rounded-full bg-gradient-to-br ${theme.bg} flex-shrink-0`} />
                  <p className="text-[11px] font-semibold text-zinc-800 flex-1">AgtPilot</p>
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200 font-medium">
                    关注
                  </span>
                </div>
                {renderVisualCover('aspect-video', false)}
                <div className="text-xs text-zinc-700 leading-relaxed space-y-2 whitespace-pre-wrap">
                  {rawContent}
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {(meta.tags || ['AI智能体', '效率工具']).map((tag, i) => (
                    <span
                      key={i}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500 border border-zinc-200"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-400 pt-1">发布于 今天 11:28 · 智能体自动编排</p>
              </div>
            ) : (
              /* 小红书笔记(默认):3:4 大字报切片轮播 + 笔记文字 + 话题标签 */
              <>
                {renderVisualCover('aspect-[3/4]', true)}
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
              </>
            )}
          </div>

          {/* App 底栏互动槽:随平台切换(小红书评论+赞藏 / 公众号赞·在看 / X 指标 / 知乎赞同) */}
          {selectedPlatform === 'wechat' ? (
            <div className="h-11 px-4 bg-white border-t border-zinc-100 flex items-center justify-around text-zinc-600 flex-shrink-0">
              <button
                onClick={() => setIsLiked(!isLiked)}
                className={`flex items-center gap-1 text-xs transition ${isLiked ? 'text-amber-500' : 'text-zinc-600'}`}
              >
                <ThumbsUp className={`h-4 w-4 ${isLiked ? 'fill-amber-400' : ''}`} />
                <span className="text-[10px] font-mono">{isLiked ? '129' : '128'}</span>
              </button>
              <button
                onClick={() => setIsBookmarked(!isBookmarked)}
                className={`flex items-center gap-1 text-xs transition ${isBookmarked ? 'text-amber-500' : 'text-zinc-600'}`}
              >
                <Star className={`h-4 w-4 ${isBookmarked ? 'fill-amber-400' : ''}`} />
                <span className="text-[10px]">在看 {isBookmarked ? '33' : '32'}</span>
              </button>
              <button type="button" className="flex items-center gap-1 text-xs text-zinc-600">
                <Share2 className="h-4 w-4" />
                <span className="text-[10px]">分享</span>
              </button>
            </div>
          ) : selectedPlatform === 'twitter' ? (
            <div className="h-11 px-6 bg-white border-t border-zinc-100 flex items-center justify-between text-zinc-500 flex-shrink-0">
              <MessageCircle className="h-4 w-4" />
              <Repeat2 className="h-4 w-4 text-emerald-600" />
              <button
                onClick={() => setIsLiked(!isLiked)}
                className={`transition ${isLiked ? 'text-rose-600' : 'text-zinc-500'}`}
                aria-label="Like"
              >
                <Heart className={`h-4 w-4 ${isLiked ? 'fill-rose-600' : ''}`} />
              </button>
              <Eye className="h-4 w-4" />
              <Share2 className="h-4 w-4" />
            </div>
          ) : selectedPlatform === 'zhihu' ? (
            <div className="h-11 px-4 bg-white border-t border-zinc-100 flex items-center gap-3 text-zinc-600 flex-shrink-0">
              <button
                onClick={() => setIsLiked(!isLiked)}
                className={`flex-1 h-8 rounded-lg border flex items-center justify-center gap-1 text-xs transition ${
                  isLiked ? 'border-blue-300 bg-blue-50 text-blue-600' : 'border-zinc-200 text-zinc-600'
                }`}
              >
                <ThumbsUp className={`h-3.5 w-3.5 ${isLiked ? 'fill-blue-500' : ''}`} /> 赞同 {isLiked ? '129' : '128'}
              </button>
              <MessageCircle className="h-4 w-4 text-zinc-500" />
              <button
                onClick={() => setIsBookmarked(!isBookmarked)}
                className={`transition ${isBookmarked ? 'text-amber-500' : 'text-zinc-500'}`}
                aria-label="收藏"
              >
                <Bookmark className={`h-4 w-4 ${isBookmarked ? 'fill-amber-500' : ''}`} />
              </button>
              <Share2 className="h-4 w-4 text-zinc-500" />
            </div>
          ) : (
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
          )}
        </div>
      </div>

      {/* ========================================================= */}
      {/* 2. 右侧：超级智能体协同运营控制台 (Agent Operations Hub)    */}
      {/* ========================================================= */}
      <div className="flex-1 min-w-0 bg-white rounded-2xl border border-zinc-200/90 p-5 md:p-6 space-y-5 shadow-2xs">
        <div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-zinc-100 border border-zinc-200 text-zinc-700 text-xs font-semibold">
            <Smartphone className="h-3.5 w-3.5" />
            <span>全平台移动端视觉卡片与排版模拟器</span>
          </div>

          <h3 className="text-lg font-bold text-zinc-900 mt-2">
            多平台所见即所得：视觉资产与一键发布
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
                onClick={() => setThemeOverride(t.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition ${
                  activeThemeKey === t.id
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

        {/* 运营决策指标(跟随所选平台更新) */}
        <div className="grid grid-cols-3 gap-3 p-3.5 rounded-xl bg-zinc-50 border border-zinc-100 text-center">
          <div>
            <span className="text-[10px] text-zinc-400 block font-mono">
              {selectedPlatform === 'twitter' ? '字数(加权)' : '字数统计'}
            </span>
            <span className={`text-xs font-bold font-mono mt-0.5 block ${overLimit ? 'text-rose-600' : 'text-zinc-800'}`}>
              {charCount}
              {charLimit !== null ? ` / ${charLimit}` : ''} 字
            </span>
          </div>
          <div>
            <span className="text-[10px] text-zinc-400 block font-mono">网感标签</span>
            <span className="text-xs font-bold text-zinc-800 font-mono mt-0.5 block">
              {tagCount} 个
            </span>
          </div>
          <div>
            <span className="text-[10px] text-zinc-400 block font-mono">上限合规</span>
            <span className={`text-xs font-bold font-mono mt-0.5 block ${overLimit ? 'text-rose-600' : 'text-emerald-600'}`}>
              {overLimit ? `超 ${charCount - (charLimit || 0)} 字` : charLimit !== null ? '✓ 限制内' : '✓ 无上限'}
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
            onClick={handleExportSlides}
            disabled={exporting}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition shadow-2xs disabled:opacity-60"
            title={`把 ${slides.length} 张视觉切片逐张渲染为 ${exportAspect} PNG 并下载`}
          >
            <Download className="h-3.5 w-3.5 text-zinc-400" />
            <span>
              {exporting
                ? '正在导出…'
                : copiedCover
                ? `已导出 ${slides.length} 张 PNG`
                : `导出 ${exportAspect} 切片图集`}
            </span>
          </button>

          {/* 去平台发布:移动版按上方选中的目标平台直跳其内容创建页
              (内容已自动复制,X 走 intent 真预填充);Web 桌面版提示到手机端操作 */}
          <button
            onClick={handlePlatformJump}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition shadow-2xs ml-auto"
            title="按上方选中平台直接跳转其内容创建页:内容自动复制,X/Twitter 自动填充正文"
          >
            <Share2 className="h-3.5 w-3.5 text-rose-500" />
            <span>去{PLATFORMS.find((p) => p.id === selectedPlatform)?.short || '小红书'}发布</span>
          </button>
        </div>

        {/* 直跳结果内联提示(8s 自动消失) */}
        {jumpHint && (
          <p className="mt-2.5 text-[11px] leading-4 text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
            {jumpHint}
          </p>
        )}
      </div>
    </div>
  );
}
