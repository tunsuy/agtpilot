import { describe, it, expect } from 'vitest';
import { parseArgs, USAGE } from './args';

describe('parseArgs', () => {
  it('pair 子命令 + 空格分隔旗标', () => {
    const r = parseArgs(['pair', '--server', 'https://app.example.com', '--code', 'ABCD2345']);
    expect(r.command).toBe('pair');
    expect(r.flags).toEqual({ server: 'https://app.example.com', code: 'ABCD2345' });
  });

  it('--key=value 形式与布尔旗标', () => {
    const r = parseArgs(['start', '--interval=3000', '--claim']);
    expect(r.command).toBe('start');
    expect(r.flags.interval).toBe('3000');
    expect(r.flags.claim).toBe('1');
  });

  it('status/stop/logs 识别;未知/缺省命令 → help', () => {
    expect(parseArgs(['status']).command).toBe('status');
    expect(parseArgs(['stop']).command).toBe('stop');
    expect(parseArgs(['logs']).command).toBe('logs');
    expect(parseArgs(['launch-the-missiles']).command).toBe('help');
    expect(parseArgs([]).command).toBe('help');
  });

  it('非 -- 开头的游离参数不进 flags', () => {
    const r = parseArgs(['status', 'extra', '--json']);
    expect(r.flags.extra).toBeUndefined();
    expect(r.flags.json).toBe('1');
  });

  it('USAGE 覆盖全部子命令与安全要点', () => {
    for (const cmd of ['pair', 'start', 'status', 'stop', 'logs']) expect(USAGE).toContain(cmd);
    expect(USAGE).toContain('出站-only');
    expect(USAGE).toContain('审批门');
  });
});
