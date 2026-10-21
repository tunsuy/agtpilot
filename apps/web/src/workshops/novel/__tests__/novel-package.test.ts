/**
 * novel-package 格式契约测试(docs/design/novel-workshop.md §4 + §9)
 *
 * 锁三件事:
 * 1. 开书包/续写包按 prompt 契约样例完整解析(六件套字段、反思五连字段);
 * 2. 坏输入诚实降级 null(缺锚段/正文过短/书号格式错),绝不半解析入库;
 * 3. 与笔记包/文章包双向互斥:【本章摘要】不命中【摘要】锚、【书名】不命中
 *    【标题】锚(novel 包不被别的解析器吃掉,别的包也不被 novel 吃掉)。
 */
import { describe, it, expect } from 'vitest';
import { parseNovelPackage, validateDeliverField, assembleNovelDelivery, extractDeliverBookId } from '../novel-package';
import { parseNotePackages } from '../../xhs/note-package';
import { parseArticlePackages } from '../../shared/article-package';

const BODY = '暴雨夜,林凡攥着手机在积水里狂奔,差评像追命的鼓点,一声声砸在他背上。'.repeat(8);

const GENESIS_FIXTURE = `【书名】
《铁拳少年》

【卖点】
外卖骑手捡到预知差评的手机,每躲开一单差评就变强。

【设定集】
世界观:近未来江城,灵气复苏初期。
力量体系:青铜→白银→黄金→宗师,严格逐级,不可跳级。
势力:骑手工会、差评教团。

【人物卡】
## 林凡
- 定位:主角
- 性格:隐忍、机灵
- 动机:还清家里的债
- 口癖:这单我接了
- 关系:与苏晚是合租室友
- 当前状态:右手骨折,欠债三万

## 苏晚
- 定位:女主
- 性格:毒舌心软
- 动机:查清父亲失踪真相
- 当前状态:刚以卧底身份入职差评教团

【作品简介】
外卖骑手林凡暴雨夜捡到一部能预知差评的神秘手机,每躲开一单差评就变强一分。差评教团的追杀、室友苏晚的卧底身份、手机裂纹背后的来历,全都指向一个更大的局。

【粗纲】
第一卷·崛起(1-30章):林凡获得手机,躲差评变强,卷入教团阴谋。
第二卷·白银(31-80章):正面抗衡教团,揭开苏晚父亲失踪案。

【细纲】
### 第1章 雨夜差评
- 钩子:暴雨夜,林凡接到一个送不到的订单
- 事件:捡到预知手机,躲开第一单差评
- 情绪点:憋屈后第一次爽
- 伏笔:埋手机屏裂纹
- 字数:3000

### 第2章 室友
- 钩子:回家发现新室友是苏晚
- 事件:两人冲突又和解,林凡露了一手
- 情绪点:轻喜剧
- 字数:3000

【伏笔】
- [埋设] 手机屏幕裂纹的来历 @第1章
- [埋设] 苏晚父亲失踪与教团有关 @第2章

【时间线】
- 第1章|周五雨夜|林凡捡到手机
- 第2章|周六|苏晚搬入合租

【第1章 雨夜差评】
雨夜差评
${BODY}

【本章摘要】
林凡在暴雨夜送单,捡到一部能预知差评的手机,躲开第一单差评后右手骨折处开始自愈。

【第2章 室友】
室友
${BODY}

【本章摘要】
林凡回家发现新室友苏晚,两人因误会冲突,林凡展露身手,苏晚注意到他的异常。`;

const CONTINUE_FIXTURE = `【书号】
nv_m3k9x2_a1b2c3

【第3章 夜袭】
夜袭
${BODY}

【本章摘要】
林凡夜探仓库,在货架深处发现教团徽记,手机屏幕裂纹与徽记同时发烫。

【人物状态更新】
- 林凡:右手痊愈,晋升白银
- 王五:身份暴露,被教团盯上

【伏笔动作】
- [埋设] 仓库背后的老板 @第3章
- [回收] 手机屏幕裂纹 (方式:裂纹中浮现教团徽记)

【时间线】
- 第3章|周日凌晨|夜探仓库

【下章细纲】
### 第8章 对决
- 事件:林凡与教团执事正面对决
- 钩子:执事竟认识苏晚

【总纲更新】
林凡从躲避差评转为主动出击,与教团的冲突公开化。`;

