import type { ToolDefinition } from '@agtpilot/core';
import { getUserConnectors } from './user-store';

/**
 * 电子邮件 IMAP 收件(读取侧,与 email-smtp.ts 发件侧互补)
 *
 * 凭证:EMAIL_IMAP_CREDENTIAL = 「账号:授权码」(QQ/163/Gmail 等自动识别 IMAP 服务器),
 * 或「账号:授权码:imap主机:端口」(自建/企业邮箱)。未单独配置时自动回退复用
 * EMAIL_SMTP_CREDENTIAL(QQ/163/Gmail 的授权码/应用密码对 IMAP 与 SMTP 通用)。
 * 按用户加密存 user-store,执行时才读取,绝不进 process.env。
 *
 * 实现:imapflow(连接/搜索/取信) + mailparser(MIME 解析)。
 * 取信一律 BODY.PEEK 语义(imapflow 默认),不会把邮件标记成已读;
 * email_read 可通过 markSeen=true 显式标记已读。
 */

export const EMAIL_IMAP_CRED_KEY = 'EMAIL_IMAP_CREDENTIAL';
const EMAIL_SMTP_CRED_KEY = 'EMAIL_SMTP_CREDENTIAL';

/** 常见邮箱域名 → IMAP 服务器(均为 993 隐式 TLS) */
const IMAP_HOST_BY_DOMAIN: Record<string, { host: string; port: number }> = {
  'qq.com': { host: 'imap.qq.com', port: 993 },
  'foxmail.com': { host: 'imap.qq.com', port: 993 },
  '163.com': { host: 'imap.163.com', port: 993 },
  '126.com': { host: 'imap.126.com', port: 993 },
  'yeah.net': { host: 'imap.yeah.net', port: 993 },
  'sina.com': { host: 'imap.sina.com', port: 993 },
  'sina.cn': { host: 'imap.sina.cn', port: 993 },
  'sohu.com': { host: 'imap.sohu.com', port: 993 },
  '139.com': { host: 'imap.139.com', port: 993 },
  'aliyun.com': { host: 'imap.aliyun.com', port: 993 },
  'gmail.com': { host: 'imap.gmail.com', port: 993 },
  'googlemail.com': { host: 'imap.gmail.com', port: 993 },
  'outlook.com': { host: 'outlook.office365.com', port: 993 },
  'hotmail.com': { host: 'outlook.office365.com', port: 993 },
  'live.com': { host: 'outlook.office365.com', port: 993 },
  'icloud.com': { host: 'imap.mail.me.com', port: 993 },
  'yahoo.com': { host: 'imap.mail.yahoo.com', port: 993 },
};

export interface ImapEndpoint {
  user: string;
  pass: string;
  host: string;
  port: number;
  /** true = 隐式 TLS(993);false = 先明文接入再 STARTTLS(143) */
  secure: boolean;
}

/**
 * 解析「账号:授权码[:主机[:端口]]」;缺省主机按邮箱域名自动映射。
 * 兼容把 smtp.* 主机填进来的情况(自动换成 imap.* 同域主机)。
 */
export function parseImapCredential(raw?: string): ImapEndpoint | null {
  const t = (raw || '').trim();
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length < 2) return null;
  const [user, pass, host, portStr] = parts;
  if (!user || !pass || !user.includes('@')) return null;
  if (host) {
    const port = portStr ? parseInt(portStr, 10) : 993;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    // 填了 smtp 主机 → 尝试映射为同域 imap 主机(用户复用 SMTP 配置时常见)
    const mapped = /^smtp\./i.test(host)
      ? IMAP_HOST_BY_DOMAIN[(user.split('@')[1] || '').toLowerCase()]
      : undefined;
    return {
      user,
      pass,
      host: mapped ? mapped.host : host.replace(/^smtp\./i, 'imap.'),
      port: mapped ? mapped.port : port,
      secure: (mapped ? mapped.port : port) === 993,
    };
  }
  const domain = (user.split('@')[1] || '').toLowerCase();
  if (!domain) return null;
  const known = IMAP_HOST_BY_DOMAIN[domain];
  if (known) return { user, pass, host: known.host, port: known.port, secure: true };
  return { user, pass, host: `imap.${domain}`, port: 993, secure: true };
}

/** 取用户 IMAP 端点:优先 EMAIL_IMAP_CREDENTIAL,回退复用 SMTP 凭证 */
export function getUserImapEndpoint(userId: string): ImapEndpoint | null {
  const cfgs = getUserConnectors(userId).configs;
  return (
    parseImapCredential(cfgs[EMAIL_IMAP_CRED_KEY]) || parseImapCredential(cfgs[EMAIL_SMTP_CRED_KEY])
  );
}

const NOT_CONFIGURED_MSG =
  '未配置邮箱凭证:请在连接器页「电子邮件收件 (IMAP)」按 账号:授权码 格式填写(QQ/163 需先在邮箱设置开启 IMAP 服务并生成授权码;Gmail 需开启两步验证后生成应用专用密码;自建邮箱可写 账号:授权码:主机:端口)。已配置「电子邮件 (SMTP)」的凭证会被自动复用。';

