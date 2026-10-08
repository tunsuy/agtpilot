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
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
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
