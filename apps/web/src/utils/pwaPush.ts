'use client';

/**
 * PWA Web Push 客户端工具。
 *
 * 前置条件（iOS 尤其严格）：
 * - 必须已"添加到主屏幕"以独立模式运行（iOS 16.4+ 才支持 Web Push）；
 * - 必须 HTTPS（agent.tunsuy.cn 满足）；
 * - 用户授权通知权限。
 */

export type PushSupport = 'ready' | 'need-install' | 'unsupported';

export function detectPushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  // iOS Safari：仅在主屏幕独立模式（standalone）下开放 Web Push
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as any).standalone === true;
  if (isIOS && !standalone) return 'need-install';
  return 'ready';
}

function base64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface PushStatus {
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
}

export async function getPushStatus(): Promise<PushStatus> {
  if (detectPushSupport() === 'unsupported' || !('Notification' in window)) {
    return { permission: 'unsupported', subscribed: false };
  }
  const reg = await navigator.serviceWorker.getRegistration('/sw.js').catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return { permission: Notification.permission, subscribed: Boolean(sub) };
}

/**
 * 请求权限并订阅推送，订阅结果上报服务端保存。
 * 返回最新状态；调用方据此更新 UI。
 */
export async function enablePush(): Promise<PushStatus> {
  const support = detectPushSupport();
  if (support === 'unsupported') return { permission: 'unsupported', subscribed: false };

  // 1. 权限
  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') return { permission, subscribed: false };

  // 2. 拿 VAPID 公钥
  const keyRes = await fetch('/api/push/vapid-key');
  if (!keyRes.ok) return { permission, subscribed: false };
  const { publicKey } = await keyRes.json();
  if (!publicKey) return { permission, subscribed: false };

  // 3. 订阅
  const reg = await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64ToUint8Array(publicKey),
    });
  }

  // 4. 上报服务端
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });

  return { permission, subscribed: true };
}

export async function disablePush(): Promise<PushStatus> {
  const reg = await navigator.serviceWorker.getRegistration('/sw.js').catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unsubscribe', endpoint }),
    }).catch(() => {});
  }
  return getPushStatus();
}
