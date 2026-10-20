import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateScriptSkill,
  loadScriptSkills,
  runSkillSteps,
  renderSkillMessage,
  skillDailyLimit,
  countTodaySkillRuns,
  skillGateAllows,
  buildScriptSkillTool,
  parseSkillMdFrontmatter,
  scanSkillPacks,
  createSkillService,
  type ScriptSkillManifest,
  type ScriptSkillBrowserService,
  type SkillStoreAdapter,
  type SkillAuditEntry,
} from './index';

/**
 * plugin-skill 验收测试(引擎自 apps/web script-skills 迁入后在插件侧的自证):
 * 清单校验(词汇表闭集/发布围栏/参数引用)→ 目录加载(坏文件跳过不炸、
 * 同名先到先得)→ 存储适配器(gate/限频/审计走注入的 store,插件零宿主依赖)→
 * 执行器(围栏/中止/旗标)→ pack 注册表(SKILL.md frontmatter 发现)→
 * createSkillService 统一清单(listSkills 汇合 flow+pack)。
 */

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-plugin-skill-'));
  delete process.env.AGTPILOT_SCRIPT_SKILLS;
  delete process.env.AGTPILOT_SCRIPT_SKILL_DIR;
});

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

/** 一份最小合格清单(可覆盖;故意收宽松类型,校验测试要喂非法步骤) */
function sampleSkill(over: Record<string, any> = {}): any {
  return {
    name: 'demo_save_draft',
    description: '演示技能',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    steps: [{ kind: 'goto', url: 'https://example.com/write' }],
    ...over,
  };
}

/** 内存版存储适配器(宿主注入形状的替身) */
function fakeStore(seed: { managed?: Record<string, any>; audit?: SkillAuditEntry[] } = {}): SkillStoreAdapter & {
  auditLog: SkillAuditEntry[];
} {
  const managed = seed.managed || {};
  const auditLog: SkillAuditEntry[] = [...(seed.audit || [])];
  return {
    auditLog,
    getManagedRecord: (_uid, platform) => managed[platform],
    listAudit: () => auditLog,
    appendAudit: (_uid, entry) => void auditLog.push(entry),
  };
}

/** 通用假 Page(按选择器控制可寻性;url 可被 goto 改写;editorText 模拟 pasteRich 后编辑器内容) */
function fakePage(opts: { redirectLogin?: boolean; textFails?: boolean; editorText?: string } = {}) {
  const state = { url: 'about:blank' };
  return {
    goto: vi.fn(async (url: string) => {
      state.url = opts.redirectLogin ? 'https://www.example.com/signin?next=%2Fwrite' : url;
    }),
    url: vi.fn(() => state.url),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    // pasteRich 用:不真执行函数体(Node 里无 document),只记录 (fn, opts)
    // 供断言 —— 真浏览器里由 Playwright 序列化后在页面执行
    evaluate: vi.fn(async () => true),
    locator: vi.fn((sel: string) => {
      const visible = String(sel).includes('#editor');
      return {
        count: vi.fn(async () => (visible && !opts.redirectLogin ? 1 : 0)),
        first: () => ({
          focus: vi.fn(async () => {}),
          innerText: vi.fn(async () => opts.editorText ?? ''),
        }),
      };
    }),
    keyboard: {
      insertText: vi.fn(async () => {}),
      press: vi.fn(async () => {}),
    },
    getByText: vi.fn(() => ({
      first: () => ({
        waitFor: vi.fn(async () => {
          if (opts.textFails) throw new Error('timeout');
        }),
      }),
    })),
    screenshot: vi.fn(async () => Buffer.from('jpeg-bytes')),
  };
}

function fakeBrowser(page: any, opts: { hasCookies?: boolean } = {}): ScriptSkillBrowserService {
  return {
    acquirePage: vi.fn(async () => page),
    hasCookies: vi.fn(async () => opts.hasCookies ?? true),
  };
}

