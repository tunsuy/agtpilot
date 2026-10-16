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
import { renderWorkshopRunServer, resolveCronPromptServer } from '../server-render';
import { getUserScenarioProfiles, saveUserScenarioProfile } from '@/lib/user-store';
import { createNovelBook, appendChapter } from '@/lib/novel-store';
import {
  createPairCode,
  redeemPairCode,
  enqueueTask,
  claimNextTask,
  recordRunnerEvents,
  getRunnerTask,
} from '@/lib/runner-bridge';
import { RUNNER_PROTOCOL_VERSION, type RunnerDeviceMeta } from '@agtpilot/protocol';
import type { ScenarioProfile } from '@/lib/scenario-profile';

// runner-bridge 的 secret-box 首次使用时解析(配对/事件回流要加密设备令牌),模块求值期设好即可
process.env.AGTPILOT_SECRET_KEY = 'server-render-test-key';

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

  // 开书三段化:第一步无书状态依赖;第二步必须现读到第一步入库的书
  it('genesis_bible(第一步设定包)不需要书状态,契约含回显段', () => {
    const run = renderWorkshopRunServer('u-novel', 'novel', { mode: 'genesis_bible', genre: '玄幻' });
    expect(run).not.toBeNull();
    expect(run!.title).toBe('网文开书:玄幻');
    for (const anchor of ['【题材】', '【文风锚】', '【每章字数】', '【设定集】', '【人物卡】']) {
      expect(run!.prompt).toContain(anchor);
    }
  });

  it('genesis_outline(第二步大纲包):有效 bookId 现读书状态,书号逐字注入;缺书抛错', () => {
    const userId = 'u-novel-outline';
    const book = createNovelBook(userId, {
      title: '铁拳少年',
      bible: '力量体系:青铜→白银,不可跳级。',
      characters: [{ name: '林凡', role: '主角' }],
    });
    const run = renderWorkshopRunServer(userId, 'novel', { mode: 'genesis_outline', bookId: book.bookId });
    expect(run!.title).toBe('《铁拳少年》大纲规划');
    expect(run!.prompt).toContain(book.bookId); // 书号回显注入,入库对账
    expect(run!.prompt).toContain('青铜→白银'); // 设定集是大纲的约束源
    expect(run!.prompt).toContain('【粗纲】');

    expect(() =>
      renderWorkshopRunServer(userId, 'novel', { mode: 'genesis_outline', bookId: 'nv_nope_000000' })
    ).toThrow(/小说不存在或无权访问/);
    expect(() => renderWorkshopRunServer(userId, 'novel', { mode: 'genesis_outline' })).toThrow(
      /小说不存在或无权访问/
    );
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

describe('novel style loader(P2 文风学习,绑书可选)', () => {
  const LONG = '暴雨夜,林凡攥着手机在积水里狂奔,差评像追命的鼓点,一声声砸在他背上。'.repeat(8);
  const SAMPLES = '雨夜,外卖箱撞在背上,冰凉。他攥紧手机,冲进巷子深处。';

  it('不绑书:无书状态也渲染(纯提炼,锚留作开书用)', () => {
    const run = renderWorkshopRunServer('u-style', 'novel', { mode: 'style', samples: SAMPLES });
    expect(run).not.toBeNull();
    expect(run!.title).toBe('文风学习');
    expect(run!.prompt).toContain('【文风锚】');
    expect(run!.prompt).toContain(SAMPLES);
    expect(run!.prompt).not.toContain('绑定书目');
    expect(run!.prompt).not.toContain('【书号】');
  });

  it('绑有效书:标题带书名,prompt 内嵌书号与回显契约', () => {
    const book = createNovelBook('u-style-b', {
      title: '铁拳少年',
      chapters: [{ title: '雨夜差评', content: LONG, summary: '捡到手机。' }],
    });
    const run = renderWorkshopRunServer('u-style-b', 'novel', {
      mode: 'style',
      bookId: book.bookId,
      samples: SAMPLES,
    });
    expect(run!.title).toBe('《铁拳少年》文风学习');
    expect(run!.prompt).toContain('绑定书目:《铁拳少年》');
    expect(run!.prompt).toContain(book.bookId);
    expect(run!.prompt).toContain('【书号】');
  });

  it('绑了书但书不存在/无权访问:抛错(绝不猜绑定)', () => {
    expect(() =>
      renderWorkshopRunServer('u-style-c', 'novel', { mode: 'style', bookId: 'nv_nope_000000', samples: SAMPLES })
    ).toThrow(/小说不存在或无权访问/);
    const book = createNovelBook('u-style-owner', {
      title: 't',
      chapters: [{ title: 't', content: LONG, summary: 's' }],
    });
    expect(() =>
      renderWorkshopRunServer('u-style-other', 'novel', { mode: 'style', bookId: book.bookId, samples: SAMPLES })
    ).toThrow(/小说不存在或无权访问/);
  });

  it('缺样文:诚实抛错(绝不凭空编造文风)', () => {
    expect(() => renderWorkshopRunServer('u-style-d', 'novel', { mode: 'style' })).toThrow(/需要样文/);
  });
});

describe('resolveCronPromptServer(触发时服务端现读,P1 novel 日更)', () => {
  const LONG = '暴雨夜,林凡攥着手机在积水里狂奔,差评像追命的鼓点,一声声砸在他背上。'.repeat(8);

  it('普通任务:原样 job.prompt;空 prompt 返回空串', () => {
    expect(resolveCronPromptServer({ prompt: '帮我总结今天的邮件' }, 'u-cron-a')).toBe('帮我总结今天的邮件');
    expect(resolveCronPromptServer({}, 'u-cron-a')).toBe('');
  });

  it('scenario 非法(脏数据):降级回 job.prompt(与纯函数路径同语义)', () => {
    expect(resolveCronPromptServer({ prompt: '兜底', scenario: { key: 'whatever' } as any }, 'u-cron-a')).toBe('兜底');
  });

  it('纯场景(xhs):档案从 user-store 现读注入重建(不依赖服务端书库)', () => {
    const userId = 'u-cron-xhs';
    saveUserScenarioProfile(userId, profile);
    const prompt = resolveCronPromptServer(
      { prompt: '旧快照', scenario: { key: 'xhs_weekly_topics', count: 5 } },
      userId
    );
    expect(prompt).toContain('【账号档案】');
    expect(prompt).toContain('产出 5 条选题');
    expect(prompt).not.toContain('旧快照');
  });

  it('novel 日更:现读书库重建续写 prompt(书号逐字、下一章序号、count=每章字数)', () => {
    const userId = 'u-cron-novel';
    const book = createNovelBook(userId, {
      title: '铁拳少年',
      bible: '力量体系:青铜→白银,不可跳级。',
      chapters: [{ title: '雨夜差评', content: LONG, summary: '捡到手机。' }],
    });
    const prompt = resolveCronPromptServer(
      { prompt: '旧快照', scenario: { key: 'novel_daily_chapter', count: 2500, bookId: book.bookId } },
      userId
    );
    expect(prompt).not.toContain('旧快照');
    expect(prompt).toContain(book.bookId);
    expect(prompt).toContain('《铁拳少年》第 2 章');
    expect(prompt).toContain('2500');
    expect(prompt).toContain('青铜→白银');

    // 书库更新后再触发跟着变(现读,不是订阅时的快照)
    appendChapter(userId, book.bookId, { title: '夜袭', content: LONG, summary: '夜探仓库。' });
    const prompt2 = resolveCronPromptServer(
      { scenario: { key: 'novel_daily_chapter', bookId: book.bookId } },
      userId
    );
    expect(prompt2).toContain('《铁拳少年》第 3 章');
    expect(prompt2).toContain('3000'); // count 缺省 → defaultCount 3000
  });

  it('novel 日更缺 bookId:诚实抛错(订阅时没绑定书)', () => {
    expect(() =>
      resolveCronPromptServer({ scenario: { key: 'novel_daily_chapter' } }, 'u-cron-novel2')
    ).toThrow(/缺少 bookId/);
  });

  it('novel 日更书被删/别人的书号:抛错(任务失败可见,绝不静默用旧快照)', () => {
    expect(() =>
      resolveCronPromptServer(
        { prompt: '旧快照', scenario: { key: 'novel_daily_chapter', bookId: 'nv_nope_000000' } },
        'u-cron-novel3'
      )
    ).toThrow(/小说不存在或无权访问/);
  });
});

describe('oss_radar 派发历史 loader(去重黑名单服务端现读,milvus #52049 重复派发修复)', () => {
  // 用真实时钟:getRunnerTasks 缺省 now=Date.now() 会扫 TTL,过期任务进不了历史
  const NOW = Date.now();
  const MILVUS_52049 = 'https://github.com/milvus-io/milvus/issues/52049';

  const deviceMeta: RunnerDeviceMeta = {
    hostname: 'radar-test-mac',
    platform: 'darwin',
    runnerVersion: '0.0.1',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  };

  function radarPack(taskId: string, issueUrl: string) {
    return {
      taskId,
      kind: 'oss_contribution',
      repo: 'milvus-io/milvus',
      issueUrl,
      workBranch: 'contrib/oss-radar-x',
      constraints: ['只修这个 Issue'],
      acceptance: { testCommand: 'pnpm test' },
      prDraft: { title: 'fix: 修一个东西', bodyTemplate: '关联 Issue' },
      executor: { name: 'claude-code' },
    };
  }

  /** 走完整链路把一条任务打到 no_action 终态(线上 runner 事件流的同形状回放) */
  function driveToNoAction(userId: string, taskId: string, issueUrl: string) {
    const { code } = createPairCode(userId, NOW);
    const d = redeemPairCode(code, deviceMeta, NOW);
    if (!d.ok) throw new Error(`pair failed: ${d.error}`);
    enqueueTask(userId, radarPack(taskId, issueUrl), NOW)!;
    claimNextTask(userId, d.deviceId, NOW)!;
    recordRunnerEvents(
      userId,
      d.deviceId,
      [
        { eventId: `${taskId}_run`, taskId, deviceId: d.deviceId, at: NOW + 1, type: 'state', payload: { state: 'running' } },
        {
          eventId: `${taskId}_err`,
          taskId,
          deviceId: d.deviceId,
          at: NOW + 2,
          type: 'error',
          payload: { message: '无需改动', noAction: { reason: 'already_fixed', evidence: 'commit d9bef57b8f 已在基线' } },
        },
        { eventId: `${taskId}_fail`, taskId, deviceId: d.deviceId, at: NOW + 3, type: 'state', payload: { state: 'failed' } },
      ],
      NOW + 3
    );
    expect(getRunnerTask(userId, taskId, NOW + 4)!.state).toBe('no_action');
  }

  it('renderWorkshopRunServer:历史任务现读注入【派发历史】(no_action 结论 + 在途)', () => {
    const userId = 'u-radar-a';
    driveToNoAction(userId, 'rtask_radar_na', MILVUS_52049);
    enqueueTask(userId, radarPack('rtask_radar_q', 'https://github.com/o/r/issues/7'), NOW)!;
    const run = renderWorkshopRunServer(userId, 'oss_radar', { count: 5 });
    expect(run).not.toBeNull();
    expect(run!.prompt).toContain('【派发历史】');
    expect(run!.prompt).toContain(`${MILVUS_52049} — 已核实无需改动(上游已修复)`);
    expect(run!.prompt).toContain('https://github.com/o/r/issues/7 — 已派发,进行中');
  });

  it('无历史:不注入【派发历史】,模板占位符也不漏', () => {
    const run = renderWorkshopRunServer('u-radar-empty', 'oss_radar', { count: 5 });
    expect(run).not.toBeNull();
    expect(run!.prompt).not.toContain('【派发历史】');
    expect(run!.prompt).not.toContain('{{historySection}}');
  });

  it('用户隔离:别人的派发历史不串进我的 prompt', () => {
    const run = renderWorkshopRunServer('u-radar-b', 'oss_radar', {});
    expect(run!.prompt).not.toContain(MILVUS_52049);
    expect(run!.prompt).not.toContain('【派发历史】');
  });

  it('renderWorkshopRunServer:手动扫描 targetRepos 透传渲染【本次指定项目】(服务端权威路径同解析)', () => {
    const run = renderWorkshopRunServer('u-radar-repos', 'oss_radar', {
      count: 5,
      targetRepos: 'milvus-io/milvus\nhttps://github.com/vllm-project/vllm\nbogus token',
    });
    expect(run).not.toBeNull();
    expect(run!.prompt).toContain('【本次指定项目】');
    expect(run!.prompt).toContain('- milvus-io/milvus');
    expect(run!.prompt).toContain('- vllm-project/vllm');
    expect(run!.prompt).not.toContain('bogus token');
  });

  it('resolveCronPromptServer 周扫:档案 + 派发历史同时注入,count 尊重 / 缺省 5', () => {
    const userId = 'u-radar-cron';
    saveUserScenarioProfile(userId, {
      ...profile,
      scenarioKey: 'oss_radar',
      positioning: { niche: 'Go / TypeScript', audience: 'LLM 基础设施' },
    });
    driveToNoAction(userId, 'rtask_radar_cron', MILVUS_52049);

    const prompt = resolveCronPromptServer(
      { prompt: '旧快照', scenario: { key: 'oss_radar_weekly', count: 7 } },
      userId
    );
    expect(prompt).not.toContain('旧快照');
    expect(prompt).toContain('产出数量:7 条机会');
    expect(prompt).toContain('【贡献者档案】');
    expect(prompt).toContain('主力技术栈:Go / TypeScript');
    expect(prompt).toContain('【派发历史】');
    expect(prompt).toContain(MILVUS_52049);

    // count 缺省 → defaultCount 5(订阅时没写条数也能重建)
    const prompt2 = resolveCronPromptServer({ scenario: { key: 'oss_radar_weekly' } }, userId);
    expect(prompt2).toContain('产出数量:5 条机会');
    expect(prompt2).toContain('【派发历史】');
  });
});
