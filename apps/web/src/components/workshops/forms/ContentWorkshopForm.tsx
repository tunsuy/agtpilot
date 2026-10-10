/**
 * 内容工坊表单 · 小红书/微博图文 + 抖音/B站短视频脚本
 * 主题/类型/时长/篇数 → buildWorkshopRun 交给 Agent。
 */
import { useState } from 'react';
import { XHS_WORKSHOP_STYLES } from '../../../lib/xhs-workshop';
import {
  WEIBO_WORKSHOP_STYLES,
  VIDEO_SCRIPT_DURATIONS,
} from '../../../lib/content-workshops';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, FieldLabel, WorkshopModalShell, inputClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string) => void | Promise<void>;
  onClose: () => void;
}

export function ContentWorkshopForm({ workshop, onRun, onClose }: Props) {
  const isVideo = workshop.id === 'video_douyin' || workshop.id === 'video_bilibili';
  const isWeibo = workshop.id === 'weibo';
  const saved = lastRunOf(workshop.id)?.params || {};

  const [topic, setTopic] = useState(typeof saved.topic === 'string' ? saved.topic : '');
  const [style, setStyle] = useState<string>(
    typeof saved.style === 'string' ? saved.style : isWeibo ? WEIBO_WORKSHOP_STYLES[0] : XHS_WORKSHOP_STYLES[0]
  );
  const [duration, setDuration] = useState<string>(
    typeof saved.duration === 'string' ? saved.duration : VIDEO_SCRIPT_DURATIONS[1]
  );
  const [count, setCount] = useState<number>(
    typeof saved.count === 'number' ? saved.count : 1
  );

  const params = { topic, style, duration, count };
  const preview = buildWorkshopRun(workshop.id, params);

  const handleSubmit = () => {
    recordRun(workshop.id, preview.title, params);
    onRun(preview.prompt, preview.title);
  };

  return (
    <WorkshopModalShell
      def={workshop}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel="开始创作"
      previewPrompt={preview.prompt}
    >
      <div className="space-y-1.5">
        <FieldLabel optional>主题</FieldLabel>
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={
            isVideo
              ? '留空则由 Agent 抓知乎热榜/搜索热点自动选题,如：AI 工具月度盘点'
              : '留空则由 Agent 抓知乎热榜/搜索热点自动选题,如：秋冬通勤穿搭'
          }
          className={inputClass}
        />
      </div>

      {(workshop.id === 'xhs' || isWeibo) && (
        <div className="space-y-1.5">
          <FieldLabel>{isWeibo ? '微博类型' : '笔记类型'}</FieldLabel>
          <ChipGroup
            options={(isWeibo ? WEIBO_WORKSHOP_STYLES : XHS_WORKSHOP_STYLES).map((s) => ({ id: s, name: s }))}
            value={style}
            onChange={setStyle}
            accent={workshop.accent}
          />
        </div>
      )}

      {isVideo && (
        <div className="space-y-1.5">
          <FieldLabel>视频时长</FieldLabel>
          <ChipGroup
            options={VIDEO_SCRIPT_DURATIONS.map((d) => ({ id: d, name: d }))}
            value={duration}
            onChange={setDuration}
            accent={workshop.accent}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <FieldLabel>{isVideo ? '产出脚本数' : '产出篇数'}</FieldLabel>
        <div className="flex gap-1.5">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setCount(n)}
              className={`w-10 py-1 rounded-lg text-xs font-medium border transition ${
                count === n
                  ? 'bg-violet-600 text-white border-violet-600'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </WorkshopModalShell>
  );
}
