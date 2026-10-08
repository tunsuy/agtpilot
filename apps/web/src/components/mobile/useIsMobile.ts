'use client';

import { useEffect, useState } from 'react';

/**
 * 判断当前是否应进入"移动端专属布局"。
 *
 * 规则（任一命中即为移动端）：
 * 1. 运行在 Capacitor 原生壳内（Android/iOS App）；
 * 2. 浏览器视口宽度 < 768px（手机竖屏）；
 * 3. UA 为手机/平板且视口 < 1024px（折叠屏、大屏手机横屏兜底）。
 *
 * 注意：首帧返回 false（SSR/水合安全），mounted 后再校正，
 * 调用方需要容忍一次布局切换，或用 `mounted` 字段做骨架屏。
 */
export function useIsMobile(): { isMobile: boolean; mounted: boolean } {
  const [mounted, setMounted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const detect = () => {
      // 1. Capacitor 原生壳
      try {
        const cap = (window as any).Capacitor;
        if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
          return true;
        }
        if (cap && cap.getPlatform && ['ios', 'android'].includes(cap.getPlatform())) {
          return true;
        }
      } catch {
        // ignore
      }

      const width = window.innerWidth;
      // 2. 小屏直接判定
      if (width < 768) return true;

      // 3. 手机 UA + 中等屏宽（横屏手机 / 折叠屏）
      const ua = navigator.userAgent || '';
      const isPhoneUA = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
      if (isPhoneUA && width < 1024) return true;

      return false;
    };

    const update = () => setIsMobile(detect());
    update();
    setMounted(true);

    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return { isMobile, mounted };
}
