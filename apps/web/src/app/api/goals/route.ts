import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getUserGoals, saveUserGoal, deleteUserGoal, getUserConnectors } from '@/lib/user-store';

/**
 * GET /api/goals
 * 获取当前登录用户的长期目标与里程碑列表
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录' },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const goals = getUserGoals(userId);

    return NextResponse.json({
      success: true,
      total: goals.length,
      goals,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/goals
 * 创建、修改、删除目标，切换里程碑状态，或调用 AI 进行智能目标拆解
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: 请先登录' },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const body = await req.json();
    const { action } = body;

    // 1. AI 智能拆解里程碑
    if (action === 'decompose') {
      const { title, description } = body;
      if (!title) {
        return NextResponse.json({ success: false, error: '目标标题不能为空' }, { status: 400 });
      }

      let milestones: any[] = [];
      const userConns = getUserConnectors(userId);
      const activeModel = userConns.activeModelId || 'deepseek';
      
      let apiKey = '';
      let baseURL = '';
      let model = 'deepseek-chat';

      if (activeModel === 'custom_llm') {
        apiKey = userConns.configs['CUSTOM_LLM_API_KEY'] || process.env.CUSTOM_LLM_API_KEY || '';
        baseURL = userConns.configs['CUSTOM_LLM_BASE_URL'] || process.env.CUSTOM_LLM_BASE_URL || '';
        model = userConns.configs['CUSTOM_LLM_MODEL_NAME'] || process.env.CUSTOM_LLM_MODEL_NAME || 'gpt-4o';
      } else if (activeModel === 'openai') {
        apiKey = userConns.configs['OPENAI_API_KEY'] || process.env.OPENAI_API_KEY || '';
        baseURL = userConns.configs['OPENAI_BASE_URL'] || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        model = userConns.configs['OPENAI_MODEL_NAME'] || process.env.OPENAI_MODEL_NAME || 'gpt-4o';
      } else {
        apiKey = userConns.configs['DEEPSEEK_API_KEY'] || process.env.DEEPSEEK_API_KEY || '';
        baseURL = userConns.configs['DEEPSEEK_BASE_URL'] || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
        model = userConns.configs['DEEPSEEK_MODEL_NAME'] || process.env.DEEPSEEK_MODEL_NAME || 'deepseek-chat';
      }

      if (apiKey && baseURL) {
        try {
          const cleanBase = baseURL.replace(/\/+$/, '');
          const url = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
          
          const aiRes = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: 'system',
                  content:
                    '你是一个顶尖的个人智能体战略参谋。请帮主人将长期目标科学拆解为 3 至 4 个循序渐进的阶段性里程碑。严格只输出 JSON 数组，严禁包含任何 Markdown 格式或额外解释说明。格式规范：[{"title": "阶段名称", "description": "具体成果或关键行动"}]',
                },
                {
                  role: 'user',
                  content: `目标：${title}\n详细背景：${description || '无'}`,
                },
              ],
              temperature: 0.7,
            }),
          });

          if (aiRes.ok) {
            const data = await aiRes.json();
            const rawContent = data.choices?.[0]?.message?.content || '';
            const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (Array.isArray(parsed)) {
                milestones = parsed.map((m: any, idx: number) => ({
                  id: `ms_${Date.now()}_${idx}`,
                  title: m.title || `阶段 ${idx + 1}`,
                  description: m.description || '',
                  status: idx === 0 ? 'in_progress' : 'pending',
                }));
              }
            }
          }
        } catch (e) {
          console.warn('AI decomposition fallback triggered:', e);
        }
      }

      // 若未配置大模型或解析失败，使用高质量默认模板
      if (!milestones.length) {
        milestones = [
          {
            id: `ms_${Date.now()}_0`,
            title: '第 1 阶段：调研分析与路径规划',
            description: `梳理目标【${title}】的必要前提、关键资源与评估指标，输出初步方案。`,
            status: 'in_progress',
          },
          {
            id: `ms_${Date.now()}_1`,
            title: '第 2 阶段：核心攻坚与原型交付',
            description: '推进最关键的核心行动项，构建最小可用成果并进行验证迭代。',
            status: 'pending',
          },
          {
            id: `ms_${Date.now()}_2`,
            title: '第 3 阶段：成果落地与总结复盘',
            description: '完成目标全部指标交付，沉淀体系化资产与长期维护机制。',
            status: 'pending',
          },
        ];
      }

      return NextResponse.json({ success: true, milestones });
    }

    // 2. 创建长期目标
    if (action === 'create') {
      const { title, description, category, targetDate, milestones = [] } = body;
      if (!title) {
        return NextResponse.json({ success: false, error: '目标名称不能为空' }, { status: 400 });
      }

      const formattedMilestones = (milestones || []).map((m: any, idx: number) => ({
        id: m.id || `ms_${Date.now()}_${idx}`,
        title: String(m.title).trim(),
        description: m.description ? String(m.description).trim() : '',
        status: m.status || (idx === 0 ? 'in_progress' : 'pending'),
        dueDate: m.dueDate,
        completedAt: m.status === 'completed' ? Date.now() : undefined,
      }));

      const completedCount = formattedMilestones.filter((m: any) => m.status === 'completed').length;
      const progress = formattedMilestones.length > 0
        ? Math.round((completedCount / formattedMilestones.length) * 100)
        : 0;

      const newGoal = {
        id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title: String(title).trim(),
        description: description ? String(description).trim() : '',
        category: category || 'engineering',
        status: progress === 100 ? 'completed' : 'active',
        progress,
        targetDate: targetDate || '',
        milestones: formattedMilestones,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const goals = saveUserGoal(userId, newGoal);
      return NextResponse.json({ success: true, newGoal, goals });
    }

    // 3. 更新目标信息
    if (action === 'update') {
      const { id, title, description, category, targetDate, status, milestones } = body;
      if (!id) {
        return NextResponse.json({ success: false, error: '缺少目标 ID' }, { status: 400 });
      }

      const existing = getUserGoals(userId).find((g: any) => g.id === id);
      if (!existing) {
        return NextResponse.json({ success: false, error: '目标不存在' }, { status: 404 });
      }

      if (title !== undefined) existing.title = String(title).trim();
      if (description !== undefined) existing.description = String(description).trim();
      if (category !== undefined) existing.category = category;
      if (targetDate !== undefined) existing.targetDate = targetDate;
      if (status !== undefined) existing.status = status;

      if (Array.isArray(milestones)) {
        existing.milestones = milestones;
        const completedCount = milestones.filter((m: any) => m.status === 'completed').length;
        existing.progress = milestones.length > 0
          ? Math.round((completedCount / milestones.length) * 100)
          : existing.progress;
        if (existing.progress === 100) existing.status = 'completed';
      }

      const goals = saveUserGoal(userId, existing);
      return NextResponse.json({ success: true, updatedGoal: existing, goals });
    }

    // 4. 切换里程碑状态
    if (action === 'toggle_milestone') {
      const { goalId, milestoneId, status } = body;
      if (!goalId || !milestoneId) {
        return NextResponse.json({ success: false, error: '缺少 goalId 或 milestoneId' }, { status: 400 });
      }

      const existing = getUserGoals(userId).find((g: any) => g.id === goalId);
      if (!existing) {
        return NextResponse.json({ success: false, error: '目标不存在' }, { status: 404 });
      }

      const targetMs = (existing.milestones || []).find((m: any) => m.id === milestoneId);
      if (targetMs) {
        if (status) {
          targetMs.status = status;
        } else {
          // 默认在 completed 与 pending 之间翻转
          targetMs.status = targetMs.status === 'completed' ? 'pending' : 'completed';
        }
        if (targetMs.status === 'completed') {
          targetMs.completedAt = Date.now();
        } else {
          delete targetMs.completedAt;
        }

        const completedCount = existing.milestones.filter((m: any) => m.status === 'completed').length;
        existing.progress = Math.round((completedCount / (existing.milestones.length || 1)) * 100);
        if (existing.progress === 100) {
          existing.status = 'completed';
        } else if (existing.status === 'completed') {
          existing.status = 'active';
        }

        saveUserGoal(userId, existing);
      }

      const goals = getUserGoals(userId);
      return NextResponse.json({ success: true, updatedGoal: existing, goals });
    }

    // 5. 删除目标
    if (action === 'delete') {
      const { id } = body;
      if (!id) {
        return NextResponse.json({ success: false, error: '缺少目标 ID' }, { status: 400 });
      }

      const goals = deleteUserGoal(userId, id);
      return NextResponse.json({ success: true, goals });
    }

    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error in POST /api/goals:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
