import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CredentialUser = { email: string; name: string };

function credentialsDir(): string {
  return path.join(process.env.USER_DATA_DIR || path.resolve(process.cwd(), '.cache', 'user_data'), 'auth-users');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function accountPath(email: string): string {
  const id = crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
  return path.join(credentialsDir(), `${id}.json`);
}

function derive(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

export function registerCredentialUser(email: string, password: string, name: string): CredentialUser | null {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized) || password.length < 12 || password.length > 1024) return null;

  const file = accountPath(normalized);
  const salt = crypto.randomBytes(16);
  const record = {
    email: normalized,
    name: name.trim().slice(0, 100) || normalized.split('@')[0],
    salt: salt.toString('base64url'),
    hash: derive(password, salt).toString('base64url'),
    createdAt: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { email: record.email, name: record.name };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
}

export function verifyCredentialUser(email: string, password: string): CredentialUser | null {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized) || !password || password.length > 1024) return null;

  try {
    const record = JSON.parse(fs.readFileSync(accountPath(normalized), 'utf8')) as {
      email: string;
      name: string;
      salt: string;
      hash: string;
    };
    const salt = Buffer.from(record.salt, 'base64url');
    const expected = Buffer.from(record.hash, 'base64url');
    const actual = derive(password, salt);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    return { email: record.email, name: record.name };
  } catch {
    return null;
  }
}
