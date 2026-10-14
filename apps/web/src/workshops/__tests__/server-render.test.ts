/**
 * 覆盖目录 + 服务端权威渲染(工坊 skill 包重构 Phase 5)。
 *
 * 锁三件事:
 * 1. loadWorkshopOverrides 镜像 loadScriptSkills 约定:坏文件只记错误不抛、
 *    未知工坊 id 跳过、空文件/超限跳过、目录缺失 = 无覆盖;
 * 2. 60s TTL:放文件 60s 内收敛,移除即回落;
 * 3. renderWorkshopRunServer:注册表 + user-store 现读档案渲染;覆盖存在时
 *    prompt 全文替换、overridden=true;未知工坊返回 null(绝不静默回落)。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadWorkshopOverrides,
  getWorkshopOverrides,
  isWorkshopOverridden,
  resetWorkshopOverrideCache,
} from '../overrides';
import { renderWorkshopRunServer } from '../server-render';
import { getUserScenarioProfiles, saveUserScenarioProfile } from '@/lib/user-store';
import { createNovelBook, appendChapter } from '@/lib/novel-store';
import type { ScenarioProfile } from '@/lib/scenario-profile';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-overrides-'));
const dir = path.join(tmpRoot, 'overrides');
fs.mkdirSync(dir, { recursive: true });

const profile: ScenarioProfile = {
  scenarioKey: 'xhs',
  version: 1,
  positioning: { niche: '秋冬通勤穿搭', audience: '30+ 通勤女性' },
  persona: { toneSamples: [], taboos: [] },
  cadence: {},
  insights: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// user-store 指到临时目录(动态读 env,静态 import 也生效),用完恢复 —— 见 artifact-files.test.ts 同款约定
const tmpUserData = path.join(tmpRoot, 'user-data');
fs.mkdirSync(tmpUserData, { recursive: true });
const savedUserDataDir = process.env.USER_DATA_DIR;
process.env.USER_DATA_DIR = tmpUserData;

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  resetWorkshopOverrideCache();
});

afterAll(() => {
  if (savedUserDataDir === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = savedUserDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadWorkshopOverrides(热修目录扫描)', () => {
  it('目录不存在 = 没有覆盖,不是错误', () => {
    const res = loadWorkshopOverrides(path.join(tmpRoot, 'nope'));
    expect(res.byId).toEqual({});
    expect(res.errors).toEqual([]);
  });

  it('放 <workshopId>.md 即生效:注册表内 id 收进 byId', () => {
    fs.writeFileSync(path.join(dir, 'xhs.md'), '热修后的全文', 'utf8');
    const res = loadWorkshopOverrides(dir);
    expect(res.byId).toEqual({ xhs: '热修后的全文' });
    expect(res.errors).toEqual([]);
  });

  it('文件名不是注册表内的工坊 id:只记错误并跳过,不抛', () => {
    fs.writeFileSync(path.join(dir, 'not_a_workshop.md'), 'x', 'utf8');
    const res = loadWorkshopOverrides(dir);
    expect(res.byId).toEqual({});
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain('not_a_workshop.md');
    expect(res.errors[0]).toContain('已忽略');
  });

  it('空文件跳过(移除文件即回落,空文件不是回落意图)', () => {
    fs.writeFileSync(path.join(dir, 'weibo.md'), '   \n', 'utf8');
    const res = loadWorkshopOverrides(dir);
    expect(res.byId).toEqual({});
    expect(res.errors[0]).toContain('weibo.md');
  });

  it('超过大小上限的文件跳过', () => {
    fs.writeFileSync(path.join(dir, 'weibo.md'), 'x'.repeat(256 * 1024 + 1), 'utf8');
    const res = loadWorkshopOverrides(dir);
    expect(res.byId).toEqual({});
    expect(res.errors[0]).toContain('字节上限');
  });

  it('非 .md 文件不扫(目录里的杂物无副作用)', () => {
    fs.writeFileSync(path.join(dir, 'xhs.md'), 'A', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.txt'), 'B', 'utf8');
    expect(loadWorkshopOverrides(dir).byId).toEqual({ xhs: 'A' });
  });
});

describe('getWorkshopOverrides · 60s TTL', () => {
  it('TTL 内同目录不重扫,目录变了立即重扫', () => {
    fs.writeFileSync(path.join(dir, 'xhs.md'), 'v1', 'utf8');
    expect(getWorkshopOverrides(dir).byId.xhs).toBe('v1');
    // TTL 内:改文件不生效(热修 60s 内收敛,可预期)
    fs.writeFileSync(path.join(dir, 'xhs.md'), 'v2', 'utf8');
    expect(getWorkshopOverrides(dir).byId.xhs).toBe('v1');
    // 换目录(测试注入)立即重扫
    const dir2 = path.join(tmpRoot, 'overrides-2');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'xhs.md'), 'v3', 'utf8');
    expect(getWorkshopOverrides(dir2).byId.xhs).toBe('v3');
  });

  it('isWorkshopOverridden:名单查询的便捷出口', () => {
    fs.writeFileSync(path.join(dir, 'xhs.md'), 'A', 'utf8');
    expect(isWorkshopOverridden('xhs', dir)).toBe(true);
    expect(isWorkshopOverridden('weibo', dir)).toBe(false);
  });
});

describe('renderWorkshopRunServer(服务端权威渲染)', () => {
  it('注册表渲染:与客户端同一 buildWorkshopRun,档案从 user-store 现读', () => {
    const userId = 'u-server-render';
    // 先无档案:渲染不含【账号档案】
    const before = renderWorkshopRunServer(userId, 'xhs', { topic: '测试选题', style: '种草推荐' });
    expect(before).not.toBeNull();
    expect(before!.overridden).toBe(false);
    expect(before!.prompt).toContain('小红书');
    expect(before!.prompt).not.toContain('【账号档案】');
    // 存档案后:同参数重渲染,档案注入(档案更新 → 服务端 prompt 跟着变)
    saveUserScenarioProfile(userId, profile);
    expect(getUserScenarioProfiles(userId).xhs.positioning.niche).toBe('秋冬通勤穿搭');
    const after = renderWorkshopRunServer(userId, 'xhs', { topic: '测试选题', style: '种草推荐' });
    expect(after!.prompt).toContain('【账号档案】');
    expect(after!.prompt).toContain('秋冬通勤穿搭');
  });

  it('无 profileSlot 的工坊不读档案,照常渲染', () => {
    const run = renderWorkshopRunServer('u2', 'weibo', { topic: '微波炉热饭' });
    expect(run).not.toBeNull();
    expect(run!.prompt).toContain('微波炉热饭');
    expect(run!.title).toContain('微博');
  });

  it('覆盖存在:prompt 全文替换为覆盖文本,title 仍来自注册表', () => {
    fs.writeFileSync(path.join(dir, 'xhs.md'), '【热修】全文替换的版本', 'utf8');
    const run = renderWorkshopRunServer('u3', 'xhs', { topic: 't' }, { overrideDir: dir });
    expect(run!.overridden).toBe(true);
    expect(run!.prompt).toBe('【热修】全文替换的版本');
    expect(run!.title).toContain('小红书');
  });

  it('移除覆盖文件(换目录模拟)即回落打包模板', () => {
    const run = renderWorkshopRunServer('u3', 'xhs', { topic: 't' }, { overrideDir: dir });
    expect(run!.overridden).toBe(false);
    expect(run!.prompt).not.toContain('【热修】');
  });

  it('未知 workshopId 返回 null(调用方 400,绝不静默回落)', () => {
    expect(renderWorkshopRunServer('u4', 'not_a_workshop', {})).toBeNull();
  });

  it('params 非对象时安全降级(空参数渲染,不抛)', () => {
    const run = renderWorkshopRunServer('u5', 'weibo', null as any);
    expect(run).not.toBeNull();
    expect(typeof run!.prompt).toBe('string');
  });
});

describe('novel loader(书状态服务端现读,docs/design/novel-workshop.md §5)', () => {
  const LONG = '暴雨夜,林凡攥着手机在积水里狂奔,差评像追命的鼓点,一声声砸在他背上。'.repeat(8);

  it('genesis 不需要书状态,照常渲染', () => {
    const run = renderWorkshopRunServer('u-novel', 'novel', { mode: 'genesis', genre: '玄幻' });
    expect(run).not.toBeNull();
    expect(run!.title).toBe('网文开书:玄幻');
    expect(run!.prompt).toContain('【设定集】');
  });

  it('continue/review 缺书或 bookId 无效:抛错带明确原因(调用方 500,绝不静默降级)', () => {
    expect(() => renderWorkshopRunServer('u-novel', 'novel', { mode: 'continue' })).toThrow(/小说不存在或无权访问/);
    expect(() =>
      renderWorkshopRunServer('u-novel', 'novel', { mode: 'continue', bookId: 'nv_nope_000000' })
    ).toThrow(/小说不存在或无权访问/);
    expect(() =>
      renderWorkshopRunServer('u-novel', 'novel', { mode: 'review', bookId: 'nv_nope_000000' })
    ).toThrow(/小说不存在或无权访问/);
  });

  it('用户隔离:别人的 bookId 现读不到', () => {
    const book = createNovelBook('u-novel-a', {
      title: '铁拳少年',
      chapters: [{ title: '雨夜差评', content: LONG, summary: '捡到手机。' }],
    });
    expect(() =>
      renderWorkshopRunServer('u-novel-b', 'novel', { mode: 'continue', bookId: book.bookId })
    ).toThrow(/小说不存在或无权访问/);
  });

  it('continue 有效 bookId:触发那一刻现读状态库(书号逐字内嵌,进度/状态注入)', () => {
    const userId = 'u-novel-c';
    const book = createNovelBook(userId, {
      title: '铁拳少年',
      bible: '力量体系:青铜→白银,不可跳级。',
      characters: [{ name: '林凡', role: '主角', currentState: '右手骨折' }],
      detailed: [{ index: 2, events: '夜探仓库' }],
      chapters: [{ title: '雨夜差评', content: LONG, summary: '捡到手机。' }],
    });
    const run = renderWorkshopRunServer(userId, 'novel', { mode: 'continue', bookId: book.bookId, chapterWords: 2500 });
    expect(run!.title).toBe('《铁拳少年》第2章');
    expect(run!.prompt).toContain(book.bookId);
    expect(run!.prompt).toContain('青铜→白银');
    expect(run!.prompt).toContain('**当前状态:右手骨折**');
    expect(run!.prompt).toContain('2500');

    // 状态库更新后,同参数再渲染跟着变(现读,不是缓存)
    appendChapter(userId, book.bookId, { title: '夜袭', content: LONG, summary: '夜探仓库。' });
    const run2 = renderWorkshopRunServer(userId, 'novel', { mode: 'continue', bookId: book.bookId });
    expect(run2!.title).toBe('《铁拳少年》第3章');
  });

  it('review 有效 bookId:体检上下文来自状态库', () => {
    const userId = 'u-novel-d';
    const book = createNovelBook(userId, {
      title: '铁拳少年',
      ledgerSeeds: [{ content: '手机裂纹来历', plantedChapter: 1 }],
      chapters: [{ title: '雨夜差评', content: LONG, summary: '捡到手机。' }],
    });
    const run = renderWorkshopRunServer(userId, 'novel', { mode: 'review', bookId: book.bookId, focus: '伏笔盘点' });
    expect(run!.title).toBe('《铁拳少年》全书体检');
    expect(run!.prompt).toContain('伏笔盘点');
    expect(run!.prompt).toContain('手机裂纹来历');
  });
});
