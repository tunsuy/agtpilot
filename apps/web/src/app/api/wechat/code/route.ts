import { NextRequest, NextResponse } from 'next/server';
import { generateLoginCode, checkCodeStatus, verifyLoginCode } from '../../../../lib/wechat-store';

// 生成新的 6 位验证码
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');

  // 如果带了 code 参数，则是查询状态
  if (code) {
    const item = checkCodeStatus(code);
    if (!item) {
      return NextResponse.json({ success: false, error: 'Code not found' }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      status: item.status,
      user: item.user,
      expiresAt: item.expiresAt,
    });
  }

  // 否则生成新验证码
  const item = generateLoginCode();
  return NextResponse.json({
    success: true,
    code: item.code,
    expiresAt: item.expiresAt,
    qrUrl: process.env.WECHAT_QR_URL || '', // 用户公众号二维码图片链接
  });
}

// 本地开发模拟扫码验证接口
export async function POST(req: NextRequest) {
  try {
    const { code, mockOpenid } = await req.json();
    if (!code) {
      return NextResponse.json({ success: false, error: 'Missing code' }, { status: 400 });
    }

    const openid = mockOpenid || `mock_user_${Math.floor(1000 + Math.random() * 9000)}`;
    const success = verifyLoginCode(code, openid);

    if (!success) {
      return NextResponse.json({ success: false, error: 'Code expired or invalid' }, { status: 400 });
    }

    const item = checkCodeStatus(code);
    return NextResponse.json({
      success: true,
      message: 'Mock verification succeeded',
      user: item?.user,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