describe('parseNovelPackage · 开书包', () => {
  it('契约样例完整解析:书名/卖点/设定集/人物卡/粗纲/细纲/伏笔/时间线/两章正文+摘要', () => {
    const pkg = parseNovelPackage(GENESIS_FIXTURE);
    expect(pkg).not.toBeNull();
    expect(pkg!.kind).toBe('genesis');
    if (pkg!.kind !== 'genesis') return;
    expect(pkg!.title).toBe('铁拳少年');
    expect(pkg!.premise).toContain('预知差评的手机');
    expect(pkg!.bible).toContain('不可跳级');
    expect(pkg!.outline).toContain('第二卷');
    expect(pkg!.synopsis).toContain('预知差评的神秘手机');

    expect(pkg!.characters).toHaveLength(2);
    const lin = pkg!.characters[0];
    expect(lin).toMatchObject({
      name: '林凡',
      role: '主角',
      personality: '隐忍、机灵',
      motivation: '还清家里的债',
      speech: '这单我接了',
      relations: '与苏晚是合租室友',
      currentState: '右手骨折,欠债三万',
    });
    expect(pkg!.characters[1].name).toBe('苏晚');

    expect(pkg!.detailed).toHaveLength(2);
    expect(pkg!.detailed[0]).toMatchObject({
      index: 1,
      title: '雨夜差评',
      hook: '暴雨夜,林凡接到一个送不到的订单',
      events: '捡到预知手机,躲开第一单差评',
      emotion: '憋屈后第一次爽',
      foreshadow: '埋手机屏裂纹',
      targetWords: 3000,
    });

    expect(pkg!.ledgerSeeds).toEqual([
      { content: '手机屏幕裂纹的来历', plantedChapter: 1 },
      { content: '苏晚父亲失踪与教团有关', plantedChapter: 2 },
    ]);
    expect(pkg!.timelineSeeds).toEqual([
      '第1章|周五雨夜|林凡捡到手机',
      '第2章|周六|苏晚搬入合租',
    ]);

    expect(pkg!.chapters).toHaveLength(2);
    expect(pkg!.chapters[0].title).toBe('雨夜差评');
    expect(pkg!.chapters[0].content.replace(/\s/g, '').length).toBeGreaterThanOrEqual(200);
    expect(pkg!.chapters[0].summary).toContain('开始自愈');
    expect(pkg!.chapters[1].summary).toContain('注意到他的异常');
  });

  it('寒暄行丢弃:首个字段头之前的文本不进任何段', () => {
    const pkg = parseNovelPackage('好的,以下是开书结果:\n\n' + GENESIS_FIXTURE);
    expect(pkg!.kind).toBe('genesis');
    if (pkg!.kind === 'genesis') expect(pkg!.bible).not.toContain('好的');
  });

  it('缺锚降级:没有【粗纲】不是开书包;章正文过短(<200字)不算有效章', () => {
    // 注意不能替换成「大纲草稿」——【粗纲|大纲】锚允许行内后缀,「大纲草稿」仍会命中
    const noOutline = GENESIS_FIXTURE.replace('【粗纲】', '【主线走向】');
    expect(parseNovelPackage(noOutline)).toBeNull();
    const thinChapter = GENESIS_FIXTURE.replace(new RegExp(BODY, 'g'), '太短了。');
    expect(parseNovelPackage(thinChapter)).toBeNull();
  });
});

