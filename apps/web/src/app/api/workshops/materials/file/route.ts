import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { auth } from '@/auth';
import {
  loadMaterialUploadManifest,
  resolveMaterialUploadPath,
} from '@/lib/material-uploads';

export const dynamic = 'force-dynamic';

/**
 * GET /api/workshops/materials/file?id=upl_xxx
 * 工坊参考资料·上传原件下载(交付物页「参考资料」区点击徽章触发)。
 * 鉴权:登录用户的 session.user.id 即上传库分区键,只能取自己名下的文件;
 * uploadId 白名单正则 + 路径围栏在 resolveMaterialUploadPath 内(与读取/
 * 删除同一入口),原件文件名只进 Content-Disposition 展示,绝不进路径。
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录' },
        { status: 401 }
      );
    }
    const userId = session.user.id;
    const uploadId = new URL(req.url).searchParams.get('id') || '';

    const filePath = resolveMaterialUploadPath(userId, uploadId);
    const manifest = filePath ? loadMaterialUploadManifest(userId, uploadId) : null;
    // manifest 最后落盘的三件套约定:manifest 在而原件不在 = 半残,同样 404
    if (!filePath || !manifest || !fs.existsSync(filePath)) {
      return NextResponse.json(
        { success: false, error: '文件不存在或已删除' },
        { status: 404 }
      );
    }

    const buf = fs.readFileSync(filePath);
    // 中文文件名走 RFC 5987 filename*;ASCII fallback 兜老客户端(与 artifacts/file 同款)
    const asciiName =
      manifest.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'material';
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': manifest.mime || 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(manifest.fileName)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: `下载失败: ${e?.message || e}` },
      { status: 500 }
    );
  }
}
