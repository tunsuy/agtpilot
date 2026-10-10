import type { Metadata, Viewport } from 'next';
import './globals.css';
import '@copilotkit/react-ui/styles.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover', // iOS 刘海屏安全区（配合 env(safe-area-inset-*)）
  themeColor: '#fbfbfd',
};

export const metadata: Metadata = {
  title: 'AgtPilot | Personal Autonomous AI Agent',
  description: 'A pluggable, autonomous personal AI agent with browser automation, sandbox execution, and Generative UI.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.png', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    // ?v= 版本参数换 URL 即换缓存键:iOS Safari 对 apple-touch-icon 的抓取缓存在
    // 「网站数据」里极顽固,URL 不变就永远不重新请求;换 logo 后必须 bump 版本号
    apple: [{ url: '/icons/apple-touch-icon.png?v=20261009', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'AgtPilot',
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
};

import { Providers } from '../components/Providers';
import { RegisterPWA } from '../components/RegisterPWA';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen bg-[#fbfbfd] text-zinc-900 antialiased" suppressHydrationWarning>
        <Providers>
          {children}
          <RegisterPWA />
        </Providers>
      </body>
    </html>
  );
}