describe('parseNovelPackage · 续写包', () => {
  it('契约样例完整解析:书号/自称序号/正文/摘要/反思五连字段', () => {
    const pkg = parseNovelPackage(CONTINUE_FIXTURE);
    expect(pkg).not.toBeNull();
    expect(pkg!.kind).toBe('continue');
    if (pkg!.kind !== 'continue') return;
    expect(pkg!.bookId).toBe('nv_m3k9x2_a1b2c3');
    expect(pkg!.claimedIndex).toBe(3);
    expect(pkg!.title).toBe('夜袭');
    expect(pkg!.summary).toContain('教团徽记');
    expect(pkg!.characterUpdates).toEqual([
      { name: '林凡', currentState: '右手痊愈,晋升白银' },
      { name: '王五', currentState: '身份暴露,被教团盯上' },
    ]);
    expect(pkg!.ledgerActions).toEqual([
      { action: 'plant', content: '仓库背后的老板' },
      { action: 'pay', keyword: '手机屏幕裂纹', payMethod: '裂纹中浮现教团徽记' },
    ]);
    expect(pkg!.timelineAppend).toEqual(['第3章|周日凌晨|夜探仓库']);
    expect(pkg!.detailedAppend).toEqual([
      { index: 8, title: '对决', events: '林凡与教团执事正面对决', hook: '执事竟认识苏晚' },
    ]);
    expect(pkg!.volumeSummary).toContain('主动出击');
  });

  it('「无」占位段:人物状态更新/伏笔动作写「无」解析为空数组,不产生脏条目', () => {
    const pkg = parseNovelPackage(CONTINUE_FIXTURE.replace(/- 林凡:右手痊愈,晋升白银\n- 王五:身份暴露,被教团盯上/, '无'));
    if (pkg!.kind === 'continue') expect(pkg!.characterUpdates).toEqual([]);
  });

  it('锚不吃尾缀变体:【伏笔动作】不被【伏笔】锚吞掉(贪婪尾缀回归),【伏笔台账】仍归 ledger', () => {
    // 开书契约里【伏笔】允许行尾追加说明(如【伏笔台账】),但【伏笔动作】是续写契约的独立段
    const genesisLedgerVariant = parseNovelPackage(GENESIS_FIXTURE.replace('【伏笔】', '【伏笔台账】'));
    expect(genesisLedgerVariant!.kind).toBe('genesis');
    if (genesisLedgerVariant!.kind === 'genesis') {
      expect(genesisLedgerVariant!.ledgerSeeds).toHaveLength(2);
    }
    const mixed = parseNovelPackage(
      CONTINUE_FIXTURE.replace('【伏笔动作】', '【伏笔】\n- [埋设] 不该被当动作的行\n\n【伏笔动作】')
    );
    expect(mixed).not.toBeNull();
    if (mixed!.kind === 'continue') {
      // 混入的【伏笔】段不污染 ledgerActions;【伏笔动作】段照常解析
      expect(mixed!.ledgerActions).toEqual([
        { action: 'plant', content: '仓库背后的老板' },
        { action: 'pay', keyword: '手机屏幕裂纹', payMethod: '裂纹中浮现教团徽记' },
      ]);
    }
  });

  it('坏输入诚实降级 null:书号格式错/缺本章摘要/正文过短', () => {
    expect(parseNovelPackage(CONTINUE_FIXTURE.replace('nv_m3k9x2_a1b2c3', 'book-123'))).toBeNull();
    expect(parseNovelPackage(CONTINUE_FIXTURE.replace('【本章摘要】', '【摘要】'))).toBeNull();
    expect(parseNovelPackage(CONTINUE_FIXTURE.replace(BODY, '短。'))).toBeNull();
    expect(parseNovelPackage('')).toBeNull();
    expect(parseNovelPackage('随便一段没有任何字段头的文本')).toBeNull();
  });
});

