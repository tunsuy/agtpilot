import { describe, it, expect, vi } from 'vitest';
import {
  E2BSessionPool,
  DEFAULT_POOL_OPTIONS,
  resolveE2BConnection,
  resolveControlPlaneUrl,
  sandboxSessionKey,
  sandboxFileUrl,
  controlPlaneProtocol,
  truncateCommandOutput,
  probeControlPlane,
} from './e2b';
import type { E2BSandboxHandle, SandboxFactory } from './e2b';

describe('resolveE2BConnection(自建 E2B 连接解析)', () => {
  it('优先级：session.env > 插件配置 > 进程环境', () => {
    const conn = resolveE2BConnection({
      sessionEnv: { E2B_API_KEY: 'user-key', E2B_API_URL: 'http://user-api:3000' },
      plugin: { apiKey: 'plugin-key', domain: 'plugin.internal' },
      processEnv: { E2B_API_KEY: 'env-key', E2B_DOMAIN: 'env.internal', E2B_SANDBOX_URL: 'http://sbx.env' },
    });
    expect(conn.apiKey).toBe('user-key');
    expect(conn.apiUrl).toBe('http://user-api:3000');
    expect(conn.domain).toBe('plugin.internal');
    expect(conn.sandboxUrl).toBe('http://sbx.env');
  });

  it('空字符串视为未设置（避免 .env 里 E2B_API_URL= 覆盖自建地址）', () => {
    const conn = resolveE2BConnection({
      sessionEnv: { E2B_API_KEY: '' },
      plugin: { apiKey: 'plugin-key' },
      processEnv: {},
    });
    expect(conn.apiKey).toBe('plugin-key');
    expect(conn.apiUrl).toBeUndefined();
  });

  it('E2B_DEBUG=true 才开启本地 debug 模式', () => {
    expect(resolveE2BConnection({ processEnv: { E2B_DEBUG: 'true' } }).debug).toBe(true);
    expect(resolveE2BConnection({ processEnv: { E2B_DEBUG: '1' } }).debug).toBeFalsy();
  });
});

describe('resolveControlPlaneUrl(自建控制面地址)', () => {
  it('显式 apiUrl 优先并去掉尾部斜杠', () => {
    expect(resolveControlPlaneUrl({ apiUrl: 'http://e2b.internal:3000/' })).toBe('http://e2b.internal:3000');
  });

  it('无 apiUrl 时按自建域名推导', () => {
    expect(resolveControlPlaneUrl({ domain: 'e2b.example.com' })).toBe('https://api.e2b.example.com');
    expect(resolveControlPlaneUrl({})).toBe('https://api.e2b.app');
  });

  it('debug 模式指向本地 envd', () => {
    expect(resolveControlPlaneUrl({ debug: true })).toBe('http://localhost:3000');
  });
});

describe('sandboxSessionKey(会话分域)', () => {
  it('按 userId+taskId 分域', () => {
    expect(sandboxSessionKey({ userId: 'u1', taskId: 't1' })).toBe('u1::t1');
  });

  it('缺省回退 default::adhoc', () => {
    expect(sandboxSessionKey(undefined)).toBe('default::adhoc');
  });
});

describe('probeControlPlane(自建控制面连通性)', () => {
  it('拼接 /health 并带 X-API-Key，不泄露到返回值', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await probeControlPlane(
      { apiKey: 'k-secret', apiUrl: 'http://e2b.internal:3000/' },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.url).toBe('http://e2b.internal:3000/health');
    expect(calls[0].init.headers['X-API-Key']).toBe('k-secret');
    expect(JSON.stringify(result)).not.toContain('k-secret');
  });

  it('控制面不可达时返回错误而不是抛出', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await probeControlPlane({ domain: 'e2b.internal' }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.url).toBe('https://api.e2b.internal/health');
  });
});

describe('truncateCommandOutput(输出裁剪)', () => {
  it('短输出原样返回', () => {
    expect(truncateCommandOutput('hello', 100)).toBe('hello');
  });

  it('长输出保留头尾并标注省略字符数', () => {
    const out = 'a'.repeat(400) + 'TAIL';
    const truncated = truncateCommandOutput(out, 100);
    expect(truncated.length).toBeLessThan(out.length);
    expect(truncated).toContain('省略');
    expect(truncated.endsWith('TAIL')).toBe(true);
  });
});

