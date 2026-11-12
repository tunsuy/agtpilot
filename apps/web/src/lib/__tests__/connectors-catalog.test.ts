import { describe, it, expect, vi, afterEach } from 'vitest';
import { getConnectorStatusList, ALLOWED_ENV_VARS } from '../connectors-catalog';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('E2B 连接器 · 自建配置入口', () => {
  it('四个自建配置键都在可写白名单内（否则 POST 会 400）', () => {
    for (const key of ['E2B_API_KEY', 'E2B_API_URL', 'E2B_DOMAIN', 'E2B_SANDBOX_URL', 'E2B_TEMPLATE']) {
      expect(ALLOWED_ENV_VARS.has(key)).toBe(true);
    }
  });

  it('E2B 卡片声明自建配置字段并按全局 env 回显（供弹窗预填）', () => {
    vi.stubEnv('E2B_API_KEY', 'e2b_selfhosted_key');
    vi.stubEnv('E2B_API_URL', 'http://e2b-api.internal:3000');
    vi.stubEnv('E2B_TEMPLATE', 'code-interpreter-v1');
    const e2b = getConnectorStatusList().find((c) => c.id === 'e2b');
    expect(e2b).toBeTruthy();
    expect(e2b!.status).toBe('connected');
    expect(e2b!.extraEnvVars?.map((f) => f.envVar)).toEqual([
      'E2B_API_URL',
      'E2B_DOMAIN',
      'E2B_SANDBOX_URL',
      'E2B_TEMPLATE',
    ]);
    expect(e2b!.extraEnvValues).toMatchObject({
      E2B_API_URL: 'http://e2b-api.internal:3000',
      E2B_TEMPLATE: 'code-interpreter-v1',
    });
  });

  it('未配置自建地址时不回显 extraEnvValues（弹窗保持空）', () => {
    vi.stubEnv('E2B_API_KEY', '');
    vi.stubEnv('E2B_API_URL', '');
    vi.stubEnv('E2B_DOMAIN', '');
    vi.stubEnv('E2B_SANDBOX_URL', '');
    vi.stubEnv('E2B_TEMPLATE', '');
    const e2b = getConnectorStatusList().find((c) => c.id === 'e2b');
    expect(e2b!.status).toBe('unconfigured');
    expect(e2b!.extraEnvValues).toBeUndefined();
  });
});