describe('parseNovelPackage · 序章包(写第 1 章前的楔子)', () => {
  const PROLOGUE_FIXTURE = `【书号】
nv_m3k9x2_a1b2c3

【楔子 · 雨夜】
${BODY}

【序章摘要】
暴雨夜神秘人捡走残破手机,镜头停在裂纹深处的徽记,与第 1 章的雨夜呼应。`;

  it('完整解析:书号 + 段头余文当标题 + 正文 + 序章摘要', () => {
    const pkg = parseNovelPackage(PROLOGUE_FIXTURE);
    expect(pkg).not.toBeNull();
    expect(pkg!.kind).toBe('prologue');
    if (pkg!.kind !== 'prologue') return;
    expect(pkg!.bookId).toBe('nv_m3k9x2_a1b2c3');
    expect(pkg!.title).toBe('楔子 · 雨夜');
    expect(pkg!.content.replace(/\s/g, '').length).toBeGreaterThanOrEqual(200);
    expect(pkg!.summary).toContain('徽记');
  });

  it('段头别名:【序章】/【前言】同样命中;无余文时标题缺省「序章」', () => {
    for (const head of ['序章', '前言']) {
      const pkg = parseNovelPackage(PROLOGUE_FIXTURE.replace('【楔子 · 雨夜】', `【${head}】`));
      expect(pkg!.kind).toBe('prologue');
      if (pkg!.kind === 'prologue') expect(pkg!.title).toBe(head);
    }
    // 空标题走「序章」缺省:正文首行是长句(不满足短行标题判定)时 title 兜底
    const bare = parseNovelPackage(PROLOGUE_FIXTURE.replace('【楔子 · 雨夜】', '【序章】'));
    if (bare!.kind === 'prologue') expect(bare!.title).toBe('序章');
  });

  it('与续写包互斥:【序章摘要】≠【本章摘要】,序章头配本章摘要仍按 continue 语义拒绝', () => {
    // 序章包写错摘要头(【本章摘要】):无 prologueSummary 锚,序章段也非章段 → 降级 null
    expect(parseNovelPackage(PROLOGUE_FIXTURE.replace('【序章摘要】', '【本章摘要】'))).toBeNull();
    // 续写包混入序章头:仍解析为 continue(章段优先,序章头不影响判定)
    const mixed = parseNovelPackage(`【书号】\nnv_m3k9x2_a1b2c3\n\n【楔子 · 雨夜】\n${BODY}\n\n【序章摘要】\n楔子摘要。\n\n【第3章 夜袭】\n${BODY}\n\n【本章摘要】\n夜探仓库。`);
    expect(mixed!.kind).toBe('continue');
  });

  it('坏输入诚实降级 null:书号格式错/缺序章摘要/正文过短', () => {
    expect(parseNovelPackage(PROLOGUE_FIXTURE.replace('nv_m3k9x2_a1b2c3', 'book-123'))).toBeNull();
    expect(parseNovelPackage(PROLOGUE_FIXTURE.replace('【序章摘要】', '【摘要】'))).toBeNull();
    expect(parseNovelPackage(PROLOGUE_FIXTURE.replace(BODY, '短。'))).toBeNull();
  });
});

describe('parseNovelPackage · 文风锚包(P2 文风学习)', () => {
  const STYLE_TEXT =
    '第一人称冷叙述,段落平均不超过三行。动作戏白描,不堆形容词,打斗用短句快速切换。对白占比高,人物口吻区分明显:主角惜字如金,女主毒舌爱反问。情绪爽点直给,铺垫不超过半章,每章结尾留钩子。氛围重视觉与听觉,环境描写服务于事件铺垫而非抒情。';
  const STYLE_FIXTURE = `【书号】
nv_m3k9x2_a1b2c3

【文风锚】
${STYLE_TEXT}`;

  it('绑书样例完整解析:书号 + 文风锚全文', () => {
    const pkg = parseNovelPackage(STYLE_FIXTURE);
    expect(pkg).not.toBeNull();
    expect(pkg!.kind).toBe('style');
    if (pkg!.kind !== 'style') return;
    expect(pkg!.bookId).toBe('nv_m3k9x2_a1b2c3');
    expect(pkg!.style).toContain('第一人称冷叙述');
    expect(pkg!.style).toContain('环境描写服务于事件铺垫而非抒情');
  });

  it('未绑书:无【书号】段,bookId 为 null(锚留作开书用)', () => {
    const pkg = parseNovelPackage(`【文风锚】\n${STYLE_TEXT}`);
    expect(pkg!.kind).toBe('style');
    if (pkg!.kind === 'style') expect(pkg!.bookId).toBeNull();
  });

  it('书号格式错:诚实降级为未绑定文风锚(不当续写包也不整包拒收)', () => {
    const pkg = parseNovelPackage(STYLE_FIXTURE.replace('nv_m3k9x2_a1b2c3', 'book-123'));
    expect(pkg!.kind).toBe('style');
    if (pkg!.kind === 'style') expect(pkg!.bookId).toBeNull();
  });

  it('文风锚过短(<30 有效字):诚实降级 null(半截输出不入库)', () => {
    expect(parseNovelPackage('【文风锚】\n太短了。')).toBeNull();
    expect(parseNovelPackage('【书号】\nnv_m3k9x2_a1b2c3\n\n【文风锚】\n   ')).toBeNull();
  });

  it('文风锚包与笔记包/文章包双向互斥;开书/续写样例不被当文风锚包', () => {
    expect(parseNotePackages(STYLE_FIXTURE).packages).toEqual([]);
    expect(parseArticlePackages(STYLE_FIXTURE).packages).toEqual([]);
    expect(parseNovelPackage(GENESIS_FIXTURE)!.kind).toBe('genesis');
    expect(parseNovelPackage(CONTINUE_FIXTURE)!.kind).toBe('continue');
  });
});