describe('sandboxFileUrl(产物直连)', () => {
  it('用 traffic 域名派生下载地址并对路径编码', () => {
    const sandbox = { getHost: () => 'https://49983-abc.sbx.internal' } as unknown as E2BSandboxHandle;
    expect(sandboxFileUrl(sandbox, '/home/user/a b.md')).toBe(
      'https://49983-abc.sbx.internal/files?path=%2Fhome%2Fuser%2Fa%20b.md&username=user',
    );
  });

  it('getHost 返回裸域名时补 https', () => {
    const sandbox = { getHost: () => '49983-abc.sbx.internal' } as unknown as E2BSandboxHandle;
    expect(sandboxFileUrl(sandbox, '/x')).toContain('https://49983-abc.sbx.internal/files');
  });

  it('自建 http 控制面时下载地址跟随 http', () => {
    const sandbox = { getHost: () => '49983-abc.sbx.internal' } as unknown as E2BSandboxHandle;
    expect(controlPlaneProtocol({ apiUrl: 'http://e2b.internal:3000' })).toBe('http');
    expect(sandboxFileUrl(sandbox, '/x', 49983, 'http')).toContain('http://49983-abc.sbx.internal/files');
  });
});

function fakeHandle(id: string, overrides: Partial<E2BSandboxHandle> = {}): E2BSandboxHandle {
  return {
    sandboxId: id,
    getHost: () => `https://49983-${id}.sbx.internal`,
    commands: { run: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })) },
    files: {
      write: vi.fn(async () => ({})),
      read: vi.fn(async () => 'content'),
      list: vi.fn(async () => []),
      makeDir: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    },
    setTimeout: vi.fn(async () => undefined),
    pause: vi.fn(async () => true),
    kill: vi.fn(async () => true),
    isRunning: vi.fn(async () => true),
    ...overrides,
  };
}

function fakeFactory(handles: E2BSandboxHandle[]): SandboxFactory & { created: number; connected: string[] } {
  const state = { created: 0, connected: [] as string[] };
  return {
    get created() {
      return state.created;
    },
    get connected() {
      return state.connected;
    },
    create: vi.fn(async () => {
      const handle = handles[state.created] || fakeHandle(`sandbox-${state.created}`);
      state.created += 1;
      return handle;
    }),
    connect: vi.fn(async (id: string) => {
      state.connected.push(id);
      return handles.find((handle) => handle.sandboxId === id) || fakeHandle(id);
    }),
  };
}

