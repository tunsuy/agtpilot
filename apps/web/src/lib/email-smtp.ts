import * as net from 'net';
import * as tls from 'tls';
import type { ToolDefinition } from '@agtpilot/core';
import { getUserConnectors } from './user-store';
import { markdownToWechatHtml } from './wechat-mp';

/**
 * 电子邮件 SMTP 直发(零依赖最小实现)
 *
 * 凭证:EMAIL_SMTP_CREDENTIAL = 「账号:授权码」(QQ/163/Gmail 等自动识别服务器),
 * 或「账号:授权码:smtp主机:端口」(自建/企业邮箱)。按用户加密存 user-store,
 * 执行时才读取,绝不进 process.env。
 *
 * 安全:465 隐式 TLS;587/25 STARTTLS 升级,服务器不支持 STARTTLS 时拒发
 * (防止明文泄露授权码);仅当 EMAIL_SMTP_INSECURE=1 且目标是 localhost 时
 * 允许明文(冒烟测试用)。
 */

export const EMAIL_SMTP_CRED_KEY = 'EMAIL_SMTP_CREDENTIAL';

const HOST_BY_DOMAIN: Record<string, { host: string; port: number }> = {
  'qq.com': { host: 'smtp.qq.com', port: 465 },
  'foxmail.com': { host: 'smtp.qq.com', port: 465 },
  '163.com': { host: 'smtp.163.com', port: 465 },
  '126.com': { host: 'smtp.126.com', port: 465 },
  'yeah.net': { host: 'smtp.yeah.net', port: 465 },
  'sina.com': { host: 'smtp.sina.com', port: 465 },
  'sina.cn': { host: 'smtp.sina.cn', port: 465 },
  'sohu.com': { host: 'smtp.sohu.com', port: 465 },
  '139.com': { host: 'smtp.139.com', port: 465 },
  'aliyun.com': { host: 'smtp.aliyun.com', port: 465 },
  'gmail.com': { host: 'smtp.gmail.com', port: 465 },
  'googlemail.com': { host: 'smtp.gmail.com', port: 465 },
  'outlook.com': { host: 'smtp.office365.com', port: 587 },
  'hotmail.com': { host: 'smtp.office365.com', port: 587 },
  'live.com': { host: 'smtp.office365.com', port: 587 },
  'icloud.com': { host: 'smtp.mail.me.com', port: 587 },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465 },
};

export interface SmtpEndpoint {
  user: string;
  pass: string;
  host: string;
  port: number;
  /** true = 隐式 TLS(465);false = 明文接入,按需 STARTTLS(587/25) */
  secure: boolean;
}

/** 解析「账号:授权码[:主机[:端口]]」;缺省主机按邮箱域名自动映射 */
export function parseSmtpCredential(raw?: string): SmtpEndpoint | null {
  const t = (raw || '').trim();
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length < 2) return null;
  const [user, pass, host, portStr] = parts;
  if (!user || !pass || !user.includes('@')) return null;
  if (host) {
    const port = portStr ? parseInt(portStr, 10) : 465;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { user, pass, host, port, secure: port === 465 };
  }
  const domain = (user.split('@')[1] || '').toLowerCase();
  if (!domain) return null;
  const known = HOST_BY_DOMAIN[domain];
  if (known) return { user, pass, host: known.host, port: known.port, secure: known.port === 465 };
  return { user, pass, host: `smtp.${domain}`, port: 465, secure: true };
}

export interface SmtpMail {
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
}

export type SmtpResult =
  | { ok: true; messageId: string }
  | { ok: false; stage: string; error: string };

const isLocal = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '::1';

/** RFC 2047 B 编码主题(分段,避免超长 encoded-word) */
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject; // 纯 ASCII 不编码
  const chunks: string[] = [];
  const chars = Array.from(subject);
  for (let i = 0; i < chars.length; i += 20) {
    chunks.push(`=?UTF-8?B?${Buffer.from(chars.slice(i, i + 20).join(''), 'utf8').toString('base64')}?=`);
  }
  return chunks.join(' ');
}

