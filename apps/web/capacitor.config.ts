import type { CapacitorConfig } from '@capacitor/cli';

/**
 * AgtPilot 原生壳配置（iOS 优先）。
 *
 * 架构：远程壳（Remote Shell）。
 * AgtPilot 的 Web 端是一个 Next.js 服务端应用（SSR + API 路由 + SSE 实时流 + next-auth），
 * 无法简单静态导出塞进包里，因此原生 App 采用「壳内 WebView 直连已部署的服务器」模式：
 *   - 通过 server.url 指向生产/开发服务器；
 *   - Capacitor 会把原生桥注入到该远程页面，@capacitor/* 插件（分享、剪贴板、推送等）照常可用；
 *   - webDir(www) 里放一个离线兜底页，未配置 server.url 或断网首屏时使用。
 *
 * server.url 由环境变量注入，便于区分开发/生产，且避免把地址硬编码进仓库：
 *   开发（局域网真机直连 Next dev）:  AGTPILOT_SERVER_URL=http://192.168.x.x:3000
 *   生产:                            AGTPILOT_SERVER_URL=https://your-domain.com
 * 构建时：
 *   AGTPILOT_SERVER_URL=https://... npx cap sync ios
 */
const serverUrl = process.env.AGTPILOT_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: 'com.agtpilot.app',
  appName: 'AgtPilot',
  webDir: 'www',
  server: {
    // 允许开发期通过 http 局域网直连；生产请用 https。
    cleartext: true,
    ...(serverUrl ? { url: serverUrl } : {}),
    // 远程页面也需要注入原生桥，允许下面这些主机名走 Capacitor 桥接。
    ...(serverUrl
      ? {
          allowNavigation: [
            // 允许服务器自身域名/主机进行导航并注入桥
            (() => {
              try {
                return new URL(serverUrl).hostname;
              } catch {
                return undefined;
              }
            })(),
          ].filter(Boolean) as string[],
        }
      : {}),
  },
  ios: {
    contentInset: 'never',
    // 键盘弹出时不调整 WebView，交由前端 CSS 处理，避免布局跳动
    scrollEnabled: true,
  },
  plugins: {
    Share: {},
    Clipboard: {},
    App: {},
    Browser: {},
    Keyboard: {
      resize: 'none',
    },
  },
};

export default config;
