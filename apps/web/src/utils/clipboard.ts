/**
 * 纯 Web 端剪贴板写入(不依赖 Capacitor,vitest node 环境可直测)。
 *
 * 背景:`navigator.clipboard` 只在**安全上下文**(https / localhost)存在 ——
 * 线上部署 http://agent.tunsuy.cn(未配 TLS)下它是 undefined,导致各处复制按钮
 * 静默失效(裸调用的还会抛 TypeError)。这里优先试 Clipboard API,不可用或被拒时
 * 降级「临时 textarea + document.execCommand('copy')」(http 下仍可用)。
 *
 * 原生 App 路径(Capacitor Clipboard 插件)在 utils/nativeBridge.ts,不受此影响。
 */

/** execCommand 降级:不抛异常,返回是否成功 */
export function legacyCopy(text: string): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari 需要显式选区
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Web 端写入:Clipboard API 优先(https/localhost),失败或缺失走 execCommand 降级 */
export async function webCopyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限拒绝 / iframe 限制等:落到降级路径
  }
  return legacyCopy(text);
}
