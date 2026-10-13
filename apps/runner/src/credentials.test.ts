import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCredentials, saveCredentials, clearCredentials, credentialsFile, type RunnerCredentials } from './credentials';

const creds: RunnerCredentials = {
  serverUrl: 'https://app.example.com',
  deviceId: 'dev_0123456789abcdef',
  deviceSecret: 's'.repeat(43),
  pairedAt: 1760000000000,
  hostname: 'test-mac',
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-creds-'));
  process.env.AGTPILOT_RUNNER_HOME = tmp;
});

describe('credentials 存取', () => {
  it('save → load 往返一致', () => {
    saveCredentials(creds);
    expect(loadCredentials()).toEqual(creds);
  });

  it('凭据文件 0600、目录 0700', () => {
    saveCredentials(creds);
    const fileMode = fs.statSync(credentialsFile()).mode & 0o777;
    const dirMode = fs.statSync(tmp).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('未配对/损坏 JSON → load 返回 null(不抛错)', () => {
    expect(loadCredentials()).toBeNull();
    fs.writeFileSync(credentialsFile(), '{oops');
    expect(loadCredentials()).toBeNull();
    fs.writeFileSync(credentialsFile(), JSON.stringify({ serverUrl: 'x' })); // 缺关键字段
    expect(loadCredentials()).toBeNull();
  });

  it('clearCredentials 自毁凭据(401 场景),重复清除不抛错', () => {
    saveCredentials(creds);
    clearCredentials();
    expect(loadCredentials()).toBeNull();
    expect(() => clearCredentials()).not.toThrow();
  });
});
