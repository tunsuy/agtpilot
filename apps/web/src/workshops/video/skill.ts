/**
 * 抖音 / B站 短视频脚本工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 * 双平台共用 prompt.ts 的一套脚本结构,差异在 PLATFORM_NOTES;两个 id 各自装配 skill。
 */
import { Video, Tv } from 'lucide-react';
import { buildVideoScriptPrompt, type VideoPlatformId } from './context';
import { str, num } from '../shared/params';
import { parseMaterials } from '../shared/materials';
import type { WorkshopSkill } from '../types';

/** 平台差异装配(旧 run.ts 的 video_douyin/video_bilibili 分支合并) */
const buildVideoSkill = (
  id: 'video_douyin' | 'video_bilibili',
  platform: VideoPlatformId,
  meta: WorkshopSkill['meta']
): WorkshopSkill => ({
  meta,
  run: (params) => {
    const duration = str(params.duration, '60 秒');
    return {
      prompt: buildVideoScriptPrompt({
        topic: str(params.topic),
        platform,
        duration,
        count: num(params.count),
        materials: parseMaterials(params.materials),
      }),
      title: `${platform === 'bilibili' ? 'B站' : '抖音'}短视频脚本工坊 · ${duration}`,
    };
  },
});

export const WORKSHOP_SKILL_DOUYIN: WorkshopSkill = buildVideoSkill('video_douyin', 'douyin', {
  id: 'video_douyin',
  name: '抖音脚本工坊',
  category: 'content',
  desc: '标题/分镜表/前 15 秒口播逐字稿/标签成套产出,竖屏快节奏',
  icon: Video,
  accent: 'violet',
  searchGroup: 'research',
  deps: [
    { id: 'newsnow', name: '全网热榜' },
    { id: 'zhihu', name: '知乎' },
    { id: 'twitterapi_io', name: 'X / Twitter' },
    { id: 'exa', name: '网络搜索' },
  ],
  note: 'Agent 产出标题/分镜脚本/口播稿/标签/封面文案。你拍摄剪辑后 → 表单底部「唤起抖音」→ App 上传、人工核对后发布。已连接热榜/搜索类连接器时选题走实时热点。',
  // 纯文本成品:收尾服务端把最终答复原样落交付库(零模型参与,交付库/成果画布可见)
  artifacts: [{ kind: 'text-deliverable', label: '抖音短视频脚本' }],
});

export const WORKSHOP_SKILL_BILIBILI: WorkshopSkill = buildVideoSkill('video_bilibili', 'bilibili', {
  id: 'video_bilibili',
  name: 'B站脚本工坊',
  category: 'content',
  desc: '横屏信息密度优先,预留弹幕互动点,含投稿分区建议',
  icon: Tv,
  accent: 'violet',
  searchGroup: 'research',
  deps: [
    { id: 'newsnow', name: '全网热榜' },
    { id: 'zhihu', name: '知乎' },
    { id: 'twitterapi_io', name: 'X / Twitter' },
    { id: 'exa', name: '网络搜索' },
  ],
  note: 'Agent 产出标题/分镜脚本/口播稿/标签分区/封面文案。你拍摄剪辑后 → 表单底部「唤起哔哩哔哩」→ App 上传、人工核对后发布。已连接热榜/搜索类连接器时选题走实时热点。',
  // 纯文本成品:收尾服务端把最终答复原样落交付库(零模型参与,交付库/成果画布可见)
  artifacts: [{ kind: 'text-deliverable', label: 'B站短视频脚本' }],
});