describe('parseNovelPackage · 设定包(开书三段化第一步)', () => {
  const BIBLE_FIXTURE = `【题材】
都市异能

【文风锚】
爽文快节奏:短段落、强钩子、三章一小爽五章一大爽

【每章字数】
3000

【书名】
铁拳少年

【卖点】
外卖骑手捡到预知差评的手机,每躲开一单差评就变强。

【设定集】
世界观:近未来江城,灵气复苏初期。
力量体系:青铜→白银→黄金→宗师,严格逐级,不可跳级。

【人物卡】
## 林凡
- 定位:主角
- 性格:隐忍、机灵
- 动机:还清家里的债
- 口癖:这单我接了

## 苏晚
- 定位:女主
- 性格:毒舌心软
- 动机:查清父亲失踪真相

【作品简介】
外卖骑手林凡捡到一部能预知差评的神秘手机,每躲开一单差评就变强一分。差评教团的追杀、室友苏晚的卧底身份,全都指向一个更大的局。`;

  it('契约样例完整解析:回显段(题材/文风锚/每章字数)+ 书名/卖点/设定集/人物卡/作品简介,无章正文', () => {
    const pkg = parseNovelPackage(BIBLE_FIXTURE);
    expect(pkg).not.toBeNull();
    expect(pkg!.kind).toBe('genesis_bible');
    if (pkg!.kind !== 'genesis_bible') return;
    expect(pkg!.title).toBe('铁拳少年');
    expect(pkg!.premise).toContain('预知差评的手机');
    expect(pkg!.bible).toContain('不可跳级');
    expect(pkg!.characters).toHaveLength(2);
    expect(pkg!.characters[0].name).toBe('林凡');
    expect(pkg!.characters[1].speech).toBeUndefined();
    expect(pkg!.genre).toBe('都市异能');
    expect(pkg!.style).toContain('三章一小爽五章一大爽');
    expect(pkg!.chapterWords).toBe(3000);
    expect(pkg!.synopsis).toContain('预知差评的神秘手机');
  });

  it('模型漏回显段:回显字段缺省(undefined),主锚(设定集+人物卡)仍解析', () => {
    const pkg = parseNovelPackage(
      BIBLE_FIXTURE
        .replace('【题材】\n都市异能\n\n', '')
        .replace('【每章字数】\n3000\n\n', '')
        .replace(/\n\n【作品简介】[\s\S]*$/, '\n')
    );
    expect(pkg!.kind).toBe('genesis_bible');
    if (pkg!.kind !== 'genesis_bible') return;
    expect(pkg!.genre).toBeUndefined();
    expect(pkg!.chapterWords).toBeUndefined();
    expect(pkg!.synopsis).toBeUndefined();
    expect(pkg!.bible).toContain('不可跳级');
  });

  it('【作品简介】只匹配全称:【项目简介】等变体头不落 synopsis 段(不误吞他包字段头)', () => {
    const pkg = parseNovelPackage(BIBLE_FIXTURE.replace('【作品简介】', '【项目简介】'));
    expect(pkg!.kind).toBe('genesis_bible');
    if (pkg!.kind !== 'genesis_bible') return;
    expect(pkg!.synopsis).toBeUndefined();
  });

  it('与文风锚包互斥:回显的【文风锚】不吞设定包(有设定集/人物卡就不是文风锚包)', () => {
    const pkg = parseNovelPackage(BIBLE_FIXTURE);
    expect(pkg!.kind).toBe('genesis_bible');
    expect(parseNotePackages(BIBLE_FIXTURE).packages).toEqual([]);
    expect(parseArticlePackages(BIBLE_FIXTURE).packages).toEqual([]);
  });
});

