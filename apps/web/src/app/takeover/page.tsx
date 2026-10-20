'use client';

/**
 * 浏览器接管页(scenario-loop §6「发布权归人」)。
 *
 * 把服务器上无头运行的持久化浏览器投射到这一页:CDP screencast 帧走 SSE 画到
 * canvas,鼠标/键盘/滚轮回传 PUT 转发到同一 Page —— 任务工具填好的发布页
 * 原样在屏幕上,用户亲眼核对、亲自点发布。全程受会话 cookie 鉴权,
 * 凭据与登录态不出服务器。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  X,
  Send,
  MousePointerClick,
  ShieldCheck,
} from 'lucide-react';

type Phase = 'starting' | 'live' | 'done' | 'error';

interface FrameData {
  data: string;
  w: number;
  h: number;
}

const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** keydown e.key → Playwright 键名(带修饰键组合) */
function toPlaywrightKey(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Dead' || k === 'Compose' || k.startsWith('Media') || k.startsWith('Audio')) return null;
  let key: string;
  if (k.length === 1) {
    key = k;
    if (key === ' ') key = 'Space';
  } else if (SPECIAL_KEYS.has(k)) {
    key = k;
  } else if (/^F\d{1,2}$/.test(k)) {
    key = k;
  } else {
    return null; // Shift/Meta 等纯修饰键按下本身不转发(组合在最终键一起发)
  }
  const mods: string[] = [];
  if (e.ctrlKey && k.toLowerCase() !== 'control') mods.push('Control');
  if (e.altKey && k.toLowerCase() !== 'alt') mods.push('Alt');
  if (e.metaKey && k.toLowerCase() !== 'meta' && !e.ctrlKey) mods.push('Meta');
  return mods.length ? `${mods.join('+')}+${key}` : key;
}