describe('E2BSessionPool(任务级会话复用 + 续期 + 回收)', () => {
  it('同一 key 复用同一 sandbox，不重复 create', async () => {
    const factory = fakeFactory([fakeHandle('s1')]);
    const pool = new E2BSessionPool(factory, DEFAULT_POOL_OPTIONS);
    const a = await pool.acquire('u::t', { apiKey: 'k' }, { apiKey: 'k' });
    const b = await pool.acquire('u::t', { apiKey: 'k' }, { apiKey: 'k' });
    expect(a.sandboxId).toBe('s1');
    expect(b.sandboxId).toBe('s1');
    expect(factory.created).toBe(1);
  });

  it('并发 acquire 只 create 一次（pending 去重）', async () => {
    const factory = fakeFactory([fakeHandle('s1')]);
    const pool = new E2BSessionPool(factory, DEFAULT_POOL_OPTIONS);
    const results = await Promise.all([
      pool.acquire('u::t', { apiKey: 'k' }, { apiKey: 'k' }),
      pool.acquire('u::t', { apiKey: 'k' }, { apiKey: 'k' }),
      pool.acquire('u::t', { apiKey: 'k' }, { apiKey: 'k' }),
    ]);
    expect(new Set(results.map((r) => r.sandboxId))).toEqual(new Set(['s1']));
    expect(factory.created).toBe(1);
  });

  it('有 resumeId 时先 connect 恢复，失败才 create', async () => {
    const resumed = fakeHandle('saved');
    const factory = fakeFactory([resumed]);
    const pool = new E2BSessionPool(factory, DEFAULT_POOL_OPTIONS);
    const sandbox = await pool.acquire('u::t', { apiKey: 'k' }, { apiKey: 'k' }, 'saved');
    expect(sandbox.sandboxId).toBe('saved');
    expect(factory.connected).toEqual(['saved']);
    expect(factory.created).toBe(0);
  });

  it('会话已死（isRunning=false）时重建', async () => {
    const dead = fakeHandle('dead', { isRunning: vi.fn(async () => false) });
    const fresh = fakeHandle('fresh');
    const factory = fakeFactory([dead, fresh]);
    const pool = new E2BSessionPool(factory, DEFAULT_POOL_OPTIONS);
    expect((await pool.acquire('u::t', {}, {})).sandboxId).toBe('dead');
    expect((await pool.acquire('u::t', {}, {})).sandboxId).toBe('fresh');
    expect(factory.created).toBe(2);
  });

  it('touch 按心跳间隔节流续期', async () => {
    let now = 1_000_000;
    const sandbox = fakeHandle('s1');
    const factory = fakeFactory([sandbox]);
    const pool = new E2BSessionPool(factory, { ...DEFAULT_POOL_OPTIONS, heartbeatIntervalMs: 60_000 }, () => now);
    const acquired = await pool.acquire('u::t', {}, {});
    // acquire 时 lastHeartbeat 已记录当前时间，立刻 touch 不重复打控制面
    await pool.touch('u::t', acquired);
    expect(sandbox.setTimeout).toHaveBeenCalledTimes(0);
    now += 10_000;
    await pool.touch('u::t', acquired);
    expect(sandbox.setTimeout).toHaveBeenCalledTimes(0);
    now += 60_000;
    await pool.touch('u::t', acquired);
    expect(sandbox.setTimeout).toHaveBeenCalledTimes(1);
  });

  it('touch 在续期失败时不抛出（控制面短暂不可用不阻断本次调用）', async () => {
    let now = 1_000_000;
    const sandbox = fakeHandle('s1', { setTimeout: vi.fn(async () => { throw new Error('api down'); }) });
    const pool = new E2BSessionPool(fakeFactory([sandbox]), { ...DEFAULT_POOL_OPTIONS, heartbeatIntervalMs: 0 }, () => now);
    const acquired = await pool.acquire('u::t', {}, {});
    now += 1;
    await expect(pool.touch('u::t', acquired)).resolves.toBeUndefined();
  });

  it('空闲回收按 idleAction=pause 保留内存快照', async () => {
    let now = 1_000_000;
    const sandbox = fakeHandle('s1');
    const pool = new E2BSessionPool(
      fakeFactory([sandbox]),
      { ...DEFAULT_POOL_OPTIONS, idleTtlMs: 1_000, idleAction: 'pause' },
      () => now,
    );
    await pool.acquire('u::t', {}, {});
    now += 2_000;
    expect(await pool.evictIdle()).toEqual(['u::t']);
    expect(sandbox.pause).toHaveBeenCalledWith({ keepMemory: true });
    expect(pool.get('u::t')).toBeUndefined();
  });

  it('空闲回收按 idleAction=kill 直接销毁', async () => {
    let now = 1_000_000;
    const sandbox = fakeHandle('s1');
    const pool = new E2BSessionPool(
      fakeFactory([sandbox]),
      { ...DEFAULT_POOL_OPTIONS, idleTtlMs: 1_000, idleAction: 'kill' },
      () => now,
    );
    await pool.acquire('u::t', {}, {});
    now += 2_000;
    await pool.evictIdle();
    expect(sandbox.kill).toHaveBeenCalled();
  });

  it('resume 仅按已保存 id 恢复，失败返回 undefined 且不新建', async () => {
    const saved = fakeHandle('saved');
    const factory = fakeFactory([saved]);
    const pool = new E2BSessionPool(factory, DEFAULT_POOL_OPTIONS);
    const resumed = await pool.resume('u::t', 'saved', { apiKey: 'k' });
    expect(resumed?.sandboxId).toBe('saved');
    expect(factory.connected).toEqual(['saved']);
    expect(factory.created).toBe(0);
    expect(pool.get('u::t')?.sandboxId).toBe('saved');
  });

  it('resume 失败时返回 undefined（不冷启动新 VM）', async () => {
    const factory = fakeFactory([]);
    (factory.connect as any).mockRejectedValueOnce(new Error('sandbox not found'));
    const pool = new E2BSessionPool(factory, DEFAULT_POOL_OPTIONS);
    expect(await pool.resume('u::t', 'gone', { apiKey: 'k' })).toBeUndefined();
    expect(factory.created).toBe(0);
  });

  it('kill 移除会话并断开会话表', async () => {
    const sandbox = fakeHandle('s1');
    const pool = new E2BSessionPool(fakeFactory([sandbox]), DEFAULT_POOL_OPTIONS);
    await pool.acquire('u::t', {}, {});
    expect(await pool.kill('u::t')).toBe(true);
    expect(pool.get('u::t')).toBeUndefined();
    expect(sandbox.kill).toHaveBeenCalled();
  });
});
