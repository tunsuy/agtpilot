import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { registerCredentialUser, verifyCredentialUser } from '../auth-credentials';

const dirs: string[] = [];
function useTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-auth-'));
  dirs.push(dir);
  process.env.USER_DATA_DIR = dir;
  return dir;
}

afterEach(() => {
  delete process.env.USER_DATA_DIR;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('auth credentials', () => {
  it('registers and verifies a password without storing plaintext', () => {
    const dir = useTempDir();
    expect(registerCredentialUser('Test@Example.com', 'a-long-secure-password', 'Test User')).toEqual({
      email: 'test@example.com',
      name: 'Test User',
    });
    expect(verifyCredentialUser('TEST@example.com', 'a-long-secure-password')).toEqual({
      email: 'test@example.com',
      name: 'Test User',
    });
    expect(verifyCredentialUser('test@example.com', 'wrong-password')).toBeNull();
    const file = path.join(dir, 'auth-users', `${(awaitlessHash('test@example.com'))}.json`);
    const stored = fs.readFileSync(file, 'utf8');
    expect(stored).not.toContain('a-long-secure-password');
  });

  it('rejects duplicate accounts and weak passwords', () => {
    useTempDir();
    expect(registerCredentialUser('person@example.com', 'short', 'Person')).toBeNull();
    expect(registerCredentialUser('person@example.com', 'a-long-secure-password', 'Person')).not.toBeNull();
    expect(registerCredentialUser('PERSON@example.com', 'another-long-password', 'Other')).toBeNull();
  });
});

function awaitlessHash(email: string): string {
  return crypto.createHash('sha256').update(email).digest('hex');
}
