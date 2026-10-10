import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// 纯类型导入(编译期擦除,不影响「先设环境变量再加载被测模块」的运行时顺序)
import type { PermissionProposedEvent, PermissionResolvedEvent } from '@/lib/governance-bus';

/**
 * 沙箱控制增强验收测试(设计依据 docs/design/sandbox-control-hardening.md §6):
 * - exposeAllowlist 门控(用户显式 opt-in 才允许 Key 进子进程环境);
 * - 权限提案生命周期: pending → approve(合并进配置) / reject(不动配置);
 * - lintConnectorValue 非阻断警告(私网 host / 通配符 / 端点不匹配);
 * - sandbox 审计 jsonl 只增往返;
 * - governance-bus permission-proposed/resolved 通道。
 *
 * 环境隔离: USER_DATA_DIR 指向一次性临时目录(secret-box 缓存派生密钥,
 * 必须在动态 import 被测模块之前设置)。
 */

let tmpDir: string;
let us: typeof import('@/lib/user-store');
let gb: typeof import('@/lib/governance-bus');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-sbx-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'sbx-spec-test-key';
  us = await import('@/lib/user-store');
  gb = await import('@/lib/governance-bus');
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

describe('sandbox 配置与 exposeAllowlist 门控', () => {
  it('默认配置为空(零暴露/零自定义绑定/fence off)', () => {
    const cfg = us.getSandboxConfig('sbx-user-a');
    expect(cfg.exposeAllowlist || []).toEqual([]);
    expect(cfg.credentialBindings || {}).toEqual({});
    expect(cfg.fence === undefined || cfg.fence === 'off').toBe(true);
  });

  it('saveSandboxConfig 往返持久化', () => {
    us.saveSandboxConfig('sbx-user-a', {
      exposeAllowlist: ['EXA_API_KEY'],
      credentialBindings: { SELF_KEY: ['llm.example.com'] },
      fence: 'best_effort',
    });
    const cfg = us.getSandboxConfig('sbx-user-a');
    expect(cfg.exposeAllowlist).toEqual(['EXA_API_KEY']);
    expect(cfg.credentialBindings?.SELF_KEY).toEqual(['llm.example.com']);
    expect(cfg.fence).toBe('best_effort');
  });

  it('配置按用户隔离', () => {
    expect(us.getSandboxConfig('sbx-user-b').exposeAllowlist || []).toEqual([]);
  });
});

describe('权限提案生命周期(deny-log → proposal → review → hot update)', () => {
  it('addPolicyProposal 落 pending 并可列出', () => {
    const p = us.addPolicyProposal('sbx-user-p', {
      kind: 'credential-binding',
      detail: { envVar: 'EXA_API_KEY', hosts: ['api2.exa.ai'], reason: 'credential_endpoint_mismatch' },
      source: { taskId: 'task_1', tool: 'sandbox_http_request', url: 'https://api2.exa.ai/search' },
    });
    expect(p.status).toBe('pending');
    expect(p.id).toBeTruthy();
    const list = us.getPolicyProposals('sbx-user-p');
    expect(list.some((x) => x.id === p.id && x.status === 'pending')).toBe(true);
  });

  it('approve credential-binding → 绑定合并进 sandbox 配置(热更新数据源)', () => {
    const p = us.addPolicyProposal('sbx-user-p', {
      kind: 'credential-binding',
      detail: { envVar: 'EXA_API_KEY', hosts: ['api2.exa.ai'] },
    });
    const resolved = us.resolvePolicyProposal('sbx-user-p', p.id, true);
    expect(resolved?.status).toBe('approved');
    expect(us.getSandboxConfig('sbx-user-p').credentialBindings?.EXA_API_KEY).toContain('api2.exa.ai');
  });

  it('approve expose-env → 键并入 exposeAllowlist(去重)', () => {
    us.saveSandboxConfig('sbx-user-p', { exposeAllowlist: ['EXA_API_KEY'] });
    const p = us.addPolicyProposal('sbx-user-p', { kind: 'expose-env', detail: { envVar: 'EXA_API_KEY' } });
    us.resolvePolicyProposal('sbx-user-p', p.id, true);
    const p2 = us.addPolicyProposal('sbx-user-p', { kind: 'expose-env', detail: { envVar: 'TAVILY_API_KEY' } });
    us.resolvePolicyProposal('sbx-user-p', p2.id, true);
    expect(us.getSandboxConfig('sbx-user-p').exposeAllowlist).toEqual(['EXA_API_KEY', 'TAVILY_API_KEY']);
  });

  it('reject → 状态 rejected 且配置不动', () => {
    const before = JSON.stringify(us.getSandboxConfig('sbx-user-r'));
    const p = us.addPolicyProposal('sbx-user-r', {
      kind: 'credential-binding',
      detail: { envVar: 'EXA_API_KEY', hosts: ['evil.example.com'] },
    });
    const resolved = us.resolvePolicyProposal('sbx-user-r', p.id, false);
    expect(resolved?.status).toBe('rejected');
    expect(JSON.stringify(us.getSandboxConfig('sbx-user-r'))).toBe(before);
  });

  it('重复 resolve / 不存在的提案 → null(幂等)', () => {
    const p = us.addPolicyProposal('sbx-user-r', { kind: 'expose-env', detail: { envVar: 'X_KEY' } });
    expect(us.resolvePolicyProposal('sbx-user-r', p.id, true)?.status).toBe('approved');
    expect(us.resolvePolicyProposal('sbx-user-r', p.id, true)).toBeNull();
    expect(us.resolvePolicyProposal('sbx-user-r', 'ghost', true)).toBeNull();
  });
});

