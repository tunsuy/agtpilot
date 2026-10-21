import { NextRequest, NextResponse } from 'next/server';
import { verifyLoginCode } from '../../../../lib/wechat-store';
import { getChannelManager } from '../../../../lib/channel-service';
import { peekWechatMpImToken } from '../../../../lib/channel-store';
import { verifyWechatCallbackSignature } from '../../../../lib/channel-utils';

/**
 * 微信公众号回调路由(单一路由,两种形态):
 * - 按用户多租户(带 ?u=<userId>,2026-10-21 主形态):每个用户把自己的公众号
 *   服务器配置指到本路由,签名用该用户专属 Token(IM 通道面板生成/轮换,
 *   channel-store 落盘);凭证复用连接器页 WECHAT_MP_CREDENTIAL,消息交
 *   通道服务时带上归属 userId(出站客服消息据此解析该用谁的凭证)。
 * - 全局单租户(无 u,旧形态兜底):全局 WECHAT_TOKEN 签名 + env 凭证
 *   (WECHAT_MP_APPID/APPSECRET),含网页登录 6 位验证码既有语义。
 */

/** 全局单租户兜底 Token(旧形态;按用户回调一律用各自专属 Token,不回落此值) */
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || 'agtpilot_token';

/** 被动回复文本 XML(平台 5s 语义内的即时答复;长任务答复走客服消息) */
function passiveReplyXml(fromUserName: string, toUserName: string, content: string): NextResponse {
  const xml = `
<xml>
  <ToUserName><![CDATA[${fromUserName}]]></ToUserName>
  <FromUserName><![CDATA[${toUserName}]]></FromUserName>
  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${content}]]></Content>
</xml>`.trim();
  return new NextResponse(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

// 1. 微信服务器接入校验接口 (GET)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const signature = searchParams.get('signature');
  const timestamp = searchParams.get('timestamp');
  const nonce = searchParams.get('nonce');
  const echostr = searchParams.get('echostr');
  const u = searchParams.get('u') || '';

  if (!signature || !timestamp || !nonce || !echostr) {
    return new NextResponse('Invalid request parameters', { status: 400 });
  }

  // 按用户回调:只认该用户专属 Token,未生成过 → 直接拒(不回落全局 Token,
  // 防拿旧全局 Token 冒充按用户 URL)。peek 只读不生成 —— 未认证请求不得造成
  // 落盘状态;Token 由 IM 通道面板(已认证)生成展示。
  if (u) {
    const userToken = peekWechatMpImToken(u);
    if (!userToken || !verifyWechatCallbackSignature(userToken, signature, timestamp, nonce)) {
      return new NextResponse('Signature mismatch', { status: 403 });
    }
    return new NextResponse(echostr);
  }

  // 旧形态(无 u):全局 Token(微信官方签名算法:字典序排序后 SHA1)
  if (!verifyWechatCallbackSignature(WECHAT_TOKEN, signature, timestamp, nonce)) {
    return new NextResponse('Signature mismatch', { status: 403 });
  }
  return new NextResponse(echostr);
}

// 2. 微信公众号消息事件推送接收接口 (POST)
export async function POST(req: NextRequest) {
  try {
    const rawXml = await req.text();
    const { searchParams } = new URL(req.url);
    const u = searchParams.get('u') || '';

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

    // ── 按用户多租户(带 u):专属 Token 验签 → 凭证门槛 → 通道服务 ──
    if (u) {
      const userToken = peekWechatMpImToken(u);
      const signed = verifyWechatCallbackSignature(
        userToken || '',
        searchParams.get('signature'),
        searchParams.get('timestamp'),
        searchParams.get('nonce'),
      );
      if (!userToken || !signed) {
        return new NextResponse('Signature mismatch', { status: 403 });
      }
      if (msgType === 'text') {
        if (getChannelManager().wechatMpUserReady(u)) {
          // 平台要求 5s 内响应而 agent 任务远超此时长:被动回复静默('success'),
          // 处理在响应后继续(fire-and-forget),重推由通道层按 MsgId 去重兜底。
          // 归属 userId 随 XML 一起交通道服务(出站凭证解析依赖,先学习再扇出)。
          void getChannelManager().ingestWechatMpWebhook(rawXml, u);
          return new NextResponse('success');
        }
        return passiveReplyXml(
          fromUserName,
          toUserName,
          '本公众号的机器人还没配置完成:请主人在 AgtPilot 连接器页「微信公众号(草稿箱直连)」填写 AppID:AppSecret,并在「IM 通道」面板生成专属回调 URL 与 Token 填到公众平台服务器配置。',
        );
      }
      if (msgType === 'event' && getTagValue(rawXml, 'Event') === 'subscribe') {
        return passiveReplyXml(
          fromUserName,
          toUserName,
          '欢迎关注!绑定后即可直接与你的 AgtPilot 智能体对话:\n1. 登录 AgtPilot 网页 → 「IM 通道」面板,生成 6 位绑定码\n2. 在这里发送:绑定 <6位码>(10 分钟内有效)\n\n其他指令:「解绑」解除绑定;「新会话」开启全新对话。',
        );
      }
      return new NextResponse('success');
    }

    // ── 全局单租户旧形态(无 u):登录验证码 + 全局凭证对话 ──
    let replyMessage = '';

    if (msgType === 'text') {
      // 6 位纯数字 → 网页登录验证码流程(既有语义,优先)
      if (/^\d{6}$/.test(content)) {
        const success = verifyLoginCode(content, fromUserName);
        if (success) {
          replyMessage = `✅ 验证成功！\n\n已成功为您完成 AgtPilot 网页登录授权，浏览器页面已自动跳转进入工作台。`;
        } else {
          replyMessage = `收到消息：${content}\n\n若您正在登录 AgtPilot，请确认验证码是否已过期或输入有误。如需登录，请在网页重新获取最新的 6 位验证码。`;
        }
      } else if (getChannelManager().wechatMpGlobalReady()) {
        // 对话消息 → 通道服务后台处理(绑定/派发/客服消息回复)。
        void getChannelManager().ingestWechatMpWebhook(rawXml);
        return new NextResponse('success');
      } else {
        replyMessage = `收到消息：${content}\n\n若您正在登录 AgtPilot，请确认验证码是否已过期或输入有误。如需登录，请在网页重新获取最新的 6 位验证码。`;
      }
    } else if (msgType === 'event') {
      const event = getTagValue(rawXml, 'Event');
      if (event === 'subscribe') {
        replyMessage = getChannelManager().wechatMpGlobalReady()
          ? `欢迎关注 AgtPilot 自主数字员工助手！\n\n· 网页登录:发送网页端展示的 6 位验证码\n· 直接对话:先在网页端生成绑定码,再发送「绑定 <6位码>」\n\n绑定后发消息即可与你的智能体对话。`
          : `欢迎关注 AgtPilot 自主数字员工助手！\n\n请在公众号中发送网页端展示的 6 位数字验证码完成快速登录。`;
      }
    }

    if (!replyMessage) {
      return new NextResponse('success');
    }
    return passiveReplyXml(fromUserName, toUserName, replyMessage);
  } catch (err: any) {
    console.error('WeChat callback error:', err);
    return new NextResponse('success');
  }
}