export default function TakeoverPage() {
  const [phase, setPhase] = useState<Phase>('starting');
  const [detail, setDetail] = useState('');
  const [nav, setNav] = useState<{ url: string; title?: string } | null>(null);
  const [frameInfo, setFrameInfo] = useState<FrameData | null>(null);
  const [insertText, setInsertText] = useState('');
  const [fps, setFps] = useState(0);
  // 输入被服务端拒绝时的可见回显(替代旧的静默吞错,让「点不动」变成看得见的错误)
  const [inputErr, setInputErr] = useState('');

  const sessionIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameTimesRef = useRef<number[]>([]);
  const pageDimsRef = useRef<{ w: number; h: number }>({ w: 1280, h: 800 });
  const inputErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 闪一条输入错误(4s 自动消失;高频 move/scroll 不走这里,防刷屏) */
  const flashInputErr = useCallback((msg: string) => {
    setInputErr(msg);
    if (inputErrTimer.current) clearTimeout(inputErrTimer.current);
    inputErrTimer.current = setTimeout(() => setInputErr(''), 4000);
  }, []);

  /** 发送一条输入到接管会话;服务端拒绝时回显(高频 move/scroll 静默,防刷屏) */
  const sendInput = useCallback(
    async (input: { type: string; [k: string]: unknown }) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const loud = input.type !== 'move' && input.type !== 'scroll';
      try {
        const res = await fetch('/api/browser/takeover', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, input }),
        });
        const data = await res.json().catch(() => null);
        if (!loud) return;
        if (data && data.ok === false) {
          flashInputErr(data.error || '输入未被接受');
        } else if (!res.ok) {
          flashInputErr(`输入转发失败(HTTP ${res.status})`);
        }
      } catch {
        // 偶发网络失败:会话本体由 SSE done 事件收口,这里只回显可见错误
        if (loud) flashInputErr('输入转发失败(网络错误)');
      }
    },
    [flashInputErr]
  );

  /** 帧上屏 + fps 统计 */
  const drawFrame = useCallback((base64: string, w: number, h: number) => {
    pageDimsRef.current = { w, h };
    setFrameInfo({ data: base64, w, h });
    const img = imgRef.current ?? (imgRef.current = new Image());
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0);
      const now = performance.now();
      const times = frameTimesRef.current;
      times.push(now);
      while (times.length > 0 && now - times[0] > 2000) times.shift();
      setFps(Math.round(times.length / 2));
    };
    img.src = `data:image/jpeg;base64,${base64}`;
  }, []);

  /** 画布坐标 → 页面坐标(canvas CSS 尺寸与页面视口等比缩放) */
  const pageCoords = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { w, h } = pageDimsRef.current;
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * w),
      y: Math.round(((e.clientY - rect.top) / rect.height) * h),
    };
  };

  // 启动/接续会话 + SSE 订阅
  useEffect(() => {
    let cancelled = false;
    const url = new URL(window.location.href).searchParams.get('url') || undefined;

    const start = async () => {
      try {
        const res = await fetch(
          url ? `/api/browser/takeover?url=${encodeURIComponent(url)}` : '/api/browser/takeover',
          { method: 'POST' }
        );
        const data = await res.json();
        if (!data.success) {
          if (res.status === 409 && data.sessionId) {
            sessionIdRef.current = data.sessionId;
          } else {
            setPhase('error');
            setDetail(data.error || '无法启动接管会话');
            return;
          }
        } else {
          sessionIdRef.current = data.sessionId;
          if (data.hasActiveMission) {
            setDetail('注意:你有一个进行中的任务也在使用这个浏览器,操作可能互相干扰');
          }
        }
        if (cancelled) return;
        setPhase('live');

        const sid = sessionIdRef.current!;
        const es = new EventSource(`/api/browser/takeover?sessionId=${sid}`);
        esRef.current = es;
        es.addEventListener('frame', (ev) => {
          try {
            const f = JSON.parse((ev as MessageEvent).data);
            drawFrame(f.data, f.w, f.h);
          } catch {}
        });
        es.addEventListener('nav', (ev) => {
          try {
            const n = JSON.parse((ev as MessageEvent).data);
            setNav({ url: n.url, title: n.title });
          } catch {}
        });
        es.addEventListener('status', (ev) => {
          try {
            const s = JSON.parse((ev as MessageEvent).data);
            if (s.detail) setDetail(s.detail);
          } catch {}
        });
        es.addEventListener('done', (ev) => {
          try {
            const d = JSON.parse((ev as MessageEvent).data);
            setPhase('done');
            setDetail(
              d.outcome === 'stopped'
                ? '已结束接管'
                : d.outcome === 'idle'
                ? '长时间无操作,接管已自动结束'
                : d.outcome === 'capped'
                ? '接管时长达到上限,已自动结束'
                : `接管异常结束:${d.detail || ''}`
            );
          } catch {}
          es.close();
        });
        es.onerror = () => {
          // SSE 断连(done 后的正常关闭也会触发);live 态下静默,浏览器自动重连
        };
      } catch (err: any) {
        setPhase('error');
        setDetail(err?.message || '网络错误');
      }
    };
    void start();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      if (inputErrTimer.current) clearTimeout(inputErrTimer.current);
    };
  }, [drawFrame]);

  // 结束接管
  const stopSession = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    esRef.current?.close();
    esRef.current = null;
    await fetch(`/api/browser/takeover?sessionId=${sid}`, { method: 'DELETE' }).catch(() => {});
    setPhase('done');
    setDetail('已结束接管');
  }, []);

  // 画布键盘转发(canvas 聚焦时;工具栏输入框不打扰)
  const onCanvasKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const key = toPlaywrightKey(e.nativeEvent);
      if (!key) return;
      e.preventDefault();
      void sendInput({ type: 'key', key });
    },
    [sendInput]
  );

  // 粘贴 → insertText(中文输入的主通道)
  const onCanvasPaste = useCallback(
    (e: React.ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text');
      if (text) void sendInput({ type: 'insert', text: text.slice(0, 5000) });
    },
    [sendInput]
  );

  const host = typeof window !== 'undefined' ? window.location.host : '';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* 顶栏:导航控制 + 地址 + 状态 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/80 flex-wrap">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-blue-400">
          <ShieldCheck className="h-4 w-4" />
          浏览器接管
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void sendInput({ type: 'back' })}
            title="后退"
            className="p-1.5 rounded hover:bg-zinc-800 disabled:opacity-40"
            disabled={phase !== 'live'}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => void sendInput({ type: 'forward' })}
            title="前进"
            className="p-1.5 rounded hover:bg-zinc-800 disabled:opacity-40"
            disabled={phase !== 'live'}
          >
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            onClick={() => void sendInput({ type: 'reload' })}
            title="刷新"
            className="p-1.5 rounded hover:bg-zinc-800 disabled:opacity-40"
            disabled={phase !== 'live'}
          >
            <RotateCw className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 min-w-0 px-2 py-1 rounded bg-zinc-800/60 text-xs text-zinc-300 font-mono truncate">
          {nav?.url || '—'}
        </div>
        <span className="text-[10px] font-mono text-zinc-500">
          {frameInfo ? `${frameInfo.w}×${frameInfo.h} · ${fps}fps` : ''}
        </span>
        <button
          onClick={() => void stopSession()}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-red-600/80 hover:bg-red-600 disabled:opacity-40"
          disabled={phase !== 'live'}
        >
          <X className="h-3.5 w-3.5" />
          结束接管
        </button>
      </div>

      {/* 主区:画布(黑幕 + 等比缩放) */}
      <div className="flex-1 relative flex items-center justify-center p-3 overflow-auto">
        {phase === 'live' && (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            className="max-w-full max-h-full rounded-lg border border-zinc-800 shadow-2xl outline-none cursor-default bg-white"
            style={{ aspectRatio: frameInfo ? `${frameInfo.w}/${frameInfo.h}` : '1280/800' }}
            onKeyDown={onCanvasKeyDown}
            onPaste={onCanvasPaste}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              (e.target as HTMLElement).focus();
              const { x, y } = pageCoords(e);
              const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
              void sendInput({ type: 'move', x, y });
              void sendInput({ type: 'click', x, y, button });
            }}
            onDoubleClick={(e) => {
              const { x, y } = pageCoords(e);
              void sendInput({ type: 'click', x, y, clickCount: 2 });
            }}
            onWheel={(e) => {
              const { x, y } = pageCoords(e);
              void sendInput({
                type: 'scroll',
                x,
                y,
                deltaX: Math.round(e.deltaX),
                deltaY: Math.round(e.deltaY),
              });
            }}
          />
        )}

        {phase === 'starting' && (
          <div className="flex flex-col items-center gap-3 text-zinc-400">
            <MousePointerClick className="h-8 w-8 animate-pulse" />
            <p className="text-sm">正在接管服务器上的浏览器…</p>
          </div>
        )}
        {phase === 'error' && (
          <div className="max-w-md text-center text-sm text-red-400">
            <p className="font-medium mb-1">接管失败</p>
            <p className="text-zinc-400 text-xs">{detail}</p>
          </div>
        )}
        {phase === 'done' && (
          <div className="max-w-md text-center text-sm">
            <p className="font-medium text-zinc-200 mb-1">{detail || '已结束接管'}</p>
            <p className="text-zinc-500 text-xs">可以关闭此页;浏览器登录态与页面状态保留在服务器。</p>
          </div>
        )}
      </div>

      {/* 底栏:提示 + 中文文字插入(键盘转发只覆盖英文/功能键) */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-800 bg-zinc-900/80 flex-wrap">
        <input
          value={insertText}
          onChange={(e) => setInsertText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && insertText.trim()) {
              void sendInput({ type: 'insert', text: insertText.slice(0, 5000) });
              setInsertText('');
            }
          }}
          placeholder="要输入到页面的文字(中文/长文本,回车发送)"
          className="flex-1 min-w-48 px-2 py-1.5 rounded bg-zinc-800/60 text-xs border border-zinc-700 focus:border-blue-500 outline-none"
        />
        <button
          onClick={() => {
            if (insertText.trim()) {
              void sendInput({ type: 'insert', text: insertText.slice(0, 5000) });
              setInsertText('');
            }
          }}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40"
          disabled={phase !== 'live' || !insertText.trim()}
        >
          <Send className="h-3.5 w-3.5" />
          发送
        </button>
        <span className="text-[10px] text-zinc-500 font-mono">{host}</span>
      </div>

      {detail && phase === 'live' && (
        <div className="px-3 pb-2 text-[11px] text-amber-400/80">{detail}</div>
      )}

      {inputErr && phase === 'live' && (
        <div className="px-3 pb-2 text-[11px] text-red-400/90 flex items-center gap-1">
          <MousePointerClick className="h-3 w-3" />
          {inputErr}
        </div>
      )}
    </div>
  );
}