describe('lintConnectorValue(非阻断警告)', () => {
  it('webhook 指向私网 host → 警告', () => {
    const w = us.lintConnectorValue('FEISHU_WEBHOOK_URL', 'https://192.168.1.10/open-apis/bot/v2/hook/x');
    expect(w.some((x) => x.includes('私有'))).toBe(true);
  });

  it('值含通配符 → 警告', () => {
    const w = us.lintConnectorValue('SELF_ENDPOINT', 'https://*.example.com/api');
    expect(w.some((x) => x.includes('通配符'))).toBe(true);
  });

  it('连接器 host 与默认凭据绑定不匹配 → 端点不匹配警告', () => {
    const w = us.lintConnectorValue('EXA_API_KEY', 'https://api.exa.ai');
    expect(w).toEqual([]); // API Key 非 URL 形态不触发;URL 形态且匹配绑定 → 无警告
    const w2 = us.lintConnectorValue('FEISHU_WEBHOOK_URL', 'https://open.feishu.cn/open-apis/bot/v2/hook/x');
    expect(w2).toEqual([]);
    const w3 = us.lintConnectorValue('FEISHU_WEBHOOK_URL', 'https://evil.example.com/hook');
    expect(w3.some((x) => x.includes('端点'))).toBe(true);
  });

  it('普通 API Key(非 URL)不误报', () => {
    expect(us.lintConnectorValue('EXA_API_KEY', 'sk-abc123')).toEqual([]);
  });
});

describe('sandbox 审计日志(jsonl 只增)', () => {
  it('append/read 往返,最近在前', () => {
    us.appendSandboxAudit('sbx-user-audit', {
      userId: 'sbx-user-audit',
      tool: 'sandbox_http_request',
      reason: 'private_host_blocked',
      url: 'http://169.254.169.254/latest/meta-data/',
      taskId: 'task_9',
    });
    us.appendSandboxAudit('sbx-user-audit', {
      userId: 'sbx-user-audit',
      tool: 'sandbox_http_request',
      reason: 'credential_endpoint_mismatch',
      credentialRef: 'EXA_API_KEY',
      taskId: 'task_10',
    });
    const entries = us.readSandboxAudit('sbx-user-audit');
    expect(entries.length).toBe(2);
    expect(entries[0].reason).toBe('credential_endpoint_mismatch'); // 最近在前
    expect(entries[0].at).toBeGreaterThan(0);
    expect(entries[1].url).toContain('169.254.169.254');
  });

  it('审计文件与用户数据文件分离', () => {
    const files = fs.readdirSync(tmpDir);
    expect(files.some((f) => f.endsWith('.sandbox-audit.jsonl'))).toBe(true);
  });
});

describe('governance-bus 权限提案通道', () => {
  it('permission-proposed / permission-resolved 事件可达订阅者', () => {
    const bus = gb.getGovernanceBus();
    const proposed: PermissionProposedEvent[] = [];
    const resolved: PermissionResolvedEvent[] = [];
    const off1 = bus.onPermissionProposed((e) => proposed.push(e));
    const off2 = bus.onPermissionResolved((e) => resolved.push(e));

    bus.emitPermissionProposed({ userId: 'u1', proposalId: 'p1', kind: 'credential-binding', detail: 'EXA→api2.exa.ai' });
    bus.emitPermissionResolved({ userId: 'u1', proposalId: 'p1', approved: true, kind: 'credential-binding' });

    expect(proposed).toHaveLength(1);
    expect(proposed[0].proposalId).toBe('p1');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].approved).toBe(true);

    off1();
    off2();
    bus.emitPermissionProposed({ userId: 'u1', proposalId: 'p2', kind: 'expose-env' });
    expect(proposed).toHaveLength(1); // 退订后不再收到
  });

  it('单个订阅者抛错不阻断其他订阅者', () => {
    const bus = gb.getGovernanceBus();
    const hits: string[] = [];
    const offBad = bus.onPermissionProposed(() => {
      throw new Error('boom');
    });
    const offGood = bus.onPermissionProposed((e) => hits.push(e.proposalId));
    bus.emitPermissionProposed({ userId: 'u1', proposalId: 'p3', kind: 'expose-env' });
    expect(hits).toEqual(['p3']);
    offBad();
    offGood();
  });
});
