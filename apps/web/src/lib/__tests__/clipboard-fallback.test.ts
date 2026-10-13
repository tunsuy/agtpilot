import { describe, it, expect, vi, afterEach } from 'vitest';
import { webCopyToClipboard, legacyCopy } from '../../utils/clipboard';

/**
 * 剪贴板 http 降级(utils/clipboard.ts):
 * navigator.clipboard 只在安全上下文(https/localhost)存在,线上 http 部署
 * (agent.tunsuy.cn 未配 TLS)下是 undefined —— 必须走 textarea+execCommand 降级,
 * 否则全站复制按钮静默失效(负责人实测 bug)。
 */

interface FakeTa {
  value: string;
  style: Record<string, string>;
  setAttribute: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  setSelectionRange: ReturnType<typeof vi.fn>;
}

function stubDocument(execImpl: () => boolean) {
  const created: FakeTa[] = [];
  const appended: FakeTa[] = [];
  const removed: FakeTa[] = [];
  const execCommand = vi.fn(execImpl);
  vi.stubGlobal('document', {
    createElement: () => {
      const ta: FakeTa = {
        value: '',
        style: {},
        setAttribute: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
      };
      created.push(ta);
      return ta;
    },
    body: {
      appendChild: (el: FakeTa) => appended.push(el),
      removeChild: (el: FakeTa) => removed.push(el),
    },
    execCommand,
  });
  return { created, appended, removed, execCommand };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('webCopyToClipboard', () => {
  it('安全上下文:navigator.clipboard 可用 → writeText 直写,不碰降级', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const doc = stubDocument(() => true);
    await expect(webCopyToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(doc.created).toHaveLength(0);
  });

  it('http 非安全上下文:navigator.clipboard 缺失 → execCommand 降级成功,textarea 内容与清理到位', async () => {
    vi.stubGlobal('navigator', {}); // 无 clipboard(线上 http 实况)
    const doc = stubDocument(() => true);
    await expect(webCopyToClipboard('交接包内容')).resolves.toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(doc.created[0].value).toBe('交接包内容');
    expect(doc.created[0].select).toHaveBeenCalled();
    expect(doc.created[0].setSelectionRange).toHaveBeenCalledWith(0, 5);
    expect(doc.appended).toHaveLength(1);
    expect(doc.removed).toHaveLength(1); // 用完即删,不留脏节点
  });

  it('clipboard.writeText 被拒(权限/iframe)→ 落到 execCommand 降级', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new Error('NotAllowedError'); }) },
    });
    stubDocument(() => true);
    await expect(webCopyToClipboard('x')).resolves.toBe(true);
  });

  it('execCommand 返回 false / 抛异常 → 如实返回 false(调用方不亮「已复制」)', async () => {
    vi.stubGlobal('navigator', {});
    stubDocument(() => false);
    await expect(webCopyToClipboard('x')).resolves.toBe(false);

    stubDocument(() => { throw new Error('execCommand unavailable'); });
    await expect(webCopyToClipboard('x')).resolves.toBe(false);
  });

  it('无 document(纯 node/SSR)→ false 不抛', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', undefined);
    await expect(webCopyToClipboard('x')).resolves.toBe(false);
    expect(legacyCopy('x')).toBe(false);
  });
});
