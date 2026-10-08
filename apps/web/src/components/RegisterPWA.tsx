'use client';

import { useEffect } from 'react';

/**
 * 注册 PWA Service Worker。
 * 仅在浏览器环境、页面 load 后注册，避免与首屏渲染竞争带宽。
 */
export function RegisterPWA() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => {
          console.warn('[PWA] Service Worker 注册失败:', err);
        });
    };

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }, []);

  return null;
}
