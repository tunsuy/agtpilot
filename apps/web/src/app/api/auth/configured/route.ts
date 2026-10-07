import { NextResponse } from 'next/server';
import { isMockAuthAllowed } from '../../../../lib/auth-mock';

export async function GET() {
  return NextResponse.json({
    github: Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET),
    google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
    apple: Boolean(process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET),
    wechat: Boolean(process.env.AUTH_WECHAT_ID && process.env.AUTH_WECHAT_SECRET),
    mock: isMockAuthAllowed(),
  });
}
