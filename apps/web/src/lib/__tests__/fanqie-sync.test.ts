/**
 * fanqie-sync 同步运行器测试(P2 全自动同步)
 *
 * 桩边界:引擎(@agtpilot/plugin-skill)与 agent-backend 全 mock(execute 结果
 * 逐用例可控);novel-store/user-store 走真实现 + USER_DATA_DIR 临时目录
 * (novel-store.test.ts 同款约定)——意图账本的落盘/重读语义必须是真的。
 *
 * 锁八件事:入队守卫矩阵(托管门/书级开关/幂等/kill switch 只记不执行)、
 * create 成功写映射并翻章节、成功无捕获 = 终态 failed 绝不自动重试、
 * 限频 rejected 保持 pending(sweep 续传)、not_logged_in 停队连坐、
 * 软避让(活跃任务 → 延迟重臂)、sweeper 重启恢复/冷却重试、手动绑定逃生门。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  skills: [] as any[],
  executeImpl: null as null | ((skillName: string, args: any) => Promise<any>),
  executeCalls: [] as Array<{ skill: string; args: any }>,
  missions: [] as any[],
  gateOpen: true,
}));

vi.mock('@agtpilot/plugin-skill', () => ({
  loadScriptSkills: () => ({ skills: mocks.skills, errors: [] }),
  scriptSkillsDir: () => 'skills',
  buildScriptSkillTool: (skill: any) => ({
    name: skill.name,
    execute: async (args: any) => {
      mocks.executeCalls.push({ skill: skill.name, args });
      return mocks.executeImpl ? mocks.executeImpl(skill.name, args) : { success: true };
    },
  }),
}));

vi.mock('../script-skills', () => ({
  webSkillStore: () => ({}),
  skillGateAllows: () => mocks.gateOpen,
}));

vi.mock('../agent-backend', () => ({
  getAgentBackend: () => ({
    whenReady: async () => {},
    ctx: { browser: { acquirePage: async () => ({}), hasCookies: async () => true } },
    state: { missions: mocks.missions },
  }),
}));

import {
  maybeEnqueueFanqieBookCreate,
  maybeEnqueueFanqieChapter,
  setFanqieSyncEnabled,
  retryFanqieSync,
  bindFanqieBook,
  runFanqieSyncSweep,
  CREATE_SKILL,
  DRAFT_SKILL,
  __fanqieSyncTest,
} from '../fanqie-sync';
import { createNovelBook, getNovelBook, updateNovelFanqie, savePrologue, appendChapter } from '../novel-store';
import { saveFanqieManaged, appendBrowserAudit } from '../user-store';

const USER = 'u-sync';
const LONG_BODY = '暴雨夜,林凡攥着手机在积水里狂奔,身后的差评像追命的鼓点。'.repeat(8);

let dataDir: string;
let savedEnv: string | undefined;

function seedBook(title = '铁拳少年', chapters = 1): string {
  const book = createNovelBook(USER, {
    title,
    genre: '都市',
    premise: '外卖骑手捡到预知差评的手机',
    chapters: Array.from({ length: chapters }, (_, i) => ({
      title: `第${i + 1}章 雨夜`,
      content: LONG_BODY,
      summary: '林凡捡到预知手机。',
    })),
  });
  return book.bookId;
}

function fanqieOf(bookId: string) {
  return getNovelBook(USER, bookId)!.fanqie;
}

function bothSkills() {
  mocks.skills = [{ name: CREATE_SKILL }, { name: DRAFT_SKILL }] as any[];
}

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanqie-sync-test-'));
  savedEnv = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = dataDir;
  __fanqieSyncTest.reset();
  __fanqieSyncTest.setTiming({ rearmMs: 10, sweepMs: 3_600_000 });
  mocks.skills = [];
  mocks.executeImpl = null;
  mocks.executeCalls = [];
  mocks.missions = [];
  mocks.gateOpen = true;
  saveFanqieManaged(USER, { enabled: true, enabledAt: Date.now(), riskAckAt: Date.now(), lastLoginAt: Date.now() } as any);
});

afterEach(async () => {
  delete process.env.AGTPILOT_FANQIE_SYNC;
  if (savedEnv === undefined) delete process.env.USER_DATA_DIR;
  else process.env.USER_DATA_DIR = savedEnv;
  await fsp.rm(dataDir, { recursive: true, force: true });
  __fanqieSyncTest.reset();
});

describe('入队守卫矩阵', () => {
  it('托管未开启 / 书级开关关闭 → 不记意图不入队', () => {
    const bookId = seedBook();
    saveFanqieManaged(USER, { enabled: false } as any);
    expect(maybeEnqueueFanqieBookCreate(USER, bookId)).toBe(false);
    expect(fanqieOf(bookId)).toBeUndefined();

    saveFanqieManaged(USER, { enabled: true, riskAckAt: Date.now() } as any);
    setFanqieSyncEnabled(USER, bookId, false);
    expect(maybeEnqueueFanqieBookCreate(USER, bookId)).toBe(false);
    expect(maybeEnqueueFanqieChapter(USER, bookId, 1)).toBe(false);
    expect(__fanqieSyncTest.snapshot().queue).toHaveLength(0);
  });

  it('幂等:重复钩子只落一份意图、队列不重复;synced 章节不再排', async () => {
    bothSkills();
    mocks.executeImpl = async (name) =>
      name === CREATE_SKILL ? { success: true, captures: { fanqieBookId: '7123' } } : { success: true };
    const bookId = seedBook();
    expect(maybeEnqueueFanqieBookCreate(USER, bookId)).toBe(true);
    expect(maybeEnqueueFanqieBookCreate(USER, bookId)).toBe(true); // 意图已 pending → 确认但不再排
    expect(maybeEnqueueFanqieChapter(USER, bookId, 1)).toBe(true);
    expect(maybeEnqueueFanqieChapter(USER, bookId, 1)).toBe(true);
    expect(__fanqieSyncTest.snapshot().queue).toHaveLength(2); // create + chapter 各一

    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.chapters?.['1']?.status).toBe('synced');
    expect(maybeEnqueueFanqieChapter(USER, bookId, 1)).toBe(false); // synced → 拒
    // 越界章号拒收(信任边界:序号必须在 progress 范围内)
    expect(maybeEnqueueFanqieChapter(USER, bookId, 99)).toBe(false);
  });

  it('kill switch:AGTPILOT_FANQIE_SYNC=0 → 意图照落、一个都不执行;sweep 也停', async () => {
    bothSkills();
    process.env.AGTPILOT_FANQIE_SYNC = '0';
    const bookId = seedBook();
    expect(maybeEnqueueFanqieBookCreate(USER, bookId)).toBe(true);
    expect(fanqieOf(bookId)?.createStatus).toBe('pending'); // 意图账本已落盘
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.executeCalls).toHaveLength(0);
    expect(runFanqieSyncSweep([USER])).toEqual({ enqueued: 0 });

    // 恢复开关:sweep 重启 drain 把滞留意图排空(旧队列项 dedup → enqueued 可为 0,
    // 但恒触发 scheduleDrain —— kill switch 恢复的排空路径)
    delete process.env.AGTPILOT_FANQIE_SYNC;
    mocks.executeImpl = async (name) =>
      name === CREATE_SKILL ? { success: true, captures: { fanqieBookId: '7123' } } : { success: true };
    runFanqieSyncSweep([USER]);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.fanqieBookId).toBe('7123');
  });

  it('无 fanqie 记录的旧书:打开开关即补建书意图并执行(同步上线前入库的书由此接入)', async () => {
    bothSkills();
    mocks.executeImpl = async (name) =>
      name === CREATE_SKILL ? { success: true, captures: { fanqieBookId: '777' } } : { success: true };
    const bookId = seedBook('旧稿', 1);
    expect(fanqieOf(bookId)).toBeUndefined(); // 上线前入库:账本无记录,sweep 不会碰它

    setFanqieSyncEnabled(USER, bookId, true);
    expect(fanqieOf(bookId)?.createStatus).toBe('pending'); // 意图已落盘
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.fanqieBookId).toBe('777');
    // 建书成功后,无记录的章整体翻入并完成存草稿
    expect(fanqieOf(bookId)?.chapters?.['1']?.status).toBe('synced');
  });
});

describe('create 项状态机', () => {
  it('成功且有捕获 → 写映射 + created,既有章节翻入草稿队列并同步', async () => {
    bothSkills();
    const bookId = seedBook('开书即同步', 2);
    mocks.executeImpl = async (name) =>
      name === CREATE_SKILL ? { success: true, captures: { fanqieBookId: '712345' } } : { success: true };

    maybeEnqueueFanqieBookCreate(USER, bookId);
    await __fanqieSyncTest.waitIdle();

    const f = fanqieOf(bookId)!;
    expect(f.fanqieBookId).toBe('712345');
    expect(f.createStatus).toBe('created');
    expect(f.chapters?.['1']?.status).toBe('synced');
    expect(f.chapters?.['2']?.status).toBe('synced');
    // 草稿参数用的是番茄书号 + 本地章标题 + 本地正文
    const draft = mocks.executeCalls.filter((c) => c.skill === DRAFT_SKILL);
    expect(draft).toHaveLength(2);
    expect(draft[0].args).toMatchObject({ bookId: '712345', title: '雨夜', body: LONG_BODY });
  });

  it('建书 intro 优先取作品简介(读者向文案);无简介回落 premise', async () => {
    bothSkills();
    mocks.executeImpl = async (name) =>
      name === CREATE_SKILL ? { success: true, captures: { fanqieBookId: '7123' } } : { success: true };
    const synopsis = '暴雨夜里外卖骑手林凡捡到一部能预知差评的神秘手机,每躲开一单差评就变强一分,差评教团的追杀随之而来,室友的身份也成谜,一切指向一个更大的局。'.repeat(2);
    const longPremise = '外卖骑手捡到预知差评的神秘手机,每躲开一单差评就变强,卷入差评教团阴谋,室友身份成谜。'.repeat(2);
    const withSynopsis = createNovelBook(USER, {
      title: '简介优先',
      genre: '都市',
      premise: longPremise, // 也够 50 字——简介必须赢
      synopsis,
    });

    maybeEnqueueFanqieBookCreate(USER, withSynopsis.bookId);
    await __fanqieSyncTest.waitIdle();
    const create = mocks.executeCalls.find((c) => c.skill === CREATE_SKILL);
    expect(create?.args).toMatchObject({ title: '简介优先', intro: synopsis.slice(0, 500) });

    // 无简介:回落 premise(premise 够 50 字才上,不凑字)
    mocks.executeCalls = [];
    const noSynopsis = createNovelBook(USER, { title: '回落', genre: '都市', premise: longPremise });
    maybeEnqueueFanqieBookCreate(USER, noSynopsis.bookId);
    await __fanqieSyncTest.waitIdle();
    const fallback = mocks.executeCalls.find((c) => c.skill === CREATE_SKILL);
    expect(fallback?.args.intro).toBe(longPremise.slice(0, 500));
  });

  it('成功但未捕获书号 → 终态 failed,绝不自动重试;sweep 也不捞', async () => {
    bothSkills();
    const bookId = seedBook();
    mocks.executeImpl = async () => ({ success: true }); // 无 captures

    maybeEnqueueFanqieBookCreate(USER, bookId);
    await __fanqieSyncTest.waitIdle();

    const f = fanqieOf(bookId)!;
    expect(f.createStatus).toBe('failed');
    expect(f.createAttempts).toBe(1);
    expect(f.createError).toContain('绑定书号');
    expect(maybeEnqueueFanqieBookCreate(USER, bookId)).toBe(false); // 钩子不捞终态
    expect(runFanqieSyncSweep([USER])).toEqual({ enqueued: 0 }); // sweeper 也不捞
    expect(mocks.executeCalls).toHaveLength(1); // 只执行过一次 = 没有重复建书风险
  });

  it('限频 rejected → 保持 pending 不算失败;后续 sweep 续传成功', async () => {
    bothSkills();
    const bookId = seedBook();
    mocks.executeImpl = async () => ({ success: false, rejected: true, error: '已达今日执行上限' });

    maybeEnqueueFanqieBookCreate(USER, bookId);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.createStatus).toBe('pending'); // 明日再试,不是 failed

    mocks.executeImpl = async () => ({ success: true, captures: { fanqieBookId: '999' } });
    runFanqieSyncSweep([USER]);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.fanqieBookId).toBe('999');
  });

  it('普通失败 → 终态 failed(页面改版等无法区分是否已提交,只认显式重试);retry 翻回 pending 再试', async () => {
    bothSkills();
    const bookId = seedBook();
    mocks.executeImpl = async () => ({ success: false, error: '执行失败:提交按钮未出现' });

    maybeEnqueueFanqieBookCreate(USER, bookId);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.createStatus).toBe('failed');
    expect(retryFanqieSync(USER, bookId)).toBe(true);
    expect(fanqieOf(bookId)?.createStatus).toBe('pending');

    mocks.executeImpl = async () => ({ success: true, captures: { fanqieBookId: '555' } });
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.fanqieBookId).toBe('555');
  });

  it('技能未部署 → 意图保持 pending 不算失败(等 commit 6 的 JSON 落盘)', async () => {
    mocks.skills = []; // create 技能缺席
    const bookId = seedBook();
    maybeEnqueueFanqieBookCreate(USER, bookId);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.createStatus).toBe('pending');
    expect(mocks.executeCalls).toHaveLength(0);
  });
});

describe('chapter 项与登录失效', () => {
  it('not_logged_in → 本项 failed + 该用户剩余队列连坐出队,本轮停', async () => {
    bothSkills();
    const b1 = seedBook('书一', 1);
    const b2 = seedBook('书二', 1);
    updateNovelFanqie(USER, b1, { fanqieBookId: '111', createStatus: 'created' });
    updateNovelFanqie(USER, b2, { fanqieBookId: '222', createStatus: 'created' });

    mocks.executeImpl = async () => {
      // 模拟引擎:审计落 not_logged_in + 返回 hint
      appendBrowserAudit(USER, { at: Date.now(), tool: DRAFT_SKILL, action: 'save_chapter_draft', result: 'failure', error: 'not_logged_in' } as any);
      return { success: false, error: '番茄网页版尚未登录,请扫码' };
    };

    maybeEnqueueFanqieChapter(USER, b1, 1);
    maybeEnqueueFanqieChapter(USER, b2, 1);
    await __fanqieSyncTest.waitIdle();

    expect(mocks.executeCalls).toHaveLength(1); // 第二项被连坐,没再烧一次执行
    expect(fanqieOf(b1)?.chapters?.['1']?.status).toBe('failed');
    expect(fanqieOf(b1)?.chapters?.['1']?.error).toContain('登录');
    expect(fanqieOf(b2)?.chapters?.['1']?.status).toBe('failed'); // 连坐落账本
    expect(__fanqieSyncTest.snapshot().queue).toHaveLength(0);
  });

  it('映射未建立时章节项暂缓(保持 pending),建书成功后自动续传', async () => {
    bothSkills();
    const bookId = seedBook();
    // 只排章节不排 create(映射缺失)→ 暂缓不执行
    maybeEnqueueFanqieChapter(USER, bookId, 1);
    await __fanqieSyncTest.waitIdle();
    expect(mocks.executeCalls).toHaveLength(0);
    expect(fanqieOf(bookId)?.chapters?.['1']?.status).toBe('pending');

    // 建书成功后:pending 章节被翻入并同步
    mocks.executeImpl = async (name) =>
      name === CREATE_SKILL ? { success: true, captures: { fanqieBookId: '321' } } : { success: true };
    maybeEnqueueFanqieBookCreate(USER, bookId);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.chapters?.['1']?.status).toBe('synced');
  });

  it('章节执行失败 → failed 计次;retryFanqieSync 单章立即重排', async () => {
    bothSkills();
    const bookId = seedBook();
    updateNovelFanqie(USER, bookId, { fanqieBookId: '111', createStatus: 'created' });
    mocks.executeImpl = async () => ({ success: false, error: '执行失败:编辑器未渲染' });

    maybeEnqueueFanqieChapter(USER, bookId, 1);
    await __fanqieSyncTest.waitIdle();
    let rec = fanqieOf(bookId)?.chapters?.['1'];
    expect(rec?.status).toBe('failed');
    expect(rec?.attempts).toBe(1);
    expect(maybeEnqueueFanqieChapter(USER, bookId, 1)).toBe(false); // 钩子不捞 failed

    mocks.executeImpl = async () => ({ success: true });
    expect(retryFanqieSync(USER, bookId, 1)).toBe(true);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.chapters?.['1']?.status).toBe('synced');
  });
});

describe('草稿标题拼装(只传章名,平台自动加位置序号)', () => {
  it('裸章名原样;自带前缀剥掉(漂移纠正);无章名回落未命名', async () => {
    bothSkills();
    mocks.executeImpl = async () => ({ success: true });
    const book = createNovelBook(USER, {
      title: '标题拼装',
      genre: '都市',
      premise: '草稿标题格式测试',
      chapters: [
        { title: '雨夜', content: LONG_BODY, summary: 's' }, // 裸章名(解析器主流产物)
        { title: '第2章 雨夜', content: LONG_BODY, summary: 's' }, // 已带正确前缀 → 剥掉
        { title: '第99章 漂移', content: LONG_BODY, summary: 's' }, // 自称序号漂移 → 剥掉
        { title: '', content: LONG_BODY, summary: 's' }, // 无章名 → 回落「未命名」
      ],
    });
    updateNovelFanqie(USER, book.bookId, { fanqieBookId: '111', createStatus: 'created' });

    for (let i = 1; i <= 4; i++) maybeEnqueueFanqieChapter(USER, book.bookId, i);
    await __fanqieSyncTest.waitIdle();

    const draft = mocks.executeCalls.filter((c) => c.skill === DRAFT_SKILL);
    expect(draft.map((d) => d.args.title)).toEqual(['雨夜', '雨夜', '漂移', '未命名']);
  });
});

describe('序章同步(账本 key "0")', () => {
  const PROLOGUE_BODY = '暴雨夜,神秘手机降临江城,一切从这里开始。'.repeat(10);

  function seedPrologueBook(title = '序章之书'): string {
    const book = createNovelBook(USER, { title, genre: '都市', premise: 'p', chapters: [] });
    savePrologue(USER, book.bookId, { title: '楔子 · 雨夜', content: PROLOGUE_BODY, summary: '神秘手机降临江城。' });
    return book.bookId;
  }

  it('守卫:无序章的书 idx 0 不入队;有序章才放行', () => {
    bothSkills();
    const plain = seedBook(); // 无序章
    expect(maybeEnqueueFanqieChapter(USER, plain, 0)).toBe(false);
    expect(fanqieOf(plain)?.chapters?.['0']).toBeUndefined();

    const withPrologue = seedPrologueBook();
    expect(maybeEnqueueFanqieChapter(USER, withPrologue, 0)).toBe(true);
    expect(fanqieOf(withPrologue)?.chapters?.['0']?.status).toBe('pending');
  });

  it('runChapter idx 0:草稿参数取序章标题 + prologue.md 正文,账本 key "0" 落 synced', async () => {
    bothSkills();
    const bookId = seedPrologueBook();
    updateNovelFanqie(USER, bookId, { fanqieBookId: '111', createStatus: 'created' });
    mocks.executeImpl = async () => ({ success: true });

    maybeEnqueueFanqieChapter(USER, bookId, 0);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.chapters?.['0']?.status).toBe('synced');
    const draft = mocks.executeCalls.find((c) => c.skill === DRAFT_SKILL);
    expect(draft?.args).toMatchObject({ bookId: '111', title: '楔子 · 雨夜', body: PROLOGUE_BODY });
  });

  it('建书成功 → 序章随整体翻入队列,且排在第 1 章之前(平台目录顺序)', async () => {
    bothSkills();
    // 手工造「先有序章、create 成功后才有第 1 章」的场景:create 翻入发生在 enqueuePendingChapters
    const book = createNovelBook(USER, { title: '翻入书', genre: '都市', premise: 'p', chapters: [] });
    savePrologue(USER, book.bookId, { title: '楔子', content: PROLOGUE_BODY, summary: 's' });
    appendChapter(USER, book.bookId, { title: '第1章 开端', content: LONG_BODY, summary: '开局。' });
    mocks.executeImpl = async (name) =>
      name === CREATE_SKILL ? { success: true, captures: { fanqieBookId: '321' } } : { success: true };

    maybeEnqueueFanqieBookCreate(USER, book.bookId);
    await __fanqieSyncTest.waitIdle();

    expect(fanqieOf(book.bookId)?.chapters?.['0']?.status).toBe('synced');
    expect(fanqieOf(book.bookId)?.chapters?.['1']?.status).toBe('synced');
    const drafts = mocks.executeCalls.filter((c) => c.skill === DRAFT_SKILL);
    // 序章在前;正文章名带「第N章」前缀的按重拼口径原样(剥后重拼结果一致)
    expect(drafts.map((d) => d.args.title)).toEqual(['楔子', '开端']);
  });

  it('序章 failed → sweeper 冷却到期捞回;book 级 retry 也翻 "0"', async () => {
    bothSkills();
    const bookId = seedPrologueBook();
    updateNovelFanqie(USER, bookId, { fanqieBookId: '111', createStatus: 'created' });
    mocks.executeImpl = async () => ({ success: false, error: '执行失败:编辑器未渲染' });

    maybeEnqueueFanqieChapter(USER, bookId, 0);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.chapters?.['0']?.status).toBe('failed');

    // 冷却未到:sweep 不捞(和正文章节同判据)
    expect(runFanqieSyncSweep([USER]).enqueued).toBe(0);

    // book 级显式重试(不等冷却):翻 "0" 并重排
    mocks.executeImpl = async () => ({ success: true });
    expect(retryFanqieSync(USER, bookId)).toBe(true);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.chapters?.['0']?.status).toBe('synced');
  });
});

describe('串行与软避让', () => {
  it('FIFO:多书多章按入队顺序全局串行执行', async () => {
    bothSkills();
    const b1 = seedBook('甲', 1);
    const b2 = seedBook('乙', 1);
    updateNovelFanqie(USER, b1, { fanqieBookId: '111', createStatus: 'created' });
    updateNovelFanqie(USER, b2, { fanqieBookId: '222', createStatus: 'created' });
    const order: string[] = [];
    mocks.executeImpl = async (_n, args) => {
      order.push(args.bookId);
      return { success: true };
    };

    maybeEnqueueFanqieChapter(USER, b2, 1);
    maybeEnqueueFanqieChapter(USER, b1, 1);
    await __fanqieSyncTest.waitIdle();
    expect(order).toEqual(['222', '111']); // 入队序 = 执行序(全局并发 1)
    expect(fanqieOf(b1)?.chapters?.['1']?.status).toBe('synced');
    expect(fanqieOf(b2)?.chapters?.['1']?.status).toBe('synced');
  });

  it('活跃任务软避让:不抢 Page,60s(测试 10ms)重臂后自动续传', async () => {
    bothSkills();
    const bookId = seedBook();
    updateNovelFanqie(USER, bookId, { fanqieBookId: '111', createStatus: 'created' });
    mocks.missions.push({ userId: USER, status: 'ACTIVE' });
    mocks.executeImpl = async () => ({ success: true });

    maybeEnqueueFanqieChapter(USER, bookId, 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.executeCalls).toHaveLength(0); // 忙:没执行,意图仍在
    expect(fanqieOf(bookId)?.chapters?.['1']?.status).toBe('pending');

    mocks.missions.length = 0; // 任务结束
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.chapters?.['1']?.status).toBe('synced');
  });
});

describe('sweeper · 重启恢复与冷却重试', () => {
  it('重启(队列清空)后按落盘意图恢复;failed 冷却 30min 内不捞、到期且 attempts<3 才捞', async () => {
    bothSkills();
    const bookId = seedBook('恢复之书', 3);
    updateNovelFanqie(USER, bookId, {
      fanqieBookId: '111',
      createStatus: 'created',
      chapters: {
        '1': { status: 'pending' }, // 重启前没跑完的
        '2': { status: 'failed', attempts: 1, at: Date.now() - 31 * 60_000 }, // 冷却已过 → 捞
        '3': { status: 'failed', attempts: 1, at: Date.now() }, // 冷却未过 → 不捞
      },
    });
    __fanqieSyncTest.reset(); // 模拟进程重启:内存队列清零
    __fanqieSyncTest.setTiming({ rearmMs: 10, sweepMs: 3_600_000 });
    mocks.executeImpl = async () => ({ success: true });

    const { enqueued } = runFanqieSyncSweep([USER]);
    expect(enqueued).toBe(2);
    await __fanqieSyncTest.waitIdle();
    const f = fanqieOf(bookId)!;
    expect(f.chapters?.['1']?.status).toBe('synced');
    expect(f.chapters?.['2']?.status).toBe('synced');
    expect(f.chapters?.['3']?.status).toBe('failed');

    // attempts 打满(=3)→ 转手动,sweep 永不再捞
    updateNovelFanqie(USER, bookId, { chapters: { '3': { status: 'failed', attempts: 3, at: Date.now() - 60 * 60_000 } } });
    expect(runFanqieSyncSweep([USER])).toEqual({ enqueued: 0 });
  });

  it('creating 冻账(进程死于执行中)→ sweep 捞回重排', async () => {
    bothSkills();
    const bookId = seedBook();
    updateNovelFanqie(USER, bookId, { createStatus: 'creating' });
    __fanqieSyncTest.reset();
    __fanqieSyncTest.setTiming({ rearmMs: 10, sweepMs: 3_600_000 });
    mocks.executeImpl = async () => ({ success: true, captures: { fanqieBookId: '888' } });

    expect(runFanqieSyncSweep([USER]).enqueued).toBe(1);
    await __fanqieSyncTest.waitIdle();
    expect(fanqieOf(bookId)?.fanqieBookId).toBe('888');
  });

  it('关了同步开关/未托管的书:sweep 一律不碰;无意图记录的章不自动补', () => {
    const bookId = seedBook('静默之书', 2);
    updateNovelFanqie(USER, bookId, { syncEnabled: false, chapters: { '1': { status: 'pending' } } });
    expect(runFanqieSyncSweep([USER])).toEqual({ enqueued: 0 });

    setFanqieSyncEnabled(USER, bookId, true);
    __fanqieSyncTest.reset();
    __fanqieSyncTest.setTiming({ rearmMs: 10, sweepMs: 3_600_000 });
    // 重开开关:无映射 → 补建书意图(create pending)+ 捞回有记录的章;
    // 第2章没记录不自动补(建书成功/绑定时由 enqueuePendingChapters 整体翻入)
    expect(fanqieOf(bookId)?.createStatus).toBe('pending');
    expect(runFanqieSyncSweep([USER]).enqueued).toBe(2); // create + 章1
  });
});

describe('bindFanqieBook · 手动绑定逃生门', () => {
  it('格式校验拒非法书号;合法绑定 → created + 未同步章节整体翻入队列', async () => {
    bothSkills();
    const bookId = seedBook('既有番茄书', 2);
    mocks.executeImpl = async () => ({ success: true });

    expect(bindFanqieBook(USER, bookId, '  ')).toMatchObject({ ok: false });
    expect(bindFanqieBook(USER, bookId, 'bad$id!')).toMatchObject({ ok: false });
    expect(bindFanqieBook(USER, 'nv_nope_000000', '7123')).toMatchObject({ ok: false });

    expect(bindFanqieBook(USER, bookId, '7123666')).toMatchObject({ ok: true });
    await __fanqieSyncTest.waitIdle();
    const f = fanqieOf(bookId)!;
    expect(f.fanqieBookId).toBe('7123666');
    expect(f.createStatus).toBe('created');
    expect(f.chapters?.['1']?.status).toBe('synced');
    expect(f.chapters?.['2']?.status).toBe('synced');
    // create 钩子此后彻底安静(映射已建立)
    expect(maybeEnqueueFanqieBookCreate(USER, bookId)).toBe(false);
  });
});
