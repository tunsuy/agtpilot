import * as zlib from 'zlib';
import type { ToolDefinition } from '@agtpilot/core';
import { renderWechatMarkdown } from './wechat-md-render';
import { WECHAT_MD_THEMES, DEFAULT_WECHAT_MD_THEME_ID } from './wechat-md-themes';
import {
  getUserConnectors,
  getBrowserAudit,
  appendBrowserAudit,
  type BrowserAuditEntry,
} from './user-store';

/**
 * 微信公众号草稿箱直连(官方 API,合规半自动)
 *
 * 链路:凭证(AppID:AppSecret,按用户加密存 user-store,执行时才读取)
 *   → stable_token 换 access_token(内存缓存,提前 5 分钟过期)
 *   → 封面图(用户给 URL 则下载;否则按主题关键词检索 Wikimedia Commons
 *     免版权图(CC0/公共领域)并用共享浏览器临时标签页叠加标题排版;
 *     检索不到回退纯排版封面,浏览器不可用回退纯 JS 渐变占位)上传永久素材
 *   → Markdown → 公众号 HTML(内联样式,微信编辑器保留)
 *   → draft/add 写入草稿箱。
 * 发布动作始终由用户在公众平台后台人工完成(不提供 freepublish,内容安全人工终审)。
 * create_draft 为 dangerLevel high(编排器审批门,投递前用户逐次确认)
 * + 每日投递上限 + 全程审计(复用 user-store 写操作审计,成败都计)。
 * 凭证在连接器页「微信公众号(草稿箱直连)」卡片配置(通用 /api/connectors 读写,
 * 工坊表单经专用 /api/wechat-mp route 查状态/测试连接)。
 *
 * 常见错误白话化:40164=IP 白名单、48001=需认证、40001/40125=Secret 错误。
 * 测试可通过 WECHAT_MP_API_BASE 指向 mock 服务。
 */

export const WECHAT_MP_CRED_KEY = 'WECHAT_MP_CREDENTIAL';

const apiBase = () =>
  (process.env.WECHAT_MP_API_BASE || 'https://api.weixin.qq.com').replace(/\/+$/, '');

/** 解析「AppID:AppSecret」(容忍中文冒号/逗号/空格/竖线分隔) */
export function parseWechatMpCredential(raw?: string): { appId: string; appSecret: string } | null {
  const t = (raw || '').trim();
  if (!t) return null;
  const m = t.match(/^([A-Za-z0-9_-]+)\s*[:：,，|]\s*([A-Za-z0-9_.-]+)\s*$/);
  if (m) return { appId: m[1], appSecret: m[2] };
  const sp = t.split(/\s+/);
  if (sp.length === 2) return { appId: sp[0], appSecret: sp[1] };
  return null;
}

export function friendlyWechatError(errcode: number, errmsg: string): string {
  if (errcode === 40164) {
    return `调用被拒(40164):发起请求的服务器 IP 不在公众号 IP 白名单内。微信提示:${errmsg}。请到公众平台「设置与开发 → 基本配置 → IP 白名单」把提示中的 IP 加入后重试。`;
  }
  if (errcode === 48001 || errcode === 48004) {
    return `接口未授权(${errcode}):该公众号没有草稿箱/素材接口权限。草稿箱 API 仅对已认证公众号开放,请先完成微信认证。`;
  }
  if (errcode === 40001 || errcode === 40125 || errcode === 40013) {
    return `AppID/AppSecret 校验失败(${errcode}):请在连接器页「微信公众号(草稿箱直连)」卡片重新核对「AppID:AppSecret」(公众平台 → 设置与开发 → 基本配置)。`;
  }
  if (errcode === 45009) return '接口调用频率超限(45009),请稍后或明天再试。';
  return `微信接口报错(${errcode}):${errmsg}`;
}

// ---------- access_token(内存缓存) ----------

interface TokenEntry {
  token: string;
  expiresAt: number;
}
/** 缓存键含 appId:连接器页换绑凭证后旧 token 立即失效,不会继续写旧公众号 */
const tokenCache = new Map<string, TokenEntry>();
const tokenCacheKey = (userId: string, appId: string) => `${userId}:${appId}`;

