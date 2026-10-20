'use client';

/**
 * IM 通道运维面板(可复用主体)。
 *
 * 从 app/channel/page.tsx 抽出,供两处共享同一套逻辑与 UI:
 * 1. 独立路由页 /channel(移动端「我的」列表仍走此路由);
 * 2. 桌面端右上角「IM 通道」按钮唤起的弹窗(ChannelModal)——
 *    与「下载移动版」一致的弹窗形态,不再整页跳转。
 *
 * 三件事:
 * 1. 通道状态总览(GET /api/channel/status)
 * 2. 微信个人号(iLink)扫码授权:取码 → 手机微信扫码 → 轮询到 confirmed 自动落盘热挂载
 *    (POST/GET /api/channel/wechat-personal/qr;bot_token 永不回显到本面板)
 * 3. 生成 IM 绑定码(POST /api/channel/bind-code):在任意已接入通道对机器人发「绑定 <码>」
 *
 * 不含页面外框(min-h-screen)与标题头 —— 由调用方(页面/弹窗)各自提供,避免标题重复。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, RefreshCw, Link2, Unplug, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface AdapterStatus {
  channel: string;
  state: string;
  capabilities: readonly string[];
}

interface StatusResponse {
  success: boolean;
  ready: boolean;
  adapters: AdapterStatus[];
  recentErrors: Array<{ channel: string; code: string; message: string; retryable: boolean; at?: string }>;
}

type QrPhase = 'idle' | 'loading' | 'scanning' | 'confirmed' | 'expired' | 'error';

const CHANNEL_LABELS: Record<string, string> = {
  wechat_mp: '微信公众号(客服消息)',
  wechat_personal: '微信个人号(iLink 官方协议)',
  qq_onebot: 'QQ(NapCat / OneBot v11)',
};

const STATE_LABELS: Record<string, { text: string; ok: boolean }> = {
  connected: { text: '已连接', ok: true },
  connecting: { text: '连接中', ok: false },
  disconnected: { text: '未连接', ok: false },
  error: { text: '错误', ok: false },
};

export function ChannelPanel() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusErr, setStatusErr] = useState('');

  // 扫码授权
  const [qrPhase, setQrPhase] = useState<QrPhase>('idle');
  const [qrImg, setQrImg] = useState('');
  const [qrNote, setQrNote] = useState('');
  const handleRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 绑定码
  const [bindCode, setBindCode] = useState('');
  const [bindErr, setBindErr] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/channel/status');
      const data = await res.json();
      if (data.success) {
        setStatus(data);
        setStatusErr('');
      } else {
        setStatusErr(data.error || '状态获取失败');
      }
    } catch {
      setStatusErr('无法连接服务端(未登录或服务未启动)');
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadStatus]);

  async function renderQr(content: string) {
    const url = await QRCode.toDataURL(content, {
      width: 260,
      margin: 1,
      color: { dark: '#18181b', light: '#ffffff' },
    });
    setQrImg(url);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function startQr() {
    stopPolling();
    setQrPhase('loading');
    setQrNote('');
    setQrImg('');
    try {
      const res = await fetch('/api/channel/wechat-personal/qr', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setQrPhase('error');
        setQrNote(data.error || '获取二维码失败');
        return;
      }
      handleRef.current = data.handle;
      await renderQr(data.qrContent);
      setQrPhase('scanning');
      setQrNote('请用手机微信「扫一扫」下方二维码,并在手机上确认授权');
      pollRef.current = setInterval(pollQr, 2000);
    } catch (err: any) {
      setQrPhase('error');
      setQrNote(err?.message || '网络错误');
    }
  }

  async function pollQr() {
    const handle = handleRef.current;
    if (!handle) return stopPolling();
    try {
      const res = await fetch(`/api/channel/wechat-personal/qr?handle=${encodeURIComponent(handle)}`);
      const data = await res.json();
      if (!data.success) return; // 瞬时错误继续轮
      if (data.status === 'confirmed') {
        stopPolling();
        setQrPhase('confirmed');
        setQrNote('✅ 授权成功!bot_token 已安全落盘,通道已热挂载,无需重启。');
        setQrImg('');
        void loadStatus();
        return;
      }
      if (data.status === 'expired' || data.status === 'verify_code_blocked') {
        stopPolling();
        setQrPhase('expired');
        setQrNote(data.status === 'expired' ? '二维码已过期,请重新获取' : '需要验证码且已被阻塞,请稍后再试');
        return;
      }
      if (data.status === 'unknown_handle') {
        stopPolling();
        setQrPhase('expired');
        setQrNote('会话已失效,请重新获取二维码');
        return;
      }
      if (data.status === 'scaned') {
        setQrNote('已扫码 ✔ 请在手机上点击确认授权');
      }
      if (data.status === 'need_verifycode') {
        setQrNote('微信要求输入验证码,请按手机提示操作');
      }
      // 换 host 重取码(scaned_but_redirect / binded_redirect):服务端已换新码
      if (data.qrContent) {
        await renderQr(data.qrContent);
        setQrNote('微信要求切换到新接入点,请重新扫描上方新二维码');
      }
    } catch {
      // 轮询瞬时失败:忽略,下一拍再试
    }
  }

  async function genBindCode() {
    setBindErr('');
    try {
      const res = await fetch('/api/channel/bind-code', { method: 'POST' });
      const data = await res.json();
      if (data.success) setBindCode(data.code);
      else setBindErr(data.error || '生成失败');
    } catch {
      setBindErr('网络错误');
    }
  }

  return (
    <div className="space-y-6">
      {/* 状态总览 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold flex items-center gap-2">
            <Unplug size={16} /> 通道状态
          </h2>
          <button
            onClick={() => void loadStatus()}
            className="text-xs text-zinc-500 hover:text-zinc-800 flex items-center gap-1"
          >
            <RefreshCw size={12} /> 刷新
          </button>
        </div>
        {statusErr && <p className="text-sm text-red-600">{statusErr}</p>}
        {status && (
          <ul className="space-y-2">
            {status.adapters.length === 0 && (
              <li className="text-sm text-zinc-400">
                暂无已注册通道(未配置凭证的通道不会出现,属正常 fail-closed 行为)
              </li>
            )}
            {status.adapters.map((a) => {
              const st = STATE_LABELS[a.state] ?? { text: a.state, ok: false };
              return (
                <li key={a.channel} className="flex items-center justify-between text-sm">
                  <span>{CHANNEL_LABELS[a.channel] ?? a.channel}</span>
                  <span className={`flex items-center gap-1 ${st.ok ? 'text-emerald-600' : 'text-zinc-400'}`}>
                    {st.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                    {st.text}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {status && status.recentErrors.length > 0 && (
          <details className="mt-3 text-xs text-zinc-500">
            <summary className="cursor-pointer">最近错误({status.recentErrors.length})</summary>
            <ul className="mt-2 space-y-1">
              {status.recentErrors.slice(0, 10).map((e, i) => (
                <li key={i}>[{e.channel}] {e.code}: {e.message}</li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* 个人微信扫码 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-4">
        <h2 className="font-semibold flex items-center gap-2 mb-2">
          <QrCode size={16} /> 微信个人号扫码授权
        </h2>
        <p className="text-sm text-zinc-500 mb-3">
          走腾讯官方 iLink 机器人协议(无封号风险)。扫一次码,token 自动落盘,重启不掉线。
        </p>
        {qrPhase === 'idle' && (
          <button
            onClick={() => void startQr()}
            className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm hover:bg-zinc-700"
          >
            获取登录二维码
          </button>
        )}
        {(qrPhase === 'loading' || qrPhase === 'scanning') && (
          <div className="flex flex-col items-center gap-3">
            {qrImg ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrImg} alt="微信登录二维码" width={260} height={260} className="rounded-lg border border-zinc-200" />
            ) : (
              <Loader2 size={40} className="animate-spin text-zinc-400" />
            )}
            <p className="text-sm text-zinc-600 text-center">{qrNote}</p>
            <button onClick={() => void startQr()} className="text-xs text-zinc-400 hover:text-zinc-700">
              重新获取
            </button>
          </div>
        )}
        {(qrPhase === 'confirmed' || qrPhase === 'expired' || qrPhase === 'error') && (
          <div className="space-y-2">
            <p className={`text-sm ${qrPhase === 'confirmed' ? 'text-emerald-600' : 'text-red-600'}`}>{qrNote}</p>
            {qrPhase !== 'confirmed' && (
              <button
                onClick={() => void startQr()}
                className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm hover:bg-zinc-700"
              >
                重新获取二维码
              </button>
            )}
          </div>
        )}
      </section>

      {/* 绑定码 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-4">
        <h2 className="font-semibold flex items-center gap-2 mb-2">
          <Link2 size={16} /> 生成绑定码
        </h2>
        <p className="text-sm text-zinc-500 mb-3">
          生成后,在已接入的 IM(公众号/个人微信/QQ)里对机器人发送「绑定 &lt;6位码&gt;」,
          即可把该 IM 身份绑定到你的账号。10 分钟有效,单次使用。
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void genBindCode()}
            className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm hover:bg-zinc-700"
          >
            生成 6 位绑定码
          </button>
          {bindCode && (
            <span className="text-2xl font-mono font-bold tracking-[0.3em] text-emerald-600">{bindCode}</span>
          )}
        </div>
        {bindCode && (
          <p className="text-xs text-zinc-400 mt-2">
            在 IM 里发送:绑定 {bindCode}
          </p>
        )}
        {bindErr && <p className="text-sm text-red-600 mt-2">{bindErr}</p>}
      </section>

      <footer className="text-xs text-zinc-400">
        公众号通道需服务端配置 WECHAT_MP_APPID/APPSECRET;QQ 通道需独立机器跑
        NapCat(部署见 docs/design/channel-plugin.md §7)。
      </footer>
    </div>
  );
}
