import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
// 纯类型导入(编译期擦除,不影响「先设环境变量再动态 import」的运行时顺序)
import type { ScriptSkillManifest, ScriptSkillBrowserService } from '@/lib/script-skills';

/**
 * script-skill 注册表验收测试:
 * 清单校验(词汇表闭集/发布围栏/参数引用)→ 目录加载(坏文件跳过不炸、
 * 同名先到先得)→ 注入门(托管 opt-in / browser 在场 / 总开关)→ 执行器
 * 全链路(用真实随包的 zhihu-draft.skill.json:参数校验、限频、登录门、
 * 重定向中止、成功链路、审计、模板消息)→ 与内置 zhihu-managed 工具的契约等价。
 *
 * 环境隔离:USER_DATA_DIR 指向一次性临时目录(同 zhihu-managed.test.ts 模式),
 * 必须在动态 import 被测模块之前设置。
 */

let tmpDir: string;
let skillsTmp: string;
let ss: typeof import('@/lib/script-skills');
let us: typeof import('@/lib/user-store');
let zm: typeof import('@/lib/zhihu-managed');

/** 随包发布的真实技能目录(apps/web/skills) */
const SHIPPED_DIR = fileURLToPath(new URL('../../../skills', import.meta.url));

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-script-skills-'));
  skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtpilot-skills-dir-'));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.AGTPILOT_SECRET_KEY = 'script-skills-test-key';
  delete process.env.AGTPILOT_SCRIPT_SKILLS;
  delete process.env.AGTPILOT_SCRIPT_SKILL_DIR;
  delete process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT;
  us = await import('@/lib/user-store');
  ss = await import('@/lib/script-skills');
  zm = await import('@/lib/zhihu-managed');
});