function b64Wrapped(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function friendlySmtpError(stage: string, raw: string, ep: SmtpEndpoint): string {
  const code = parseInt(raw.slice(0, 3), 10);
  if (stage === 'auth' || code === 535 || code === 537) {
    return `SMTP 认证失败(${raw.trim()}):请确认使用「授权码」而非登录密码——QQ/163 需在邮箱设置 → 账户 → 开启 SMTP 服务并生成授权码;Gmail 需开启两步验证后生成应用专用密码。`;
  }
  if (code === 550 || code === 553) return `收件人被服务器拒绝(${raw.trim()}):检查发信权限与收件人地址。`;
  if (code === 421 || code === 450 || code === 451 || code === 452) return `服务器临时故障(${raw.trim()}),请稍后重试。`;
  if (raw.includes('ETIMEDOUT') || raw.includes('timeout')) return `连接 ${ep.host}:${ep.port} 超时:检查主机/端口,或该邮箱是否限制了第三方客户端。`;
  if (raw.includes('ECONNREFUSED')) return `连接 ${ep.host}:${ep.port} 被拒绝:主机或端口不正确。`;
  if (raw.includes('ENOTFOUND') || raw.includes('getaddrinfo')) return `无法解析主机 ${ep.host}:检查 SMTP 主机名。`;
  return `SMTP ${stage} 阶段失败:${raw.trim()}`;
}

interface Reader {
  read(): Promise<string>;
  detach(): void;
}

function attachReader(socket: net.Socket | tls.TLSSocket): Reader {
  let buf = '';
  let partial = ''; // 多行响应累积:「250-xxx」继续,直到「250 xxx」为一条完整响应
  const queue: string[] = [];
  const waiters: Array<(v: string) => void> = [];
  const deliver = (v: string) => {
    const w = waiters.shift();
    if (w) w(v);
    else queue.push(v);
  };
  const onData = (d: Buffer) => {
    buf += d.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx + 2);
      buf = buf.slice(idx + 2);
      partial += line;
      if (/^\d{3}\s/.test(line)) {
        deliver(partial);
        partial = '';
      }
    }
  };
  socket.on('data', onData);
  return {
    read: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise<string>((resolve) => waiters.push(resolve)),
    detach: () => socket.off('data', onData),
  };
}

async function cmd(
  socket: net.Socket | tls.TLSSocket,
  reader: Reader,
  command: string,
  accept: number[],
  stage: string,
  ep: SmtpEndpoint,
  timeoutMs: number
): Promise<string> {
  socket.write(command + '\r\n');
  const resp = await Promise.race([
    reader.read(),
    new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
  ]);
  const code = parseInt(resp.slice(0, 3), 10);
  if (!accept.includes(code)) throw new Error(friendlySmtpError(stage, resp, ep));
  return resp;
}

