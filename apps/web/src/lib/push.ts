import webpush from 'web-push';
import {
  getUserPushSubscriptions,
  removeUserPushSubscription,
  PushSubscriptionRecord,
} from './user-store';
import { getVapidKeys, getVapidSubject } from './vapid';

export interface PushPayload {
  title: string;
  body?: string;
  tag?: string;
  /** 点击通知后跳转的站内路径，例如 '/?tab=activity' */
  url?: string;
  icon?: string;
}

let vapidConfigured = false;

function ensureVapid() {
  if (vapidConfigured) return;
  const keys = getVapidKeys();
  webpush.setVapidDetails(getVapidSubject(), keys.publicKey, keys.privateKey);
  vapidConfigured = true;
}

/**
 * 向某用户的所有已订阅设备推送一条通知。
 * 失败端点（404/410 = 订阅已失效）自动清理；整体异步不阻塞调用方。
 * 未配置或无订阅时静默返回 0。
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  const subs = getUserPushSubscriptions(userId);
  if (!subs.length) return 0;

  try {
    ensureVapid();
  } catch (e) {
    console.error('[push] VAPID 配置失败:', e);
    return 0;
  }

  const body = JSON.stringify({ ...payload, icon: payload.icon || '/icons/icon-192.png' });
  let delivered = 0;

  await Promise.all(
    subs.map(async (sub: PushSubscriptionRecord) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          { TTL: 60 * 60 * 12 }
        );
        delivered += 1;
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          // 订阅已失效（用户卸载/清除站点数据），清理掉
          removeUserPushSubscription(userId, sub.endpoint);
        } else {
          console.error('[push] send failed:', status, err?.message);
        }
      }
    })
  );

  return delivered;
}