function friendlyImapError(e: any, ep: ImapEndpoint): string {
  const msg = String(e?.message || e);
  if (/auth|login|credentials/i.test(msg) && /fail|invalid|denied/i.test(msg)) {
    return `IMAP 认证失败(${msg}):请确认使用「授权码/应用专用密码」而非登录密码,且邮箱已开启 IMAP 服务——QQ:设置→账户→开启 IMAP/SMTP 并生成授权码;163:设置→POP3/IMAP/SMTP→开启并获取授权码;Gmail:两步验证后生成应用专用密码。`;
  }
  if (/ETIMEDOUT|timeout/i.test(msg)) return `连接 ${ep.host}:${ep.port} 超时:检查主机/端口,或该邮箱是否限制了第三方客户端。`;
  if (/ECONNREFUSED/i.test(msg)) return `连接 ${ep.host}:${ep.port} 被拒绝:主机或端口不正确(IMAP 常用 993/SSL 或 143/STARTTLS)。`;
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return `无法解析主机 ${ep.host}:检查 IMAP 主机名。`;
  if (/self.signed|certificate/i.test(msg)) return `${ep.host} 证书不受信任:自建邮件服务器请配置有效证书。`;
  return `IMAP 操作失败:${msg}`;
}

// ---------- 核心收发实现 ----------

export interface MailListEntry {
  uid: number;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
  snippet: string;
}

export interface MailListOptions {
  folder?: string;
  unreadOnly?: boolean;
  sinceDays?: number;
  search?: string;
  limit?: number;
}

interface WithImapClient<T> {
  (ep: ImapEndpoint, fn: (client: any) => Promise<T>): Promise<T>;
}

/** 建立一次性连接执行操作(imapflow 每次操作独立连接,简单可靠,无常驻状态) */
const withImapClient: WithImapClient<any> = async (ep, fn) => {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: ep.host,
    port: ep.port,
    secure: ep.secure,
    auth: { user: ep.user, pass: ep.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
};

/** 搜索条件 → 最新 N 个 uid(倒序返回,新邮件在前) */
async function searchUids(client: any, opts: MailListOptions): Promise<number[]> {
  const limit = Math.min(50, Math.max(1, Math.round(opts.limit || 15)));
  const query: Record<string, unknown> = {};
  if (opts.unreadOnly) query.unseen = true;
  if (opts.sinceDays && opts.sinceDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - opts.sinceDays);
    d.setHours(0, 0, 0, 0);
    query.since = d;
  }
  const search = (opts.search || '').trim();
  if (search) {
    // 主题或正文命中(服务端 SEARCH;FROM/TO 精确语义交给 email_search 参数)
    query.or = [{ subject: search }, { text: search }];
  }
  const res = await client.search(query, { uid: true });
  // search 可能返回 number[] / false / undefined（无匹配或服务器拒绝）
  const uids: number[] = Array.isArray(res) ? res.map(Number).filter((n) => Number.isFinite(n)) : [];
  return uids.slice(-limit).reverse();
}

export async function listEmails(ep: ImapEndpoint, opts: MailListOptions): Promise<MailListEntry[]> {
  const folder = (opts.folder || 'INBOX').trim() || 'INBOX';
  return withImapClient(ep, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = await searchUids(client, opts);
      if (!uids.length) return [];
      const entries: MailListEntry[] = [];
      // 只取头部字段做列表(envelope+flags+前 8KB 原文提取摘要),避免全量下载
      for await (const msg of client.fetch(
        uids,
        {
          uid: true,
          flags: true,
          envelope: true,
          source: { maxLength: 8 * 1024 },
        },
        { uid: true }
      )) {
        let snippet = '';
        try {
          const { simpleParser } = await import('mailparser');
          const parsed = await simpleParser(msg.source as Buffer);
          snippet = (parsed.text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
        } catch {
          // 截断的原文可能解析失败,列表场景忽略摘要即可
        }
        const from = msg.envelope?.from?.[0];
        entries.push({
          uid: msg.uid,
          from: from ? `${from.name || ''} <${from.address || ''}>`.trim() : '(未知发件人)',
          subject: msg.envelope?.subject || '(无主题)',
          date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : '',
          unread: !msg.flags?.has('\\Seen'),
          snippet,
        });
      }
      // fetch 返回按 seq 升序,重新按 uid 集合的倒序排列(新在前)
      const order = new Map(uids.map((u, i) => [u, i]));
      entries.sort((a, b) => (order.get(a.uid) ?? 0) - (order.get(b.uid) ?? 0));
      return entries;
    } finally {
      lock.release();
    }
  });
}

export interface MailDetail {
  uid: number;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  text: string;
  truncated: boolean;
  attachments: Array<{ filename: string; size: number; contentType: string }>;
}

const MAX_BODY_CHARS = 20000;