/** 最小 SMTP 发信:EHLO → [STARTTLS] → AUTH → MAIL/RCPT → DATA → QUIT */
export async function sendSmtp(
  ep: SmtpEndpoint & { insecureLocalhost?: boolean; timeoutMs?: number },
  mail: SmtpMail
): Promise<SmtpResult> {
  const timeout = ep.timeoutMs ?? 15000;
  const plainLocal = Boolean(ep.insecureLocalhost && isLocal(ep.host));
  let stage = 'connect';
  let socket: net.Socket | tls.TLSSocket | undefined;
  try {
    socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      if (ep.secure && !plainLocal) {
        const s = tls.connect({ host: ep.host, port: ep.port, servername: ep.host }, () => {
          s.off('error', onErr);
          resolve(s);
        });
        s.setTimeout(timeout, () => reject(new Error('timeout')));
        s.once('error', onErr);
      } else {
        const s = net.connect({ host: ep.host, port: ep.port }, () => {
          s.off('error', onErr);
          resolve(s);
        });
        s.setTimeout(timeout, () => reject(new Error('timeout')));
        s.once('error', onErr);
      }
    });

    // 局部别名:外层 socket 类型含 undefined(供 catch 清理),闭包内一律用 sock
    let sock: net.Socket | tls.TLSSocket = socket;
    let reader = attachReader(sock);

    // greeting(不发送任何内容,只等待 220)
    stage = 'greeting';
    {
      const resp = await Promise.race([
        reader.read(),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout)),
      ]);
      if (!resp.startsWith('220')) throw new Error(friendlySmtpError(stage, resp, ep));
    }

    stage = 'ehlo';
    let resp = await cmd(sock, reader, `EHLO ${ep.host}`, [250], stage, ep, timeout);

    if (!ep.secure && !plainLocal) {
      if (!/STARTTLS/i.test(resp)) {
        throw new Error('服务器不支持 STARTTLS,拒绝明文传输凭证(请改用 465 SSL 端口)');
      }
      stage = 'starttls';
      await cmd(sock, reader, 'STARTTLS', [220], stage, ep, timeout);
      reader.detach();
      sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect({ socket: sock as net.Socket, servername: ep.host }, () => resolve(s));
        s.setTimeout(timeout, () => reject(new Error('timeout')));
        s.once('error', reject);
      });
      reader = attachReader(sock);
      stage = 'ehlo2';
      resp = await cmd(sock, reader, `EHLO ${ep.host}`, [250], stage, ep, timeout);
    }

    stage = 'auth';
    const mechs = (resp.match(/AUTH\s+([^\r\n]+)/i)?.[1] || 'LOGIN PLAIN').toUpperCase();
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    let authed = false;
    const tryLogin = async (): Promise<boolean> => {
      try {
        await cmd(sock, reader, 'AUTH LOGIN', [334], 'auth', ep, timeout);
        await cmd(sock, reader, b64(ep.user), [334], 'auth', ep, timeout);
        await cmd(sock, reader, b64(ep.pass), [235], 'auth', ep, timeout);
        return true;
      } catch {
        return false;
      }
    };
    const tryPlain = async (): Promise<boolean> => {
      try {
        await cmd(sock, reader, `AUTH PLAIN ${b64(`\0${ep.user}\0${ep.pass}`)}`, [235], 'auth', ep, timeout);
        return true;
      } catch {
        return false;
      }
    };
    if (mechs.includes('LOGIN')) authed = (await tryLogin()) || (mechs.includes('PLAIN') && (await tryPlain()));
    else if (mechs.includes('PLAIN')) authed = await tryPlain();
    else authed = (await tryLogin()) || (await tryPlain());
    if (!authed) {
      throw new Error(
        friendlySmtpError('auth', '535 authentication failed(LOGIN/PLAIN 均被拒)', ep)
      );
    }

    const from = ep.user;
    stage = 'mail-from';
    await cmd(sock, reader, `MAIL FROM:<${from}>`, [250], stage, ep, timeout);
    stage = 'rcpt-to';
    for (const addr of [...mail.to, ...(mail.cc || [])]) {
      await cmd(sock, reader, `RCPT TO:<${addr}>`, [250, 251], stage, ep, timeout);
    }

    // 组装邮件(正文一律 base64,免点填充与字符集问题)
    const boundary = `----=_Agtpilot_${Date.now().toString(36)}_b${Math.random().toString(36).slice(2, 10)}`;
    const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@${from.split('@')[1] || 'localhost'}>`;
    const headers: string[] = [
      `From: ${from}`,
      `To: ${mail.to.join(', ')}`,
      ...(mail.cc && mail.cc.length ? [`Cc: ${mail.cc.join(', ')}`] : []),
      `Subject: ${encodeSubject(mail.subject)}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
    ];
    let bodyRaw: string;
    if (mail.html) {
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      bodyRaw =
        `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Wrapped(mail.text || '')}\r\n` +
        `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Wrapped(mail.html)}\r\n` +
        `--${boundary}--\r\n`;
    } else {
      headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
      bodyRaw = `${b64Wrapped(mail.text || '')}\r\n`;
    }

    stage = 'data';
    await cmd(sock, reader, 'DATA', [354], stage, ep, timeout);
    sock.write(`${headers.join('\r\n')}\r\n\r\n${bodyRaw}.\r\n`);
    {
      const dataResp = await Promise.race([
        reader.read(),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout)),
      ]);
      const code = parseInt(dataResp.slice(0, 3), 10);
      if (code !== 250) throw new Error(friendlySmtpError('data', dataResp, ep));
    }

    stage = 'quit';
    try {
      await cmd(sock, reader, 'QUIT', [221], stage, ep, timeout);
    } catch {
      // QUIT 失败不影响已投递结果
    }
    reader.detach();
    sock.end();
    return { ok: true, messageId };
  } catch (e: any) {
    const msg = String(e?.message || e);
    try {
      socket?.destroy();
    } catch {
      // ignore
    }
    return { ok: false, stage, error: friendlySmtpError(stage, msg, ep) };
  }
}

