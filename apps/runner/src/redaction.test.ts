import { describe, it, expect } from 'vitest';
import { redactText, redactValue, redactEvent, redactWithBlacklist, REDACTED } from './redaction';

/**
 * §10 M4 门禁:redaction 用例库(密钥形态)。
 * 原则:宁可过度替换,不可漏上行;正常任务文本(工具摘要/diffstat/测试尾部)不受影响。
 */

describe('redactText(已知密钥形态)', () => {
  // [名称, 输入文本, 必须消失的秘密值]
  const cases: Array<[string, string, string]> = [
    ['GitHub 经典 token', 'auth 用 ghp_aBcD1234567890aBcD1234567890aBcD1234 拉的仓库', 'ghp_aBcD1234567890aBcD1234567890aBcD1234'],
    ['GitHub 细粒度 PAT', 'token=github_pat_11ABCDEFG_aBcD1234567890aBcD', 'github_pat_11ABCDEFG_aBcD1234567890aBcD'],
    ['AWS Access Key', 'key AKIAIOSFODNN7EXAMPLE 在环境里', 'AKIAIOSFODNN7EXAMPLE'],
    ['Slack token', 'webhook xoxb-123456789012-abcdef 失效', 'xoxb-123456789012-abcdef'],
    ['OpenAI key', 'sk-abcDEF1234567890abcDEF1234567890', 'sk-abcDEF1234567890abcDEF1234567890'],
    ['Anthropic key', 'sk-ant-api03-aBcD1234567890aBcD1234567890', 'sk-ant-api03-aBcD1234567890aBcD1234567890'],
    ['Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw'],
    ['npm token', '//registry:npm_aBcD1234567890aBcD1234567890ab', 'npm_aBcD1234567890aBcD1234567890ab'],
    ['Stripe live key', 'sk_live_aBcD1234567890abcd', 'sk_live_aBcD1234567890abcd'],
    ['JWT', 'header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz'],
    ['Bearer 头', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', 'abcdefghijklmnopqrstuvwxyz123456'],
    ['URL 内嵌凭据', 'git clone https://user:sup3rsecretpw@github.com/o/r.git', 'sup3rsecretpw'],
    ['key=value(api_key)', 'config api_key=abcdefgh12345678 已加载', 'abcdefgh12345678'],
    ['key: value(password)', 'db password: "hunter2secret" 连接失败', 'hunter2secret'],
    ['client_secret JSON', '{"client_secret":"aBcD1234567890abcd"}', 'aBcD1234567890abcd'],
  ];
  for (const [name, input, secret] of cases) {
    it(`${name} → 含 ${REDACTED},秘密值消失`, () => {
      const out = redactText(input);
      expect(out).toContain(REDACTED);
      expect(out).not.toContain(secret);
    });
  }

  it('PEM 私钥块(含未闭合截断形态)整块替换', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\nabcdef\n-----END RSA PRIVATE KEY-----\n后续日志`;
    const out = redactText(pem);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA1234');
    expect(out).toContain('后续日志');
    // 截断形态:只有 BEGIN 没有 END → BEGIN 之后全部吞掉
    const truncated = `日志 -----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretmaterial`;
    const out2 = redactText(truncated);
    expect(out2).not.toContain('AAAAsecretmaterial');
  });

  it('正常任务文本不误伤(工具摘要/diffstat/测试尾部)', () => {
    const normal = [
      'Edit src/parser.py 修改解析函数',
      ' src/a.py | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)',
      'PASSED 12 tests in 3.4s',
      'git commit -m "fix: 修复 #123 空指针"',
      'Bash pnpm test 退出码 0',
    ].join('\n');
    expect(redactText(normal)).toBe(normal);
  });
});

describe('redactWithBlacklist(本机 secret 值黑名单)', () => {
  it('整串命中替换(不依赖形态);短于 8 字符的值忽略(防误伤)', () => {
    const secret = 'sec'.repeat(15); // deviceSecret 形态
    expect(redactWithBlacklist(`Bearer ${secret} 出现在日志`, [secret])).toContain(REDACTED);
    expect(redactWithBlacklist(`Bearer ${secret}`, [secret])).not.toContain(secret);
    expect(redactWithBlacklist('abc 出现', ['abc'])).toBe('abc 出现');
  });
});

describe('redactValue / redactEvent(深度结构)', () => {
  it('对象/数组递归,字符串值全部过滤;非字符串原样', () => {
    const out = redactValue(
      {
        summary: 'ghp_aBcD1234567890aBcD1234567890aBcD1234 泄露',
        nested: { list: ['sk-abcDEF1234567890abcDEF1234567890', 42, null, true] },
        count: 3,
      },
      ['blacklistedSecretValue123']
    ) as any;
    expect(out.summary).toContain(REDACTED);
    expect(out.nested.list[0]).toBe(REDACTED);
    expect(out.nested.list[1]).toBe(42);
    expect(out.nested.list[2]).toBeNull();
    expect(out.count).toBe(3);
  });

  it('超深嵌套(>8 层)在深度上限处截断为 REDACTED(宁可过度不上行)', () => {
    let deep: any = 'x'.repeat(10);
    for (let i = 0; i < 12; i++) deep = { v: deep };
    const out = JSON.stringify(redactValue(deep));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('xxxxxxxxxx'); // 最深层的值没有原样通过
  });

  it('redactEvent 只动 payload,结构化字段原样;非对象事件原样返回', () => {
    const ev = {
      eventId: 'ev_1',
      taskId: 'rtask_1',
      deviceId: 'dev_1',
      at: 123,
      type: 'progress',
      payload: { summary: 'api_key=abcdefgh12345678' },
    };
    const out = redactEvent(ev, []) as any;
    expect(out.eventId).toBe('ev_1');
    expect(out.type).toBe('progress');
    expect(out.payload.summary).toContain(REDACTED);
    expect(out.payload.summary).not.toContain('abcdefgh12345678');
    // payload 缺失/非对象 → 事件原样
    expect(redactEvent({ eventId: 'x' })).toEqual({ eventId: 'x' });
    expect(redactEvent('nope')).toBe('nope');
    expect(redactEvent(null)).toBeNull();
  });
});