describe('parseNovelPackage · 大纲包(开书三段化第二步)', () => {
  const OUTLINE_FIXTURE = `【书号】
nv_m3k9x2_a1b2c3

【粗纲】
第一卷·崛起(1-30章):林凡获得手机,躲差评变强,卷入教团阴谋。
第二卷·白银(31-80章):正面抗衡教团,揭开苏晚父亲失踪案。

【细纲】
### 第1章 雨夜差评
- 钩子:暴雨夜,林凡接到一个送不到的订单
- 事件:捡到预知手机,躲开第一单差评
- 情绪点:憋屈后第一次爽
- 伏笔:埋手机屏裂纹
- 字数:3000

### 第2章 室友
- 钩子:回家发现新室友是苏晚
- 事件:两人冲突又和解

【伏笔】
- [埋设] 手机屏幕裂纹的来历 @第1章
- [埋设] 苏晚父亲失踪与教团有关 @第2章

【时间线】
- 第1章|周五雨夜|林凡捡到手机
- 第2章|周六|苏晚搬入合租`;

  it('契约样例完整解析:书号回显 + 粗纲/细纲/伏笔/时间线,无设定集无章正文', () => {
    const pkg = parseNovelPackage(OUTLINE_FIXTURE);
    expect(pkg).not.toBeNull();
    expect(pkg!.kind).toBe('genesis_outline');
    if (pkg!.kind !== 'genesis_outline') return;
    expect(pkg!.bookId).toBe('nv_m3k9x2_a1b2c3');
    expect(pkg!.outline).toContain('第一卷·崛起');
    expect(pkg!.detailed).toHaveLength(2);
    expect(pkg!.detailed[0].index).toBe(1);
    expect(pkg!.detailed[0].hook).toContain('送不到的订单');
    expect(pkg!.detailed[0].targetWords).toBe(3000);
    expect(pkg!.ledgerSeeds).toHaveLength(2);
    expect(pkg!.ledgerSeeds[0].plantedChapter).toBe(1);
    expect(pkg!.timelineSeeds).toHaveLength(2);
  });

  it('漏回显书号:bookId 为空串(卡片给下拉指认,不猜)', () => {
    const pkg = parseNovelPackage(OUTLINE_FIXTURE.replace('【书号】\nnv_m3k9x2_a1b2c3\n\n', ''));
    expect(pkg!.kind).toBe('genesis_outline');
    if (pkg!.kind !== 'genesis_outline') return;
    expect(pkg!.bookId).toBe('');
    expect(pkg!.outline).toContain('第一卷·崛起');
  });

  it('与笔记包/文章包互斥,不当续写包(无【本章摘要】无章正文)', () => {
    const pkg = parseNovelPackage(OUTLINE_FIXTURE);
    expect(pkg!.kind).toBe('genesis_outline');
    expect(parseNotePackages(OUTLINE_FIXTURE).packages).toEqual([]);
    expect(parseArticlePackages(OUTLINE_FIXTURE).packages).toEqual([]);
  });
});

