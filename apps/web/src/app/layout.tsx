import type { Metadata } from 'next';
import './globals.css';
import '@copilotkit/react-ui/styles.css';

export const metadata: Metadata = {
  title: 'agtpilot | Personal Autonomous AI Agent',
  description: 'A pluggable, autonomous personal AI agent with browser automation, sandbox execution, and Generative UI.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
