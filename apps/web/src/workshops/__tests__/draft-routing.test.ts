import { describe, it, expect } from 'vitest';
import { buildWechatMpDraftReplyText } from '../wechat_mp/draft';
import { buildZhihuDraftReplyText } from '../zhihu/draft';
import { buildXhsDraftReplyText } from '../xhs/draft';
import { resolveArtifactDraft } from '../registry';
import type { ArticlePackage } from '../shared/article-package';
import type { NotePackage } from '../xhs/note-package';

/**
 * 存草稿投递指令 + 工域路由(生产实例驱动):
 * 2026-10-11 投草稿续聊轮带完整会话上下文、定稿已逐字内嵌,模型仍跑了
 * 4 次 search_web + 重生成标题候选(全部弃用)——只约束参数(「严格按下文填写」)
 * 挡不住对上轮工作流的模式补全,三个工坊的投递指令必须带显式纯执行边界句。
 * 路由按 mission.workshopId 经工坊包声明解析,不嗅探任务标题。
 */

const article: ArticlePackage = {
  index: 1,
  titles: ['大模型落地:别再谈概念了', '从 demo 到生产的三道坎'],
  digest: '大模型落地的关键不在工程化路径。',
  body: '正文'.repeat(80),
};

const note: NotePackage = {
  index: 1,
  titles: ['平价通勤穿搭合集'],
  body: '笔记正文'.repeat(30),
  tags: ['通勤穿搭', '平价穿搭'],
};

describe('三个工坊的存草稿指令 · 纯执行边界句(生产先例 2026-10-11)', () => {
  it('公众号:工具名/审批/人工发布 + 边界句 + title/digest/markdown 逐字内嵌', () => {
    const text = buildWechatMpDraftReplyText(article, 0);
    expect(text).toContain('wechat_mp_create_draft');
    expect(text).toContain('审批确认');
    expect(text).toContain('不传 cover_url');
    // 纯执行边界:显式负向禁止过程(调研与标题已定稿,勿重复调研/生成新候选)
    expect(text).toContain('纯执行投递');
    expect(text).toContain('不要重新检索资料');
    expect(text).toContain('不要生成新的标题候选');
    // 参数逐字内嵌(零漂移)
    expect(text).toContain('title:大模型落地:别再谈概念了');
    expect(text).toContain('digest:大模型落地的关键不在工程化路径。');
    expect(text).toContain(`markdown:\n${'正文'.repeat(80)}`);
  });

  it('知乎:托管工具 + 边界句 + title/body 内嵌,不带公众号参数键', () => {
    const text = buildZhihuDraftReplyText(article, 1);
    expect(text).toContain('zhihu_save_article_draft');
    // 正文传 Markdown 原文,工具侧转富文本粘贴(不再让模型自己改写正文)
    expect(text).toContain('转成富文本排版填进知乎编辑器');
    expect(text).toContain('不要自行改写正文');
    expect(text).toContain('纯执行投递');
    expect(text).toContain('不要重新检索资料');
    expect(text).toContain('title:从 demo 到生产的三道坎');
    expect(text).toContain(`body:\n${'正文'.repeat(80)}`);
    expect(text).not.toContain('digest:');
    expect(text).not.toContain('wechat_mp_create_draft');
  });

  it('小红书:存草稿工具 + 边界句 + title/body/tags 内嵌(标签不带 #)', () => {
    const text = buildXhsDraftReplyText(note, 0);
    expect(text).toContain('xhs_save_note_draft');
    expect(text).toContain('绝不发布');
    expect(text).toContain('纯执行投递');
    expect(text).toContain('不要重新检索资料');
    expect(text).toContain('title:平价通勤穿搭合集');
    expect(text).toContain('tags:通勤穿搭,平价穿搭');
    expect(text).not.toContain('#通勤');
  });
});

describe('resolveArtifactDraft · 按 mission.workshopId 路由(声明驱动,不嗅探标题)', () => {
  it('知乎工坊任务的文章包 → 知乎托管存草稿;其余 → 公众号', () => {
    expect(resolveArtifactDraft('zhihu', 'article-package')?.build(article, 0)).toContain(
      'zhihu_save_article_draft'
    );
    expect(resolveArtifactDraft('wechat_mp', 'article-package')?.build(article, 0)).toContain(
      'wechat_mp_create_draft'
    );
    // xhs 工坊不产出文章包 → 按格式缺省路由到公众号
    expect(resolveArtifactDraft('xhs', 'article-package')?.build(article, 0)).toContain(
      'wechat_mp_create_draft'
    );
  });

  it('手输/历史任务(无 workshopId)按格式缺省路由:文章包→公众号,笔记包→小红书', () => {
    expect(resolveArtifactDraft(undefined, 'article-package')?.build(article, 0)).toContain(
      'wechat_mp_create_draft'
    );
    expect(resolveArtifactDraft(undefined, 'note-package')?.build(note, 0)).toContain('xhs_save_note_draft');
    // 未知工坊 id 同样落回缺省,不抛错
    expect(resolveArtifactDraft('unknown_ws', 'article-package')?.build(article, 0)).toContain(
      'wechat_mp_create_draft'
    );
  });

  it('托管门与按钮文案出自声明:知乎/小红书有门,公众号凭证内置无门', () => {
    expect(resolveArtifactDraft('zhihu', 'article-package')?.managedGate).toBe('zhihu');
    expect(resolveArtifactDraft(undefined, 'note-package')?.managedGate).toBe('xhs');
    expect(resolveArtifactDraft('wechat_mp', 'article-package')?.managedGate).toBeUndefined();
    // 按钮文案与门未开的引导都在声明里(卡片不持工域知识)
    expect(resolveArtifactDraft('zhihu', 'article-package')?.label).toContain('知乎');
    expect(resolveArtifactDraft('zhihu', 'article-package')?.disabledHint).toContain('托管模式');
    expect(resolveArtifactDraft(undefined, 'note-package')?.disabledHint).toContain('托管写操作');
  });
});

