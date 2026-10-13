import { describe, it, expect } from 'vitest';
import { queryGhLogin, type GhExec } from './gh';

/**
 * gh 登录名探测(公开用户名,非凭据 —— §7 凭据零上行红线:只跑
 * `gh api user --jq .login`,不读任何 token 文件)。假 exec 注入,不碰真 gh。
 */

function fakeGh(result: { stdout?: string; stderr?: string } | Error): { calls: string[][]; exec: GhExec } {
  const calls: string[][] = [];
  const exec: GhExec = async (_cmd, args) => {
    calls.push([...args]);
    if (result instanceof Error) throw result;
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { calls, exec };
}

describe('queryGhLogin(只查公开登录名,永不抛错)', () => {
  it('gh api user --jq .login → trim 后返回', async () => {
    const { calls, exec } = fakeGh({ stdout: 'tunsuy\n' });
    expect(await queryGhLogin(exec)).toBe('tunsuy');
    expect(calls[0]).toEqual(['api', 'user', '--jq', '.login']);
  });

  it('合法形状放行:字母数字连字符,1-39 位,不以连字符开头/结尾', async () => {
    expect(await queryGhLogin(fakeGh({ stdout: 'a-b-9' }).exec)).toBe('a-b-9');
    expect(await queryGhLogin(fakeGh({ stdout: 'A'.repeat(39) }).exec)).toBe('A'.repeat(39));
    expect(await queryGhLogin(fakeGh({ stdout: 'x' }).exec)).toBe('x');
  });

  it('未登录/未装 gh(exec 抛错)→ null,不上抛', async () => {
    const { exec } = fakeGh(Object.assign(new Error('gh: command not found'), { stderr: '' }));
    expect(await queryGhLogin(exec)).toBeNull();
  });

  it('输出畸形(空串/带空格/连字符开头结尾/超 39 位/多行注入形态)→ null', async () => {
    for (const out of ['', '  ', 'a b', '-lead', 'trail-', 'x'.repeat(40), 'ok\nevil']) {
      expect(await queryGhLogin(fakeGh({ stdout: out }).exec), JSON.stringify(out)).toBeNull();
    }
  });
});