describe('格式互斥 · 与笔记包/文章包双向不碰撞', () => {
  const NOTE_FIXTURE = `【标题候选】
1. 秋冬通勤穿搭三件套
2. 一周通勤不重样

【封面文案】
通勤穿搭天花板

【正文】
${BODY}

【标签】
#穿搭 #通勤

---
`;
  const ARTICLE_FIXTURE = `【标题候选】
1. AI 编程工具横评

【摘要】
本文横评五款 AI 编程工具。

【正文】
${BODY}

【封面建议】
工具矩阵图

---
`;

  it('笔记包/文章包样例不被 novel 解析器误吃', () => {
    expect(parseNovelPackage(NOTE_FIXTURE)).toBeNull();
    expect(parseNovelPackage(ARTICLE_FIXTURE)).toBeNull();
  });

  it('novel 开书包/续写包不被笔记包、文章包解析器误吃(【书名】≠【标题】,【本章摘要】≠【摘要】)', () => {
    expect(parseNotePackages(GENESIS_FIXTURE).packages).toEqual([]);
    expect(parseArticlePackages(GENESIS_FIXTURE).packages).toEqual([]);
    expect(parseNotePackages(CONTINUE_FIXTURE).packages).toEqual([]);
    expect(parseArticlePackages(CONTINUE_FIXTURE).packages).toEqual([]);
  });

  it('对照:文章包样例仍被文章包解析器命中(证明上面的空结果不是解析器全盲)', () => {
    expect(parseArticlePackages(ARTICLE_FIXTURE).packages.length).toBeGreaterThan(0);
    expect(parseNotePackages(NOTE_FIXTURE).packages.length).toBeGreaterThan(0);
  });
});

// ---- 逐字段交付:单字段校验 + 已交付字段组包(计划「novel 工坊逐字段交付」) ----

const FOUR_CARDS = ['林凡', '苏晚', '陈默', '赵烈']
  .map(
    (n) => `## ${n}
- 定位:主角
- 性格:隐忍
- 动机:还清债
- 口癖:接了
- 关系:室友
- 弧光:成长`
  )
  .join('\n\n');

const DETAILED = [1, 2, 3, 4, 5]
  .map(
    (n) => `### 第${n}章 标题${n}
- 钩子:开场钩子
- 事件:本章主要事件描述,推进主线冲突。
- 情绪点:爽点
- 伏笔:无
- 字数:3000`
  )
  .join('\n\n');

describe('validateDeliverField · novel_bible', () => {
  it('合格内容通过(空错误清单)', () => {
    expect(validateDeliverField('novel_bible', '书名', '铁拳少年')).toEqual([]);
    expect(validateDeliverField('novel_bible', '卖点', '外卖骑手捡到预知差评的手机,越躲越强')).toEqual([]);
    expect(validateDeliverField('novel_bible', '设定集', '世界观:近未来江城。'.repeat(15))).toEqual([]);
    expect(validateDeliverField('novel_bible', '人物卡', FOUR_CARDS)).toEqual([]);
    expect(validateDeliverField('novel_bible', '题材', '都市')).toEqual([]);
    expect(validateDeliverField('novel_bible', '文风锚', '爽文快节奏:短段落强钩子')).toEqual([]);
    expect(validateDeliverField('novel_bible', '每章字数', '3000')).toEqual([]);
    const synopsis = '外卖骑手林凡捡到一部能预知差评的神秘手机,每躲开一单差评就变强一分。'.repeat(3);
    expect(validateDeliverField('novel_bible', '作品简介', synopsis)).toEqual([]);
  });

  it('结构/篇幅不合格给可执行错误(非空)', () => {
    expect(validateDeliverField('novel_bible', '书名', '').length).toBeGreaterThan(0);
    expect(validateDeliverField('novel_bible', '书名', '候选一\n候选二\n候选三').length).toBeGreaterThan(0); // 多行=候选清单
    expect(validateDeliverField('novel_bible', '设定集', '太短').length).toBeGreaterThan(0);
    expect(validateDeliverField('novel_bible', '人物卡', '## 林凡\n- 定位:主角').length).toBeGreaterThan(0); // 不足 4 张
    expect(validateDeliverField('novel_bible', '每章字数', '300').length).toBeGreaterThan(0); // 域外
    expect(validateDeliverField('novel_bible', '作品简介', '一句话太短').length).toBeGreaterThan(0); // < 50
    expect(validateDeliverField('novel_bible', '作品简介', '简介段落。'.repeat(300)).length).toBeGreaterThan(0); // > 500
  });

  it('content 首行误带【字段头】先剥掉再校验', () => {
    expect(validateDeliverField('novel_bible', '书名', '【书名】\n铁拳少年')).toEqual([]);
  });

  it('未知字段/契约给错误(不静默通过)', () => {
    expect(validateDeliverField('novel_bible', '不存在字段', 'x').length).toBeGreaterThan(0);
    expect(validateDeliverField('未知契约', '书名', 'x').length).toBeGreaterThan(0);
  });
});

