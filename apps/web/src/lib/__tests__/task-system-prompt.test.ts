import { describe, expect, it } from 'vitest';
import { buildTaskSystemPrompt } from '../task-system-prompt';

/**
 * loop 执行优化 P6:系统提示的并行检索指引。
 * 生产实测:热点日报 8 轮串行搜索每轮只发一个 query,而泛化的
 * 「独立调用并行发出」不足以改变检索行为 —— 必须给出具体操作指引
 * (拆多角度关键词/信息源,一轮批量发起)。
 */
describe('buildTaskSystemPrompt', () => {
  it('规则 6 给出独立检索的具体并行指引(拆角度→一轮批量→结果齐再汇总)', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('一轮批量发起');
    expect(s).toContain('每轮只发一个查询');
    expect(s).toContain('多角度');
  });

  it('行为准则完整保留(防调优中丢失红线)', () => {
    const s = buildTaskSystemPrompt();
    for (const keyword of [
      'AgtPilot',
      '区分对话与执行',
      '连接器工具优先',
      '中途授权',
      '结构化交付',
      '步数经济',
      '看板规划',
      '受控进展播报',
      '小红书托管边界',
      '公众号草稿箱边界',
      '先问后猜', // 模糊需求提问卡(ask_user)
      '计划确认', // 大任务方案批准门(confirm_plan)
      '后台子任务', // 长任务后台化(launch_background_task)
      '发布永远由用户本人', // 小红书发布合规红线
      'freepublish', // 公众号群发红线
    ]) {
      expect(s).toContain(keyword);
    }
  });

  /**
   * 看板规划优化(对照 CC/Codex/Manus 公开实践):
   * - 正面触发清单(旧版只有反面清单「不要」,判「该」靠感觉)
   * - 「先规划后执行」时序(旧版没约束建板发生在动手之前)
   * - 追问注入后的重建语义(配合 steering 特性:【用户追加消息】改向时重建看板)
   */
  it('看板规划规则给出正面触发清单、规划先行时序与追问改向重建语义', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('三个以上异构动作'); // 正面触发判据
    expect(s).toContain('多个待办事项'); // 一条消息多事项也触发
    expect(s).toContain('再开始执行第一个动作'); // 先规划后执行
    expect(s).toContain('【用户追加消息】'); // steering 改向重建
    expect(s).toContain('重建看板'); // 重建出口
    // 看板策略已从步数经济里拆出独立规则(两条各自一个注意力锚点)
    expect(s.indexOf('【步数经济】')).toBeGreaterThan(0);
    expect(s.indexOf('【看板规划】')).toBeGreaterThan(s.indexOf('【步数经济】'));
  });

  /**
   * 看板契约切换(2026-10,对照 Claude Code TodoWrite / Codex update_plan):
   * 进度从「工具成功自动推进」的服务器猜测改为模型显式申报 ——
   * 完成立即同批打勾、单一 in_progress、严禁单独汇报轮(步数膨胀老路)。
   * 旧文案的「自动推进/不要调用」必须清干净,防两套合同并存。
   */
  it('看板维护合同:显式申报、同批更新、立即打勾、禁单独汇报轮;旧的自动推进承诺已清除', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('看板状态由你维护');
    expect(s).toContain('【同一批】');
    expect(s).toContain('立即'); // 完成即勾不攒批
    expect(s).toContain('恰好一个 in_progress');
    expect(s).toContain('严禁为汇报进度单独花一轮');
    // 旧合同反向断言:服务器自动推进的承诺不再出现
    expect(s).not.toContain('自动推进');
    expect(s).not.toContain('【不要】调用 planner_update_task');
  });

  it('受控进展播报:开题确认 + 阶段报告两点位,正文通道,无逐工具碎语(原「安静执行」升级)', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('【受控进展播报】');
    expect(s).toContain('继续'); // 续聊"继续"也要确认目标与路线
    expect(s).toContain('阶段报告'); // 关键阶段节点出口
    expect(s).toContain('必须输出在正文里'); // 推理模型会把应答吞进思考流,显式约束通道
    // 反面清单仍在:逐工具碎语依旧禁止
    expect(s).toContain('过程碎语');
  });

  /**
   * 存草稿发起边界(生产实测:模型写完笔记看到托管已开启,未经用户
   * 要求直接调 xhs_save_note_draft,审批卡一弹用户顺手通过,草稿就
   * 存了 —— 审批卡是执行确认,被当成了发起授权)。规则 9/10 补上
   * 「谁发起」:用户明确要求/卡片按钮触发才调,交付成品时停在成品。
   */
  it('存草稿发起权在用户:明确要求才调,交付成品不主动存;审批卡≠发起授权', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('只在用户明确要求时');
    expect(s).toContain('不要未经要求主动存草稿');
    expect(s).toContain('不等于发起授权');
    expect(s).toContain('不要未经要求主动写入'); // 公众号同款边界
  });

  it('用户记忆块按需插值:有值时插入、缺省时无空占位', () => {
    const withMemory = buildTaskSystemPrompt('【用户记忆】偏好中文交付');
    expect(withMemory).toContain('【用户记忆】偏好中文交付');
    const without = buildTaskSystemPrompt();
    expect(without).not.toContain('undefined');
    // 两次无记忆调用输出恒定(提示前缀稳定 = provider 缓存可命中)
    expect(without).toBe(buildTaskSystemPrompt());
  });

  it('思考经济规则锚定(推理模型不预演执行细节,生产实测 7.5 分钟过度思考修复)', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('【思考经济】');
    expect(s).toContain('脑内模拟不产生任何核验价值');
    expect(s).toContain('够决定下一步动作');
    // 规则编号连续:排在时效基准(11)之后
    expect(s.indexOf('【思考经济】')).toBeGreaterThan(s.indexOf('【时效基准】'));
  });

  /**
   * 先问后猜(ask_user 问题卡):模糊 query 逐个方向试探是 token 黑洞 ——
   * 正面触发判据(多种合理解读 + 影响交付方向)与反面防滥问清单
   * (查证优先/琐事拍板/次数上限/禁假选项)缺一不可。
   * 多问打包(至多 3 问一张卡)防拆多轮:对齐 Claude Code AskUserQuestion 的
   * questions[] 设计,一次问清方向/范围/形式,省模型往返。
   */
  it('规则 13 给出提问触发判据、多问打包上限与防滥问反面约束', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('【先问后猜】');
    expect(s).toContain('ask_user');
    expect(s).toContain('2-4 个互斥的具体选项'); // 选项契约
    expect(s).toContain('recommended'); // 推荐项标注
    expect(s).toContain('multi_select'); // 多选问
    expect(s).toContain('preview'); // 选项对照物
    expect(s).toContain('至多 3 个'); // 多问打包上限
    expect(s).toContain('一次打包问清就不要拆成多轮'); // 打包优先
    expect(s).toContain('同一任务提问不超过 2 次'); // 次数上限
    expect(s).toContain('能自行检索/查证的事项先查证'); // 查证优先
    expect(s).toContain('严禁再问'); // 已明确内容不重复问
    expect(s).toContain('假选项'); // 反面:没有真分歧不弹卡
    // 规则编号连续:排在思考经济(12)之后
    expect(s.indexOf('【先问后猜】')).toBeGreaterThan(s.indexOf('【思考经济】'));
  });

  /**
   * 计划确认门(confirm_plan,对齐 Claude Code ExitPlanMode 的方案批准):
   * 与提问分轨 —— 提问是参数级澄清可多次,确认是方案级批准每任务一次;
   * 反面约束(小任务禁调/用户说直接做禁调/修改后不二次确认)防确认疲劳。
   */
  it('规则 14 给出计划确认触发面、单次上限与防确认疲劳反面约束', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('【计划确认】');
    expect(s).toContain('confirm_plan');
    expect(s).toContain('开始执行前'); // 建板后动手前的时序
    expect(s).toContain('同一任务至多确认一次'); // 单次上限
    expect(s).toContain('不要再弹卡二次确认'); // 修改意见直接改完执行
    expect(s).toContain('严禁调用'); // 小任务/闲聊/「直接做」禁调
    expect(s).toContain('先走【先问后猜】问清'); // 与提问分轨:方向不清先问再出计划
    // 规则编号连续:排在先问后猜(13)之后
    expect(s.indexOf('【计划确认】')).toBeGreaterThan(s.indexOf('【先问后猜】'));
  });

  /**
   * 后台子任务(docs/design/background-child-missions.md,对齐 Claude Code
   * run_in_background):正面触发判据(长耗时+独立)+ 通知送达语义(【后台
   * 任务通知】)+ 反面约束(严禁空等/goal 自包含/禁重复派发/禁链式派发)。
   * 没有这条规则时模型的典型失败:派发后反复轮询空转,或把强耦合的下一步
   * 也丢进后台导致主线断档。
   */
  it('规则 15 给出后台子任务触发判据、严禁空等与通知整合语义', () => {
    const s = buildTaskSystemPrompt();
    expect(s).toContain('【后台子任务】');
    expect(s).toContain('launch_background_task');
    expect(s).toContain('【后台任务通知】'); // 通知送达通道名与注入前缀一致
    expect(s).toContain('严禁】空转等待'); // 派发后先干别的
    expect(s).toContain('goal 必须自包含'); // 子任务看不到父上下文
    expect(s).toContain('不能向用户提问'); // unattended 语义
    expect(s).toContain('整合进当前任务'); // 收通知后的动作
    expect(s).toContain('不要重复派发同一子任务');
    expect(s).toContain('不要原样重试'); // 失败改道
    expect(s).toContain('不超过 4 个'); // 并发闸与工具侧一致
    // 规则编号连续:排在计划确认(14)之后
    expect(s.indexOf('【后台子任务】')).toBeGreaterThan(s.indexOf('【计划确认】'));
  });
});
