/**
 * 教研工坊 · skill 包清单(平移自 components/workshops/{registry,run}.ts)。
 */
import { GraduationCap } from 'lucide-react';
import { buildEduPrompt, EDU_MODES } from './prompt';
import { str } from '../shared/params';
import type { WorkshopSkill } from '../types';

export const WORKSHOP_SKILL: WorkshopSkill = {
  meta: {
    id: 'edu',
    name: '教研工坊',
    category: 'edu',
    desc: '文献综述 · 论文精读 · 智能备课 · 学习卡片,引用附 DOI 严禁编造',
    icon: GraduationCap,
    accent: 'indigo',
    deps: [
      { id: 'openalex', name: 'OpenAlex' },
      { id: 'alphaxiv', name: 'alphaXiv' },
      { id: 'huggingface_mcp', name: 'Hugging Face' },
      { id: 'deepl_mcp', name: 'DeepL' },
    ],
    note: '生成后跳转任务页,Agent 通过你已连接的 OpenAlex / alphaXiv / Hugging Face / DeepL 连接器检索真实文献(缺失时降级为网络搜索并明示),按模式产出文献综述 / 论文精读卡 / 教案 / 学习卡片。每条引用附 DOI 或 arXiv ID、严禁编造参考文献;全程只读、不改你的文献库;成果经邮件/群机器人投递前需你确认。',
  },
  run: (params) => {
    const mode = str(params.mode, 'literature_review');
    return {
      prompt: buildEduPrompt({
        mode,
        topic: str(params.topic),
        focus: str(params.focus),
        paper: str(params.paper),
        subject: str(params.subject),
        grade: str(params.grade),
        duration: str(params.duration),
        extras: str(params.extras),
        material: str(params.material),
        cardType: str(params.cardType, 'mixed'),
        cardFormat: str(params.cardFormat, 'anki_csv'),
        delivery: str(params.delivery, 'chat'),
      }),
      title: `教研 · ${EDU_MODES.find((m) => m.id === mode)?.name || '教研'}`,
    };
  },
};