describe('draft.direct 直连投递声明(「文档+脚本」模式:正文不过模型)', () => {
  it('三工坊平台声明与 payload 键名对齐各自工具契约', () => {
    // 公众号:wechat_mp_create_draft(title/digest/markdown;theme 由服务端从任务提取)
    const mp = resolveArtifactDraft('wechat_mp', 'article-package');
    expect(mp?.direct?.platform).toBe('wechat_mp');
    expect(mp?.direct?.buildPayload(article, 0)).toEqual({
      title: '大模型落地:别再谈概念了',
      digest: '大模型落地的关键不在工程化路径。',
      markdown: article.body,
    });
    // 知乎:zhihu_save_article_draft(title/body,body 传 Markdown 原文)
    const zh = resolveArtifactDraft('zhihu', 'article-package');
    expect(zh?.direct?.platform).toBe('zhihu');
    expect(zh?.direct?.buildPayload(article, 1)).toEqual({
      title: '从 demo 到生产的三道坎',
      body: article.body,
    });
    // 小红书:xhs_save_note_draft(title/body/tags 数组)
    const xhs = resolveArtifactDraft('xhs', 'note-package');
    expect(xhs?.direct?.platform).toBe('xhs');
    expect(xhs?.direct?.buildPayload(note, 0)).toEqual({
      title: '平价通勤穿搭合集',
      body: note.body,
      tags: ['通勤穿搭', '平价穿搭'],
    });
  });

  it('payload 不带任何指令性文本(纯数据,零模型参与);标题索引越界收敛', () => {
    const mp = resolveArtifactDraft('wechat_mp', 'article-package');
    const payload = mp?.direct?.buildPayload(article, 99);
    expect(payload?.title).toBe('从 demo 到生产的三道坎'); // 越界收敛到末位
    expect(mp?.direct?.buildPayload(article, -3).title).toBe('大模型落地:别再谈概念了');
    // 键集合固定,没有塞给模型的指令字段
    expect(Object.keys(payload || {}).sort()).toEqual(['digest', 'markdown', 'title']);
  });

  it('小红书 tags:截断到 10(工具 schema 上限的前置防线)', () => {
    const many: NotePackage = {
      ...note,
      tags: Array.from({ length: 14 }, (_, i) => `标签${i}`),
    };
    const xhs = resolveArtifactDraft('xhs', 'note-package');
    const tags = xhs?.direct?.buildPayload(many, 0).tags as string[];
    expect(tags).toHaveLength(10);
    expect(tags[0]).toBe('标签0');
  });

  it('confirmText(HIL 弹窗文案)点明直连语义/配额/人工发布边界', () => {
    const mp = resolveArtifactDraft('wechat_mp', 'article-package');
    const text = mp?.direct?.confirmText(article, 0) || '';
    expect(text).toContain('《大模型落地:别再谈概念了》');
    expect(text).toContain('直连投递');
    expect(text).toContain('不经过 AI 对话');
    expect(text).toContain('配额');
    expect(text).toContain('人工完成');

    const zh = resolveArtifactDraft('zhihu', 'article-package');
    expect(zh?.direct?.confirmText(article, 0)).toContain('知乎草稿');
    const xhs = resolveArtifactDraft('xhs', 'note-package');
    expect(xhs?.direct?.confirmText(note, 0)).toContain('小红书草稿');
  });

  it('续聊 build 路径保留(模型自主流程兜底 + 旧数据回放),与 direct 同源同参', () => {
    // direct 存在不意味着 build 作废:三工坊声明两者并存
    for (const [ws, kind] of [
      ['wechat_mp', 'article-package'],
      ['zhihu', 'article-package'],
      ['xhs', 'note-package'],
    ] as const) {
      const spec = resolveArtifactDraft(ws, kind);
      expect(spec?.direct).toBeDefined();
      expect(typeof spec?.build).toBe('function');
    }
    // build 仍产出内嵌全文的续聊指令(旧行为不变)
    expect(resolveArtifactDraft('wechat_mp', 'article-package')?.build(article, 0)).toContain(
      'wechat_mp_create_draft'
    );
  });
});