/** Markdown → 纯文本(邮件 text 兜底部分) */
function mdToPlainText(md: string): string {
  return (md || '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildEmailTools(userId: string): ToolDefinition[] {
  return [
    {
      name: 'email_send',
      description:
        '通过用户配置的 SMTP 邮箱发送邮件:任务报告、内容投递、通知提醒均可。正文支持 Markdown(自动排版 HTML 邮件)或纯文本;收件人/抄送支持逗号分隔多个。QQ/163/Gmail/Outlook 自动识别服务器,自建邮箱可配主机端口。需要用户先在连接器页「电子邮件 (SMTP)」配置 账号:授权码。',
      dangerLevel: 'medium',
      // 回滚把手(治理 I5):邮件一经 SMTP 投递即不可撤回 —— 显式声明不可逆,
      // 配合审批门在事前告知,而不是事后假装能撤销
      compensation: {
        kind: 'irreversible',
        undoHint: '邮件发出后无法撤回;如需补救只能再发一封更正/致歉邮件',
      },
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人邮箱地址,多个用逗号分隔' },
          subject: { type: 'string', description: '邮件主题' },
          markdown: { type: 'string', description: 'Markdown 正文(自动转 HTML 邮件,与 text 二选一)' },
          text: { type: 'string', description: '纯文本正文(与 markdown 二选一)' },
          cc: { type: 'string', description: '抄送地址,多个用逗号分隔(可选)' },
        },
        required: ['to', 'subject'],
      },
      execute: async ({ to, subject, markdown, text, cc }) => {
        const ep = parseSmtpCredential(getUserConnectors(userId).configs[EMAIL_SMTP_CRED_KEY]);
        if (!ep) {
          return {
            success: false,
            error:
              '未配置邮件凭证:请在连接器页「电子邮件 (SMTP)」按 账号:授权码 格式填写(QQ/163 需先在邮箱设置开启 SMTP 服务并生成授权码;自建邮箱可写 账号:授权码:主机:端口)。',
          };
        }
        const tos = String(to || '').split(/[,;，；\s]+/).filter(Boolean);
        const ccs = String(cc || '').split(/[,;，；\s]+/).filter(Boolean);
        if (!tos.length) return { success: false, error: '缺少收件人 to' };
        const bad = [...tos, ...ccs].filter((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
        if (bad.length) return { success: false, error: `邮箱地址格式无效:${bad.join(', ')}` };
        const subj = String(subject || '').trim();
        if (!subj) return { success: false, error: '缺少主题 subject' };
        const md = String(markdown || '');
        const tx = String(text || '');
        if (!md.trim() && !tx.trim()) return { success: false, error: '缺少正文:markdown 或 text 至少提供一个' };

        const html = md.trim() ? markdownToWechatHtml(md) : undefined;
        const plain = tx.trim() ? tx : mdToPlainText(md);
        const result = await sendSmtp(
          { ...ep, insecureLocalhost: process.env.EMAIL_SMTP_INSECURE === '1' },
          { to: tos, cc: ccs, subject: subj, html, text: plain }
        );
        if (!result.ok) return { success: false, stage: result.stage, error: result.error };
        return {
          success: true,
          message_id: result.messageId,
          to: tos,
          cc: ccs,
          subject: subj,
          message: `✅ 邮件已从 ${ep.user} 发送给 ${tos.join(', ')}${ccs.length ? `(抄送 ${ccs.join(', ')})` : ''}`,
        };
      },
    },
  ];
}