async function getAccessToken(
  userId: string,
  force = false
): Promise<{ token?: string; error?: string }> {
  const cred = parseWechatMpCredential(getUserConnectors(userId).configs[WECHAT_MP_CRED_KEY]);
  if (!cred) {
    return {
      error:
        '未配置公众号凭证:请在连接器页「微信公众号(草稿箱直连)」卡片按 AppID:AppSecret 格式填写(公众平台 → 设置与开发 → 基本配置),并确保已完成微信认证 + 服务器 IP 已加白名单。',
    };
  }
  const cacheKey = tokenCacheKey(userId, cred.appId);
  const cached = tokenCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return { token: cached.token };
  try {
    const res = await fetch(`${apiBase()}/cgi-bin/stable_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: cred.appId,
        secret: cred.appSecret,
        force_refresh: false,
      }),
    });
    const data: any = await res.json();
    if (!data.access_token) {
      return { error: friendlyWechatError(data.errcode ?? -1, data.errmsg || 'access_token 获取失败') };
    }
    tokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(60, (data.expires_in || 7200) - 300) * 1000,
    });
    return { token: data.access_token };
  } catch (e: any) {
    return { error: `请求微信接口失败:${e?.message || e}` };
  }
}

// ---------- 投草稿限频 / 凭证检查 / 审计(scenario-loop 托管承诺,对齐 xhs-managed) ----------

/** 每日投草稿上限(可用 env 调整) */
export function dailyWechatDraftLimit(): number {
  const n = Number(process.env.AGTPILOT_WECHAT_DRAFT_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/** 今日(本地时区)已尝试的投草稿次数(成败都计,保守限频;按 tool 名过滤,与 xhs 审计互不干扰) */
export function countTodayWechatDrafts(audit: BrowserAuditEntry[], now = new Date()): number {
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  return audit.filter((e) => {
    if (e.tool !== 'wechat_mp_create_draft') return false;
    const d = new Date(e.at);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === dayKey;
  }).length;
}

/** 凭证连通性检查:解析 → 强刷 access_token(错误已白话化,可直接回显给用户) */
export async function checkWechatMpCredential(userId: string): Promise<{ ok: boolean; appId?: string; error?: string }> {
  const cred = parseWechatMpCredential(getUserConnectors(userId).configs[WECHAT_MP_CRED_KEY]);
  if (!cred) return { ok: false, error: '未配置凭证(格式:AppID:AppSecret)' };
  const tok = await getAccessToken(userId, true);
  if (!tok.token) return { ok: false, appId: cred.appId, error: tok.error };
  return { ok: true, appId: cred.appId };
}

/** 换绑/清除凭证时清掉内存 access_token 缓存(该用户全部 appId 的条目) */
export function resetWechatMpTokenCache(userId: string): void {
  for (const key of tokenCache.keys()) {
    if (key.startsWith(`${userId}:`)) tokenCache.delete(key);
  }
}

// ---------- 封面图:纯 JS 生成渐变 PNG(无第三方依赖) ----------

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** 900×383(公众号封面 2.35:1)对角渐变占位封面,色相由标题 hash 决定 */
export function generateCoverPng(seed: string): Buffer {
  const W = 900, H = 383;
  let h = 7;
  for (const ch of seed || 'agtpilot') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue1 = h % 360;
  const hue2 = (hue1 + 45 + (h % 50)) % 360;
  const c1 = hslToRgb(hue1, 0.5, 0.42);
  const c2 = hslToRgb(hue2, 0.58, 0.62);
  const stride = 1 + W * 3;
  const raw = Buffer.alloc(H * stride);
  for (let y = 0; y < H; y++) {
    const off = y * stride;
    raw[off] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const t = (x / W) * 0.65 + (y / H) * 0.35;
      const p = off + 1 + x * 3;
      raw[p] = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      raw[p + 1] = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      raw[p + 2] = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 主题配图检索(Wikimedia Commons,CC0/公共领域,免 key) ----------

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
// Wikimedia 拒绝无 UA 请求(403);声明产品身份
const COMMONS_UA = 'AgtPilot/1.0 (wechat-cover-image; server-side; https://agtpilot.local)';

export interface CommonsImage {
  bytes: Buffer;
  mime: string;
  /** 文件详情页(来源披露/人工核验用) */
  pageUrl: string;
}

/**
 * 按关键词检索一张可安全商用的横图:只接受 CC0/公共领域(公众号公开发布,
 * CC BY/CC BY-SA 的署名义务在封面场景无法履行,宁可不要)。任何一步失败
 * 返回 null,调用方回退排版封面——图片检索绝不阻塞投草稿。
 */
export async function searchCommonsImage(keywords: string): Promise<CommonsImage | null> {
  try {
    const kw = (keywords || '').trim().slice(0, 80);
    if (!kw) return null;
    const url =
      `${COMMONS_API}?action=query&format=json&generator=search` +
      `&gsrsearch=${encodeURIComponent(`${kw} filetype:bitmap`)}&gsrnamespace=6&gsrlimit=20` +
      `&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&iiurlwidth=1200`;
    const r = await fetch(url, { headers: { 'User-Agent': COMMONS_UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data: any = await r.json();
    const pages: any[] = Object.values(data?.query?.pages || {});
    const usable = pages.filter((p) => {
      const ii = p?.imageinfo?.[0];
      if (!ii) return false;
      if (ii.mime !== 'image/jpeg' && ii.mime !== 'image/png') return false;
      const w = Number(ii.width) || 0;
      const h = Number(ii.height) || 0;
      if (w < 800 || h < 300) return false;
      const ratio = w / h;
      if (ratio < 1.4 || ratio > 3.2) return false; // 封面 2.35:1,过窄/过长裁切后失焦
      const lic = String(ii.extmetadata?.LicenseShortName?.value || '').toLowerCase();
      return lic.includes('cc0') || lic.includes('public domain') || lic.startsWith('pd');
    });
    if (usable.length === 0) return null;
    // 前几名里随机挑一张:同题多篇文章封面不全雷同
    const pick = usable[Math.floor(Math.random() * Math.min(usable.length, 8))];
    const ii = pick.imageinfo[0];
    const dl = await fetch(ii.thumburl || ii.url, {
      headers: { 'User-Agent': COMMONS_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!dl.ok) return null;
    const bytes = Buffer.from(await dl.arrayBuffer());
    if (bytes.length < 5 * 1024 || bytes.length > 8 * 1024 * 1024) return null;
    return { bytes, mime: ii.mime, pageUrl: ii.descriptionurl || String(pick.title || '') };
  } catch {
    return null;
  }
}

// ---------- 内容排版封面(浏览器临时标签页渲染,失败回退纯渐变) ----------

/** 浏览器服务最小面(与 plugin-browser 的 ctx.browser 同构;测试可 mock) */
export interface WechatCoverBrowserService {
  acquirePage(userId?: string): Promise<any>;
}

/** 各排版主题对应的封面主色/底色(封面与正文风格一致) */
const COVER_THEME_ACCENTS: Record<string, [string, string]> = {
  'classic-green': ['#0a9d4e', '#eafaf1'],
  'tech-blue': ['#174ea6', '#ecf3fd'],
  'warm-orange': ['#c05a10', '#fdf1e5'],
  'ink-minimal': ['#20242a', '#f3f4f6'],
};

function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string;
  });
}

/** 标题视觉宽度(CJK 记 2,其他记 1)——决定字号档位 */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s || '') w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

/** 封面排版 HTML(导出仅供可视化调试/测试断言);photoDataUrl 存在时走"照片打底 + 白字排版"变体 */
export function coverHtml(opts: {
  title: string;
  digest?: string;
  author?: string;
  themeId?: string;
  photoDataUrl?: string;
}): string {
  const [accent, tint] = COVER_THEME_ACCENTS[opts.themeId || ''] || COVER_THEME_ACCENTS['tech-blue'];
  const w = visualWidth(opts.title);
  const titleSize = w > 48 ? 42 : w > 28 ? 52 : 62;
  const digest = (opts.digest || '').slice(0, 60);
  const byline = escapeHtml((opts.author || '').slice(0, 12) || 'AgtPilot');
  const photo = Boolean(opts.photoDataUrl);
  const titleColor = photo ? '#ffffff' : '#1d2129';
  const digestColor = photo ? 'rgba(255,255,255,0.80)' : '#5a6472';
  const bylineColor = photo ? '#ffffff' : accent;
  const markColor = photo ? 'rgba(255,255,255,0.55)' : '#9aa3af';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 900px; height: 383px; overflow: hidden; }
body {
  font-family: "WenQuanYi Zen Hei", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  background: ${photo ? `#10141a url(${opts.photoDataUrl}) center / cover no-repeat` : `linear-gradient(135deg, ${tint} 0%, #ffffff 62%, ${tint} 100%)`};
  position: relative;
  display: flex; flex-direction: column; justify-content: center;
  padding: 0 64px;
}
/* 照片变体:左深右浅横向蒙版,白字压得住任意底图 */
${photo ? `.scrim { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(13,16,22,0.86) 0%, rgba(13,16,22,0.55) 46%, rgba(13,16,22,0.10) 100%); }` : ''}
${photo ? '' : `.deco { position: absolute; border-radius: 50%; pointer-events: none; }
.deco1 { width: 320px; height: 320px; right: -110px; top: -130px; background: ${accent}; opacity: 0.10; }
.deco2 { width: 190px; height: 190px; right: 60px; bottom: -95px; background: ${accent}; opacity: 0.07; }
.deco3 { width: 120px; height: 120px; right: 190px; top: 46px; border: 2px solid ${accent}; opacity: 0.18; background: none; }`}
.bar { position: absolute; left: 0; top: 0; bottom: 0; width: 10px; background: ${accent}; }
h1 {
  color: ${titleColor}; font-size: ${titleSize}px; line-height: 1.32; font-weight: 700;
  letter-spacing: 0.5px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; max-width: 740px;
  ${photo ? 'text-shadow: 0 2px 14px rgba(0,0,0,0.45);' : 'text-shadow: 0 1px 0 rgba(255,255,255,0.8);'}
}
.digest {
  margin-top: 18px; color: ${digestColor}; font-size: 15px; line-height: 1.5;
  max-width: 680px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.byline {
  position: absolute; left: 64px; bottom: 30px;
  display: flex; align-items: center; gap: 8px;
  color: ${bylineColor}; font-size: 13px; font-weight: 700; letter-spacing: 2px;
}
.byline::before { content: ""; width: 22px; height: 2px; background: ${accent}; }
.mark { position: absolute; right: 64px; bottom: 30px; color: ${markColor}; font-size: 11px; letter-spacing: 1px; }
</style></head><body>
${photo ? '<div class="scrim"></div>' : '<div class="deco deco1"></div><div class="deco deco2"></div><div class="deco deco3"></div>'}
<div class="bar"></div>
<h1>${escapeHtml(opts.title)}</h1>
${digest ? `<div class="digest">${escapeHtml(digest)}</div>` : ''}
<div class="byline">${byline}</div>
<div class="mark">AgtPilot · 智能体创作</div>
</body></html>`;
}

/**
 * 渲染"标题/摘要入图"的内容封面:共享浏览器上下文里开**临时标签页**,
 * 不触碰用户的共享页(登录态/任务执行不受影响)。任何一步失败返回 null,
 * 调用方回退纯渐变占位——封面渲染绝不阻塞投草稿主链路。
 */
export async function renderContentCoverPng(
  browser: WechatCoverBrowserService,
  userId: string,
  opts: { title: string; digest?: string; author?: string; themeId?: string; photoDataUrl?: string }
): Promise<Buffer | null> {
  let temp: any;
  try {
    const shared = await browser.acquirePage(userId);
    temp = await shared.context().newPage();
    await temp.setViewportSize({ width: 900, height: 383 });
    await temp.setContent(coverHtml(opts), { waitUntil: 'domcontentloaded' });
    await temp.waitForTimeout(150); // 字体/排版沉降
    return await temp.screenshot({ type: 'png' });
  } catch {
    return null;
  } finally {
    if (temp) await temp.close().catch(() => {});
  }
}

// ---------- Markdown → 公众号 HTML(内联样式) ----------
// 渲染核心已升级为 doocs/md 式主题体系(markdown-it + 主题 CSS + juice 内联),
// 实现在 wechat-md-render.ts / wechat-md-themes.ts;此处保留入口转发:
// email-smtp.ts 复用同一渲染器(邮件客户端同样只认内联样式)。

/**
 * Markdown → 公众号可用的内联样式 HTML。
 * @param themeId 排版主题 id(wechat-md-themes.ts);缺省/未注册 → 默认主题
 */
export function markdownToWechatHtml(md: string, themeId?: string): string {
  return renderWechatMarkdown(md, themeId);
}

/** 摘要兜底:去 Markdown 语法后截取 */
function deriveDigest(md: string): string {
  const plain = (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*`#>|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, 110);
}

// ---------- 封面上传 ----------

async function uploadCover(
  token: string,
  coverUrl: string | undefined,
  opts: {
    userId: string;
    title: string;
    digest?: string;
    author?: string;
    themeId?: string;
    keywords?: string;
    browser?: WechatCoverBrowserService;
  }
): Promise<{
  mediaId?: string;
  coverKind: 'user-image' | 'auto-photo-typeset' | 'auto-photo-raw' | 'auto-typeset' | 'auto-gradient';
  photoPageUrl?: string;
  error?: string;
}> {
  let bytes: Buffer;
  let filename = 'cover.png';
  let ct = 'image/png';
  let coverKind: 'user-image' | 'auto-photo-typeset' | 'auto-photo-raw' | 'auto-typeset' | 'auto-gradient' =
    'user-image';
  let photoPageUrl: string | undefined;
  if (coverUrl && coverUrl.trim()) {
    try {
      const r = await fetch(coverUrl.trim());
      if (!r.ok) return { mediaId: undefined, coverKind, error: `封面图下载失败:HTTP ${r.status}` };
      const mime = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (!mime.startsWith('image/')) {
        return { mediaId: undefined, coverKind, error: `封面链接不是图片(content-type: ${mime || '未知'})` };
      }
      bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > 10 * 1024 * 1024) {
        return { mediaId: undefined, coverKind, error: '封面图超过微信 10MB 限制' };
      }
      ct = mime;
      filename = mime.includes('png') ? 'cover.png' : mime.includes('gif') ? 'cover.gif' : 'cover.jpg';
    } catch (e: any) {
      return { mediaId: undefined, coverKind, error: `封面图下载失败:${e?.message || e}` };
    }
  } else {
    // 主题配图优先:免版权图库检索 + 标题排版叠加;逐级回退,绝不阻塞
    const photo = await searchCommonsImage(opts.keywords || opts.title);
    if (photo) {
      photoPageUrl = photo.pageUrl;
      const rendered = opts.browser
        ? await renderContentCoverPng(opts.browser, opts.userId, {
            title: opts.title,
            digest: opts.digest,
            author: opts.author,
            themeId: opts.themeId,
            photoDataUrl: `data:${photo.mime};base64,${photo.bytes.toString('base64')}`,
          })
        : null;
      if (rendered && rendered.length) {
        bytes = rendered;
        coverKind = 'auto-photo-typeset';
      } else {
        // 浏览器不可用:原图直接作封面(仍是主题相关真图)
        bytes = photo.bytes;
        ct = photo.mime;
        filename = photo.mime.includes('png') ? 'cover.png' : 'cover.jpg';
        coverKind = 'auto-photo-raw';
      }
    } else {
      // 检索不到:纯排版封面(标题/摘要入图)
      const rendered = opts.browser
        ? await renderContentCoverPng(opts.browser, opts.userId, {
            title: opts.title,
            digest: opts.digest,
            author: opts.author,
            themeId: opts.themeId,
          })
        : null;
      if (rendered && rendered.length) {
        bytes = rendered;
        coverKind = 'auto-typeset';
      } else {
        bytes = generateCoverPng(opts.title);
        coverKind = 'auto-gradient';
      }
    }
  }
  const form = new FormData();
  // Buffer<ArrayBufferLike> 不满足 BlobPart 类型,拷进独立 Uint8Array
  form.append('media', new Blob([new Uint8Array(bytes)], { type: ct }), filename);
  const res = await fetch(
    `${apiBase()}/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
    { method: 'POST', body: form }
  );
  const data: any = await res.json();
  if (!data.media_id) {
    return {
      mediaId: undefined,
      coverKind,
      photoPageUrl,
      error: friendlyWechatError(data.errcode ?? -1, data.errmsg || '封面素材上传失败'),
    };
  }
  return { mediaId: data.media_id, coverKind, photoPageUrl };
}

// ---------- 工具工厂(按用户闭包,凭证执行时才从 user-store 读取) ----------

export function buildWechatMpTools(
  userId: string,
  browser?: WechatCoverBrowserService
): ToolDefinition[] {
  const checkSetup: ToolDefinition = {
    name: 'wechat_mp_check_setup',
    description:
      '诊断微信公众号草稿箱直连配置:校验 AppID:AppSecret 是否有效、能否获取 access_token,并把 IP 白名单(40164)/未认证(48001)/Secret 错误(40001)等问题翻译成可操作的中文指引。用户在连接器页「微信公众号(草稿箱直连)」卡片配置完成后应先调用本工具确认链路通畅。',
    dangerLevel: 'low',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const cred = parseWechatMpCredential(getUserConnectors(userId).configs[WECHAT_MP_CRED_KEY]);
      if (!cred) {
        return {
          success: false,
          configured: false,
          message:
            '尚未配置公众号凭证。请引导用户到连接器页「微信公众号(草稿箱直连)」卡片按 AppID:AppSecret 格式填写(公众平台 → 设置与开发 → 基本配置),并确认:1) 公众号已完成微信认证;2) 服务器出口 IP 已加入该页 IP 白名单。',
        };
      }
      const tok = await getAccessToken(userId, true);
      if (!tok.token) {
        return { success: false, configured: true, appId: cred.appId, error: tok.error };
      }
      return {
        success: true,
        configured: true,
        appId: cred.appId,
        message:
          '凭证有效,access_token 获取成功。可调用 wechat_mp_create_draft 把文章写入草稿箱;发布仍需用户在公众平台后台人工确认。',
      };
    },
  };

  const createDraft: ToolDefinition = {
    name: 'wechat_mp_create_draft',
    description:
      '把一篇 Markdown 文章经公众号排版(四套主题可选:微信绿/科技蓝/暖橙/极简黑白,内联样式 HTML)+ 封面处理(可传图片 URL;不传则按 cover_keywords 检索 Wikimedia Commons 免版权真实配图并叠加标题排版,检索不到回退标题/摘要排版封面)后,通过微信官方草稿箱接口写入用户公众号的草稿箱。写入后必须由用户在公众平台后台人工审核发布——本工具不会也不能直接发布。调用前需用户审批确认。每次调用计入每日上限,达到上限会收到拒绝提示。需要用户先在连接器页「微信公众号(草稿箱直连)」卡片配置 AppID:AppSecret(已认证公众号 + IP 白名单)。',
    dangerLevel: 'high',
    compensation: {
      kind: 'partially-reversible',
      undoHint: '草稿可在公众平台后台「草稿箱」中编辑或删除;未影响已发布内容',
    },
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文章标题,不超过 64 字,超长自动截断' },
        markdown: { type: 'string', description: '文章正文,Markdown 格式(标题/列表/引用/代码块/图片均可)' },
        theme: {
          type: 'string',
          description: `排版主题 id:${WECHAT_MD_THEMES.map((t) => `${t.id}(${t.name})`).join(' / ')};缺省为 ${DEFAULT_WECHAT_MD_THEME_ID}`,
          enum: WECHAT_MD_THEMES.map((t) => t.id),
        },
        author: { type: 'string', description: '作者名(可选)' },
        digest: { type: 'string', description: '摘要,不超过 120 字(可选,缺省自动从正文提取)' },
        cover_url: { type: 'string', description: '封面图 URL(可选,不传则自动生成封面,用户可在后台替换)' },
        cover_keywords: {
          type: 'string',
          description:
            '封面主题关键词(可选,建议英文,如 "robot technology city night");不传则用标题检索。用于从 Wikimedia Commons 免版权图库(CC0/公共领域)检索贴合主题的真实配图并叠加标题排版;检索不到回退纯排版封面',
        },
        content_source_url: { type: 'string', description: '原文链接(可选,显示为「阅读原文」)' },
      },
      required: ['title', 'markdown'],
    },
    execute: async (args: any, session: any) => {
      const { title, markdown, theme, author, digest, cover_url, cover_keywords, content_source_url } = args || {};
      const missionId = session?.taskId;
      const t = String(title || '').trim();
      const md = String(markdown || '');
      if (!t) return { success: false, error: '缺少标题 title' };
      if (!md.trim()) return { success: false, error: '缺少正文 markdown' };

      // ① 限频前置:今日尝试次数(成败都计)达到上限直接拒绝,不请求微信接口、不落审计
      const todayCount = countTodayWechatDrafts(getBrowserAudit(userId));
      if (todayCount >= dailyWechatDraftLimit()) {
        return {
          success: false,
          rejected: true,
          error: `已达今日投草稿上限(${dailyWechatDraftLimit()} 次)。明天再试,或复制文章内容到公众平台后台手动创建。`,
        };
      }

      const auditFailure = (error: string) =>
        appendBrowserAudit(userId, {
          at: Date.now(),
          tool: 'wechat_mp_create_draft',
          action: 'create_draft',
          title: t,
          result: 'failure',
          error,
          missionId,
        });

      const tok = await getAccessToken(userId);
      if (!tok.token) {
        auditFailure('not_configured_or_invalid');
        return { success: false, error: tok.error };
      }

      const finalTitle = t.length > 64 ? `${t.slice(0, 61)}...` : t;
      // 摘要先行:内容封面要把摘要排进图里(封面渲染在正文 HTML 之前)
      const finalDigest = String(digest || '').trim() ? String(digest).trim().slice(0, 120) : deriveDigest(md);
      const finalAuthor = author ? String(author).slice(0, 8) : '';
      const themeId = typeof theme === 'string' ? theme : undefined;
      const cover = await uploadCover(tok.token, cover_url, {
        userId,
        title: finalTitle,
        digest: finalDigest,
        author: finalAuthor,
        themeId,
        keywords: typeof cover_keywords === 'string' ? cover_keywords : undefined,
        browser,
      });
      if (!cover.mediaId) {
        auditFailure(cover.error || 'cover_upload_failed');
        return { success: false, error: cover.error };
      }

      const content = markdownToWechatHtml(md, themeId);
      if (Buffer.byteLength(content, 'utf8') > 1.9 * 1024 * 1024) {
        auditFailure('content_too_large');
        return { success: false, error: '正文过长(公众号上限约 2MB),请精简后重试' };
      }

      try {
        const res = await fetch(
          `${apiBase()}/cgi-bin/draft/add?access_token=${encodeURIComponent(tok.token)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              articles: [
                {
                  title: finalTitle,
                  author: finalAuthor,
                  digest: finalDigest,
                  content,
                  content_source_url: content_source_url || '',
                  thumb_media_id: cover.mediaId,
                  need_open_comment: 0,
                  only_fans_can_comment: 0,
                },
              ],
            }),
          }
        );
        const data: any = await res.json();
        if (!data.media_id) {
          const error = friendlyWechatError(data.errcode ?? -1, data.errmsg || '草稿创建失败');
          auditFailure(error);
          return {
            success: false,
            error,
          };
        }
        // ② 审计(成败都落;成功也计数——限频是保守语义)
        appendBrowserAudit(userId, {
          at: Date.now(),
          tool: 'wechat_mp_create_draft',
          action: 'create_draft',
          title: finalTitle,
          result: 'success',
          missionId,
        });
        return {
          success: true,
          draft_media_id: data.media_id,
          title: finalTitle,
          cover:
            cover.coverKind === 'user-image'
              ? '使用指定封面图'
              : cover.coverKind === 'auto-photo-typeset'
                ? '自动检索主题配图(Wikimedia Commons CC0/公共领域)并叠加标题排版,可在后台替换'
                : cover.coverKind === 'auto-photo-raw'
                  ? '自动检索主题配图(Wikimedia Commons CC0/公共领域)直接作封面,可在后台替换'
                  : cover.coverKind === 'auto-typeset'
                    ? '自动生成排版封面(标题/摘要已入图,未检索到贴合主题的免版权图,可在后台替换)'
                    : '自动生成渐变占位封面(渲染服务暂不可用,可在后台替换)',
          ...(cover.photoPageUrl ? { coverImageSource: cover.photoPageUrl } : {}),
          message: `✅ 草稿已写入公众号草稿箱(media_id: ${data.media_id})。请提醒用户到公众平台后台或订阅号助手 App 人工审核后发布。今日已用 ${todayCount + 1}/${dailyWechatDraftLimit()} 次。`,
        };
      } catch (e: any) {
        const message = `草稿创建请求失败:${e?.message || e}`;
        auditFailure(message);
        return { success: false, error: message };
      }
    },
  };

  return [checkSetup, createDraft];
}
