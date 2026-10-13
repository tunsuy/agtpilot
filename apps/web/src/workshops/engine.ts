/**
 * 工坊提示词模板引擎(Phase 3)
 *
 * 语法刻意极简,只覆盖工坊提示词实际需要的两类结构:
 * - `{{var}}`                       变量插值(值为 falsy 时渲染空串)
 * - `{{#if var}}…{{else}}…{{/if}}`  条件块,指令必须独占一行,不支持嵌套
 *
 * 条件块语义(「false 块整行删除含换行」):
 *   A
 *   {{#if profile}}
 *   B
 *   {{/if}}
 *   C
 * profile 为真 → 输出 A/B/C 三行;为假 → B 所在行连同两条指令行整段消失,
 * 输出 A/C 两行、不残留空行——与 context.ts 字符串拼接的省略语义逐字节对齐。
 * 指令行自身(含行尾换行)永远随求值消隐:真分支只保留内容行。
 *
 * 未知变量(键不在 vars 里)在 dev/test 直接抛错,不静默空串——模板改名/漏传
 * 属于编译期就该暴露的漂移,由 golden 快照在测试里兜住;生产降级为
 * console.error + 空值,不影响用户跑任务。
 */

export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

/** 词法单元:文本或指令/变量,span 记录其在原文中的 [start, end) */
type Token =
  | { kind: 'text'; text: string; start: number; end: number }
  | { kind: 'var'; name: string; start: number; end: number }
  | { kind: 'if'; name: string; start: number; end: number }
  | { kind: 'else'; start: number; end: number }
  | { kind: 'endif'; start: number; end: number };

const TAG = /\{\{([^{}]*)\}\}/g;

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  for (const m of template.matchAll(TAG)) {
    const [start, end] = [m.index!, m.index! + m[0].length];
    if (start > cursor) tokens.push({ kind: 'text', text: template.slice(cursor, start), start: cursor, end: start });
    const inner = m[1].trim();
    if (inner.startsWith('#if ')) {
      const name = inner.slice(4).trim();
      if (!/^\w+$/.test(name)) throw new Error(`模板指令不合法: {{${inner}}}(变量名只能是 \\w+)`);
      tokens.push({ kind: 'if', name, start, end });
    } else if (inner === 'else') {
      tokens.push({ kind: 'else', start, end });
    } else if (inner === '/if') {
      tokens.push({ kind: 'endif', start, end });
    } else if (/^\w+$/.test(inner)) {
      tokens.push({ kind: 'var', name: inner, start, end });
    } else {
      throw new Error(`模板花括号内容不合法: {{${inner}}}`);
    }
    cursor = end;
  }
  if (cursor < template.length) tokens.push({ kind: 'text', text: template.slice(cursor), start: cursor, end: template.length });
  return tokens;
}

const STRICT = process.env.NODE_ENV !== 'production';

function lookup(vars: TemplateVars, name: string): string | number | boolean | null | undefined {
  if (!(name in vars)) {
    const msg = `模板引用了未提供的变量: {{${name}}}(检查 context.ts 是否漏传或模板写错名字)`;
    if (STRICT) throw new Error(msg);
    console.error(`[WORKSHOP-TEMPLATE] ${msg}`);
    return undefined;
  }
  return vars[name];
}

/** 指令必须独占一行:前邻文件头或换行,后邻换行或文件尾 */
function assertOwnLine(template: string, t: Token, directive: string): void {
  const beforeOk = t.start === 0 || template[t.start - 1] === '\n';
  const afterOk = t.end === template.length || template[t.end] === '\n';
  if (!beforeOk || !afterOk) {
    throw new Error(`模板指令 {{${directive}}} 必须独占一行(前后都不能有其他字符)`);
  }
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  // .md 文件按惯例以单个换行结尾;提示词输出不带尾换行(旧构建器语义),剥掉一层。
  // 需要输出尾换行的模板,文件结尾留两个换行即可。
  // 条件块体的递归渲染走 renderBody(不剥层)——块体不是文件,不能重复规范化。
  return renderBody(template.replace(/\n$/, ''), vars);
}

function renderBody(src: string, vars: TemplateVars): string {
  const tokens = tokenize(src);
  let out = '';
  // 条件块把 {{/if}} 行尾换行一并消费;相邻的下一个文本 token 需让出这个换行
  let skipNextNewline = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'text') {
      let text = t.text;
      if (skipNextNewline && text.startsWith('\n')) text = text.slice(1);
      skipNextNewline = false;
      out += text;
    } else if (t.kind === 'var') {
      skipNextNewline = false;
      const v = lookup(vars, t.name);
      out += v == null ? '' : String(v);
    } else if (t.kind === 'if') {
      // 收集到配对的 {{/if}}(不允许嵌套与重复 else)
      let elseIdx = -1;
      let j = i + 1;
      for (; j < tokens.length; j++) {
        const u = tokens[j];
        if (u.kind === 'if') throw new Error('模板不支持嵌套条件块(需要时拆多段或改由 context.ts 组装)');
        if (u.kind === 'else') {
          if (elseIdx !== -1) throw new Error('模板条件块里出现多个 {{else}}');
          elseIdx = j;
        } else if (u.kind === 'endif') {
          break;
        }
      }
      if (j >= tokens.length) throw new Error(`{{#if ${t.name}}} 没有配对的 {{/if}}`);

      assertOwnLine(src, tokens[i], `#if ${t.name}`);
      if (elseIdx !== -1) assertOwnLine(src, tokens[elseIdx], 'else');
      assertOwnLine(src, tokens[j], '/if');

      const truthy = Boolean(lookup(vars, t.name));
      // 分支原文 = 两条边界指令之间的文本,去掉指令行相邻的边界换行;
      // 体内可能还有 {{var}},递归渲染。块整体落空(含渲染后为空)时
      // 连同行边界一起消隐,不残留空行。
      // 无 {{else}} 时假分支整体为空(原文取真分支只为偏移对称,不发射)
      const branchStart = truthy ? tokens[i].end : elseIdx === -1 ? -1 : tokens[elseIdx].end;
      const branchEnd = truthy ? (elseIdx === -1 ? tokens[j].start : tokens[elseIdx].start) : tokens[j].start;
      const body = branchStart === -1 ? '' : src.slice(branchStart, branchEnd).replace(/^\n/, '').replace(/\n$/, '');
      if (body) {
        const rendered = renderBody(body, vars);
        if (rendered) {
          out += rendered;
          if (tokens[j].end < src.length) out += '\n';
        }
      }
      skipNextNewline = src[tokens[j].end] === '\n';
      i = j;
    }
  }
  return out;
}
