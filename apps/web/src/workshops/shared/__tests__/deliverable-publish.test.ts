import { describe, it, expect } from 'vitest';
import { buildWorkshopDeliverable } from '../deliverable-publish';
import { resolveDeliverableKind } from '../../registry';

/**
 * 内容工坊成品 → 交付库自动落地(收尾发布)契约测试。
 *
 * 锁两件事:
 * 1. buildWorkshopDeliverable:按 kind 用对应解析器抽成品、渲染成干净 Markdown;
 *    单篇标题=成品标题、多篇=任务名兜底;非成品格式(自由文本/选题清单/空答复)
 *    一律 null —— 绝不把非成品当交付件发布。
 * 2. resolveDeliverableKind:声明驱动,只有声明了包类交付物的内容工坊
 *    (知乎/公众号=文章包,小红书=笔记包)才参与,其余工坊/手输任务 → null。
 */

const LONG_BODY =
  '这是一篇关于大模型落地实践的深度长文正文,讨论工程化路径与真实收益,内容必须超过一百字才能被判定为有效的文章包,所以这里把正文写得足够长以便通过有效性校验。'.repeat(
    2
  );

const article = (title: string, digest: string, body = LONG_BODY) =>
  `【标题】\n${title}\n【摘要】\n${digest}\n【正文】\n${body}`;

describe('buildWorkshopDeliverable · article-package(知乎/公众号)', () => {
  it('单篇:标题=成品标题,正文含 H1 标题 + 引用摘要 + 正文,count=1', () => {
    const text = article('大模型落地:别再谈概念了', '关键不在模型本身,而在工程化路径。');
    const d = buildWorkshopDeliverable('article-package', text, '知乎专栏工坊 · 技术长文');
    expect(d).not.toBeNull();
    expect(d!.count).toBe(1);
    expect(d!.title).toBe('大模型落地:别再谈概念了');
    expect(d!.content).toContain('# 大模型落地:别再谈概念了');
    expect(d!.content).toContain('> 关键不在模型本身,而在工程化路径。');
    expect(d!.content).toContain(LONG_BODY);
  });

  it('多篇:标题回落任务名,正文以 --- 合并,count=篇数', () => {
    const text = [
      article('第一篇标题', '第一篇摘要一句话。'),
      article('第二篇标题', '第二篇摘要一句话。'),
    ].join('\n---\n');
    const d = buildWorkshopDeliverable('article-package', text, '知乎专栏工坊 · 技术长文')!;
    expect(d.count).toBe(2);
    expect(d.title).toBe('知乎专栏工坊 · 技术长文');
    expect(d.content).toContain('# 第一篇标题');
    expect(d.content).toContain('# 第二篇标题');
    expect(d.content).toContain('\n\n---\n\n');
  });

  it('自由文本(无字段头)/空答复 → null(绝不发布非成品)', () => {
    expect(
      buildWorkshopDeliverable('article-package', '今天聊一下大模型落地……' + '没有结构的长文本。'.repeat(10), 't')
    ).toBeNull();
    expect(buildWorkshopDeliverable('article-package', '', 't')).toBeNull();
  });

  it('笔记包形状喂 article kind:无【摘要】互斥锚 → null(绝不误投)', () => {
    const noteShape = `【标题】\n通勤穿搭\n【封面文案】\n3 件单品穿一周\n【正文】\n${'笔记正文与文章包字段头高度重合但没有摘要字段。'.repeat(
      6
    )}\n【标签】\n#穿搭 #ootd`;
    expect(buildWorkshopDeliverable('article-package', noteShape, 't')).toBeNull();
  });
});

describe('buildWorkshopDeliverable · note-package(小红书)', () => {
  const note = (title: string, body: string, tags: string) =>
    `【标题】\n${title}\n【封面文案】\n封面一句话\n【正文】\n${body}\n【标签】\n${tags}`;

  it('单篇笔记:标题=笔记标题,正文含 H1 标题 + 正文 + 标签串', () => {
    const text = note('平价通勤穿搭', '笔记正文内容足够长以便通过有效性校验。'.repeat(6), '#穿搭 #ootd');
    const d = buildWorkshopDeliverable('note-package', text, '小红书笔记工坊')!;
    expect(d).not.toBeNull();
    expect(d.count).toBe(1);
    expect(d.title).toBe('平价通勤穿搭');
    expect(d.content).toContain('# 平价通勤穿搭');
    expect(d.content).toContain('#穿搭 #ootd');
  });

  it('选题清单(非笔记包)→ null(xhs 每周选题是中间产物,绝不当交付件)', () => {
    const picks = `【选题 1】\n秋冬通勤穿搭\n【选题 2】\n周末露营装备清单`;
    expect(buildWorkshopDeliverable('note-package', picks, 't')).toBeNull();
  });
});

describe('resolveDeliverableKind(声明驱动:仅包类内容工坊参与自动落地)', () => {
  it('知乎/公众号 → article-package;小红书 → note-package', () => {
    expect(resolveDeliverableKind('zhihu')).toBe('article-package');
    expect(resolveDeliverableKind('wechat_mp')).toBe('article-package');
    expect(resolveDeliverableKind('xhs')).toBe('note-package');
  });

  it('非包类交付物工坊 → null(PPT/开源雷达/小说/视频/微博/邮件等)', () => {
    for (const id of ['ppt', 'oss_radar', 'novel', 'video_douyin', 'video_bilibili', 'weibo', 'email_triage', 'weekly']) {
      expect(resolveDeliverableKind(id)).toBeNull();
    }
  });

  it('无 workshopId / 未知 id → null(手输任务、历史任务不参与)', () => {
    expect(resolveDeliverableKind(undefined)).toBeNull();
    expect(resolveDeliverableKind('not_a_workshop')).toBeNull();
  });
});