export async function readEmail(
  ep: ImapEndpoint,
  uid: number,
  opts?: { folder?: string; markSeen?: boolean }
): Promise<MailDetail | null> {
  const folder = (opts?.folder || 'INBOX').trim() || 'INBOX';
  return withImapClient(ep, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      let raw: Buffer | undefined;
      let flags: Set<string> | undefined;
      for await (const msg of client.fetch(
        [uid],
        { uid: true, flags: true, source: true },
        { uid: true }
      )) {
        raw = msg.source as Buffer;
        flags = msg.flags as Set<string>;
      }
      if (!raw) return null;
      const { simpleParser } = await import('mailparser');
      const parsed = await simpleParser(raw);
      const fmtAddr = (a: any) =>
        Array.isArray(a?.value)
          ? a.value.map((v: any) => `${v.name || ''} <${v.address || ''}>`.trim()).join(', ')
          : a?.text || '';
      let text = (parsed.text || '').trim();
      if (!text && parsed.html) {
        // 纯 HTML 邮件:粗暴去标签兜底(保排版换行)
        text = String(parsed.html)
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
      const truncated = text.length > MAX_BODY_CHARS;
      if (opts?.markSeen && flags && !flags.has('\\Seen')) {
        await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
      }
      return {
        uid,
        from: fmtAddr(parsed.from),
        to: fmtAddr(parsed.to),
        cc: parsed.cc ? fmtAddr(parsed.cc) : undefined,
        subject: parsed.subject || '(无主题)',
        date: parsed.date ? parsed.date.toISOString() : '',
        text: truncated ? text.slice(0, MAX_BODY_CHARS) : text,
        truncated,
        attachments: (parsed.attachments || []).map((a) => ({
          filename: a.filename || '(未命名)',
          size: a.size,
          contentType: a.contentType,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

// ---------- Agent 工具 ----------

export function buildEmailImapTools(userId: string): ToolDefinition[] {
  const getEp = () => getUserImapEndpoint(userId);

  return [
    {
      name: 'email_list',
      description:
        '列出用户邮箱收件箱邮件(默认最新 15 封,新邮件在前):返回 uid/发件人/主题/时间/未读标记/正文摘要。' +
        '支持只看未读(unreadOnly)、限定最近 N 天(sinceDays)、关键词搜索(search,命中主题或正文)。' +
        '不会把邮件标记成已读。拿到 uid 后用 email_read 读全文。' +
        '需要用户先在连接器页配置「电子邮件收件 (IMAP)」凭证(或直接复用已配置的 SMTP 凭证)。',
      dangerLevel: 'medium',
      parameters: {
        type: 'object',
        properties: {
          unreadOnly: { type: 'boolean', description: '只列未读邮件(默认 false)' },
          sinceDays: { type: 'number', description: '只看最近 N 天(如 1=今天起、7=本周;缺省不限)' },
          search: { type: 'string', description: '关键词搜索,命中主题或正文(可选)' },
          limit: { type: 'number', description: '返回条数 1-50(默认 15)' },
          folder: { type: 'string', description: '邮箱文件夹(默认 INBOX)' },
        },
      },
      execute: async ({ unreadOnly, sinceDays, search, limit, folder }) => {
        const ep = getEp();
        if (!ep) return { success: false, error: NOT_CONFIGURED_MSG };
        try {
          const mails = await listEmails(ep, {
            unreadOnly: Boolean(unreadOnly),
            sinceDays: typeof sinceDays === 'number' ? sinceDays : undefined,
            search: typeof search === 'string' ? search : undefined,
            limit: typeof limit === 'number' ? limit : undefined,
            folder: typeof folder === 'string' ? folder : undefined,
          });
          return {
            success: true,
            account: ep.user,
            count: mails.length,
            mails,
            hint: mails.length ? '用 email_read 工具按 uid 读取某封邮件全文' : undefined,
          };
        } catch (e: any) {
          return { success: false, error: friendlyImapError(e, ep) };
        }
      },
    },
    {
      name: 'email_read',
      description:
        '按 uid 读取一封邮件的完整内容:发件人/收件人/主题/时间/正文(纯文本,超长截断)/附件清单(只列文件名与大小,不下载内容)。' +
        'uid 从 email_list 结果中获取。默认不改变已读状态,markSeen=true 可标记为已读。',
      dangerLevel: 'medium',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'number', description: '邮件 uid(来自 email_list 结果)' },
          markSeen: { type: 'boolean', description: '读取后标记为已读(默认 false)' },
          folder: { type: 'string', description: '邮箱文件夹(默认 INBOX)' },
        },
        required: ['uid'],
      },
      execute: async ({ uid, markSeen, folder }) => {
        const ep = getEp();
        if (!ep) return { success: false, error: NOT_CONFIGURED_MSG };
        const id = Number(uid);
        if (!Number.isFinite(id) || id <= 0) return { success: false, error: 'uid 必须是正整数(来自 email_list)' };
        try {
          const mail = await readEmail(ep, id, {
            markSeen: Boolean(markSeen),
            folder: typeof folder === 'string' ? folder : undefined,
          });
          if (!mail) return { success: false, error: `收件箱中未找到 uid=${id} 的邮件(可能已被移动或删除)` };
          return { success: true, account: ep.user, mail };
        } catch (e: any) {
          return { success: false, error: friendlyImapError(e, ep) };
        }
      },
    },
  ];
}
