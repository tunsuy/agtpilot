'use client';

/**
 * 小红书网页版扫码登录弹窗(scenario-loop P2 模块 1)。
 *
 * 远程部署形态:浏览器在服务器上无头运行,弹窗实时回传页面截图,
 * 用户用手机小红书 App 扫截图里的二维码 —— 全程登录态只落服务器
 * 的 per-user 浏览器 profile,前端只见过画面、不过凭据。
 */
import { useEffect, useRef, useState } from 'react';
import { X, RefreshCw, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface XhsWebLoginModalProps {
  onClose: () => void;
  /** 登录成功回调(连接器页刷新登录徽标) */
  onLoggedIn?: () => void;
}

type Phase =
  | 'idle' // 请求会话中
  | 'starting'
  | 'opening'
  | 'waiting'
  | 'confirming'
  | 'success'
  | 'timeout'
  | 'cancelled'
  | 'error';

const PHASE_HINTS: Record<string, string> = {
  starting: '正在启动浏览器…',
  opening: '正在打开小红书创作平台…',
  waiting: '请用小红书 App 扫描下方二维码',
  confirming: '扫码成功,正在确认登录…',
  success: '登录成功,已保存在本服务',
};

/** 剩余时间 mm:ss */
function fmtRemain(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const TIMEOUT_MS = 300_000;

export function XhsWebLoginModal({ onClose, onLoggedIn }: XhsWebLoginModalProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [detail, setDetail] = useState<string>('');
  const [frame, setFrame] = useState<string>('');
  const [remainMs, setRemainMs] = useState(TIMEOUT_MS);
  const sessionIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const startedAtRef = useRef<number>(Date.now());
  const successNotifiedRef = useRef(false);

  const openSession = async () => {
    // 清上一轮状态
    esRef.current?.close();
    esRef.current = null;
    sessionIdRef.current = null;
    setPhase('idle');
    setDetail('');
    setFrame('');
    setRemainMs(TIMEOUT_MS);
    startedAtRef.current = Date.now();

    try {
      const res = await fetch('/api/browser/login', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        // 409:已有进行中的会话 —— 直接接上它的流
        if (res.status === 409 && data.sessionId) {
          sessionIdRef.current = data.sessionId;
        } else {
          setPhase('error');
          setDetail(data.error || '无法启动登录会话');
          return;
        }
      } else {
        sessionIdRef.current = data.sessionId;
        if (data.hasActiveMission) {
          setDetail('提示:你有进行中的任务,登录过程与其共享浏览器页面,建议任务空闲时再扫码');
        }
      }

      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      const es = new EventSource(`/api/browser/login?sessionId=${encodeURIComponent(sessionId)}`);
      esRef.current = es;
      es.addEventListener('status', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data);
          setPhase(payload.phase as Phase);
          if (payload.detail) setDetail(payload.detail);
        } catch {}
      });
      es.addEventListener('frame', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data);
          if (payload.screenshotBase64) {
            setFrame(`data:image/jpeg;base64,${payload.screenshotBase64}`);
          }
        } catch {}
      });
      es.addEventListener('done', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data);
          setPhase(payload.outcome === 'success' ? 'success' : (payload.outcome as Phase));
          if (payload.detail) setDetail(payload.detail);
          if (payload.outcome === 'success' && !successNotifiedRef.current) {
            successNotifiedRef.current = true;
            onLoggedIn?.();
          }
        } catch {}
        es.close();
        esRef.current = null;
      });
      es.onerror = () => {
        // 服务端关流(done 后)会触发 error;非终态时由 remain 倒计时兜底
        es.close();
        esRef.current = null;
      };
    } catch {
      setPhase('error');
      setDetail('网络异常,无法连接登录通道');
    }
  };

  useEffect(() => {
    void openSession();
    return () => {
      esRef.current?.close();
      // 关弹窗 = 取消会话(未完成时)
      const sid = sessionIdRef.current;
      if (sid && !['success'].includes(phase)) {
        fetch(`/api/browser/login?sessionId=${encodeURIComponent(sid)}`, { method: 'DELETE' }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 倒计时(仅等待阶段展示)
  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'starting' && phase !== 'opening' && phase !== 'confirming') return;
    const timer = setInterval(() => {
      setRemainMs(TIMEOUT_MS - (Date.now() - startedAtRef.current));
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const isTerminal = ['success', 'timeout', 'cancelled', 'error'].includes(phase);
  const hint = PHASE_HINTS[phase] || detail || '';

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="w-full max-w-md max-h-[88vh] overflow-y-auto rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-red-500" />
              小红书网页版 · 扫码登录
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
              登录态保存在本服务的浏览器环境,只用于读取创作数据与保存草稿
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 p-1 rounded-md">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 实时画面:服务器上无头浏览器的截图流 */}
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 overflow-hidden">
          {frame ? (
            <img src={frame} alt="登录页面实时画面" className="w-full aspect-[16/10] object-cover object-top" />
          ) : (
            <div className="w-full aspect-[16/10] flex items-center justify-center">
              <span className="text-xs text-zinc-400 animate-pulse">
                {phase === 'idle' ? '正在建立登录通道…' : '正在打开页面…'}
              </span>
            </div>
          )}
        </div>

        {/* 状态行:指引 / 结果 / 剩余时间 */}
        <div className="space-y-2">
          {phase === 'success' ? (
            <p className="flex items-center gap-1.5 text-xs text-emerald-700 font-medium">
              <CheckCircle2 className="h-4 w-4" />
              {hint || '登录成功'}
              {detail ? <span className="text-zinc-400 font-normal">({detail})</span> : null}
            </p>
          ) : isTerminal ? (
            <p className="flex items-center gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="h-4 w-4" />
              {phase === 'timeout' ? '等待扫码超时,未完成登录' : phase === 'cancelled' ? '已取消登录' : detail || '登录未完成'}
            </p>
          ) : (
            <div className="flex items-center justify-between text-xs text-zinc-600">
              <span>{hint || '等待中…'}</span>
              <span className="font-mono text-[11px] text-zinc-400">{fmtRemain(remainMs)}</span>
            </div>
          )}
          {detail && !isTerminal && phase !== 'waiting' && (
            <p className="text-[11px] text-amber-600 leading-relaxed">{detail}</p>
          )}
        </div>

        {/* 操作区:完成关闭 / 失败重试 */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 hover:bg-zinc-100 transition">
            {phase === 'success' ? '完成' : '关闭'}
          </button>
          {isTerminal && phase !== 'success' && (
            <button
              type="button"
              onClick={() => void openSession()}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-xs font-medium transition shadow-xs"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>重试</span>
            </button>
          )}
        </div>

        <p className="text-[10px] text-zinc-400 leading-relaxed">
          说明:本功能属于「托管模式」的一部分,默认关闭;开启前会在连接器页看到风险说明。
          登录不会授权 Agent 发布 —— 发布按钮被代码级围栏永久拦截。
        </p>
      </div>
    </div>
  );
}
