import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  saveMaterialUpload,
  listMaterialUploads,
  deleteMaterialUpload,
  UPLOAD_ID_RE,
} from '@/lib/material-uploads';

export const dynamic = 'force-dynamic';

/**
 * 工坊「参考资料」本地上传文件(2026-10-20):
 * - GET    /api/workshops/materials          列出当前用户的上传(选择器数据源)
 * - POST   /api/workshops/materials          multipart 上传一份文件(form 字段名 file)
 * - DELETE /api/workshops/materials?id=upl_… 删除一份上传
 *
 * 鉴权:登录用户的 session.user.id 即上传库分区键,只能读写自己名下的文件;
 * id 白名单正则 + 路径围栏在 lib/material-uploads(与 artifact-files 同款)。
 * 类型/体积/份数/总预算校验失败 → 400 带人话文案(选择器直接展示,不静默)。
 */

function toItemList(items: ReturnType<typeof listMaterialUploads>) {
  return items.map((m) => ({
    id: m.uploadId,
    title: m.title,
    fileName: m.fileName,
    kind: m.kind,
    sizeBytes: m.sizeBytes,
    textChars: m.textChars,
    createdAt: m.createdAt,
  }));
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    return NextResponse.json({ success: true, items: toItemList(listMaterialUploads(session.user.id)) });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: '缺少 file 字段(multipart 上传)' }, { status: 400 });
    }
    const data = Buffer.from(await file.arrayBuffer());
    const manifest = await saveMaterialUpload({
      userId: session.user.id,
      fileName: file.name || '',
      mime: file.type || '',
      data,
    });
    return NextResponse.json({
      success: true,
      item: {
        id: manifest.uploadId,
        title: manifest.title,
        fileName: manifest.fileName,
        kind: manifest.kind,
        sizeBytes: manifest.sizeBytes,
        textChars: manifest.textChars,
        createdAt: manifest.createdAt,
      },
    });
  } catch (e: any) {
    // saveMaterialUpload 的拒收(类型/体积/份数/预算/解析失败)全是人话文案 → 400
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: 'Unauthorized: 请先登录' }, { status: 401 });
    }
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!UPLOAD_ID_RE.test(id)) {
      return NextResponse.json({ success: false, error: 'id 形态非法(应为 upl_*)' }, { status: 400 });
    }
    const ok = deleteMaterialUpload(session.user.id, id);
    if (!ok) {
      return NextResponse.json({ success: false, error: '文件不存在或已删除' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
