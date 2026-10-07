/**
 * 模拟登录(沙盒体验)总开关
 *
 * 生产环境默认关闭以下 mock 通道:
 * - POST /api/wechat/code(本地模拟扫码验证)
 * - Credentials provider 的 isDemo / socialProvider 模拟身份
 *
 * 显式设置 AUTH_ALLOW_MOCK=true 可在任何环境开启(如线上 Demo 演示),
 * 设置 AUTH_ALLOW_MOCK=false 可在开发环境强制关闭。
 */
export function isMockAuthAllowed(): boolean {
  const flag = process.env.AUTH_ALLOW_MOCK;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}
