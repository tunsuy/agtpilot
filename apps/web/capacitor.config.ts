import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.agtpilot.app',
  appName: 'AgtPilot',
  webDir: 'out',
  server: {
    // 在开发调试阶段，支持真机通过局域网直连 Next.js 开发服务
    // 生产打包时如果静态导出，可关闭 url 直接加载打包后的离线资源
    cleartext: true,
  },
  plugins: {
    Share: {},
    Clipboard: {},
    App: {},
    Browser: {},
  },
};

export default config;
