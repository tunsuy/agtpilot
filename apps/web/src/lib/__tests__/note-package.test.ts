import { describe, it, expect } from 'vitest';
import { parseNotePackages, buildNotePackageCopyText } from '../note-package';

const LONG_BODY = '这篇正文要超过五十字才能被判定为有效笔记包,所以这里写得长一点。'.repeat(3);

const singlePackage = `【标题候选】
1. 平价通勤穿搭合集
2. 打工人早八三分钟出门
3. 通勤ootd这样穿
【封面文案】
3 件单品穿一周
【正文】
${LONG_BODY}
【标签】
#通勤穿搭 #平价穿搭 #ootd
【发布建议】
工作日早 7-9 点,通勤类内容浏览高峰`;

describe('parseNotePackages · 标准格式', () => {
  it('单篇全字段解析:标题去序号、标签去#、正文完整', () => {
    const { packages, fallback } = parseNotePackages(singlePackage);
    expect(fallback).toBeNull();
    expect(packages).toHaveLength(1);
    const pkg = packages[0];
    expect(pkg.index).toBe(1);
    expect(pkg.titles).toEqual(['平价通勤穿搭合集', '打工人早八三分钟出门', '通勤ootd这样穿']);
    expect(pkg.coverCopy).toBe('3 件单品穿一周');
    expect(pkg.body).toContain(LONG_BODY);
    expect(pkg.tags).toEqual(['通勤穿搭', '平价穿搭', 'ootd']);
    expect(pkg.publishAdvice).toContain('工作日早 7-9 点');
  });

  it('三篇以 --- 分隔,篇号递增', () => {
    const text = [singlePackage, singlePackage, singlePackage].join('\n---\n');
    const { packages, fallback } = parseNotePackages(text);
    expect(fallback).toBeNull();
    expect(packages.map((p) => p.index)).toEqual([1, 2, 3]);
  });

  it('开头寒暄归 fallback;结尾提醒(无分隔符)并入发布建议,不丢内容', () => {
    const text = `好的,以下是为你准备的笔记:\n${singlePackage}\n复制满意的一篇后到手机发布~`;
    const { packages, fallback } = parseNotePackages(text);
    expect(packages).toHaveLength(1);
    expect(fallback).toBe('好的,以下是为你准备的笔记:');
    expect(packages[0].publishAdvice).toContain('工作日早 7-9 点');
    expect(packages[0].publishAdvice).toContain('复制满意的一篇后到手机发布');
  });

  it('寒暄独立成块(有 --- 分隔)时干净归 fallback', () => {
    const text = `好的,以下是为你准备的笔记:\n---\n${singlePackage}`;
    const { packages, fallback } = parseNotePackages(text);
    expect(packages).toHaveLength(1);
    expect(fallback).toBe('好的,以下是为你准备的笔记:');
  });
});

describe('parseNotePackages · 容错', () => {
  it('字段头变体:【标题】【封面建议】【发布提示】均能识别', () => {
    const variant = `【标题】
1. 变体标题
【封面建议】
封面一句话
【正文】
${LONG_BODY}
【发布提示】
周五晚发布`;
    const { packages } = parseNotePackages(variant);
    expect(packages).toHaveLength(1);
    expect(packages[0].titles).toEqual(['变体标题']);
    expect(packages[0].coverCopy).toBe('封面一句话');
    expect(packages[0].publishAdvice).toBe('周五晚发布');
  });

  it('标题行支持 1、xxx 与 - xxx 与裸行', () => {
    const variant = `【标题候选】
1、顿号标题
- 短横标题
裸行标题
【正文】
${LONG_BODY}
【标签】
#a #b #c`;
    const { packages } = parseNotePackages(variant);
    expect(packages[0].titles).toEqual(['顿号标题', '短横标题', '裸行标题']);
  });

  it('标签字段为空时从正文兜底提取并去重', () => {
    const variant = `【标题候选】
标题
【封面文案】
封面
【正文】
${LONG_BODY} #正文标签 #正文标签
【标签】
`;
    const { packages } = parseNotePackages(variant);
    expect(packages[0].tags).toEqual(['正文标签']);
  });

  it('缺正文的块整体进 fallback(不成笔记包)', () => {
    const text = `【标题候选】
只有标题没有正文
【标签】
#a #b #c
---
${singlePackage}`;
    const { packages, fallback } = parseNotePackages(text);
    expect(packages).toHaveLength(1);
    expect(fallback).toContain('只有标题没有正文');
  });

  it('纯自由文本(无字段头)→ packages 为空、fallback 全文(调用方降级)', () => {
    const text = '今天聊一下怎么选羽绒服,首先要看充绒量……' + '一些没有结构的长文本。'.repeat(10);
    const { packages, fallback } = parseNotePackages(text);
    expect(packages).toHaveLength(0);
    expect(fallback).toBe(text.trim());
  });

  it('正文不足 50 字的块不成笔记包', () => {
    const short = `【标题候选】
标题
【封面文案】
封面
【正文】
太短了
【标签】
#a #b #c
【发布建议】
随时`;
    const { packages, fallback } = parseNotePackages(short);
    expect(packages).toHaveLength(0);
    expect(fallback).not.toBeNull();
  });

  it('空文本返回空结果', () => {
    expect(parseNotePackages('')).toEqual({ packages: [], fallback: null });
    expect(parseNotePackages('   \n  ')).toEqual({ packages: [], fallback: null });
  });
});

describe('buildNotePackageCopyText', () => {
  const pkg = parseNotePackages(singlePackage).packages[0];

  it('默认取第一个标题,按 标题-正文-标签 顺序两空行分隔', () => {
    const text = buildNotePackageCopyText(pkg);
    expect(text).toBe(`平价通勤穿搭合集\n\n${LONG_BODY}\n\n#通勤穿搭 #平价穿搭 #ootd`);
  });

  it('可指定标题索引', () => {
    expect(buildNotePackageCopyText(pkg, 1).startsWith('打工人早八三分钟出门')).toBe(true);
  });

  it('索引越界回落到末位标题', () => {
    expect(buildNotePackageCopyText(pkg, 99).startsWith('通勤ootd这样穿')).toBe(true);
  });
});
