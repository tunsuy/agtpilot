/**
 * novel 逐字段交付契约测试(计划「novel 工坊逐字段交付」Phase 1)
 *
 * 锁:契约字段 key 与模板交付说明里的字段名一一对应(模型按 enum 交付,漂移即打回);
 * resolveDeliveryContract / deliveryContractKind 映射;灰度保险丝现读 process.env。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  NOVEL_DELIVERY_CONTRACTS,
  NOVEL_BIBLE_CONTRACT_ID,
  NOVEL_OUTLINE_CONTRACT_ID,
  resolveDeliveryContract,
  deliveryContractKind,
  novelFieldDeliveryEnabled,
} from '../delivery';
import { buildNovelGenesisBiblePrompt, buildNovelGenesisOutlinePrompt } from '../context';
import { NOVEL_STYLES } from '../context';
import type { NovelBook } from '@/lib/novel-context';

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeBook(): NovelBook {
  return {
    bookId: 'nv_test01_a1b2c3',
    title: '铁拳少年',
    genre: '都市',
    premise: '外卖骑手捡到预知差评的手机',
    style: '爽文快节奏',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    progress: { chapterCount: 0, wordCount: 0, nextChapter: 1 },
    bible: '力量体系:青铜→白银→黄金。',
    characters: [{ name: '林凡', role: '主角' }],
    detailed: [],
    ledgerSeeds: [],
    timelineSeeds: [],
    chapters: [],
  } as unknown as NovelBook;
}

describe('NOVEL_DELIVERY_CONTRACTS', () => {
  it('设定包契约字段 = 模板交付说明里的字段名(逐个出现在 prompt 里)', () => {
    const contract = NOVEL_DELIVERY_CONTRACTS[NOVEL_BIBLE_CONTRACT_ID];
    expect(contract.fields.map((f) => f.key)).toEqual(['书名', '卖点', '设定集', '人物卡', '作品简介', '题材', '文风锚', '每章字数']);
    const p = buildNovelGenesisBiblePrompt({ genre: '都市', style: NOVEL_STYLES[0], chapterWords: 3000 });
    for (const f of contract.fields) {
      expect(p).toContain(f.key);
    }
    // required 标记:书名/卖点/设定集/人物卡/作品简介 必交付
    const required = contract.fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(['书名', '卖点', '设定集', '人物卡', '作品简介']);
  });

  it('大纲包契约字段 = 模板交付说明里的字段名', () => {
    const contract = NOVEL_DELIVERY_CONTRACTS[NOVEL_OUTLINE_CONTRACT_ID];
    expect(contract.fields.map((f) => f.key)).toEqual(['书号', '粗纲', '细纲', '伏笔', '时间线']);
    const p = buildNovelGenesisOutlinePrompt({ book: makeBook(), chapterWords: 3000 });
    for (const f of contract.fields) {
      expect(p).toContain(f.key);
    }
    const required = contract.fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(['粗纲', '细纲']);
  });

  it('每字段都绑定纯函数 validate(spec.validate 可调)', () => {
    for (const c of Object.values(NOVEL_DELIVERY_CONTRACTS)) {
      for (const f of c.fields) {
        expect(typeof f.validate).toBe('function');
        expect(Array.isArray(f.validate!(''))).toBe(true);
      }
    }
  });
});

describe('resolveDeliveryContract / deliveryContractKind', () => {
  it('按 id 取回完整 spec(续聊/重启重建钥匙)', () => {
    expect(resolveDeliveryContract(NOVEL_BIBLE_CONTRACT_ID)?.id).toBe(NOVEL_BIBLE_CONTRACT_ID);
    expect(resolveDeliveryContract(NOVEL_OUTLINE_CONTRACT_ID)?.fields.length).toBeGreaterThan(0);
    expect(resolveDeliveryContract('不存在')).toBeUndefined();
  });

  it('契约 id → 包 kind 映射(渐进卡路由不靠解析锚)', () => {
    expect(deliveryContractKind(NOVEL_BIBLE_CONTRACT_ID)).toBe('genesis_bible');
    expect(deliveryContractKind(NOVEL_OUTLINE_CONTRACT_ID)).toBe('genesis_outline');
    expect(deliveryContractKind('不存在')).toBeNull();
  });
});

describe('novelFieldDeliveryEnabled · 灰度保险丝', () => {
  it('缺省启用;置 0 关闭(现读 process.env)', () => {
    expect(novelFieldDeliveryEnabled()).toBe(true);
    vi.stubEnv('AGTPILOT_NOVEL_FIELD_DELIVERY', '0');
    expect(novelFieldDeliveryEnabled()).toBe(false);
    vi.stubEnv('AGTPILOT_NOVEL_FIELD_DELIVERY', '1');
    expect(novelFieldDeliveryEnabled()).toBe(true);
  });
});