describe('validateScriptSkill · 清单校验', () => {
  it('最小合格清单通过', () => {
    expect(validateScriptSkill(sampleSkill())).toBeNull();
  });

  it('name 非法 / steps 缺失或超限 / 未知动作 → 拒收', () => {
    expect(validateScriptSkill(sampleSkill({ name: 'Bad-Name' }))).toContain('name');
    expect(validateScriptSkill(sampleSkill({ steps: [] }))).toContain('steps');
    const many = Array.from({ length: 21 }, () => ({ kind: 'screenshot' }));
    expect(validateScriptSkill(sampleSkill({ steps: many }))).toContain('上限');
    expect(validateScriptSkill(sampleSkill({ steps: [{ kind: 'evaluateJs', code: 'x' }] }))).toContain('未知动作');
  });

  it('发布围栏(加载时):步骤字符串含发布词即拒收', () => {
    expect(
      validateScriptSkill(sampleSkill({ steps: [{ kind: 'clickOrFocus', selector: 'button:has-text("发布")' }] }))
    ).toContain('发布');
    expect(validateScriptSkill(sampleSkill({ steps: [{ kind: 'goto', url: 'https://x.com/publish' }] }))).toContain('发布');
  });

  it('goto/login.homeUrl 非 https、login.hint 超长、dailyLimit 越界、非法正则 → 拒收', () => {
    expect(validateScriptSkill(sampleSkill({ steps: [{ kind: 'goto', url: 'http://x.com' }] }))).toContain('https');
    expect(
      validateScriptSkill(
        sampleSkill({ login: { homeUrl: 'https://a.com/', cookieNames: ['c'], hint: 'x'.repeat(401) } })
      )
    ).toContain('hint');
    expect(validateScriptSkill(sampleSkill({ dailyLimit: { default: 999 } }))).toContain('dailyLimit');
    expect(validateScriptSkill(sampleSkill({ steps: [{ kind: 'waitForText', pattern: '(' }] }))).toContain('正则');
  });

  it('param/checks 引用未声明参数 → 拒收', () => {
    expect(validateScriptSkill(sampleSkill({ steps: [{ kind: 'insertText', param: 'nope' }] }))).toContain('未声明');
    expect(validateScriptSkill(sampleSkill({ checks: [{ param: 'nope', minLength: 5 }] }))).toContain('未声明');
  });

  it('gate.managed:fanqie 放行,未知平台拒收', () => {
    expect(validateScriptSkill(sampleSkill({ gate: { managed: 'fanqie' } }))).toBeNull();
    expect(validateScriptSkill(sampleSkill({ gate: { managed: 'weibo' } }))).toContain('gate.managed');
  });

  it('goto.params:引用未声明参数拒收;声明齐了通过', () => {
    const step = { kind: 'goto', url: 'https://example.com/write/{bookId}', params: ['nope'] };
    expect(validateScriptSkill(sampleSkill({ steps: [step] }))).toContain('未声明的参数 nope');
    const ok = { kind: 'goto', url: 'https://example.com/write/{bookId}', params: ['bookId'] };
    expect(
      validateScriptSkill(
        sampleSkill({ parameters: { type: 'object', properties: { title: { type: 'string' }, bookId: { type: 'string' } }, required: ['title'] } , steps: [ok] })
      )
    ).toBeNull();
  });

  it('captureUrl/extractText 校验:合法通过;pattern 非法正则 / output 名非法 / extractText 缺 selector → 拒收', () => {
    expect(
      validateScriptSkill(sampleSkill({ steps: [{ kind: 'captureUrl', pattern: 'works/(\\d+)', output: 'bid' }] }))
    ).toBeNull();
    expect(
      validateScriptSkill(
        sampleSkill({ steps: [{ kind: 'extractText', selector: '#id', pattern: '(\\d+)', output: 'bid' }] })
      )
    ).toBeNull();
    expect(validateScriptSkill(sampleSkill({ steps: [{ kind: 'captureUrl', pattern: '(', output: 'bid' }] }))).toContain('正则');
    expect(validateScriptSkill(sampleSkill({ steps: [{ kind: 'captureUrl', pattern: 'x' }] }))).toContain('output 名非法');
    expect(validateScriptSkill(sampleSkill({ steps: [{ kind: 'captureUrl', pattern: 'x', output: '1bad' }] }))).toContain('output 名非法');
    expect(validateScriptSkill(sampleSkill({ steps: [{ kind: 'captureUrl', pattern: 'x', output: 'a-b' }] }))).toContain('output 名非法');
    expect(
      validateScriptSkill(sampleSkill({ steps: [{ kind: 'extractText', pattern: '(\\d+)', output: 'bid' }] }))
    ).toContain('selector 缺失');
  });

  it('发布围栏覆盖 output 字段:借捕获名夹带发布词 → 拒收', () => {
    expect(
      validateScriptSkill(sampleSkill({ steps: [{ kind: 'captureUrl', pattern: 'x', output: 'publishId' }] }))
    ).toContain('发布');
  });

  it('选择器插值 params:必须是闭集 enum 参数;enum 值含发布词拒收;未声明拒收', () => {
    const enumParams = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        channel: { type: 'string', enum: ['male', 'female'] },
      },
      required: ['title'],
    };
    // 合法:闭集 enum
    expect(
      validateScriptSkill(
        sampleSkill({
          parameters: enumParams,
          steps: [{ kind: 'clickOrFocus', selector: '.tab-{channel}', params: ['channel'] }],
        })
      )
    ).toBeNull();
    // 非 enum 参数(自由字符串)→ 拒收(选择器注入面)
    expect(
      validateScriptSkill(
        sampleSkill({ steps: [{ kind: 'fill', selector: '#{title}', param: 'title', params: ['title'] }] })
      )
    ).toContain('闭集 enum');
    // 未声明参数 → 拒收
    expect(
      validateScriptSkill(
        sampleSkill({ parameters: enumParams, steps: [{ kind: 'waitForSelector', selector: '.x', params: ['nope'] }] })
      )
    ).toContain('未声明的参数 nope');
    // enum 值本身过发布围栏
    const smuggle = {
      type: 'object',
      properties: { title: { type: 'string' }, ch: { type: 'string', enum: ['ok', '发布'] } },
      required: ['title'],
    };
    expect(
      validateScriptSkill(sampleSkill({ parameters: smuggle, steps: [{ kind: 'clickOrFocus', selector: '.{ch}', params: ['ch'] }] }))
    ).toContain('发布');
    // params 不是字符串数组 → 拒收
    expect(
      validateScriptSkill(sampleSkill({ parameters: enumParams, steps: [{ kind: 'clickOrFocus', selector: '.x', params: 'channel' }] }))
    ).toContain('params 必须是参数名字符串数组');
  });
});

