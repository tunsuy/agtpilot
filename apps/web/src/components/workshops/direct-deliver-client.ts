/**
 * 直连投递前端客户端(文章包/笔记包卡片共用)
 *
 * POST /api/workshops/deliver:服务端直调落稿工具,正文不过模型。
 * 网络/HTTP/业务失败统一归一成 { success:false, error },卡片只管展示与重试。
 */
export interface DirectDeliverResponse {
  success: boolean;
  /** true = 托管门未开/浏览器未就绪,错误文案即引导(连接器页配置) */
  gated?: boolean;
  error?: string;
  tool?: string;
  /** 工具原始返回(message 含配额提示,可展示) */
  result?: any;
}

export async function postDirectDelivery(
  platform: string,
  args: Record<string, unknown>,
  missionId?: string | null,
): Promise<DirectDeliverResponse> {
  try {
    const res = await fetch('/api/workshops/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, missionId: missionId || undefined, args }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      return {
        success: false,
        gated: Boolean(data?.gated),
        error: String(data?.error || `投递失败(HTTP ${res.status})`),
      };
    }
    return data as DirectDeliverResponse;
  } catch (e: any) {
    return { success: false, error: e?.message || '网络错误,投递失败' };
  }
}
