/**
 * 抖音 / B站 短视频脚本工坊 · 模板上下文(正文见 prompt.main.md)
 *
 * 与微博包(weibo)同一分工:Agent 只做选题与脚本创作,拍摄与发布由用户人工完成。
 * 双平台共用一套脚本结构,差异在 PLATFORM_NOTES(节奏/标签/分区约定),
 * 以 platformName/styleNote/titleNote/tagsNote 注入模板。
 * 选题数据源统一走 shared/sources 的检索梯度;最后模型自身知识兜底。
 */

import prompt from './prompt.main.md';
import { renderTemplate } from '../engine';
import { TOPIC_RESEARCH_SOURCES } from '../shared/sources';

// ---------- 抖音 / B站 短视频脚本 ----------

export const VIDEO_PLATFORMS = [
  { id: 'douyin', name: '抖音' },
  { id: 'bilibili', name: 'B站' },
] as const;

export type VideoPlatformId = (typeof VIDEO_PLATFORMS)[number]['id'];

export const VIDEO_SCRIPT_DURATIONS = ['30 秒', '60 秒', '3 分钟'] as const;

export interface VideoScriptInput {
  /** 用户指定主题;留空则由 Agent 调研热点选题 */
  topic?: string;
  platform: VideoPlatformId | string;
  /** 时长(VIDEO_SCRIPT_DURATIONS 之一) */
  duration: string;
  /** 产出脚本数 1-3 */
  count: number;
}

const PLATFORM_NOTES: Record<string, { name: string; style: string; tags: string }> = {
  douyin: {
    name: '抖音',
    style:
      '抖音风格:竖屏 9:16、快节奏强钩子——前 3 秒必须抛出冲突/悬念/利益点,单镜头不超过 3 秒,信息口语化高密度,结尾引导点赞关注要自然',
    tags: '标签 4-6 个,以 # 开头,热门泛流量话题 + 垂类话题混搭;建议投放的 DOU+ 人群方向一句话',
  },
  bilibili: {
    name: 'B站',
    style:
      'B站风格:横屏 16:9、信息密度优先——开头 15 秒内说清「这期讲什么、你能得到什么」,中段允许展开论证与玩梗,预留 2-3 个弹幕互动点(提问/投票/名场面),结尾一键三连引导',
    tags: '标签 5-8 个;建议投稿分区(如知识/科技/生活);封面标题党程度需克制(B站社区反感纯标题党)',
  },
};

export function buildVideoScriptPrompt({ topic, platform, duration, count }: VideoScriptInput): string {
  const t = (topic || '').trim();
  const n = Math.min(3, Math.max(1, Math.round(count) || 1));
  const p = PLATFORM_NOTES[platform] || PLATFORM_NOTES.douyin;
  return renderTemplate(prompt, {
    topic: t,
    platformName: p.name,
    duration,
    count: n,
    styleNote: p.style,
    titleNote:
      p.name === 'B站'
        ? '不超过 20 字,信息明确、可带适度悬念'
        : '不超过 15 字,强钩子、口语化、不造假不标题党',
    tagsNote: p.tags,
    sources: TOPIC_RESEARCH_SOURCES,
  });
}
