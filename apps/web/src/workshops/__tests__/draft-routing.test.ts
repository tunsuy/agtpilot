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
    expect(text).toContain('纯文本填入');
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
