/**
 * 网文小说工坊 · skill 包清单(docs/design/novel-workshop.md)
 *
 * 三模式 run():genesis(开新书)/ continue(续写下一章)/ review(全书体检)。
 * continue/review 的书状态经 ctx.novelState 注入:客户端预览由表单带已拉取的
 * 书快照;服务端权威渲染由 server-render 的 novel loader 现读 novel-store
 * (loader 放 server-render 侧而非本文件——本文件进客户端 bundle,不得引 fs)。
 *
 * 合规红线(负责人拍板 2026-10-14「自动发布」讨论):本工坊只产文本与本地书库;
 * 任何平台投递都是 P2 的「存官方草稿箱 + 人工确认发布」,AI 声明由作者本人在
 * 平台如实勾选,不代填不绕过;不接番茄/起点正文抓取类连接器(版权红线)。
 */
import { BookOpen } from 'lucide-react';
import {
  buildNovelGenesisPrompt,
  buildNovelGenesisBiblePrompt,
  buildNovelGenesisOutlinePrompt,
  buildNovelContinuePrompt,
  buildNovelReviewPrompt,
  buildNovelStylePrompt,
  NOVEL_GENRES,
  clampChapterWords,
} from './context';
import { str } from '../shared/params';
import type { CronScenarioSpec, WorkshopSkill } from '../types';
import type { NovelBook } from '@/lib/novel-context';

/** cron 日更场景 key(注册表汇入 CRON_SCENARIOS,派生 CronScenarioKey union) */
export const CRON_KEY = 'novel_daily_chapter' as const;

/**
 * cron 日更场景:count = 每章字数(不是产出条数);目标书 bookId 存在任务标记上,
 * 触发时服务端现读书库重建续写 prompt(requiresServerState)——build 只是诚实占位,
 * 纯函数路径(客户端预览/无书库上下文)调它直接抛错,绝不静默产出假 prompt。
 */
export const CRON: CronScenarioSpec = {
  key: CRON_KEY,
  profileSlot: 'novel',
  countMin: 1000,
  countMax: 6000,
  defaultCount: 3000,
  requiresServerState: true,
  build: () => {
    throw new Error('novel 日更场景需要服务端现读书库(server-render.resolveCronPromptServer),纯函数重建不可用');
  },
  workshopId: 'novel',
};

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'novel',
    name: '网文小说工坊',
    category: 'content',
    desc: '设定库驱动的长篇创作:六件套开书、恒定上下文续写不漂移、状态库全书体检',
    icon: BookOpen,
    accent: 'violet',
    // 依赖按工作流顺序:榜单选题(fanqie-radar,本地 stdio 免凭证 optIn,选题调研
    // 参考)→ 存草稿投递(扫码托管)。都不设 required:开书/续写/体检只落本地
    // 书库,两个连接器缺谁都不拦表单。番茄作家后台的「已连接」语义在
    // WorkshopsView 按托管登录态判定(本地 MCP 已撤,MCP 态恒灰);榜单是真
    // MCP 子进程,连接器页连接态照常判定
    deps: [
      { id: 'fanqie_radar', name: '番茄小说榜单' },
      { id: 'tomato_writer', name: '番茄作家后台' },
    ],
    note: '按职业作者方法论(设定集/人物卡/三层大纲/伏笔台账/时间线/文风锚)建库,每章生成只注入恒定上下文,写后反思写回,长篇前后一致。产出存入你的书库(可手改);投递任何平台前请人工审阅,并按平台规则如实勾选 AI 辅助声明——发布永远由你确认,本工坊不自动发布。',
    profileSlot: 'novel',
  },
  cron: CRON,
  run: (params, ctx) => {
    const mode = str(params.mode, 'genesis');
    if (mode === 'style') {
      // 文风学习(P2):书绑定可选——绑了书号就必须拿到书状态(不猜),没绑则纯提炼
      const bookId = str(params.bookId);
      const book: NovelBook | undefined = ctx?.novelState;
      if (bookId && !book) {
        throw new Error('缺少小说状态(书不存在或参数缺 bookId),无法绑定文风锚');
      }
      return {
        prompt: buildNovelStylePrompt({
          samples: str(params.samples),
          book: bookId ? book ?? null : null,
          profile: ctx?.scenarioProfile ?? null,
        }),
        title: bookId && book ? `《${book.title}》文风学习` : '文风学习',
      };
    }
    if (mode === 'continue' || mode === 'review') {
      const book: NovelBook | undefined = ctx?.novelState;
      if (!book) {
        // 服务端渲染时由 loader 保证;走到这里 = 客户端预览没带书状态或 bookId 失效
        throw new Error(`缺少小说状态(书不存在或参数缺 bookId),无法${mode === 'continue' ? '续写' : '审查'}`);
      }
      if (mode === 'review') {
        return {
          prompt: buildNovelReviewPrompt({ book, focus: str(params.focus), profile: ctx?.scenarioProfile ?? null }),
          title: `《${book.title}》全书体检`,
        };
      }
      const { prompt, nextIndex } = buildNovelContinuePrompt({
        book,
        style: str(params.style),
        chapterWords: clampChapterWords(params.chapterWords),
        profile: ctx?.scenarioProfile ?? null,
      });
      return { prompt, title: `《${book.title}》第${nextIndex}章` };
    }
    // 开书第二步:大纲包(粗纲/细纲/伏笔/时间线)。必须拿到第一步入库的书
    // 状态——设定集/人物卡是注入源,没有就拒绝渲染(服务端 loader 保证,
    // 客户端预览无书状态时诚实抛错)
    if (mode === 'genesis_outline') {
      const book: NovelBook | undefined = ctx?.novelState;
      if (!book) {
        throw new Error('缺少小说状态:开书第二步需要第一步已入库的书(缺 bookId 或书不存在)');
      }
      return {
        prompt: buildNovelGenesisOutlinePrompt({
          book,
          style: str(params.style),
          chapterWords: clampChapterWords(params.chapterWords),
          profile: ctx?.scenarioProfile ?? null,
        }),
        title: `《${book.title}》大纲规划`,
      };
    }
    // 开书第一步:设定包(书名/卖点/设定集/人物卡)。这是唯一无书状态依赖的
    // 开书模式;旧的单次全量 genesis 保留给历史重跑(local history 参数兼容),
    // 新表单不再产它
    const genre = str(params.genre, NOVEL_GENRES[0]);
    if (mode === 'genesis_bible') {
      return {
        prompt: buildNovelGenesisBiblePrompt({
          genre,
          premise: str(params.premise),
          style: str(params.style, '爽文快节奏:短段落、强钩子、三章一小爽五章一大爽'),
          chapterWords: clampChapterWords(params.chapterWords),
          profile: ctx?.scenarioProfile ?? null,
        }),
        title: `网文开书:${genre}`,
      };
    }
    // genesis(旧单次全量,兼容历史重跑)
    return {
      prompt: buildNovelGenesisPrompt({
        genre,
        premise: str(params.premise),
        style: str(params.style, '爽文快节奏:短段落、强钩子、三章一小爽五章一大爽'),
        chapterWords: clampChapterWords(params.chapterWords),
        openingChapters: params.openingChapters,
        profile: ctx?.scenarioProfile ?? null,
      }),
      title: `网文开书:${genre}`,
    };
  },
};