describe('loadScriptSkills · 目录热加载', () => {
  it('坏 JSON / 坏清单跳过并记错误,绝不抛出;同名先到先得', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'load-'));
    fs.writeFileSync(path.join(dir, 'a.skill.json'), JSON.stringify(sampleSkill({ name: 'aaa_skill' })));
    fs.writeFileSync(path.join(dir, 'b.skill.json'), '{broken json');
    fs.writeFileSync(path.join(dir, 'c.skill.json'), JSON.stringify(sampleSkill({ name: 'aaa_skill', description: '第二个' })));
    fs.writeFileSync(path.join(dir, 'not-a-skill.json'), '{}');
    const out = loadScriptSkills(dir);
    expect(out.skills.map((s) => s.name)).toEqual(['aaa_skill']);
    expect(out.skills[0].description).toBe('演示技能');
    expect(out.errors).toHaveLength(2);
  });

  it('目录不存在 → 空结果不是错误', () => {
    const out = loadScriptSkills(path.join(tmp, 'no-such-dir'));
    expect(out.skills).toEqual([]);
    expect(out.errors).toEqual([]);
  });
});

describe('存储适配器 · gate / 限频 / 审计全部走注入的 store', () => {
  it('gate:无 store 保守拒绝;有 store 但缺 enabled/riskAckAt 拒绝;齐了放行', () => {
    const skill = sampleSkill({ gate: { managed: 'zhihu' } }) as ScriptSkillManifest;
    expect(skillGateAllows(skill, 'u1')).toBe(false); // 无 store(如 CLI)→ 保守不注入
    expect(skillGateAllows(skill, 'u1', fakeStore({ managed: { zhihu: { enabled: true } } }))).toBe(false);
    expect(
      skillGateAllows(skill, 'u1', fakeStore({ managed: { zhihu: { enabled: true, riskAckAt: Date.now() } } }))
    ).toBe(true);
    expect(skillGateAllows(sampleSkill() as ScriptSkillManifest, 'u1')).toBe(true); // 无 gate 不看 store
  });

  it('每日上限:env 覆盖清单缺省;限频计数(成败都计)与审计写入都走 store', async () => {
    const skill = sampleSkill({
      dailyLimit: { default: 3, env: 'AGT_TEST_LIMIT' },
      steps: [{ kind: 'goto', url: 'https://example.com/write' }],
    }) as ScriptSkillManifest;
    expect(skillDailyLimit(skill)).toBe(3);
    process.env.AGT_TEST_LIMIT = '1';
    try {
      expect(skillDailyLimit(skill)).toBe(1);
    } finally {
      delete process.env.AGT_TEST_LIMIT;
    }

    const now = new Date();
    const audit: SkillAuditEntry[] = [
      { at: now.getTime(), tool: 'demo_save_draft', action: 'x', result: 'success' },
      { at: now.getTime(), tool: 'demo_save_draft', action: 'x', result: 'failure' },
      { at: now.getTime() - 86400000, tool: 'demo_save_draft', action: 'x', result: 'success' },
      { at: now.getTime(), tool: 'other_tool', action: 'x', result: 'success' },
    ];
    expect(countTodaySkillRuns(audit, 'demo_save_draft', now)).toBe(2);

    // 工具执行:成功后审计经 store.appendAudit 落下
    const store = fakeStore({ managed: {}, audit });
    const browser = fakeBrowser(fakePage());
    const tool = buildScriptSkillTool(skill, 'u2', browser, store);
    const res: any = await tool.execute({ title: 't' }, { taskId: 'm1' });
    expect(res.success).toBe(true);
    expect(store.auditLog.at(-1)).toMatchObject({ tool: 'demo_save_draft', result: 'success', missionId: 'm1' });

    // 无 store:审计写入被丢弃但不炸(CLI/装配缺省路径)
    const tool2 = buildScriptSkillTool(sampleSkill() as ScriptSkillManifest, 'u3', fakeBrowser(fakePage()));
    const res2: any = await tool2.execute({ title: 't' }, {});
    expect(res2.success).toBe(true);
  });

  it('execute 全链路:参数拒绝不开浏览器 → 限频 rejected → 登录门 not_logged_in → 成功', async () => {
    const skill = sampleSkill({
      name: 'full_chain_demo',
      login: { homeUrl: 'https://example.com/', cookieNames: ['sid'], hint: '请扫码登录' },
      dailyLimit: { default: 2 },
      checks: [{ param: 'title', minLength: 3 }],
      steps: [
        { kind: 'goto', url: 'https://example.com/write' },
        { kind: 'waitForSelector', selector: '#editor', retries: 2, intervalMs: 5 },
        { kind: 'fill', selector: '#editor', param: 'title' },
        { kind: 'screenshot' },
      ],
      successMessage: '「{title}」已存草稿。今日已用 {todayCount}/{dailyLimit} 次。',
    }) as ScriptSkillManifest;
    const store = fakeStore();

    // ① 参数不合格:不开浏览器不落审计
    const browser1 = fakeBrowser(fakePage());
    const tool1 = buildScriptSkillTool(skill, 'u4', browser1, store);
    const r1: any = await tool1.execute({ title: 'x' }, {});
    expect(r1.success).toBe(false);
    expect((browser1.acquirePage as any).mock.calls.length).toBe(0);
    expect(store.auditLog).toHaveLength(0);

    // ② 限频:今日已满 → rejected,不开浏览器
    store.auditLog.push(
      { at: Date.now(), tool: 'full_chain_demo', action: 'x', result: 'success' },
      { at: Date.now(), tool: 'full_chain_demo', action: 'x', result: 'failure' }
    );
    const browser2 = fakeBrowser(fakePage());
    const r2: any = await buildScriptSkillTool(skill, 'u4', browser2, store).execute({ title: 'ok-title' }, {});
    expect(r2.rejected).toBe(true);
    expect(r2.error).toContain('上限');
    expect((browser2.acquirePage as any).mock.calls.length).toBe(0);
    store.auditLog.length = 0;

    // ③ 登录门:cookie 缺失 → not_logged_in,不开浏览器,审计落 failure
    const browser3 = fakeBrowser(fakePage(), { hasCookies: false });
    const r3: any = await buildScriptSkillTool(skill, 'u4', browser3, store).execute({ title: 'ok-title' }, { taskId: 'm9' });
    expect(r3.success).toBe(false);
    expect(r3.error).toContain('扫码');
    expect((browser3.acquirePage as any).mock.calls.length).toBe(0);
    expect(store.auditLog[0]).toMatchObject({ result: 'failure', error: 'not_logged_in', missionId: 'm9' });
    store.auditLog.length = 0;

    // ④ 成功链路:模板渲染 + 截图 + 审计 success
    const page = fakePage();
    const browser4 = fakeBrowser(page);
    const r4: any = await buildScriptSkillTool(skill, 'u4', browser4, store).execute({ title: 'ok-title' }, { taskId: 'm10' });
    expect(r4.success).toBe(true);
    expect(r4.message).toBe('「ok-title」已存草稿。今日已用 1/2 次。');
    expect(r4.screenshotBase64).toContain('data:image/jpeg;base64,');
    expect(page.fill).toHaveBeenCalledWith('#editor', 'ok-title', expect.anything());
    expect(store.auditLog[0]).toMatchObject({ result: 'success', title: 'ok-title', missionId: 'm10' });
  });

  it('goto 后被重定向回 signin → 中止为 not_logged_in(结构化:审计码+用户引导)', async () => {
    const skill = sampleSkill({
      login: { homeUrl: 'https://example.com/', cookieNames: ['sid'], hint: '请重新扫码登录' },
      steps: [
        { kind: 'goto', url: 'https://example.com/write' },
        { kind: 'waitForSelector', selector: '#editor', retries: 2, intervalMs: 5, abortIfUrl: 'signin|login' },
      ],
    }) as ScriptSkillManifest;
    const store = fakeStore();
    const tool = buildScriptSkillTool(skill, 'u5', fakeBrowser(fakePage({ redirectLogin: true })), store);
    const res: any = await tool.execute({ title: 't' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('扫码');
    expect(store.auditLog[0]).toMatchObject({ result: 'failure', error: 'not_logged_in' });
  });
});

describe('runSkillSteps · 执行器', () => {
  it('goto params 模板替换:声明的参数按 args 编码替换,未声明的占位符原样保留', async () => {
    const skill = sampleSkill({
      parameters: { type: 'object', properties: { bookId: { type: 'string' } }, required: ['bookId'] },
      steps: [{ kind: 'goto', url: 'https://example.com/write/{bookId}/{other}', params: ['bookId'] }],
    }) as any;
    const page = fakePage();
    await runSkillSteps(page, skill, { bookId: '7123456 89/xx' });
    expect(page.goto).toHaveBeenCalledWith(
      'https://example.com/write/7123456%2089%2Fxx/{other}',
      expect.anything()
    );
  });

  it('运行时发布围栏:clickOrFocus 选择器含发布词 → 抛错拦截(双保险)', async () => {
    const forged = sampleSkill({ steps: [{ kind: 'clickOrFocus', selector: 'button.publish-btn:发布' }] }) as any;
    await expect(runSkillSteps(fakePage(), forged, {})).rejects.toThrow(/发布围栏/);
  });

  it('waitForText optional:等不到不失败,旗标记 false', async () => {
    const skill = sampleSkill({
      steps: [{ kind: 'waitForText', pattern: '已保存', timeoutMs: 20, optional: true, flag: 'autosaved' }],
    }) as any;
    const out = await runSkillSteps(fakePage({ textFails: true }), skill, {});
    expect(out.flags.autosaved).toBe(false);
  });

  it('insertText/fill 的 markdown-plain 转换:填入的是排版化纯文本,不是 Markdown 原文', async () => {
    const skill = sampleSkill({
      steps: [
        { kind: 'fill', selector: '#editor', param: 'title', transform: 'markdown-plain' },
        { kind: 'insertText', param: 'body', transform: 'markdown-plain' },
      ],
    }) as any;
    const page = fakePage();
    await runSkillSteps(page, skill, { title: '**粗**标题', body: '## 小节\n- 要点' });
    // 排版约定:加粗转「」,标题 ▍ 前缀,列表 • 弹头
    expect(page.fill).toHaveBeenCalledWith('#editor', '「粗」标题', expect.anything());
    expect(page.keyboard.insertText).toHaveBeenCalledWith('▍ 小节\n\n• 要点');
  });

  it('transform 闭集:未知值在加载校验拒收,运行时兜底原文返回', async () => {
    expect(
      validateScriptSkill(sampleSkill({ steps: [{ kind: 'insertText', param: 'title', transform: 'yaml' }] }))
    ).toContain('transform');
    const skill = sampleSkill({ steps: [{ kind: 'insertText', param: 'title', transform: 'yaml' }] }) as any;
    const page = fakePage();
    await runSkillSteps(page, skill, { title: '# 原文' });
    expect(page.keyboard.insertText).toHaveBeenCalledWith('# 原文');
  });

  it('pasteRich:合成 paste 派发成功 + 编辑器有字 → 旗标 true,insertText 不被调', async () => {
    const skill = sampleSkill({
      steps: [{ kind: 'pasteRich', param: 'body', selector: '#editor', flag: 'richPaste', settleMs: 1 }],
    }) as any;
    const page = fakePage({ editorText: '粘贴后的正文' });
    const out = await runSkillSteps(page, skill, { body: '## 小节\n\n**重点**' });
    expect(out.flags.richPaste).toBe(true);
    // 双份数据:text/html 语义标签 + text/plain 排版化纯文本
    const [fn, arg] = (page.evaluate as any).mock.calls[0] as [Function, any];
    expect(arg.selector).toBe('#editor');
    expect(arg.html).toBe('<h2>小节</h2><p><strong>重点</strong></p>');
    expect(arg.plain).toBe('▍ 小节\n\n「重点」');
    expect(typeof fn).toBe('function');
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
  });

  it('pasteRich:编辑器不认合成 paste(仍空)→ 回退 insertText 排版化纯文本,旗标 false', async () => {
    const skill = sampleSkill({
      steps: [{ kind: 'pasteRich', param: 'body', selector: '#editor', flag: 'richPaste', settleMs: 1 }],
    }) as any;
    const page = fakePage({ editorText: '' });
    const out = await runSkillSteps(page, skill, { body: '## 小节\n\n- 要点' });
    expect(out.flags.richPaste).toBe(false);
    expect(page.keyboard.insertText).toHaveBeenCalledWith('▍ 小节\n\n• 要点');
  });

  it('pasteRich:evaluate 抛错(ClipboardEvent 构造被禁)→ 纯文本兜底,不失败', async () => {
    const skill = sampleSkill({
      steps: [{ kind: 'pasteRich', param: 'body', selector: '#editor', settleMs: 1 }],
    }) as any;
    const page = fakePage();
    (page.evaluate as any) = vi.fn(async () => {
      throw new Error('ClipboardEvent is not defined');
    });
    const out = await runSkillSteps(page, skill, { body: '**纯文本**兜底' });
    expect(out.flags.richPaste).toBe(false);
    expect(page.keyboard.insertText).toHaveBeenCalledWith('「纯文本」兜底');
  });
});

describe('runSkillSteps · 引擎扩展(captureUrl / extractText / clickOrFocus optional / 选择器插值)', () => {
  it('选择器插值:params 声明的占位符按 args 原样替换(不 URI 编码),未声明占位符原样保留', async () => {
    const skill = sampleSkill({
      parameters: { type: 'object', properties: { channel: { type: 'string', enum: ['male', 'female'] } }, required: [] },
      steps: [{ kind: 'fill', selector: '.tab-{channel} #{other}', param: 'title', params: ['channel'] }],
    }) as any;
    const page = fakePage();
    await runSkillSteps(page, skill, { channel: 'male', title: 'x' });
    expect(page.fill).toHaveBeenCalledWith('.tab-male #{other}', 'x', expect.anything());
  });

  it('clickOrFocus optional:元素不存在 → 静默跳过,旗标 false,不点击;存在 → 点击且旗标 true', async () => {
    const skill = sampleSkill({
      steps: [{ kind: 'clickOrFocus', selector: '#ai-declare', optional: true, flag: 'aiDeclared' }],
    }) as any;
    const page = fakePage(); // locator 只认 #editor → #ai-declare count=0
    const out = await runSkillSteps(page, skill, {});
    expect(out.flags.aiDeclared).toBe(false);
    expect(page.click).not.toHaveBeenCalled();

    const skill2 = sampleSkill({
      steps: [{ kind: 'clickOrFocus', selector: '#editor-btn', optional: true, flag: 'aiDeclared' }],
    }) as any;
    const page2 = fakePage();
    const out2 = await runSkillSteps(page2, skill2, {});
    expect(out2.flags.aiDeclared).toBe(true);
    expect(page2.click).toHaveBeenCalledWith('#editor-btn', expect.anything());
  });

  it('captureUrl:命中即取组1;SPA 延迟跳转靠轮询等到;超时非 optional 抛错,optional 静默', async () => {
    // ① 立即命中:正则组 1 → captures
    const skill = sampleSkill({
      steps: [{ kind: 'captureUrl', pattern: 'works/(\\d+)', output: 'bid' }],
    }) as any;
    const page = fakePage();
    (page.url as any) = vi.fn(() => 'https://writer.example.com/works/7123456/chapter');
    const out = await runSkillSteps(page, skill, {});
    expect(out.captures.bid).toBe('7123456');

    // ② 无捕获组:整段匹配兜底
    const skill2 = sampleSkill({ steps: [{ kind: 'captureUrl', pattern: 'created-ok', output: 'done' }] }) as any;
    const page2 = fakePage();
    (page2.url as any) = vi.fn(() => 'https://x.com/created-ok');
    expect((await runSkillSteps(page2, skill2, {})).captures.done).toBe('created-ok');

    // ③ 轮询:第一次未命中,后续跳转命中(真实耗时 ~500ms)
    const page3 = fakePage();
    let n = 0;
    (page3.url as any) = vi.fn(() => (++n >= 2 ? 'https://x.com/works/999' : 'https://x.com/creating'));
    const out3 = await runSkillSteps(page3, sampleSkill({
      steps: [{ kind: 'captureUrl', pattern: 'works/(\\d+)', output: 'bid', timeoutMs: 3000 }],
    }) as any, {});
    expect(out3.captures.bid).toBe('999');

    // ④ 超时:非 optional 抛错;optional 静默且无捕获
    const miss = sampleSkill({ steps: [{ kind: 'captureUrl', pattern: 'works/(\\d+)', output: 'bid', timeoutMs: 0 }] }) as any;
    await expect(runSkillSteps(fakePage(), miss, {})).rejects.toThrow(/URL 捕获超时/);
    const opt = sampleSkill({
      steps: [{ kind: 'captureUrl', pattern: 'works/(\\d+)', output: 'bid', timeoutMs: 0, optional: true }],
    }) as any;
    const out4 = await runSkillSteps(fakePage(), opt, {});
    expect(out4.captures).toEqual({});
  });

  it('extractText:innerText 按 pattern 提取;不匹配非 optional 抛错,optional 静默', async () => {
    const skill = sampleSkill({
      steps: [{ kind: 'extractText', selector: '#book-id', pattern: '书号[:：]\\s*(\\d+)', output: 'bid' }],
    }) as any;
    const page = fakePage({ editorText: '作品书号：7123456 已创建' });
    const out = await runSkillSteps(page, skill, {});
    expect(out.captures.bid).toBe('7123456');

    const miss = sampleSkill({
      steps: [{ kind: 'extractText', selector: '#book-id', pattern: '不存在(\\d+)', output: 'bid' }],
    }) as any;
    await expect(runSkillSteps(fakePage({ editorText: '别的' }), miss, {})).rejects.toThrow(/文本捕获失败/);
    const opt = sampleSkill({
      steps: [{ kind: 'extractText', selector: '#book-id', pattern: '不存在(\\d+)', output: 'bid', optional: true }],
    }) as any;
    expect((await runSkillSteps(fakePage({ editorText: '别的' }), opt, {})).captures).toEqual({});
  });

  it('execute 端到端:captures 透出到工具结果,successMessage 渲染 {capture:name}', async () => {
    const skill = sampleSkill({
      name: 'create_book_demo',
      steps: [
        { kind: 'goto', url: 'https://example.com/works/555' },
        { kind: 'captureUrl', pattern: 'works/(\\d+)', output: 'bid' },
        { kind: 'screenshot' },
      ],
      successMessage: '已开书,书号 {capture:bid};{capture:nope} 保留。',
    }) as ScriptSkillManifest;
    const store = fakeStore();
    const res: any = await buildScriptSkillTool(skill, 'u8', fakeBrowser(fakePage()), store).execute({ title: 't' }, {});
    expect(res.success).toBe(true);
    expect(res.captures).toEqual({ bid: '555' });
    expect(res.message).toBe('已开书,书号 555;{capture:nope} 保留。');
    expect(store.auditLog.at(-1)).toMatchObject({ tool: 'create_book_demo', result: 'success' });

    // 无捕获时结果不带 captures 键(调用方判空语义清晰)
    const plain: any = await buildScriptSkillTool(sampleSkill() as ScriptSkillManifest, 'u8', fakeBrowser(fakePage()), store).execute({ title: 't' }, {});
    expect(plain.success).toBe(true);
    expect(plain.captures).toBeUndefined();
  });
});

describe('renderSkillMessage · 模板', () => {
  it('{note:flag} 按旗标取文案;短参数/计数替换;未知占位符原样保留', () => {
    const skill = sampleSkill({
      notes: { autosaved: { present: '已保存。', missing: '未确认。' } },
      successMessage: '{note:autosaved}标题「{title}」今日 {todayCount}/{dailyLimit} 次,{unknownKey} 完。',
    }) as any;
    const msg = renderSkillMessage(skill, { title: '测试' }, { todayCount: 2, dailyLimit: 3 }, { autosaved: true });
    expect(msg).toBe('已保存。标题「测试」今日 2/3 次,{unknownKey} 完。');
  });
});

describe('pack 注册表 · 沙箱技能包发现', () => {
  it('frontmatter 解析:name/description、引号剥离、无 frontmatter 返回空', () => {
    expect(parseSkillMdFrontmatter('---\nname: demo-pack\ndescription: "演示包"\n---\n\n# body')).toEqual({
      name: 'demo-pack',
      description: '演示包',
    });
    expect(parseSkillMdFrontmatter('# 没有 frontmatter')).toEqual({});
  });

  it('扫描:含 SKILL.md 的一级子目录 = pack;frontmatter 缺 name 用目录名;无 SKILL.md 跳过;根目录不存在不炸', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'packs-'));
    const p1 = path.join(root, 'pack-one');
    fs.mkdirSync(path.join(p1, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(p1, 'SKILL.md'), '---\nname: pack-one\ndescription: 一号包\n---\n用法…');
    const p2 = path.join(root, 'pack-two');
    fs.mkdirSync(p2);
    fs.writeFileSync(path.join(p2, 'SKILL.md'), '# 没有 frontmatter 的技能包');
    fs.mkdirSync(path.join(root, 'not-a-pack')); // 无 SKILL.md → 跳过

    const packs = scanSkillPacks([root, path.join(tmp, 'no-such-root')]);
    expect(packs.map((p) => p.name)).toEqual(['pack-one', 'pack-two']);
    expect(packs[0]).toMatchObject({ description: '一号包', dir: p1, hasSkillMd: true, hasScripts: true });
    expect(packs[1]).toMatchObject({ name: 'pack-two', description: '', hasScripts: false });
  });

  it('AGTPILOT_SKILL_PACK_DIRS 覆盖缺省目录清单', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'packs-env-'));
    fs.mkdirSync(path.join(root, 'envpack'));
    fs.writeFileSync(path.join(root, 'envpack', 'SKILL.md'), '---\nname: envpack\n---\nx');
    const prev = process.env.AGTPILOT_SKILL_PACK_DIRS;
    process.env.AGTPILOT_SKILL_PACK_DIRS = root;
    try {
      const svc = createSkillService();
      expect(svc.getPack('envpack')?.dir).toBe(path.join(root, 'envpack'));
      expect(svc.listSkills().some((s) => s.form === 'pack' && s.name === 'envpack')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGTPILOT_SKILL_PACK_DIRS;
      else process.env.AGTPILOT_SKILL_PACK_DIRS = prev;
    }
  });
});

