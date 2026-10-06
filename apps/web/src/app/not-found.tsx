import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 text-center">
      <h2 className="text-2xl font-bold text-zinc-900 mb-2">404 - 页面未找到</h2>
      <p className="text-sm text-zinc-500 mb-6">您访问的页面不存在或已被移除。</p>
      <Link
        href="/"
        className="px-4 py-2 rounded-xl bg-zinc-900 text-white text-xs font-medium hover:bg-zinc-800 transition"
      >
        返回主页
      </Link>
    </div>
  );
}
