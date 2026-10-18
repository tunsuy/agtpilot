import fs from 'fs';
import path from 'path';
import { getDataDir } from './user-store';

/**
 * 通道应用层存储 —— 身份绑定 / 会话映射 / 通道凭证 / 绑定码 / 消息去重。
 *
 * 分层依据(ARCHITECTURE.md 反模式 #10):plugin-channel 是无头通道引擎,
 * 持久化与身份策略全部归应用层。绑定与会话映射按数据目录落盘(进程重启不丢),
 * 绑定码与去重窗口是短命状态,留内存。
 *
 * 密钥卫生:凭证文件只落数据目录(与 user-store 同域,不进 git、不进日志);
 * 任何函数不回显凭证值。
 */

export interface ChannelBinding {
  /** 通道 id(wechat_mp / wechat_personal / qq_onebot) */
  channel: string;
  /** IM 侧用户身份(openid / from_user_id / 群内成员键) */
  externalUserId: string;
  externalUserName?: string;
  /** AgtPilot 产品侧 userId */
  userId: string;
  boundAt: string;
}

export interface ChannelConversation {
  channel: string;
  conversationId: string;
  userId: string;
  /** 映射的续聊任务;「新会话」指令清除,下一条消息开新 mission */
  missionId?: string;
  lastActiveAt: string;
}

export interface StoredChannelCredentials {
  /** 扫码授权产生的 iLink bot_token(运维流写入,不进 .env) */
  wechatPersonalBotToken?: string;
  wechatPersonalBaseUrl?: string;
  updatedAt?: string;
}

const BINDINGS_FILE = 'channel-bindings.json';
const CONVERSATIONS_FILE = 'channel-conversations.json';
const CREDENTIALS_FILE = 'channel-credentials.json';

function storePath(name: string): string {
  return path.join(getDataDir(), name);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(storePath(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, data: unknown): void {
  const p = storePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 先写临时文件再原子替换,防写一半被读到
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// ── 绑定 ──

export function findBinding(channel: string, externalUserId: string): ChannelBinding | null {
  const all = readJson<ChannelBinding[]>(BINDINGS_FILE, []);
  return all.find((b) => b.channel === channel && b.externalUserId === externalUserId) ?? null;
}

export function saveBinding(binding: ChannelBinding): void {
  const all = readJson<ChannelBinding[]>(BINDINGS_FILE, []);
  const idx = all.findIndex((b) => b.channel === binding.channel && b.externalUserId === binding.externalUserId);
  if (idx >= 0) all[idx] = binding;
  else all.push(binding);
  writeJson(BINDINGS_FILE, all);
}

export function deleteBinding(channel: string, externalUserId: string): boolean {
  const all = readJson<ChannelBinding[]>(BINDINGS_FILE, []);
  const next = all.filter((b) => !(b.channel === channel && b.externalUserId === externalUserId));
  if (next.length === all.length) return false;
  writeJson(BINDINGS_FILE, next);
  return true;
}

export function listBindingsForUser(userId: string): ChannelBinding[] {
  return readJson<ChannelBinding[]>(BINDINGS_FILE, []).filter((b) => b.userId === userId);
}

// ── 会话映射 ──

export function getConversation(channel: string, conversationId: string): ChannelConversation | null {
  const all = readJson<ChannelConversation[]>(CONVERSATIONS_FILE, []);
  return all.find((c) => c.channel === channel && c.conversationId === conversationId) ?? null;
}

export function saveConversation(conv: ChannelConversation): void {
  const all = readJson<ChannelConversation[]>(CONVERSATIONS_FILE, []);
  const idx = all.findIndex((c) => c.channel === conv.channel && c.conversationId === conv.conversationId);
  if (idx >= 0) all[idx] = conv;
  else all.push(conv);
  writeJson(CONVERSATIONS_FILE, all);
}

/** 「新会话」:清 missionId 映射,下一条消息开新任务(绑定保留)。 */
export function resetConversationMission(channel: string, conversationId: string): boolean {
  const conv = getConversation(channel, conversationId);
  if (!conv) return false;
  saveConversation({ ...conv, missionId: undefined, lastActiveAt: new Date().toISOString() });
  return true;
}

// ── 通道凭证(扫码授权产物) ──

export function getChannelCredentials(): StoredChannelCredentials {
  return readJson<StoredChannelCredentials>(CREDENTIALS_FILE, {});
}

export function saveChannelCredentials(patch: Partial<StoredChannelCredentials>): void {
  const cur = getChannelCredentials();
  writeJson(CREDENTIALS_FILE, { ...cur, ...patch, updatedAt: new Date().toISOString() });
}

// ── 绑定码(内存,10min TTL,单次消费) ──

const BIND_CODE_TTL_MS = 10 * 60 * 1000;
const bindCodes = new Map<string, { userId: string; expiresAt: number }>();

export function generateBindCodeDigits(rand: () => number = Math.random): string {
  return String(Math.floor(rand() * 1_000_000)).padStart(6, '0');
}

export function createBindCode(userId: string, now: number = Date.now()): string {
  // 碰撞重试几次即可(6 位数字 + 10min 窗口,活跃码极少)
  for (let i = 0; i < 20; i++) {
    const code = generateBindCodeDigits();
    const existing = bindCodes.get(code);
    if (!existing || existing.expiresAt <= now) {
      bindCodes.set(code, { userId, expiresAt: now + BIND_CODE_TTL_MS });
      return code;
    }
  }
  throw new Error('绑定码池拥挤,请稍后再试');
}

export function consumeBindCode(code: string, now: number = Date.now()): { userId: string } | null {
  const entry = bindCodes.get(code);
  if (!entry) return null;
  bindCodes.delete(code); // 单次消费:过期与否都作废
  if (entry.expiresAt <= now) return null;
  return { userId: entry.userId };
}

// ── 消息去重(内存 LRU,平台重推防御 —— 公众号有 3 次重试语义) ──

const DEDUPE_CAP = 500;
const seenMessages = new Map<string, number>();

export function isDuplicateMessage(channel: string, messageId: string, now: number = Date.now()): boolean {
  const key = `${channel}:${messageId}`;
  if (seenMessages.has(key)) return true;
  seenMessages.set(key, now);
  if (seenMessages.size > DEDUPE_CAP) {
    // 丢最旧一半(Map 迭代序 = 插入序)
    const dropCount = Math.floor(DEDUPE_CAP / 2);
    let i = 0;
    for (const k of seenMessages.keys()) {
      if (i++ >= dropCount) break;
      seenMessages.delete(k);
    }
  }
  return false;
}

/** 测试辅助:清空内存态(绑定码 + 去重窗口)。 */
export function __resetInMemoryState(): void {
  bindCodes.clear();
  seenMessages.clear();
}
