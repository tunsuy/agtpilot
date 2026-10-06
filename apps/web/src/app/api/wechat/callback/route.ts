import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { verifyLoginCode } from '../../../../lib/wechat-store';

const WECHAT_TOKEN = process.env.WECHAT_TOKEN || 'agtpilot_token';

// 1. 微信服务器接入校验接口 (GET)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const signature = searchParams.get('signature');
  const timestamp = searchParams.get('timestamp');
  const nonce = searchParams.get('nonce');
  const echostr = searchParams.get('echostr');

  if (!signature || !timestamp || !nonce || !echostr) {
    return new NextResponse('Invalid request parameters', { status: 400 });
  }

  // 微信官方签名校验算法：字典序排序后 SHA1 加密
  const sorted = [WECHAT_TOKEN, timestamp, nonce].sort().join('');
  const hash = crypto.createHash('sha1').update(sorted).digest('hex');

  if (hash === signature) {
    return new NextResponse(echostr); // 校验通过，原样返回 echostr
  }

  return new NextResponse('Signature mismatch', { status: 403 });
}

// 2. 微信公众号消息事件推送接收接口 (POST)
export async function POST(req: NextRequest) {
  try {
    const rawXml = await req.text();

    // 简单提取 XML 核心标签内容
    const getTagValue = (xml: string, tag: string) => {
      const cdataMatch = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`));
      if (cdataMatch) return cdataMatch[1];
      const normalMatch = xml.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`));
      return normalMatch ? normalMatch[1] : '';
    };

    const fromUserName = getTagValue(rawXml, 'FromUserName'); // 用户 openid
    const toUserName = getTagValue(rawXml, 'ToUserName');     // 公众号 id
    const msgType = getTagValue(rawXml, 'MsgType');
    const content = getTagValue(rawXml, 'Content').trim();   // 用户发送的文本内容

    let replyMessage = '';

    if (msgType === 'text') {
      // 用户回复了 6 位数字验证码
      const success = verifyLoginCode(content, fromUserName);

      if (success) {
        replyMessage = `✅ 验证成功！\n\n已成功为您完成 AgtPilot 网页登录授权，浏览器页面已自动跳转进入工作台。`;
      } else {
        replyMessage = `收到消息：${content}\n\n若您正在登录 AgtPilot，请确认验证码是否已过期或输入有误。如需登录，请在网页重新获取最新的 6 位验证码。`;
      }
    } else if (msgType === 'event') {
      const event = getTagValue(rawXml, 'Event');
      if (event === 'subscribe') {
        replyMessage = `欢迎关注 AgtPilot 自主数字员工助手！\n\n请在公众号中发送网页端展示的 6 位数字验证码完成快速登录。`;
      }
    }

    if (!replyMessage) {
      return new NextResponse('success');
    }

    // 回复被动文本消息 XML
    const replyXml = `
<xml>
  <ToUserName><![CDATA[${fromUserName}]]></ToUserName>
  <FromUserName><![CDATA[${toUserName}]]></FromUserName>
  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${replyMessage}]]></Content>
</xml>`.trim();

    return new NextResponse(replyXml, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  } catch (err: any) {
    console.error('WeChat callback error:', err);
    return new NextResponse('success');
  }
}