afterAll(() => {
  for (const d of [tmpDir, skillsTmp]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
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

/** 知乎编辑器假 Page(与 zhihu-managed.test.ts 同构;editorText 模拟 pasteRich 后编辑器内容) */
function fakeZhihuPage(
  opts: { autosaveFails?: boolean; redirectLogin?: boolean; editorText?: string } = {},
) {
  const state = { url: 'about:blank' };
  return {
    goto: vi.fn(async (url: string) => {
      state.url = opts.redirectLogin ? 'https://www.zhihu.com/signin?next=%2Fwrite' : url;
    }),
    url: vi.fn(() => state.url),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    // pasteRich 用:不真执行函数体(Node 里无 document),只记录 (fn, opts)
    // 供断言 —— 真浏览器里由 Playwright 序列化后在页面执行
    evaluate: vi.fn(async () => true),
    locator: vi.fn((sel: string) => {
      const isTitle = String(sel).includes('标题');
      return {
        count: vi.fn(async () => (isTitle && !opts.redirectLogin ? 1 : 0)),
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
          if (opts.autosaveFails) throw new Error('timeout');
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

/** 给某用户开通知乎托管(opt-in + 风险已读) */
function optInZhihu(uid: string) {
  us.saveZhihuManaged(uid, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
}

describe('validateScriptSkill · 清单校验', () => {
  it('最小合格清单通过', () => {
    expect(ss.validateScriptSkill(sampleSkill())).toBeNull();
  });

  it('name 非法(大写/数字开头/缺失)→ 拒收', () => {
    expect(ss.validateScriptSkill(sampleSkill({ name: 'Bad-Name' }))).toContain('name');
    expect(ss.validateScriptSkill(sampleSkill({ name: '9x' }))).toContain('name');
    expect(ss.validateScriptSkill(sampleSkill({ name: undefined }))).toContain('name');
  });

  it('steps 缺失/为空/超上限 → 拒收', () => {
    expect(ss.validateScriptSkill(sampleSkill({ steps: [] }))).toContain('steps');
    expect(ss.validateScriptSkill(sampleSkill({ steps: undefined }))).toContain('steps');
    const many = Array.from({ length: 21 }, () => ({ kind: 'screenshot' }));
    expect(ss.validateScriptSkill(sampleSkill({ steps: many }))).toContain('上限');
  });

  it('未知动作 kind → 拒收(词汇表是闭集)', () => {
    const s = sampleSkill({ steps: [{ kind: 'evaluateJs', code: 'process.exit()' }] });
    expect(ss.validateScriptSkill(s)).toContain('未知动作');
  });

  it('发布围栏(加载时):步骤里出现发布词即拒收', () => {
    expect(
      ss.validateScriptSkill(
        sampleSkill({ steps: [{ kind: 'clickOrFocus', selector: 'button:has-text("发布")' }] })
      )
    ).toContain('发布');
    expect(
      ss.validateScriptSkill(sampleSkill({ steps: [{ kind: 'goto', url: 'https://x.com/publish' }] }))
    ).toContain('发布');
  });

  it('goto 非 https / login.homeUrl 非 https → 拒收', () => {
    expect(ss.validateScriptSkill(sampleSkill({ steps: [{ kind: 'goto', url: 'http://x.com' }] }))).toContain('https');
    const s = sampleSkill({
      login: { homeUrl: 'http://www.zhihu.com/', cookieNames: ['z_c0'], hint: 'x' },
    });
    expect(ss.validateScriptSkill(s)).toContain('https');
  });

  it('步骤/checks 引用未声明参数 → 拒收;fill 缺 param/value → 拒收', () => {
    const s1 = sampleSkill({ steps: [{ kind: 'insertText', param: 'nope' }] });
    expect(ss.validateScriptSkill(s1)).toContain('未声明');
    const s2 = sampleSkill({ checks: [{ param: 'nope', minLength: 5 }] });
    expect(ss.validateScriptSkill(s2)).toContain('未声明');
    const s3 = sampleSkill({ steps: [{ kind: 'fill', selector: '#a' }] });
    expect(ss.validateScriptSkill(s3)).toContain('param 或 value');
  });

  it('waitForText 非法正则 / gate 非法平台 / dailyLimit 越界 → 拒收', () => {
    expect(ss.validateScriptSkill(sampleSkill({ steps: [{ kind: 'waitForText', pattern: '(' }] }))).toContain('正则');
    expect(ss.validateScriptSkill(sampleSkill({ gate: { managed: 'weibo' } as any }))).toContain('gate');
    expect(ss.validateScriptSkill(sampleSkill({ dailyLimit: { default: 999 } }))).toContain('dailyLimit');
  });

  it('随包发布的 zhihu-draft.skill.json 本身是合格清单', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(SHIPPED_DIR, 'zhihu-draft.skill.json'), 'utf-8'));
    expect(ss.validateScriptSkill(raw)).toBeNull();
  });
});

describe('loadScriptSkills · 目录热加载', () => {
  it('加载合格文件;坏 JSON / 坏清单跳过并记错误,绝不抛出', () => {
    const dir = fs.mkdtempSync(path.join(skillsTmp, 'load-'));
    fs.writeFileSync(path.join(dir, 'a.skill.json'), JSON.stringify(sampleSkill({ name: 'aaa_skill' })));
    fs.writeFileSync(path.join(dir, 'b.skill.json'), '{broken json');
    fs.writeFileSync(path.join(dir, 'c.skill.json'), JSON.stringify({ name: 'CCC', steps: [] }));
    fs.writeFileSync(path.join(dir, 'not-a-skill.json'), '{}');
    const out = ss.loadScriptSkills(dir);
    expect(out.skills.map((s) => s.name)).toEqual(['aaa_skill']);
    expect(out.errors).toHaveLength(2);
    expect(out.errors.join()).toContain('b.skill.json');
    expect(out.errors.join()).toContain('c.skill.json');
  });

  it('同名技能先到先得,后到文件记错误被忽略', () => {
    const dir = fs.mkdtempSync(path.join(skillsTmp, 'dup-'));
    fs.writeFileSync(path.join(dir, 'a-first.skill.json'), JSON.stringify(sampleSkill({ name: 'dup_skill' })));
    fs.writeFileSync(
      path.join(dir, 'b-second.skill.json'),
      JSON.stringify(sampleSkill({ name: 'dup_skill', description: '第二个' }))
    );
    const out = ss.loadScriptSkills(dir);
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].description).toBe('演示技能');
    expect(out.errors.join()).toContain('重复');
  });

  it('目录不存在 → 空结果(注册表为空不是错误,内置工具兜底)', () => {
    const out = ss.loadScriptSkills(path.join(skillsTmp, 'no-such-dir'));
    expect(out.skills).toEqual([]);
    expect(out.errors).toEqual([]);
  });
});

describe('buildScriptSkillTools · 注入门', () => {
  beforeEach(() => {
    delete process.env.AGTPILOT_SCRIPT_SKILLS;
  });

  it('gate=托管 opt-in:未开通不注入;enabled+riskAckAt 齐了才注入', () => {
    const gated = sampleSkill({ name: 'gated_skill', gate: { managed: 'zhihu' } });
    const dir = fs.mkdtempSync(path.join(skillsTmp, 'gate-'));
    fs.writeFileSync(path.join(dir, 'g.skill.json'), JSON.stringify(gated));

    const uid = 'ss-gate';
    us.saveZhihuManaged(uid, { enabled: false });
    expect(ss.buildScriptSkillTools(uid, fakeBrowser(fakeZhihuPage()), { dir }).tools).toHaveLength(0);

    us.saveZhihuManaged(uid, { enabled: true, lastLoginAt: Date.now() }); // 缺 riskAckAt 仍不行
    expect(ss.buildScriptSkillTools(uid, fakeBrowser(fakeZhihuPage()), { dir }).tools).toHaveLength(0);

    optInZhihu(uid);
    const out = ss.buildScriptSkillTools(uid, fakeBrowser(fakeZhihuPage()), { dir });
    expect(out.tools.map((t) => t.name)).toEqual(['gated_skill']);
    expect(out.tools[0].dangerLevel).toBe('high'); // 缺省高危 → 审批门
  });

  it('browser 服务缺失 → 全部不注入;AGTPILOT_SCRIPT_SKILLS=0 → 整体关闭', () => {
    const uid = 'ss-nobrowser';
    optInZhihu(uid);
    expect(ss.buildScriptSkillTools(uid, undefined, { dir: SHIPPED_DIR }).tools).toHaveLength(0);

    process.env.AGTPILOT_SCRIPT_SKILLS = '0';
    try {
      expect(ss.buildScriptSkillTools(uid, fakeBrowser(fakeZhihuPage()), { dir: SHIPPED_DIR }).tools).toHaveLength(0);
    } finally {
      delete process.env.AGTPILOT_SCRIPT_SKILLS;
    }
  });

  it('加载错误经 errors 透出(供挂载日志)', () => {
    const dir = fs.mkdtempSync(path.join(skillsTmp, 'err-'));
    fs.writeFileSync(path.join(dir, 'bad.skill.json'), '{"name": 123}');
    const out = ss.buildScriptSkillTools('ss-err', fakeBrowser(fakeZhihuPage()), { dir });
    expect(out.tools).toHaveLength(0);
    expect(out.errors.join()).toContain('bad.skill.json');
  });
});

describe('runSkillSteps · 执行器', () => {
  it('运行时发布围栏:clickOrFocus 选择器含发布词 → 抛错拦截(双保险)', async () => {
    const page = fakeZhihuPage();
    const forged: ScriptSkillManifest = {
      ...sampleSkill({ steps: [{ kind: 'clickOrFocus', selector: 'button.publish-btn:发布' }] }),
    } as any;
    await expect(ss.runSkillSteps(page, forged, {})).rejects.toThrow(/发布围栏/);
  });

  it('waitForSelector 超时 → 抛 timeoutError 文案;abortIfUrl 命中 → SkillAbort(登录引导)', async () => {
    // 快速超时:自建 2×10ms 的清单
    const page = fakeZhihuPage({ redirectLogin: false });
    (page.locator as any).mockReturnValue({ count: vi.fn(async () => 0), first: () => ({ focus: vi.fn() }) });
    const timeoutSkill = {
      ...sampleSkill({
        steps: [
          { kind: 'waitForSelector', selector: '#nope', retries: 2, intervalMs: 10, timeoutError: '编辑器未渲染,需人工核查' },
        ],
      }),
    } as any;
    await expect(ss.runSkillSteps(page, timeoutSkill, {})).rejects.toThrow('编辑器未渲染');

    // 重定向中止(先 goto 让假页面把 URL 置成 signin,再轮询触发 abortIfUrl)
    const redirectPage = fakeZhihuPage({ redirectLogin: true });
    const abortSkill = {
      ...sampleSkill({
        login: { homeUrl: 'https://www.zhihu.com/', cookieNames: ['z_c0'], hint: '请扫码登录' },
        steps: [
          { kind: 'goto', url: 'https://zhuanlan.zhihu.com/write' },
          { kind: 'waitForSelector', selector: '#x', retries: 2, intervalMs: 10, abortIfUrl: 'signin|login' },
        ],
      }),
    } as any;
    await expect(ss.runSkillSteps(redirectPage, abortSkill, {})).rejects.toMatchObject({
      userMessage: '请扫码登录',
      auditError: 'not_logged_in',
    });
  });

  it('waitForText optional:等不到不失败,旗标记 false', async () => {
    const page = fakeZhihuPage({ autosaveFails: true });
    const skill = {
      ...sampleSkill({
        steps: [{ kind: 'waitForText', pattern: '草稿|已保存', timeoutMs: 50, optional: true, flag: 'autosaved' }],
      }),
    } as any;
    const out = await ss.runSkillSteps(page, skill, {});
    expect(out.flags.autosaved).toBe(false);
  });
});

describe('renderSkillMessage · 模板', () => {
  it('{note:flag} 按旗标取文案;{todayCount}/{dailyLimit}/短参数替换;未知占位符原样保留', () => {
    const skill = sampleSkill({
      notes: { autosaved: { present: '已保存。', missing: '未确认。' } },
      successMessage: '{note:autosaved}标题「{title}」今日 {todayCount}/{dailyLimit} 次,{unknownKey} 完。',
    }) as any;
    const msg = ss.renderSkillMessage(skill, { title: '测试' }, { todayCount: 2, dailyLimit: 3 }, { autosaved: true });
    expect(msg).toBe('已保存。标题「测试」今日 2/3 次,{unknownKey} 完。');
    const msg2 = ss.renderSkillMessage(skill, { title: 'x'.repeat(200) }, { todayCount: 1, dailyLimit: 3 }, {
      autosaved: false,
    });
    expect(msg2).toContain('未确认。');
    expect(msg2).toContain('{title}'); // 超长参数不替换
  });
});

describe('随包 zhihu-draft.skill.json · 与内置工具的契约等价', () => {
  it('工具契约与 zhihu-managed 内置版一致(name/dangerLevel/compensation/parameters)', () => {
    const uid = 'ss-parity';
    optInZhihu(uid);
    const browser = fakeBrowser(fakeZhihuPage());
    const builtin = zm.buildZhihuManagedTools(uid, browser as any);
    const registry = ss.buildScriptSkillTools(uid, browser, { dir: SHIPPED_DIR }).tools;
    expect(builtin).toHaveLength(1);
    expect(registry).toHaveLength(1);
    expect(registry[0].name).toBe(builtin[0].name);
    expect(registry[0].name).toBe('zhihu_save_article_draft');
    expect(registry[0].dangerLevel).toBe(builtin[0].dangerLevel);
    expect(registry[0].compensation).toEqual(builtin[0].compensation);
    expect(registry[0].parameters).toEqual(builtin[0].parameters);
  });

  it('技能文件的选择器/步骤里不存在发布按钮(三层红线之二在注册表延续)', () => {
    const raw = fs.readFileSync(path.join(SHIPPED_DIR, 'zhihu-draft.skill.json'), 'utf-8');
    const manifest = JSON.parse(raw);
    const stepsDump = JSON.stringify(manifest.steps);
    expect(stepsDump).not.toMatch(/发布/);
    expect(stepsDump).not.toMatch(/publish|submit/i);
  });
});

describe('注册表版 zhihu_save_article_draft · execute 全链路', () => {
  const okArgs = { title: '测试文章标题', body: '这是一段足够长的正文内容,用于通过最少 20 字的校验门槛。' };

  function buildTool(uid: string, page: any, browser?: any) {
    optInZhihu(uid);
    const b = browser || fakeBrowser(page);
    const tools = ss.buildScriptSkillTools(uid, b, { dir: SHIPPED_DIR }).tools;
    return { tool: tools.find((t) => t.name === 'zhihu_save_article_draft')!, browser: b };
  }

  beforeEach(() => {
    delete process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT;
  });

  it('参数缺失 → 直接拒绝,不开浏览器不落审计', async () => {
    const uid = 'ss-t1';
    const page = fakeZhihuPage();
    const { tool, browser } = buildTool(uid, page);
    const res: any = await (tool.execute as any)({ title: '', body: '' }, { taskId: 'm1' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('必填');
    expect((browser.acquirePage as any).mock.calls.length).toBe(0);
    expect(us.getBrowserAudit(uid).length).toBe(0);
  });

  it('限频前置:今日已满 3 次 → rejected,不开浏览器不落审计;env 可上调', async () => {
    const uid = 'ss-t2';
    const page = fakeZhihuPage();
    const { tool, browser } = buildTool(uid, page);
    for (let i = 0; i < 3; i++) {
      us.appendBrowserAudit(uid, {
        at: Date.now(),
        tool: 'zhihu_save_article_draft',
        action: 'save_article_draft',
        result: i === 2 ? 'failure' : 'success',
      });
    }
    const before = us.getBrowserAudit(uid).length;
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm2' });
    expect(res.success).toBe(false);
    expect(res.rejected).toBe(true);
    expect(res.error).toContain('上限');
    expect((browser.acquirePage as any).mock.calls.length).toBe(0);
    expect(us.getBrowserAudit(uid).length).toBe(before);
  });

  it('未登录(cookie 缺失)→ not_logged_in,不开浏览器,审计落 failure', async () => {
    const uid = 'ss-t3';
    const page = fakeZhihuPage();
    const browser = fakeBrowser(page, { hasCookies: false });
    const { tool } = buildTool(uid, page, browser);
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm3' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('扫码');
    expect((browser.acquirePage as any).mock.calls.length).toBe(0);
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('failure');
    expect(audit[0].error).toBe('not_logged_in');
    expect(audit[0].missionId).toBe('m3');
  });

  it('goto 后被重定向回 signin → not_logged_in(登录态导航后失效)', async () => {
    const uid = 'ss-t4';
    const page = fakeZhihuPage({ redirectLogin: true });
    const { tool } = buildTool(uid, page);
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm4' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('扫码');
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('failure');
    expect(audit[0].error).toBe('not_logged_in');
  }, 30000);

  it('成功链路(富文本粘贴被接受):填标题 → 合成 paste 双份数据 → 审计 success', async () => {
    const uid = 'ss-t5';
    const page = fakeZhihuPage({ editorText: '正文已粘贴进编辑器' });
    const { tool } = buildTool(uid, page);
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm5' });
    expect(res.success).toBe(true);
    expect(res.title).toBe(okArgs.title);
    expect(res.message).toContain('今日已用 1/3');
    expect(res.message).toContain('发布由你本人完成');
    expect(res.message).toContain('富文本排版粘贴');
    expect(res.message).toContain('平台已自动保存进草稿箱');
    expect(res.screenshotBase64).toContain('data:image/jpeg;base64,');
    expect(page.fill).toHaveBeenCalledWith('textarea[placeholder*="标题"]', okArgs.title, expect.anything());
    expect(page.keyboard.press).toHaveBeenCalledWith('Control+a');
    // pasteRich:text/html(语义标签)+ text/plain(排版化纯文本)双份数据派给编辑器
    const [fn, arg] = (page.evaluate as any).mock.calls[0];
    expect(arg.html).toBe('<p>这是一段足够长的正文内容,用于通过最少 20 字的校验门槛。</p>');
    expect(arg.plain).toBe(okArgs.body);
    expect(typeof fn).toBe('function');
    // 编辑器认了合成 paste → 不走 insertText 兜底
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('success');
    expect(audit[0].tool).toBe('zhihu_save_article_draft');
    expect(audit[0].action).toBe('save_article_draft');
    expect(audit[0].title).toBe(okArgs.title);
    expect(audit[0].missionId).toBe('m5');
  }, 30000);

  it('编辑器不认合成 paste(仍空)→ 回退排版化纯文本,消息如实告知,审计带附注', async () => {
    const uid = 'ss-t5b';
    const page = fakeZhihuPage(); // editorText 空 → 校验判定粘贴未落
    const { tool } = buildTool(uid, page);
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm5b' });
    expect(res.success).toBe(true);
    expect(res.message).toContain('回退为排版化纯文本');
    expect(page.keyboard.insertText).toHaveBeenCalledWith(okArgs.body);
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('success');
    expect(audit[0].error).toContain('富文本粘贴未被接受');
  }, 30000);

  it('自动保存指示未出现 → 仍算成功,消息如实告知未确认,审计带附注', async () => {
    const uid = 'ss-t6';
    const page = fakeZhihuPage({ autosaveFails: true, editorText: '正文已粘贴进编辑器' });
    const { tool } = buildTool(uid, page);
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'm6' });
    expect(res.success).toBe(true);
    expect(res.message).toContain('自动保存未确认');
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('success');
    expect(audit[0].error).toContain('未等到自动保存指示');
  }, 30000);

  it('每日上限 env 覆盖清单缺省值(AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT)', async () => {
    const uid = 'ss-t7';
    const page = fakeZhihuPage();
    const { tool } = buildTool(uid, page);
    process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT = '1';
    us.appendBrowserAudit(uid, {
      at: Date.now(),
      tool: 'zhihu_save_article_draft',
      action: 'save_article_draft',
      result: 'success',
    });
    try {
      const res: any = await (tool.execute as any)(okArgs, { taskId: 'm7' });
      expect(res.success).toBe(false);
      expect(res.rejected).toBe(true);
      expect(res.error).toContain('1 次');
    } finally {
      delete process.env.AGTPILOT_ZHIHU_DRAFT_DAILY_LIMIT;
    }
  });
});

describe('随包 fanqie-draft.skill.json · 番茄章节存草稿', () => {
  /** 番茄编辑器假 Page:.editor-title/.editor-content/新建章节/存草稿 可寻,其余不可寻 */
  function fakeFanqiePage(opts: { redirectLogin?: boolean; savedFails?: boolean } = {}) {
    const state = { url: 'about:blank' };
    const FINDABLE = ['.editor-title', '新建章节', 'editor-content', '存草稿'];
    return {
      goto: vi.fn(async (url: string) => {
        state.url = opts.redirectLogin
          ? 'https://fanqienovel.com/main/writer/login?next=%2Fchapter-manage'
          : url;
      }),
      url: vi.fn(() => state.url),
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
      evaluate: vi.fn(async () => true),
      locator: vi.fn((sel: string) => {
        const visible = FINDABLE.some((k) => String(sel).includes(k)) && !opts.redirectLogin;
        return {
          count: vi.fn(async () => (visible ? 1 : 0)),
          first: () => ({ focus: vi.fn(async () => {}), innerText: vi.fn(async () => '') }),
        };
      }),
      keyboard: {
        insertText: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
      },
      getByText: vi.fn(() => ({
        first: () => ({
          waitFor: vi.fn(async () => {
            if (opts.savedFails) throw new Error('timeout');
          }),
        }),
      })),
      screenshot: vi.fn(async () => Buffer.from('jpeg-bytes')),
    };
  }

  function optInFanqie(uid: string) {
    us.saveFanqieManaged(uid, { enabled: true, riskAckAt: Date.now(), lastLoginAt: Date.now() });
  }

  const okArgs = {
    bookId: '7123456789',
    title: '第12章 风起',
    body: '这是一段足够长的章节正文内容,远超最少五十字的校验门槛;下面还有一个独立标题行与一段加粗,用于验证 markdown-plain 转换会把它们全部剥成排版化纯文本再填入编辑器,不留任何 Markdown 原文。\n\n## 小节\n\n这行属于小节,加粗记号 **强调** 也一并剥除。',
  };

  it('清单合格且步骤里不存在发布词(三层红线之二)', () => {
    const raw = fs.readFileSync(path.join(SHIPPED_DIR, 'fanqie-draft.skill.json'), 'utf-8');
    const manifest = JSON.parse(raw);
    expect(ss.validateScriptSkill(manifest)).toBeNull();
    const stepsDump = JSON.stringify(manifest.steps);
    expect(stepsDump).not.toMatch(/发布/);
    expect(stepsDump).not.toMatch(/publish|submit/i);
  });

  it('注入门:未 opt-in 不注入;opt-in 后注入且 dangerLevel 为 low(用户拍板免逐次审批)', () => {
    const uid = 'ss-fq-gate';
    const browser = fakeBrowser(fakeFanqiePage());
    expect(ss.buildScriptSkillTools(uid, browser, { dir: SHIPPED_DIR }).tools).toHaveLength(0);
    optInFanqie(uid);
    const tools = ss.buildScriptSkillTools(uid, browser, { dir: SHIPPED_DIR }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['fanqie_create_book', 'fanqie_save_chapter_draft']);
    for (const t of tools) expect(t.dangerLevel).toBe('low');
  });

  it('execute 全链路:URL 模板替换 → 填标题 → 正文剥 Markdown → 存草稿 → 审计 success', async () => {
    const uid = 'ss-fq-run';
    const page = fakeFanqiePage();
    optInFanqie(uid);
    const tools = ss.buildScriptSkillTools(uid, fakeBrowser(page), { dir: SHIPPED_DIR }).tools;
    const tool = tools.find((t: any) => t.name === 'fanqie_save_chapter_draft')!;
    const res: any = await (tool.execute as any)(okArgs, { taskId: 'mf1' });
    expect(res.success).toBe(true);
    // goto params 模板替换:bookId 填进 chapter-manage 路径
    expect(page.goto).toHaveBeenCalledWith(
      `https://fanqienovel.com/main/writer/chapter-manage/${okArgs.bookId}`,
      expect.anything()
    );
    expect(page.fill).toHaveBeenCalledWith('.editor-title', okArgs.title, expect.anything());
    expect(page.keyboard.press).toHaveBeenCalledWith('Control+a');
    // insertText + markdown-plain:Markdown 记号被剥除(标题 ▍ 前缀,不再有 ##)
    const inserted = (page.keyboard.insertText as any).mock.calls[0][0] as string;
    expect(inserted).toContain('章节正文内容');
    expect(inserted).not.toContain('##');
    // 点了「存草稿」按钮;保存确认出现 → 旗标 true → 消息用 present 文案
    expect(page.click).toHaveBeenCalledWith('button:has-text("存草稿")', expect.anything());
    expect(res.message).toContain('章节管理 → 草稿箱立即可见');
    expect(res.message).toContain('发布/定时发布由你本人');
    expect(res.message).toContain('今日已用 1/10'); // 2026-10-16 拍板:全自动同步下番茄每日上限 3→10
    expect(res.screenshotBase64).toContain('data:image/jpeg;base64,');
    const audit = us.getBrowserAudit(uid);
    expect(audit[0]).toMatchObject({
      result: 'success',
      tool: 'fanqie_save_chapter_draft',
      action: 'save_chapter_draft',
      title: okArgs.title,
      missionId: 'mf1',
    });
  }, 30000);

  it('保存确认未出现 → 仍算成功,消息如实引导人工核对草稿箱', async () => {
    const uid = 'ss-fq-unconfirmed';
    const page = fakeFanqiePage({ savedFails: true });
    optInFanqie(uid);
    const tools = ss.buildScriptSkillTools(uid, fakeBrowser(page), { dir: SHIPPED_DIR }).tools;
    const draftTool = tools.find((t: any) => t.name === 'fanqie_save_chapter_draft')!;
    const res: any = await (draftTool.execute as any)(okArgs, { taskId: 'mf2' });
    expect(res.success).toBe(true);
    expect(res.message).toContain('保存确认未出现');
    const audit = us.getBrowserAudit(uid);
    expect(audit[0].result).toBe('success');
    expect(String(audit[0].error || '')).toContain('未等到保存确认');
  }, 30000);

  it('goto 后被重定向回登录 → not_logged_in(登录引导,审计 failure)', async () => {
    const uid = 'ss-fq-login';
    const page = fakeFanqiePage({ redirectLogin: true });
    optInFanqie(uid);
    const tools = ss.buildScriptSkillTools(uid, fakeBrowser(page), { dir: SHIPPED_DIR }).tools;
    const draftTool = tools.find((t: any) => t.name === 'fanqie_save_chapter_draft')!;
    const res: any = await (draftTool.execute as any)(okArgs, { taskId: 'mf3' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('扫码');
    const audit = us.getBrowserAudit(uid);
    expect(audit[0]).toMatchObject({ result: 'failure', error: 'not_logged_in' });
  }, 30000);

  it('开书技能全链路:填书名+点频道 radio+立即创建 → 捕获落地页书号;AI 声明缺席如实注记', async () => {
    const uid = 'ss-fq-create';
    optInFanqie(uid);
    let url = 'https://fanqienovel.com/main/writer/create?enter_from=home';
    const clicks: string[] = [];
    const fills: Array<[string, string]> = [];
    const page: any = {
      goto: async (u: string) => {
        url = u;
      },
      url: () => url,
      fill: async (sel: string, val: string) => {
        fills.push([sel, val]);
      },
      click: async (sel: string) => {
        clicks.push(sel);
        // 提交成功 → 落地 /book-info/<书号>(commit 6 侦察挖到的 onSuccess 路由)
        if (sel.includes('立即创建')) url = 'https://fanqienovel.com/main/writer/book-info/7712345?type=1';
      },
      locator: (sel: string) => ({
        count: async () => (sel.includes('#name_input') ? 1 : 0),
        first: () => ({ focus: async () => {} }),
      }),
      keyboard: { press: async () => {}, insertText: async () => {} },
      screenshot: vi.fn(async () => Buffer.from('jpeg-bytes')),
    };
    const tools = ss.buildScriptSkillTools(uid, fakeBrowser(page), { dir: SHIPPED_DIR }).tools;
    const tool = tools.find((t: any) => t.name === 'fanqie_create_book')!;
    const res: any = await (tool.execute as any)(
      { title: '我以杀伐换长生', intro: '', channel: '男频' },
      { taskId: 'mf4' }
    );
    expect(res.success).toBe(true);
    expect(res.captures?.fanqieBookId).toBe('7712345');
    // 频道 enum 闭集插值进 radio label;简介空串 = 留空(选填不凑字)
    expect(clicks).toContain('#radio label.arco-radio:has-text("男频")');
    expect(clicks).toContain('button:has-text("立即创建")');
    expect(fills).toEqual([
      ['#name_input input', '我以杀伐换长生'],
      ['#descRow_input textarea', ''],
    ]);
    // AI 辅助声明入口缺席(2026-10-16 侦察事实)→ 三态注记走 missing 如实说明
    expect(res.message).toContain('书号 7712345');
    expect(res.message).toContain('本次建书页无 AI 辅助声明入口');
    const audit = us.getBrowserAudit(uid);
    expect(audit[0]).toMatchObject({ result: 'success', action: 'create_book' });
  }, 30000);
});
