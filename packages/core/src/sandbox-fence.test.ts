import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CREDENTIAL_BINDINGS,
  buildChildEnv,
  resolveCredentialRequest,
  decideFence,
  buildBwrapArgs,
} from './sandbox-fence';

const HOST_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/test',
  LANG: 'C.UTF-8',
  SECRET_OTHER: 'should-never-leak',
};

const SESSION_ENV = {
  EXA_API_KEY: 'exa-secret',
  TAVILY_API_KEY: 'tavily-secret',
  FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
};

describe('buildChildEnv(凭据托管:默认零 session.env Key)', () => {
  it('默认策略下子进程环境不含任何 session.env 键', () => {
    const env = buildChildEnv(SESSION_ENV, undefined, HOST_ENV);
    expect(env).not.toHaveProperty('EXA_API_KEY');
    expect(env).not.toHaveProperty('TAVILY_API_KEY');
    expect(env).not.toHaveProperty('FEISHU_WEBHOOK_URL');
    expect(env.CI).toBe('true');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('不整包继承宿主 process.env', () => {
    const env = buildChildEnv(undefined, undefined, HOST_ENV);
    expect(env).not.toHaveProperty('SECRET_OTHER');
  });

  it('exposeEnv 显式白名单内的键才透传(交集语义)', () => {
    const env = buildChildEnv(SESSION_ENV, { exposeEnv: ['EXA_API_KEY', 'NOT_SAVED_KEY'] }, HOST_ENV);
    expect(env.EXA_API_KEY).toBe('exa-secret');
    expect(env).not.toHaveProperty('NOT_SAVED_KEY');
    expect(env).not.toHaveProperty('TAVILY_API_KEY');
  });

  it('exposeEnv 为空数组 = 零透传', () => {
    const env = buildChildEnv(SESSION_ENV, { exposeEnv: [] }, HOST_ENV);
    expect(Object.keys(env).some((k) => k.endsWith('_API_KEY') || k.endsWith('_WEBHOOK_URL'))).toBe(false);
  });
});

describe('resolveCredentialRequest(端点绑定)', () => {
  it('默认绑定覆盖既有连接器 Key', () => {
    expect(DEFAULT_CREDENTIAL_BINDINGS.EXA_API_KEY).toContain('api.exa.ai');
    expect(DEFAULT_CREDENTIAL_BINDINGS.E2B_API_KEY).toContain('api.e2b.dev');
    expect(DEFAULT_CREDENTIAL_BINDINGS.WECOM_WEBHOOK_URL).toContain('qyapi.weixin.qq.com');
  });

  it('凭据发往绑定端点 → ok 且返回真实值', () => {
    const r = resolveCredentialRequest({ credentialRef: 'EXA_API_KEY', hostname: 'api.exa.ai' }, SESSION_ENV, DEFAULT_CREDENTIAL_BINDINGS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('exa-secret');
  });

  it('凭据发往陌生端点 → credential_endpoint_mismatch,不泄漏值', () => {
    const r = resolveCredentialRequest({ credentialRef: 'EXA_API_KEY', hostname: 'evil.example.com' }, SESSION_ENV, DEFAULT_CREDENTIAL_BINDINGS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('credential_endpoint_mismatch');
      expect(JSON.stringify(r)).not.toContain('exa-secret');
    }
  });

  it('引用不存在的凭据 → credential_not_found', () => {
    const r = resolveCredentialRequest({ credentialRef: 'GHOST_KEY', hostname: 'api.exa.ai' }, SESSION_ENV, DEFAULT_CREDENTIAL_BINDINGS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('credential_not_found');
  });

  it('无绑定记录的凭据即使 host 看似合理也拒绝(fail closed)', () => {
    const r = resolveCredentialRequest({ credentialRef: 'TAVILY_API_KEY', hostname: 'api.tavily.com' }, SESSION_ENV, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('credential_endpoint_mismatch');
  });

  it('用户自定义绑定与默认合并生效', () => {
    const merged = { ...DEFAULT_CREDENTIAL_BINDINGS, SELF_HOSTED_KEY: ['llm.mycorp.internal.example'] };
    const r = resolveCredentialRequest(
      { credentialRef: 'SELF_HOSTED_KEY', hostname: 'llm.mycorp.internal.example' },
      { SELF_HOSTED_KEY: 'sk-x' },
      merged,
    );
    expect(r.ok).toBe(true);
  });
});

describe('decideFence(best_effort / hard_requirement 矩阵)', () => {
  it('off → 不包裹不降级', () => {
    expect(decideFence('off', true)).toEqual({ wrap: false, degraded: false, blocked: false });
    expect(decideFence(undefined, true).wrap).toBe(false);
  });

  it('best_effort + bwrap 可用 → 包裹', () => {
    const d = decideFence('best_effort', true);
    expect(d).toMatchObject({ wrap: true, degraded: false, blocked: false });
  });

  it('best_effort + bwrap 不可用 → 降级继续(显式标注)', () => {
    const d = decideFence('best_effort', false);
    expect(d).toMatchObject({ wrap: false, degraded: true, blocked: false });
    expect(d.reason).toBeTruthy();
  });

  it('hard_requirement + bwrap 可用 → 包裹', () => {
    expect(decideFence('hard_requirement', true)).toMatchObject({ wrap: true, blocked: false });
  });

  it('hard_requirement + bwrap 不可用 → 拒绝执行', () => {
    const d = decideFence('hard_requirement', false);
    expect(d).toMatchObject({ wrap: false, blocked: true });
    expect(d.reason).toBeTruthy();
  });
});

describe('buildBwrapArgs', () => {
  it('只读根 + 可写 workspace + tmpfs /tmp + die-with-parent', () => {
    const args = buildBwrapArgs({ workspaceRoot: '/srv/app' });
    expect(args).toContain('--ro-bind-try');
    expect(args).toContain('--die-with-parent');
    expect(args.join(' ')).toContain('--tmpfs /tmp');
    expect(args.join(' ')).toContain('--bind /srv/app /srv/app');
    expect(args).not.toContain('--unshare-net');
  });

  it('net=deny 时加 --unshare-net', () => {
    const args = buildBwrapArgs({ workspaceRoot: '/srv/app', net: 'deny' });
    expect(args).toContain('--unshare-net');
  });

  it('workspace 绑定排在只读根之后(覆盖生效)', () => {
    const args = buildBwrapArgs({ workspaceRoot: '/srv/app' });
    const roIdx = args.indexOf('--ro-bind-try');
    const bindIdx = args.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(roIdx);
  });
});
