/**
 * 模板引擎单测(Phase 3):语义以「false 块整行删除含换行」为核心契约,
 * 逐条钉死行边界行为——后续逐工坊迁移的逐字节保真全靠这些边界不漂。
 * 约定:测试模板字符串按 .md 文件惯例以单个换行结尾,输出不带尾换行。
 */
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../engine';

describe('renderTemplate · 变量插值', () => {
  it('基本替换', () => {
    expect(renderTemplate('你好 {{name}},今天是 {{day}}', { name: '阿紫', day: '周一' })).toBe('你好 阿紫,今天是 周一');
  });

  it('值为空串/null/undefined 渲染为空,不报错(键在即合法)', () => {
    expect(renderTemplate('A{{x}}B', { x: '' })).toBe('AB');
    expect(renderTemplate('A{{x}}B', { x: null })).toBe('AB');
    expect(renderTemplate('A{{x}}B', { x: undefined })).toBe('AB');
  });

  it('数字与布尔按 String() 规则', () => {
    expect(renderTemplate('{{n}}', { n: 12 })).toBe('12');
    expect(renderTemplate('{{b}}', { b: true })).toBe('true');
  });

  it('未知变量在 dev/test 抛错,不静默空串', () => {
    expect(() => renderTemplate('{{nope}}', {})).toThrow(/未提供的变量/);
    expect(() => renderTemplate('{{nope}}', { other: 'x' })).toThrow(/nope/);
  });

  it('花括号内容不合法直接抛错', () => {
    expect(() => renderTemplate('{{a b}}', {})).toThrow(/不合法/);
    expect(() => renderTemplate('{{# if x}}', {})).toThrow(/不合法/);
  });

  it('文件结尾单个尾换行被规范化:.md 惯例带尾行,输出不带', () => {
    expect(renderTemplate('A\nB\n', {})).toBe('A\nB');
    // 想要输出带尾换行:模板结尾留两个换行
    expect(renderTemplate('A\nB\n\n', {})).toBe('A\nB\n');
  });
});

describe('renderTemplate · 条件块行语义', () => {
  const T = 'A\n{{#if flag}}\nB\n{{/if}}\nC\n';

  it('真:指令行消隐,内容行保留,输出 A/B/C 三行', () => {
    expect(renderTemplate(T, { flag: true })).toBe('A\nB\nC');
  });

  it('假:整块连同行换行删除,不残留空行', () => {
    expect(renderTemplate(T, { flag: false })).toBe('A\nC');
  });

  it('键在但值为空串 → 走假分支', () => {
    expect(renderTemplate(T, { flag: '' })).toBe('A\nC');
  });

  it('#if 引用未知变量同样抛错', () => {
    expect(() => renderTemplate(T, {})).toThrow(/未提供的变量/);
  });

  it('多行内容原样保留', () => {
    expect(renderTemplate('A\n{{#if f}}\nB1\nB2\nB3\n{{/if}}\nC\n', { f: 1 })).toBe('A\nB1\nB2\nB3\nC');
  });

  it('块内 {{var}} 递归渲染', () => {
    const t = '{{#if profile}}\n档案:{{profile}}\n{{/if}}\n尾行\n';
    expect(renderTemplate(t, { profile: 'Go 后端' })).toBe('档案:Go 后端\n尾行');
    expect(renderTemplate(t, { profile: '' })).toBe('尾行');
  });

  it('块在文件开头', () => {
    expect(renderTemplate('{{#if f}}\nB\n{{/if}}\nC\n', { f: true })).toBe('B\nC');
    expect(renderTemplate('{{#if f}}\nB\n{{/if}}\nC\n', { f: false })).toBe('C');
  });

  it('块在文件结尾(模板无尾换行)', () => {
    expect(renderTemplate('A\n{{#if f}}\nB\n{{/if}}', { f: true })).toBe('A\nB');
    expect(renderTemplate('A\n{{#if f}}\nB\n{{/if}}', { f: false })).toBe('A\n');
  });

  it('块在文件结尾且模板带惯例尾换行:输出仍不带尾换行', () => {
    expect(renderTemplate('A\n{{#if f}}\nB\n{{/if}}\n', { f: true })).toBe('A\nB');
    expect(renderTemplate('A\n{{#if f}}\nB\n{{/if}}\n', { f: false })).toBe('A\n');
  });

  it('连续两块:前真后假互不干扰', () => {
    const t = '{{#if a}}\nX\n{{/if}}\n{{#if b}}\nY\n{{/if}}\nZ\n';
    expect(renderTemplate(t, { a: true, b: false })).toBe('X\nZ');
    expect(renderTemplate(t, { a: false, b: true })).toBe('Y\nZ');
  });

  it('内容渲染后为空(体内变量为空串)→ 整块仍消隐', () => {
    const t = 'A\n{{#if f}}\n{{x}}\n{{/if}}\nC\n';
    expect(renderTemplate(t, { f: true, x: '' })).toBe('A\nC');
  });
});

describe('renderTemplate · else 分支', () => {
  const T = 'A\n{{#if f}}\n真\n{{else}}\n假\n{{/if}}\nC\n';

  it('真分支', () => {
    expect(renderTemplate(T, { f: true })).toBe('A\n真\nC');
  });

  it('假分支', () => {
    expect(renderTemplate(T, { f: false })).toBe('A\n假\nC');
  });

  it('多行 else 分支', () => {
    const t = '{{#if f}}\nT1\nT2\n{{else}}\nF1\nF2\n{{/if}}\n';
    expect(renderTemplate(t, { f: 0 })).toBe('F1\nF2');
  });
});

describe('renderTemplate · 结构错误', () => {
  it('缺 {{/if}} 抛错', () => {
    expect(() => renderTemplate('{{#if f}}\nB\n', { f: true })).toThrow(/没有配对的/);
  });

  it('嵌套条件块抛错', () => {
    const t = '{{#if a}}\n{{#if b}}\nX\n{{/if}}\n{{/if}}\n';
    expect(() => renderTemplate(t, { a: true, b: true })).toThrow(/嵌套/);
  });

  it('指令不独占一行抛错', () => {
    expect(() => renderTemplate('前缀 {{#if f}}\nB\n{{/if}}\n', { f: true })).toThrow(/独占一行/);
    expect(() => renderTemplate('{{#if f}}\nB\n{{/if}} 尾缀\n', { f: true })).toThrow(/独占一行/);
    expect(() => renderTemplate('{{#if f}}\nB\n中途 {{else}}\nF\n{{/if}}\n', { f: true })).toThrow(/独占一行/);
  });

  it('多个 {{else}} 抛错', () => {
    const t = '{{#if f}}\nA\n{{else}}\nB\n{{else}}\nC\n{{/if}}\n';
    expect(() => renderTemplate(t, { f: true })).toThrow(/多个/);
  });
});
