/**
 * 教研工坊表单:模式(文献综述/论文精读/备课/学习卡片) + 各模式专属字段 + 投递方式。
 */
import { useState } from 'react';
import {
  EDU_MODES,
  FLASHCARD_TYPES,
  FLASHCARD_FORMATS,
  EDU_DELIVERIES,
} from '../../../lib/edu-workshops';
import type { WorkshopDef } from '../registry';
import { buildWorkshopRun } from '../run';
import { recordRun, lastRunOf } from '../history';
import { ChipGroup, FieldLabel, WorkshopModalShell, inputClass, textareaClass } from './shared';

interface Props {
  workshop: WorkshopDef;
  onRun: (prompt: string, title?: string) => void | Promise<void>;
  onClose: () => void;
}

export function EduWorkshopForm({ workshop, onRun, onClose }: Props) {
  const saved = lastRunOf(workshop.id)?.params || {};
  const s = (k: string, d = '') => (typeof saved[k] === 'string' ? (saved[k] as string) : d);

  const [mode, setMode] = useState<string>(s('mode', 'literature_review'));
  const [topic, setTopic] = useState(s('topic'));
  const [focus, setFocus] = useState(s('focus'));
  const [paper, setPaper] = useState(s('paper'));
  const [subject, setSubject] = useState(s('subject'));
  const [grade, setGrade] = useState(s('grade'));
  const [duration, setDuration] = useState(s('duration'));
  const [extras, setExtras] = useState(s('extras'));
  const [material, setMaterial] = useState(s('material'));
  const [cardType, setCardType] = useState<string>(s('cardType', 'mixed'));
  const [cardFormat, setCardFormat] = useState<string>(s('cardFormat', 'anki_csv'));
  const [delivery, setDelivery] = useState<string>(s('delivery', 'chat'));

  const params = {
    mode,
    topic,
    focus,
    paper,
    subject,
    grade,
    duration,
    extras,
    material,
    cardType,
    cardFormat,
    delivery,
  };
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
      submitLabel="开始生成"
      previewPrompt={preview.prompt}
    >
      <div className="space-y-1.5">
        <FieldLabel>教研模式</FieldLabel>
        <ChipGroup
          options={EDU_MODES.map((m) => ({ id: m.id, name: m.name }))}
          value={mode as never}
          onChange={setMode}
          accent={workshop.accent}
        />
      </div>

      {mode === 'literature_review' && (
        <>
          <div className="space-y-1.5">
            <FieldLabel optional>综述课题 / 关键词</FieldLabel>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="如：扩散模型在医学图像分割中的应用（留空则任务里先问你）"
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel optional>额外要求</FieldLabel>
            <input
              type="text"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="如：只要近 3 年、侧重方法论、以中文文献为主、需要 15 篇以上"
              className={inputClass}
            />
          </div>
        </>
      )}

      {mode === 'paper_read' && (
        <>
          <div className="space-y-1.5">
            <FieldLabel optional>论文标识</FieldLabel>
            <input
              type="text"
              value={paper}
              onChange={(e) => setPaper(e.target.value)}
              placeholder="标题 / arXiv ID（如 2506.13538）/ DOI / 链接（留空则任务里先问你）"
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel optional>额外关注点</FieldLabel>
            <input
              type="text"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="如：重点讲清方法、和我的课题的关系、实验复现难度"
              className={inputClass}
            />
          </div>
        </>
      )}

      {mode === 'lesson_plan' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <FieldLabel>学科</FieldLabel>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="如：初中数学"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>学段年级</FieldLabel>
              <input
                type="text"
                value={grade}
                onChange={(e) => setGrade(e.target.value)}
                placeholder="如：八年级 / 大一下学期"
                className={inputClass}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-1.5">
              <FieldLabel>课题</FieldLabel>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="如：勾股定理 / 光合作用"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>课时</FieldLabel>
              <input
                type="text"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="1 课时"
                className={inputClass}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <FieldLabel optional>补充要求</FieldLabel>
            <input
              type="text"
              value={extras}
              onChange={(e) => setExtras(e.target.value)}
              placeholder="教材版本 / 学情 / 特殊安排，如：人教版、班级基础偏弱、需含分组实验"
              className={inputClass}
            />
          </div>
        </>
      )}

      {mode === 'flashcards' && (
        <>
          <div className="space-y-1.5">
            <FieldLabel optional>卡片主题</FieldLabel>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="如：高一化学必修一 · 离子反应（用于聚焦与命名）"
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>学习材料</FieldLabel>
            <textarea
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
              rows={5}
              placeholder={'把要做成卡片的学习材料/笔记/教材段落粘贴到这里（留空则任务里先问你）。\n材料越具体，卡片越贴合考点。'}
              className={textareaClass}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>卡片类型</FieldLabel>
            <ChipGroup
              options={FLASHCARD_TYPES.map((t) => ({ id: t.id, name: t.name }))}
              value={cardType as never}
              onChange={setCardType}
              accent={workshop.accent}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>输出格式</FieldLabel>
            <ChipGroup
              options={FLASHCARD_FORMATS.map((f) => ({ id: f.id, name: f.name }))}
              value={cardFormat as never}
              onChange={setCardFormat}
              accent={workshop.accent}
            />
          </div>
        </>
      )}

      {mode !== 'flashcards' && (
        <div className="space-y-1.5">
          <FieldLabel>成果投递</FieldLabel>
          <ChipGroup
            options={EDU_DELIVERIES.map((d) => ({ id: d.id, name: d.name }))}
            value={delivery as never}
            onChange={setDelivery}
            accent={workshop.accent}
          />
        </div>
      )}
    </WorkshopModalShell>
  );
}
