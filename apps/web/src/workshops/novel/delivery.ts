/**
 * novel 工坊 · 逐字段交付契约(计划「novel 工坊逐字段交付」)
 *
 * 背景:开书设定包/大纲包曾是"单轮巨型文本契约"(一次生成扛书名/卖点/设定集/
 * 人物卡全部决策),推理模型单步思考 47k 字符、正文 0 字(生产 mission n6185)。
 * 改为每字段一步小生成 + workshop_deliver_field 工具交付:思考被切段有界、
 * 前端按工具步 args 逐字段点亮、校验失败即时反馈重试。
 *
 * 边界:本文件进客户端 bundle(skill.ts ← registry.ts ← 客户端组件),
 * 只放纯数据 + 纯函数校验器引用;novel-store(fs)访问绝不进 spec——
 * 书号的服务端权威校验(getNovelBook)由 lib/workshop-delivery.ts 的 deps 注入。
 */
import type { DeliverableFieldSpec, DeliveryContract } from '../types';
import { validateDeliverField } from './novel-package';

export const NOVEL_BIBLE_CONTRACT_ID = 'novel_bible';
export const NOVEL_OUTLINE_CONTRACT_ID = 'novel_outline';

/**
 * 灰度保险丝(仿 AGTPILOT_WORKSHOP_TOOLS=0):置 '0' 整体回退 legacy 单轮
 * 巨文本契约(模板/工具挂载/交付声明同退)。客户端 bundle 里 process.env
 * 无此变量 → 缺省启用;权威判定发生在服务端渲染/派发一侧。
 */
export function novelFieldDeliveryEnabled(): boolean {
  return process.env.AGTPILOT_NOVEL_FIELD_DELIVERY !== '0';
}

/** 字段校验器绑定:spec.validate = 该契约该字段的纯函数校验 */
function field(contractId: string, key: string, required: boolean, hint: string, label?: string): DeliverableFieldSpec {
  return {
    key,
    label: label || key,
    required,
    hint,
    validate: (content: string) => validateDeliverField(contractId, key, content),
  };
}

/** 开书第一步 · 设定包字段(顺序即建议交付顺序,模型可自主调整) */
const BIBLE_FIELDS: DeliverableFieldSpec[] = [
  field(NOVEL_BIBLE_CONTRACT_ID, '书名', true, '仅一行:拍板的书名(不带书名号,12 字以内优先,有题材感与钩子,不要候选清单)'),
  field(NOVEL_BIBLE_CONTRACT_ID, '卖点', true, '一句话题材卖点:卖什么、给谁看、爽在哪'),
  field(NOVEL_BIBLE_CONTRACT_ID, '设定集', true, '世界观 markdown:世界规则/力量体系(写死层级与上限)/势力与地理/关键道具术语'),
  field(NOVEL_BIBLE_CONTRACT_ID, '人物卡', true, '主要人物 4-8 人:「## 姓名」起卡,逐行 - 定位:/外貌:/性格:/动机:/口癖:/关系:/弧光:'),
  field(NOVEL_BIBLE_CONTRACT_ID, '作品简介', true, '150-300字读者向简介:平台书页口吻,抛核心钩子,不剧透设定期之后的剧情'),
  field(NOVEL_BIBLE_CONTRACT_ID, '题材', false, '仅一行:回显本任务给定的题材'),
  field(NOVEL_BIBLE_CONTRACT_ID, '文风锚', false, '仅一行:回显本任务给定的文风锚原文,不增删改'),
  field(NOVEL_BIBLE_CONTRACT_ID, '每章字数', false, '仅一行:回显本任务给定的每章字数数字'),
];

/** 开书第二步 · 大纲包字段 */
const OUTLINE_FIELDS: DeliverableFieldSpec[] = [
  field(NOVEL_OUTLINE_CONTRACT_ID, '书号', false, '仅一行:原样回显任务给定的目标书号(nv_ 开头,别改;入库对账用)'),
  field(NOVEL_OUTLINE_CONTRACT_ID, '粗纲', true, '全书粗纲 500-2000 字:起承转合主线 + 分卷规划(每卷目标/主要冲突/卷末钩子)'),
  field(NOVEL_OUTLINE_CONTRACT_ID, '细纲', true, '前 10-15 章细纲池:「### 第N章 标题」起条,逐行 - 钩子:/事件:/情绪点:/伏笔:/字数:'),
  field(NOVEL_OUTLINE_CONTRACT_ID, '伏笔', false, '开篇伏笔台账:每行「- [埋设] 内容 @第N章」;没有则只输出「无」'),
  field(NOVEL_OUTLINE_CONTRACT_ID, '时间线', false, '时间线年表框架:每行「- 第N章|故事内时间|关键事件」'),
];

export const NOVEL_DELIVERY_CONTRACTS: Record<string, DeliveryContract> = {
  [NOVEL_BIBLE_CONTRACT_ID]: { id: NOVEL_BIBLE_CONTRACT_ID, fields: BIBLE_FIELDS },
  [NOVEL_OUTLINE_CONTRACT_ID]: { id: NOVEL_OUTLINE_CONTRACT_ID, fields: OUTLINE_FIELDS },
};

/**
 * 契约 id → 完整 spec 现场重建(mission 只持久化 {id,fields:[{key,label,required}]}
 * 可序列化投影;validator 是函数,续聊/重启后凭 id 从这里取回)。
 */
export function resolveDeliveryContract(id: string): DeliveryContract | undefined {
  return NOVEL_DELIVERY_CONTRACTS[id];
}

/** 契约 id → 包 kind(渐进卡路由不靠解析锚判定,半包不会误命中) */
export function deliveryContractKind(id: string): 'genesis_bible' | 'genesis_outline' | null {
  if (id === NOVEL_BIBLE_CONTRACT_ID) return 'genesis_bible';
  if (id === NOVEL_OUTLINE_CONTRACT_ID) return 'genesis_outline';
  return null;
}