describe('createSkillService · 统一服务面', () => {
  beforeEach(() => {
    delete process.env.AGTPILOT_SCRIPT_SKILLS;
  });

  it('listSkills 汇合 flow + pack 两种形态', () => {
    const flowDir = fs.mkdtempSync(path.join(tmp, 'svc-flow-'));
    fs.writeFileSync(path.join(flowDir, 'f.skill.json'), JSON.stringify(sampleSkill({ name: 'svc_flow_skill' })));
    const packDir = fs.mkdtempSync(path.join(tmp, 'svc-pack-'));
    fs.mkdirSync(path.join(packDir, 'svc-pack'));
    fs.writeFileSync(path.join(packDir, 'svc-pack', 'SKILL.md'), '---\nname: svc-pack\ndescription: 服务面包\n---\nx');

    const svc = createSkillService({ skillDir: flowDir, packDirs: [packDir] });
    const inv = svc.listSkills();
    expect(inv).toContainEqual({ form: 'flow', name: 'svc_flow_skill', description: '演示技能' });
    expect(inv.some((s) => s.form === 'pack' && s.name === 'svc-pack')).toBe(true);
  });

  it('buildTaskTools:总开关关闭 → 空;无 browser → 全 gated;gate 不满足 → gated;满足 → 注入', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'svc-gate-'));
    fs.writeFileSync(
      path.join(dir, 'g.skill.json'),
      JSON.stringify(sampleSkill({ name: 'svc_gated_skill', gate: { managed: 'zhihu' } }))
    );
    const openStore = fakeStore({ managed: { zhihu: { enabled: true, riskAckAt: Date.now() } } });

    const svc = createSkillService({ skillDir: dir, store: openStore });
    expect(svc.buildTaskTools('u6', undefined).tools).toHaveLength(0);
    expect(svc.buildTaskTools('u6', undefined).gated).toEqual(['svc_gated_skill']);
    expect(svc.buildTaskTools('u6', fakeBrowser(fakePage())).tools.map((t) => t.name)).toEqual(['svc_gated_skill']);

    const closed = createSkillService({ skillDir: dir }); // 无 store → gate 保守拒绝
    expect(closed.buildTaskTools('u6', fakeBrowser(fakePage())).gated).toEqual(['svc_gated_skill']);

    process.env.AGTPILOT_SCRIPT_SKILLS = '0';
    try {
      expect(svc.buildTaskTools('u6', fakeBrowser(fakePage())).tools).toHaveLength(0);
    } finally {
      delete process.env.AGTPILOT_SCRIPT_SKILLS;
    }
  });

  it('buildTaskTools:加载错误经 errors 透出(供挂载日志)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'svc-err-'));
    fs.writeFileSync(path.join(dir, 'bad.skill.json'), '{"name": 123}');
    const out = createSkillService({ skillDir: dir }).buildTaskTools('u7', fakeBrowser(fakePage()));
    expect(out.tools).toHaveLength(0);
    expect(out.errors.join()).toContain('bad.skill.json');
  });
});

