import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { auth } from '@/auth';
import {
  loadArtifactFileManifest,
  resolveArtifactFilePath,
  artifactFileExists,
} from '@/lib/artifact-files';

export const dynamic = 'force-dynamic';

/**
 * GET /api/artifacts/file?fileId=af_xxx.pptx
 * 二进制产物文件下载(如 PPT 工坊 ppt-master 路线的真 .pptx)。
 * 鉴权:登录用户的 session.user.id 即文件库分区键,只能取自己名下的文件;
 * fileId 白名单正则校验 + 路径围栏,杜绝穿越。
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
    const fileId = new URL(req.url).searchParams.get('fileId') || '';

    const manifest = loadArtifactFileManifest(userId, fileId);
    const filePath = resolveArtifactFilePath(userId, fileId);
    if (!manifest || !filePath || !artifactFileExists(userId, fileId)) {
      return NextResponse.json(
        { success: false, error: '文件不存在或已清理' },
        { status: 404 }
      );
    }

    const buf = fs.readFileSync(filePath);
    // 中文文件名走 RFC 5987 filename*;ASCII fallback 兜老客户端
    const asciiName = manifest.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'deliverable';
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