describe('validateDeliverField · novel_outline', () => {
  it('合格内容通过', () => {
    expect(validateDeliverField('novel_outline', '书号', 'nv_test01_a1b2c3')).toEqual([]);
    expect(validateDeliverField('novel_outline', '粗纲', '起承转合主线规划。'.repeat(40))).toEqual([]);
    expect(validateDeliverField('novel_outline', '细纲', DETAILED)).toEqual([]);
    expect(validateDeliverField('novel_outline', '伏笔', '无')).toEqual([]);
    expect(validateDeliverField('novel_outline', '伏笔', '- [埋设] 手机裂纹来历 @第1章')).toEqual([]);
    expect(validateDeliverField('novel_outline', '时间线', '- 第1章|雨夜|捡到手机')).toEqual([]);
  });

  it('书号格式错/粗纲过短/细纲不足给错误', () => {
    expect(validateDeliverField('novel_outline', '书号', '随便写的').length).toBeGreaterThan(0);
    expect(validateDeliverField('novel_outline', '粗纲', '太短').length).toBeGreaterThan(0);
    expect(validateDeliverField('novel_outline', '细纲', '### 第1章\n- 事件:x').length).toBeGreaterThan(0);
  });
});

describe('extractDeliverBookId', () => {
  it('剥字段头取首行归一化 bookId', () => {
    expect(extractDeliverBookId('nv_test01_a1b2c3')).toBe('nv_test01_a1b2c3');
    expect(extractDeliverBookId('【书号】\nnv_test01_a1b2c3\n多余行')).toBe('nv_test01_a1b2c3');
  });
});

describe('assembleNovelDelivery', () => {
  it('novel_bible 已交付字段 → genesis_bible 包(与整包解析同结构口径)', () => {
    const pkg = assembleNovelDelivery('novel_bible', {
      书名: '铁拳少年',
      卖点: '外卖骑手捡到预知差评的手机',
      设定集: '世界观:近未来江城。力量体系:青铜→白银→黄金。'.repeat(3),
      人物卡: FOUR_CARDS,
      作品简介: '外卖骑手林凡捡到预知差评的神秘手机,躲差评变强,卷入教团阴谋,室友身份成谜。',
      题材: '都市',
      文风锚: '爽文快节奏:短段落强钩子',
      每章字数: '3000',
    });
    expect(pkg).not.toBeNull();
    expect(pkg!.kind).toBe('genesis_bible');
    if (pkg!.kind === 'genesis_bible') {
      expect(pkg!.title).toBe('铁拳少年');
      expect(pkg!.characters.length).toBe(4);
      expect(pkg!.genre).toBe('都市');
      expect(pkg!.chapterWords).toBe(3000);
      expect(pkg!.synopsis).toContain('预知差评的神秘手机');
    }
  });

  it('novel_outline 已交付字段 → genesis_outline 包;书号格式非法则空', () => {
    const pkg = assembleNovelDelivery('novel_outline', {
      书号: 'nv_test01_a1b2c3',
      粗纲: '起承转合主线规划。'.repeat(40),
      细纲: DETAILED,
      伏笔: '- [埋设] 手机裂纹来历 @第1章',
      时间线: '- 第1章|雨夜|捡到手机',
    });
    expect(pkg).not.toBeNull();
    expect(pkg!.kind).toBe('genesis_outline');
    if (pkg!.kind === 'genesis_outline') {
      expect(pkg!.bookId).toBe('nv_test01_a1b2c3');
      expect(pkg!.detailed.length).toBe(5);
      expect(pkg!.ledgerSeeds.length).toBe(1);
    }
    const bad = assembleNovelDelivery('novel_outline', { 书号: '乱写', 粗纲: 'x'.repeat(400), 细纲: DETAILED });
    if (bad && bad.kind === 'genesis_outline') expect(bad.bookId).toBe('');
  });

  it('未知契约返回 null', () => {
    expect(assembleNovelDelivery('不存在', {})).toBeNull();
  });
});