/**
 * 2026-10-20 番茄建书「URL 捕获超时」事故三处加固的自证:
 * ① requireClick —— 写动作点击失败禁止静默降级 focus,抛原始断点;
 * ② captureResponse —— 直接从建书接口响应抠 book_id,服务端拒绝(书名已存在)
 *    带响应体原文抛出,不再被落地页 URL 超时整个吞掉;
 * ③ 失败现场照 —— 后台同步无旁观者,抛错前补拍一张挂到 err/结果上供落盘排障。
 */
describe('runSkillSteps · requireClick / captureResponse / 失败现场照(番茄建书事故修复)', () => {
  /** 带网络监听的假 Page:.on 挂 response 监听器,__emit 同步投喂缓冲响应
   *  (模拟「响应在 click 步骤执行期间就已到达」——建书接口回包早于落地页跳转) */
  function respPage(responses: { url: string; body: string }[] = []) {
    const page: any = fakePage();
    let listener: ((res: any) => void) | null = null;
    page.on = vi.fn((ev: string, cb: any) => { if (ev === 'response') listener = cb; });
    page.off = vi.fn((ev: string, cb: any) => { if (ev === 'response' && cb === listener) listener = null; });
    page.__emit = () => { for (const r of responses) listener?.({ url: () => r.url, text: async () => r.body }); };
    return page;
  }

  it('requireClick:点击失败 → 抛原始错误(禁止降级 focus),并补失败现场照', async () => {
    const skill = sampleSkill({ steps: [{ kind: 'clickOrFocus', selector: '#editor-submit', requireClick: true }] }) as any;
    const page = fakePage();
    (page.click as any) = vi.fn(async () => { throw new Error('element not stable'); });
    let err: any;
    try { await runSkillSteps(page, skill, {}); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/点击失败.*requireClick/);
    expect(err.message).toContain('element not stable'); // 真实断点不被吞
    expect(page.locator).not.toHaveBeenCalled();          // 未走 focus 降级
    expect(String(err.screenshotBase64).startsWith('data:image/jpeg;base64,')).toBe(true); // 抛错前补拍现场照
  });

  it('clickOrFocus 无 requireClick:点击失败 → 降级 focus、旗标 false(不谎报);留痕随后续失败经 err.diagnostics 带出', async () => {
    // ① 降级成功(无后续失败):旗标记 false(点击没成不能谎报 true),focus 被调用
    const page = fakePage();
    (page.click as any) = vi.fn(async () => { throw new Error('intercepted by overlay'); });
    const out = await runSkillSteps(page, sampleSkill({ steps: [{ kind: 'clickOrFocus', selector: '#editor', flag: 'clicked' }] }) as any, {});
    expect(out.flags.clicked).toBe(false);
    expect(page.locator).toHaveBeenCalled(); // 经 locator(sel).first().focus 降级

    // ② 降级留痕在后续步骤失败时随 err.diagnostics 带出(审计能定位哪步是降级过的)
    const page2 = fakePage();
    (page2.click as any) = vi.fn(async () => { throw new Error('intercepted'); });
    let err: any;
    try {
      await runSkillSteps(page2, sampleSkill({ steps: [
        { kind: 'clickOrFocus', selector: '#editor' },                            // 降级(留痕)
        { kind: 'captureUrl', pattern: 'nope/(\\d+)', output: 'x', timeoutMs: 0 }, // 必抛
      ] }) as any, {});
    } catch (e) { err = e; }
    expect(err.message).toMatch(/URL 捕获超时/);
    expect(err.diagnostics.join()).toContain('降级为 focus');
    expect(String(err.screenshotBase64).startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('captureResponse:命中建书接口响应 → 按 pattern 抠出 book_id 进 captures、旗标 true', async () => {
    const resp = { url: 'https://fanqienovel.com/api/author/book/create/v0/?aid=2329', body: '{"code":0,"data":{"book_id":"7698638757322296382"},"message":"success"}' };
    const skill = sampleSkill({ steps: [{ kind: 'captureResponse', urlPattern: 'api/author/book/create', pattern: '"book_id"\\s*:\\s*"([0-9A-Za-z_-]+)"', output: 'fanqieBookId', flag: 'respCaptured', timeoutMs: 2000 }] }) as any;
    const page = respPage([resp]);
    const p = runSkillSteps(page, skill, {}); // 监听器在此同步挂上
    page.__emit();                            // 投喂响应(模拟 click 期间到达)
    const out = await p;
    expect(out.captures.fanqieBookId).toBe('7698638757322296382');
    expect(out.flags.respCaptured).toBe(true);
  });

  it('captureResponse:观察到响应但抠不出值(服务端拒绝/字段改名) → 抛错并带响应体摘要', async () => {
    const reject = { url: 'https://fanqienovel.com/api/author/book/create/v0/', body: '{"code":40001,"message":"书名已存在","data":null}' };
    const skill = sampleSkill({ steps: [{ kind: 'captureResponse', urlPattern: 'api/author/book/create', pattern: '"book_id"\\s*:\\s*"([0-9A-Za-z_-]+)"', output: 'bid', timeoutMs: 400 }] }) as any;
    const page = respPage([reject]);
    const p = runSkillSteps(page, skill, {});
    page.__emit();
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err.message).toMatch(/响应捕获失败/);
    expect(err.message).toContain('响应体');
    expect(err.message).toContain('书名已存在'); // 真实拒绝原因透出(此前被「URL 捕获超时」整个吞掉)
  });

  it('captureResponse:未等到响应 + optional → 静默跳过、旗标 false(交后续 captureUrl 兜底)', async () => {
    const skill = sampleSkill({ steps: [{ kind: 'captureResponse', urlPattern: 'api/author/book/create', pattern: '"book_id":"(\\d+)"', output: 'bid', optional: true, flag: 'respCaptured', timeoutMs: 100 }] }) as any;
    const out = await runSkillSteps(respPage([]), skill, {}); // 从不 __emit
    expect(out.captures).toEqual({});
    expect(out.flags.respCaptured).toBe(false);
  });

  it('captureResponse:未等到响应 + 非 optional → 抛响应捕获超时', async () => {
    const skill = sampleSkill({ steps: [{ kind: 'captureResponse', urlPattern: 'api/author/book/create', pattern: '"book_id":"(\\d+)"', output: 'bid', timeoutMs: 100 }] }) as any;
    await expect(runSkillSteps(respPage([]), skill, {})).rejects.toThrow(/响应捕获超时/);
  });

  it('execute 端到端:步骤失败 → 结果带 screenshotBase64(data URL),审计 failure 拼入降级留痕', async () => {
    const skill = sampleSkill({
      name: 'create_fail_demo',
      steps: [
        { kind: 'clickOrFocus', selector: '#editor-focus' },                      // 降级(click 抛)→ 留痕
        { kind: 'clickOrFocus', selector: '#editor-submit', requireClick: true }, // 必抛
      ],
    }) as ScriptSkillManifest;
    const page = fakePage();
    (page.click as any) = vi.fn(async () => { throw new Error('not stable'); });
    const store = fakeStore();
    const res: any = await buildScriptSkillTool(skill, 'u9', fakeBrowser(page), store).execute({ title: 't' }, {});
    expect(res.success).toBe(false);
    expect(String(res.screenshotBase64).startsWith('data:image/jpeg;base64,')).toBe(true);
    const last = store.auditLog.at(-1)!;
    expect(last.result).toBe('failure');
    expect(String(last.error)).toContain('降级留痕'); // diagnostics 拼进审计错误,排障可见
  });
});
