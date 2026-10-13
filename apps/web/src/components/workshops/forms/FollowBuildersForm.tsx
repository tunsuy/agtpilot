/**
 * AI Builders 日报工坊表单:输出语言 / 时间范围 / 内容类别。
 * 全部有默认值(中文 / 最近 24 小时 / 全类别),零输入可直接运行;
 * 上次运行参数自动回填(lastRunOf),与其余工坊同规矩。
 */
import { useState } from 'react';
import {
  FB_LANGUAGES,
  FB_RANGES,
  FB_CATEGORIES,
} from '@/workshops/follow_builders/context';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, MultiChipGroup, FieldLabel, WorkshopModalShell } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string) => void | Promise<void>;
  onClose: () => void;
}

const ALL_CATEGORY_IDS: readonly string[] = FB_CATEGORIES.map((c) => c.id);

export function FollowBuildersForm({ workshop, onRun, onClose }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};

  const [language, setLanguage] = useState<string>(
    typeof saved.language === 'string' && (FB_LANGUAGES as readonly string[]).includes(saved.language)
      ? saved.language
      : FB_LANGUAGES[0]
  );
  const [range, setRange] = useState<string>(
    typeof saved.range === 'string' && FB_RANGES.some((r) => r.id === saved.range)
      ? saved.range
      : FB_RANGES[0].id
  );
  const [categories, setCategories] = useState<string[]>(() => {
    const savedCats = Array.isArray(saved.categories)
      ? (saved.categories as unknown[]).filter(
          (c): c is string => typeof c === 'string' && ALL_CATEGORY_IDS.includes(c)
        )
      : [];
    return savedCats.length > 0 ? savedCats : [...ALL_CATEGORY_IDS];
  });

  const toggleCategory = (id: string) => {
    setCategories((prev) => {
      const next = prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id];
      // 至少保留一个类别:全取消等于没选,维持原状
      return next.length > 0 ? next : prev;
    });
  };

  const params = { language, range, categories };
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
      submitLabel="生成日报"
      previewPrompt={preview.prompt}
    >
      <div className="space-y-1.5">
        <FieldLabel>时间范围</FieldLabel>
        <ChipGroup
          options={FB_RANGES.map((r) => ({ id: r.id, name: r.name }))}
          value={range as never}
          onChange={setRange}
          accent={workshop.accent}
        />
        <p className="text-[10px] text-zinc-400 leading-relaxed">
          X 动态上游只保留最近 24 小时;播客覆盖 14 天、博客覆盖 72 小时,选更长范围时 X 部分仍是 24h 的量(日报中会注明)。
        </p>
      </div>

      <div className="space-y-1.5">
        <FieldLabel>内容类别</FieldLabel>
        <MultiChipGroup
          options={FB_CATEGORIES.map((c) => ({ id: c.id, name: c.name }))}
          values={categories}
          onToggle={toggleCategory}
          accent={workshop.accent}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>输出语言</FieldLabel>
        <ChipGroup
          options={FB_LANGUAGES.map((l) => ({ id: l, name: l }))}
          value={language as never}
          onChange={setLanguage}
          accent={workshop.accent}
        />
      </div>
    </WorkshopModalShell>
  );
}
