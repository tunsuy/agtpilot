import { describe, it, expect, afterEach, vi } from 'vitest';
import { getOpsAdminIds, isOpsAdmin } from '../ops-admin';

/** 邮箱 → 稳定 userId（与 auth-identity.deriveStableUserId / ops-admin 同款算法） */
function stableId(email: string): string {
  return 'usr_' + Buffer.from(email.toLowerCase().trim()).toString('hex').slice(0, 16);
}

describe('ops-admin default admin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('env 未设置时默认 957126743@qq.com 为运营管理员', () => {
    vi.stubEnv('AGTPILOT_OPS_ADMINS', undefined as unknown as string);
    delete process.env.AGTPILOT_OPS_ADMINS;
    expect(isOpsAdmin(stableId('957126743@qq.com'))).toBe(true);
    expect(isOpsAdmin(stableId('someone@else.com'))).toBe(false);
  });

  it('env 显式设置为其它账号则默认账号不再命中', () => {
    vi.stubEnv('AGTPILOT_OPS_ADMINS', 'boss@corp.com');
    expect(isOpsAdmin(stableId('boss@corp.com'))).toBe(true);
    expect(isOpsAdmin(stableId('957126743@qq.com'))).toBe(false);
  });

  it('env 显式空串清空默认管理员', () => {
    vi.stubEnv('AGTPILOT_OPS_ADMINS', '');
    expect(getOpsAdminIds().size).toBe(0);
    expect(isOpsAdmin(stableId('957126743@qq.com'))).toBe(false);
  });
});
