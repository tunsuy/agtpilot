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
  buildNovelContinuePrompt,
  buildNovelReviewPrompt,
  NOVEL_GENRES,
  clampChapterWords,
} from './context';
import { str } from '../shared/params';
import type { WorkshopSkill } from '../types';
import type { NovelBook } from '@/lib/novel-context';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'novel',
    name: '网文小说工坊',
    category: 'content',
    desc: '设定库驱动的长篇创作:六件套开书、恒定上下文续写不漂移、状态库全书体检',
    icon: BookOpen,
    accent: 'violet',
    deps: [],
    note: '按职业作者方法论(设定集/人物卡/三层大纲/伏笔台账/时间线/文风锚)建库,每章生成只注入恒定上下文,写后反思写回,长篇前后一致。产出存入你的书库(可手改);投递任何平台前请人工审阅,并按平台规则如实勾选 AI 辅助声明——发布永远由你确认,本工坊不自动发布。',
  },
  run: (params, ctx) => {
    const mode = str(params.mode, 'genesis');
    if (mode === 'continue' || mode === 'review') {
      const book: NovelBook | undefined = ctx?.novelState;
      if (!book) {
        // 服务端渲染时由 loader 保证;走到这里 = 客户端预览没带书状态或 bookId 失效
        throw new Error(`缺少小说状态(书不存在或参数缺 bookId),无法${mode === 'continue' ? '续写' : '审查'}`);
      }
      if (mode === 'review') {
        return {
          prompt: buildNovelReviewPrompt({ book, focus: str(params.focus) }),
          title: `《${book.title}》全书体检`,
        };
      }
      const { prompt, nextIndex } = buildNovelContinuePrompt({
        book,
        style: str(params.style),
        chapterWords: clampChapterWords(params.chapterWords),
      });
      return { prompt, title: `《${book.title}》第${nextIndex}章` };
    }
    // genesis(开新书)
    const genre = str(params.genre, NOVEL_GENRES[0]);
    return {
      prompt: buildNovelGenesisPrompt({
        genre,
        premise: str(params.premise),
        style: str(params.style, '爽文快节奏:短段落、强钩子、三章一小爽五章一大爽'),
        chapterWords: clampChapterWords(params.chapterWords),
        openingChapters: params.openingChapters,
      }),
      title: `网文开书:${genre}`,
    };
  },
};
