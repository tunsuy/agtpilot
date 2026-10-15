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

/** 通用假 Page(按选择器控制可寻性;url 可被 goto 改写) */
function fakePage(opts: { redirectLogin?: boolean; textFails?: boolean } = {}) {
  const state = { url: 'about:blank' };
  return {
    goto: vi.fn(async (url: string) => {
      state.url = opts.redirectLogin ? 'https://www.example.com/signin?next=%2Fwrite' : url;
    }),
    url: vi.fn(() => state.url),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    locator: vi.fn((sel: string) => {
      const visible = String(sel).includes('#editor');
      return {
        count: vi.fn(async () => (visible && !opts.redirectLogin ? 1 : 0)),
        first: () => ({ focus: vi.fn(async () => {}) }),
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

  it('insertText/fill 的 markdown-plain 转换:填入的是转出的纯文本,不是 Markdown 原文', async () => {
    const skill = sampleSkill({
      steps: [
        { kind: 'fill', selector: '#editor', param: 'title', transform: 'markdown-plain' },
        { kind: 'insertText', param: 'body', transform: 'markdown-plain' },
      ],
    }) as any;
    const page = fakePage();
    await runSkillSteps(page, skill, { title: '**粗**标题', body: '## 小节\n- 要点' });
    expect(page.fill).toHaveBeenCalledWith('#editor', '粗标题', expect.anything());
    expect(page.keyboard.insertText).toHaveBeenCalledWith('小节\n• 要点');
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
