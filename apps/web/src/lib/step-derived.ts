/**
 * 步骤解析结果缓存(桌面 CockpitView 与移动 MobileConversationView 共用)。
 *
 * 背景:两个会话视图都会对每条 assistant 步骤做一批昂贵的纯函数解析
 * (笔记包/选题/文章包/开源机会/小说包 + 搜索来源归属)。原先这些都内联在
 * render 里,每次组件重渲染就对【全部历史步骤】重跑一遍 —— 而流式输出期间
 * steps 每帧变化(合帧后仍 ~60fps),等于每秒把整段会话重解析几十遍,
 * 时间复杂度 O(n²)。桌面 CPU 尚可,移动端/WebView 直接卡死。
 *
 * 关键观察:流式期间只有「正在输出的那一条」步骤对象被替换成新引用,
 * 历史步骤对象引用保持不变。因此按 step 对象引用做 WeakMap 缓存:历史
 * 步骤只解析一次,后续命中缓存;只有流式那条会重算。
 */
import { parseNotePackages } from '../workshops/xhs/note-package';
import { parseArticlePackages } from '../workshops/shared/article-package';
import { parseTopicPicks } from '../workshops/xhs/topic-picks';
import { parseNovelPackage } from '../workshops/novel/novel-package';
import { parseOssOpportunities } from '../workshops/oss_radar/opportunities';
import { sourcesForAnswer, type SearchSource } from './search-sources';

export interface StepDerived {
  reply: boolean;
  noteResult: any;
  pickResult: any;
  articleResult: any;
  ossResult: any;
  novelRaw: any;
}

const stepDerivedCache = new WeakMap<object, StepDerived>();

/**
 * 解析一条 assistant 步骤的各类结构化卡片。
 * @param reply 是否提供「续聊出口」。为 false 时跳过选题/文章包解析(移动端
 *              无 onRunMission 时这些卡不渲染);桌面恒传 true。
 */
export function deriveAssistantStep(st: any, reply: boolean): StepDerived {
  const cached = stepDerivedCache.get(st);
  if (cached && cached.reply === reply) return cached;
  const isStreaming = st.status === 'RUNNING' && st.role === 'assistant';
  const pNote = st.answer && !isStreaming ? parseNotePackages(st.answer) : null;
  const pPicks = st.answer && !isStreaming && reply ? parseTopicPicks(st.answer) : null;
  const pArticle = st.answer && !isStreaming && reply ? parseArticlePackages(st.answer) : null;
  const pOss = st.answer && !isStreaming ? parseOssOpportunities(st.answer) : null;
  const pNovel = st.answer && !isStreaming ? parseNovelPackage(st.answer) : null;
  const d: StepDerived = {
    reply,
    noteResult: pNote && pNote.packages.length > 0 ? pNote : null,
    pickResult: pPicks && pPicks.picks.length > 0 ? pPicks : null,
    articleResult: pArticle && pArticle.packages.length > 0 ? pArticle : null,
    ossResult: pOss && pOss.opportunities.length > 0 ? pOss : null,
    novelRaw: pNovel,
  };
  stepDerivedCache.set(st, d);
  return d;
}

export interface StepSources {
  search: SearchSource[];
  inline: SearchSource[];
}

const stepSourcesCache = new WeakMap<object, StepSources>();

/**
 * 计算一条步骤的搜索来源(搜索来源是「该步骤之前那段固定区间」的函数,
 * 前缀稳定 → 历史步骤按引用缓存一次即可)。
 */
export function deriveStepSources(st: any, steps: any[], answerIndex: number): StepSources {
  const cached = stepSourcesCache.get(st);
  if (cached) return cached;
  const isStreaming = st.status === 'RUNNING' && st.role === 'assistant';
  const search =
    st.messageKind === 'final' && st.answer && !isStreaming && answerIndex >= 0
      ? sourcesForAnswer(steps, answerIndex)
      : [];
  const inline =
    (st.messageKind === 'final' || (isStreaming && st.role === 'assistant')) && st.answer && answerIndex >= 0
      ? sourcesForAnswer(steps, answerIndex)
      : [];
  const d = { search, inline };
  stepSourcesCache.set(st, d);
  return d;
}
