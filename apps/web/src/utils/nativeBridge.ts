import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Clipboard } from '@capacitor/clipboard';
import { App } from '@capacitor/app';

/**
 * 判断当前是否运行在 Capacitor 原生移动端应用中
 */
export const isNativePlatform = (): boolean => {
  return Capacitor.isNativePlatform();
};

/**
 * 获取当前平台名称 ('ios' | 'android' | 'web')
 */
export const getPlatform = (): 'ios' | 'android' | 'web' => {
  return Capacitor.getPlatform() as 'ios' | 'android' | 'web';
};

/**
 * 原生呼起外部应用或 URL Scheme
 * @param scheme 外部 App URL Scheme，例如 "weixin://", "xhsdiscover://", "twitter://"
 * @param fallbackUrl 降级网页跳转地址（可选）
 */
export const openAppScheme = async (scheme: string, fallbackUrl?: string): Promise<boolean> => {
  try {
    if (isNativePlatform()) {
      // 在原生 Android/iOS 下，可以直接通过 window.location 或特定 Intent 唤起
      window.location.href = scheme;
      return true;
    } else {
      // 网页端环境下使用常规跳转
      window.location.href = scheme;
      if (fallbackUrl) {
        setTimeout(() => {
          window.open(fallbackUrl, '_blank');
        }, 1500);
      }
      return true;
    }
  } catch (err) {
    console.warn('[NativeBridge] Failed to open scheme:', scheme, err);
    if (fallbackUrl) {
      window.open(fallbackUrl, '_blank');
    }
    return false;
  }
};

/**
 * 调用系统级原生分享面板（Native Share Sheet）
 * 在手机端直接把图片/文本推入微信、小红书、微博、备忘录等应用的草稿箱
 */
export const shareToApp = async (options: {
  title: string;
  text?: string;
  url?: string;
  dialogTitle?: string;
}): Promise<boolean> => {
  try {
    if (isNativePlatform()) {
      await Share.share({
        title: options.title,
        text: options.text,
        url: options.url,
        dialogTitle: options.dialogTitle || '选择要发布的 App',
      });
      return true;
    } else if (typeof navigator !== 'undefined' && navigator.share) {
      await navigator.share({
        title: options.title,
        text: options.text,
        url: options.url,
      });
      return true;
    } else {
      // 浏览器环境降级复制到剪贴板
      if (options.text) {
        await copyToClipboard(options.text);
      }
      return false;
    }
  } catch (err) {
    console.warn('[NativeBridge] Share canceled or failed:', err);
    return false;
  }
};

/**
 * 写入系统剪贴板
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (isNativePlatform()) {
      await Clipboard.write({ string: text });
      return true;
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[NativeBridge] Clipboard error:', err);
    return false;
  }
};
