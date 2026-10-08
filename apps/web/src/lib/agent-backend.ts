import { Context } from '@deepseek-ai/cordis';
import { AgentService, OrchestratorService } from '@agtpilot/core';
import { ApprovalRequest, PlanData, PlanTask } from '@agtpilot/protocol';
import * as BrowserPlugin from '@agtpilot/plugin-browser';
import * as SandboxPlugin from '@agtpilot/plugin-sandbox';
import * as SearchPlugin from '@agtpilot/plugin-search';
import * as MCPPlugin from '@agtpilot/plugin-mcp';
import * as ArtifactPlugin from '@agtpilot/plugin-artifact';
import * as PlannerPlugin from '@agtpilot/plugin-planner';
import * as MemoryPlugin from '@agtpilot/plugin-memory';
import * as CronPlugin from '@agtpilot/plugin-cron';
import * as ObservabilityPlugin from '@agtpilot/plugin-observability';
import * as GitPlugin from '@agtpilot/plugin-git';
import * as NotifyPlugin from '@agtpilot/plugin-notify';
import * as RagPlugin from '@agtpilot/plugin-rag';
import * as DesktopPlugin from '@agtpilot/plugin-desktop';
import * as RouterPlugin from '@agtpilot/plugin-router';
import * as ModelPlugin from '@agtpilot/plugin-model';
import { Cron } from 'croner';

import { Mission, MissionStep, ViewportState, TerminalLog } from '../types/agent';

export interface AgentBackendState {
  missions: Mission[];
  activeMissionId: string | null;
  viewport: ViewportState;
  terminalLogs: TerminalLog[];
  approvalRequests: ApprovalRequest[];
  latestArtifact?: any;
}

class AgentBackend {
  private static instance: AgentBackend;
  public ctx: Context;
  public orchestrator: OrchestratorService;
  public agentService: AgentService;
  public state: AgentBackendState;
  private subscribers: Set<(event: any) => void> = new Set();
  private initialized = false;
  private activeAbortControllers: Map<string, AbortController> = new Map();
  private activeCronJobs: Map<string, { job: Cron; userId: string; info: any }> = new Map();
  private cronSchedulerInitialized = false;

  private constructor() {
    this.ctx = new Context();
    this.agentService = new AgentService(this.ctx);
    this.orchestrator = new OrchestratorService(this.ctx);

    this.state = {
      missions: [],
      activeMissionId: null,
      viewport: {
        activeTab: 'browser',
        url: 'about:blank',
        title: 'Ready',
        status: 'idle',
      },
      terminalLogs: [
        {
          id: 'log-init',
          timestamp: Date.now(),
          type: 'system',
          text: '[System] AgtPilot Core Kernel Initialized. 15 plugins and 43 atomic tools ready.',
        },
      ],
      approvalRequests: [],
    };

    this.bindEvents();
  }

  public static getInstance(): AgentBackend {
    const g = globalThis as any;
    if (!g.__agtPilotBackend) {
      g.__agtPilotBackend = new AgentBackend();
      g.__agtPilotBackend.initPlugins().catch((err: any) => {
        console.error('Failed to init plugins in AgentBackend:', err);
      });
      g.__agtPilotBackend.initCronScheduler();
    }
    return g.__agtPilotBackend;
  }

  public async initPlugins() {
    if (this.initialized) return;
    this.initialized = true;

    await this.ctx.plugin(BrowserPlugin, { headless: true });
    await this.ctx.plugin(SandboxPlugin);
    await this.ctx.plugin(SearchPlugin);
    await this.ctx.plugin(MCPPlugin);
    await this.ctx.plugin(ArtifactPlugin);
    await this.ctx.plugin(PlannerPlugin);
    await this.ctx.plugin(MemoryPlugin);
    await this.ctx.plugin(CronPlugin);
    await this.ctx.plugin(ObservabilityPlugin);
    await this.ctx.plugin(GitPlugin);
    await this.ctx.plugin(NotifyPlugin);
    await this.ctx.plugin(RagPlugin);
    await this.ctx.plugin(DesktopPlugin);
    await this.ctx.plugin(RouterPlugin);
    await this.ctx.plugin(ModelPlugin);

    this.addTerminalLog('system', '[Cordis] All 15 SOTA plugins attached to microkernel.');
  }

  private bindEvents() {
    this.ctx.on('agtpilot/event', (event) => {
      this.handleEvent(event);
    });
  }

  private handleEvent(event: any) {
    const timestamp = event.timestamp || Date.now();

    switch (event.type) {
      case 'viewport_update': {
        this.state.viewport.url = event.payload.url || this.state.viewport.url;
        this.state.viewport.title = event.payload.title || this.state.viewport.title;
        if (event.payload.screenshotBase64) {
          this.state.viewport.screenshotBase64 = event.payload.screenshotBase64;
        }
        this.state.viewport.status = 'idle';

        if (this.state.activeMissionId) {
          const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
          if (mission) {
            mission.viewport = { ...this.state.viewport };
            this.broadcast({ type: 'mission_updated', data: mission });
          }
        }

        this.broadcast({ type: 'viewport_update', data: this.state.viewport });
        break;
      }

      case 'terminal_output': {
        if (event.payload.command) {
          this.addTerminalLog('command', `$ ${event.payload.command}`);
        }
        if (event.payload.stdout) {
          this.addTerminalLog('stdout', event.payload.stdout);
        }
        if (event.payload.stderr) {
          this.addTerminalLog('stderr', event.payload.stderr);
        }
        break;
      }

      case 'tool_call': {
        const toolName = event.payload.tool;
        if (toolName === 'browser_navigate') {
          this.state.viewport.url = event.payload.url || event.payload.args?.url;
          this.state.viewport.status = 'navigating';
          if (this.state.activeMissionId) {
            const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
            if (mission) {
              mission.viewport = { ...this.state.viewport };
            }
          }
          this.broadcast({ type: 'viewport_update', data: this.state.viewport });
        }

        // 挂载到当前任务的步骤（去重逻辑：如果最后一步是相同的处于 RUNNING 状态的工具，则复用更新参数，避免插件与核心双重广播导致的成对重复步骤）
        if (this.state.activeMissionId) {
          const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
          if (mission) {
            const lastStep = mission.steps[mission.steps.length - 1];
            if (lastStep && lastStep.tool === toolName && lastStep.status === 'RUNNING') {
              lastStep.args = event.payload.args || event.payload;
            } else {
              const stepId = `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
              mission.steps.push({
                id: stepId,
                title: `执行工具: ${toolName}`,
                tool: toolName,
                role: 'tool',
                status: 'RUNNING',
                args: event.payload.args || event.payload,
              });
            }
            this.broadcast({ type: 'mission_updated', data: mission });
          }
        }
        break;
      }

      case 'tool_result': {
        const toolName = event.payload.tool;
        if (toolName === 'browser_navigate' || !toolName) {
          this.state.viewport.status = 'idle';
          if (this.state.activeMissionId) {
            const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
            if (mission && mission.viewport) {
              mission.viewport.status = 'idle';
            }
          }
          this.broadcast({ type: 'viewport_update', data: this.state.viewport });
        }

        if (this.state.activeMissionId) {
          const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
          if (mission && mission.steps.length > 0) {
            // 找到最后处于 RUNNING 的该工具步骤并将其标记为完成
            const targetStep = [...mission.steps].reverse().find((s) => s.status === 'RUNNING' && (!toolName || s.tool === toolName)) || mission.steps[mission.steps.length - 1];
            if (targetStep && targetStep.status === 'RUNNING') {
              targetStep.status = 'DONE';
              targetStep.output = event.payload.output;
              targetStep.duration = '320ms';
              this.broadcast({ type: 'mission_updated', data: mission });
            }
          }
        }
        break;
      }

      case 'plan': {
        const plan: PlanData = event.payload;
        if (this.state.activeMissionId) {
          const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
          if (mission) {
            mission.title = plan.goal;
            mission.steps = plan.tasks.map((t: PlanTask) => ({
              id: t.id,
              title: t.title,
              status: t.status === 'completed' ? 'DONE' : t.status === 'in_progress' ? 'RUNNING' : 'PENDING',
              duration: t.status === 'completed' ? '280ms' : undefined,
            }));
            const completedCount = mission.steps.filter((s) => s.status === 'DONE').length;
            mission.progress = Math.round((completedCount / (mission.steps.length || 1)) * 100);
            this.broadcast({ type: 'mission_updated', data: mission });
          }
        }
        break;
      }

      case 'approval_request': {
        const req: ApprovalRequest = event.payload;
        this.state.approvalRequests.push(req);
        if (this.state.activeMissionId) {
          const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
          if (mission) {
            mission.status = 'WAITING_APPROVAL';
            this.broadcast({ type: 'mission_updated', data: mission });
          }
        }
        this.broadcast({ type: 'approval_requested', data: req });
        break;
      }

      case 'artifact': {
        this.state.latestArtifact = event.payload;
        if (this.state.activeMissionId) {
          const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
          if (mission) {
            mission.artifact = event.payload;
            this.broadcast({ type: 'mission_updated', data: mission });
          }
        }
        this.broadcast({ type: 'artifact_updated', data: event.payload });
        break;
      }

      case 'thought': {
        if (this.state.activeMissionId) {
          const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
          if (mission) {
            const thoughtText = event.payload.text || '';
            // 更新当前第一步或者添加思考步骤
            if (mission.steps.length > 0 && mission.steps[0].id === 'step_init') {
              mission.steps[0].title = `意图理解与分析: ${thoughtText.slice(0, 60)}${thoughtText.length > 60 ? '...' : ''}`;
              mission.steps[0].status = 'DONE';
              mission.steps[0].duration = '450ms';
            }
            this.broadcast({ type: 'mission_updated', data: mission });
          }
        }
        if (event.payload.text) {
          this.addTerminalLog('system', `[AI 思考与回复] ${event.payload.text}`);
        }
        break;
      }

      case 'done': {
        const finalAnswer = event.payload?.finalAnswer || 'Task completed';
        if (this.state.activeMissionId) {
          const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
          if (mission) {
            // 确保未完成的工具步骤状态标记为 DONE
            mission.steps.forEach((st) => {
              if (st.status === 'RUNNING' || st.status === 'PENDING') {
                st.status = 'DONE';
                st.duration = st.duration || '320ms';
              }
            });

            // 作为独立的 Assistant 回复步骤追加，清晰区分提问、工具调用和最终回复
            mission.steps.push({
              id: `step_assistant_${Date.now()}`,
              role: 'assistant',
              title: '智能体回复',
              status: 'DONE',
              answer: finalAnswer,
            });

            // 执行效率摘要：让"本该 2 步却空转了很多步"的任务一眼可见
            const eff = event.payload?.efficiency;
            if (eff && typeof eff === 'object' && eff.toolCalls > 0) {
              mission.steps.push({
                id: `step_eff_${Date.now()}`,
                title: `执行效率: ${eff.stepsCount} 步 · 工具调用 ${eff.toolCalls} 次 · 失败 ${eff.failedCalls} · 熔断跳过 ${eff.skippedCalls} · 有效率 ${Math.round((eff.effectiveRate ?? 1) * 100)}% · 挂载工具 ${eff.toolsMounted}/${eff.toolsTotal}${eff.routed ? ' (按需)' : ''}`,
                status: eff.effectiveRate < 0.5 ? 'FAILED' : 'DONE',
              });
            }

            mission.status = 'DONE';
            mission.progress = 100;
            if (mission.viewport) {
              mission.viewport.status = 'idle';
            }
            this.broadcast({ type: 'mission_updated', data: mission });
          }
        }

        this.state.viewport.status = 'idle';
        this.broadcast({ type: 'viewport_update', data: this.state.viewport });
        this.addTerminalLog('system', `[Agent] 回复完成: ${finalAnswer.slice(0, 100)}`);
        break;
      }

      case 'error': {
        const errorMsg = event.payload?.error || 'Unknown execution error';
        if (this.state.activeMissionId) {
          const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
          if (mission) {
            mission.status = 'DONE';
            mission.steps.push({
              id: `step_err_${Date.now()}`,
              title: `执行异常: ${errorMsg}`,
              status: 'FAILED',
            });
            this.broadcast({ type: 'mission_updated', data: mission });
          }
        }
        this.addTerminalLog('stderr', `[Agent Error] ${errorMsg}`);
        break;
      }
    }
  }

  public addTerminalLog(type: TerminalLog['type'], text: string) {
    const entry: TerminalLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      type,
      text,
    };
    this.state.terminalLogs.push(entry);
    if (this.state.terminalLogs.length > 500) {
      this.state.terminalLogs.shift();
    }

    if (this.state.activeMissionId) {
      const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
      if (mission) {
        if (!mission.terminalLogs) mission.terminalLogs = [];
        mission.terminalLogs.push(entry);
        if (mission.terminalLogs.length > 300) {
          mission.terminalLogs.shift();
        }
      }
    }

    this.broadcast({ type: 'terminal_log', data: entry });
  }

  public subscribe(callback: (event: any) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  public broadcast(event: any) {
    if ((event.type === 'mission_updated' || event.type === 'mission_created') && event.data?.userId) {
      try {
        const { saveUserMission } = require('@/lib/user-store');
        saveUserMission(event.data.userId, event.data);
      } catch (e) {
        // ignore
      }
    }

    // PWA Web Push：关键事件推送到用户已订阅的移动设备（审批请求 / 任务完成）
    this.maybePushNotification(event);

    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  /** 已推送过"完成"通知的任务，避免重复推送 */
  private pushedDoneMissions: Set<string> = new Set();

  private maybePushNotification(event: any) {
    try {
      const { sendPushToUser } = require('@/lib/push');

      if (event.type === 'approval_requested') {
        const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
        const userId = mission?.userId || event.data?.userId;
        if (!userId) return;
        const req = event.data || {};
        sendPushToUser(userId, {
          title: '需要你审批',
          body: `${req.action || '敏感操作'}：${(req.description || '').slice(0, 80)}`,
          tag: `approval-${req.id || Date.now()}`,
          url: '/',
        }).catch(() => {});
        return;
      }

      if (event.type === 'mission_updated' && event.data?.status === 'DONE' && event.data?.userId) {
        const missionId = event.data.id;
        if (!missionId || this.pushedDoneMissions.has(missionId)) return;
        this.pushedDoneMissions.add(missionId);
        // 控制集合大小
        if (this.pushedDoneMissions.size > 500) {
          this.pushedDoneMissions = new Set([...this.pushedDoneMissions].slice(-250));
        }
        sendPushToUser(event.data.userId, {
          title: '任务完成',
          body: `${event.data.title || '任务'}：${(event.data.steps?.slice(-1)?.[0]?.answer || '').toString().slice(0, 80) || '点击查看交付成果'}`,
          tag: `mission-done-${missionId}`,
          url: '/',
        }).catch(() => {});
      }
    } catch {
      // push 不可用不影响主流程
    }
  }

  public submitApproval(approvalId: string, approved: boolean): boolean {
    const success = this.orchestrator.submitApproval(approvalId, approved);
    this.state.approvalRequests = this.state.approvalRequests.filter((r) => r.id !== approvalId);

    if (this.state.activeMissionId) {
      const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
      if (mission && mission.status === 'WAITING_APPROVAL') {
        mission.status = 'ACTIVE';
        this.broadcast({ type: 'mission_updated', data: mission });
      }
    }

    this.broadcast({ type: 'approval_resolved', data: { approvalId, approved } });
    this.addTerminalLog('system', `[Approval] User ${approved ? 'AUTHORIZED' : 'REJECTED'} action ${approvalId}.`);
    return success;
  }

  public stopMission(missionId: string) {
    const controller = this.activeAbortControllers.get(missionId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(missionId);
    }

    // 清理并拒绝所有挂起的人机协同审批，避免终止后残留授权弹窗
    if (this.state.approvalRequests.length > 0) {
      for (const req of this.state.approvalRequests) {
        try {
          (this.ctx.orchestrator as any)?.submitApproval?.(req.id, false);
        } catch {
          // ignore
        }
        this.broadcast({ type: 'approval_resolved', data: { approvalId: req.id } });
      }
      this.state.approvalRequests = [];
    }

    const mission = this.state.missions.find((m) => m.id === missionId);
    if (mission && mission.status !== 'DONE') {
      mission.status = 'DONE';
      mission.steps.forEach((st) => {
        if (st.status === 'RUNNING' || st.status === 'PENDING') {
          st.status = 'FAILED';
        }
      });
      mission.steps.push({
        id: `step_abort_${Date.now()}`,
        title: '任务已被用户主动终止 (Aborted)',
        status: 'FAILED',
        duration: '0ms',
      });
      this.broadcast({ type: 'mission_updated', data: mission });
      this.addTerminalLog('system', `[Mission Aborted] ID: ${missionId} has been terminated.`);
    }
  }

  public stopAllMissions() {
    for (const [id, controller] of this.activeAbortControllers.entries()) {
      controller.abort();
    }
    this.activeAbortControllers.clear();

    this.state.missions.forEach((m) => {
      if (m.status !== 'DONE') {
        m.status = 'DONE';
        m.steps.forEach((st) => {
          if (st.status === 'RUNNING' || st.status === 'PENDING') {
            st.status = 'FAILED';
          }
        });
        m.steps.push({
          id: `step_abort_${Date.now()}`,
          title: '会话已重置，任务已终止 (Session Reset)',
          status: 'FAILED',
        });
        this.broadcast({ type: 'mission_updated', data: m });
      }
    });

    this.state.activeMissionId = null;
    this.addTerminalLog('system', '[System] All active missions terminated upon logout/reset.');
  }

  public async runMission(goal: string, options: { title?: string; userId?: string; missionId?: string } = {}): Promise<Mission> {
    await this.initPlugins();

    let targetMission: Mission;
    const isContinuing = Boolean(options.missionId && this.state.missions.some((m) => m.id === options.missionId));

    if (isContinuing) {
      targetMission = this.state.missions.find((m) => m.id === options.missionId)!;
      targetMission.status = 'ACTIVE';
      targetMission.progress = 10;
      targetMission.steps.push({
        id: `step_${Date.now()}`,
        role: 'user',
        title: goal,
        userPrompt: goal,
        status: 'DONE',
      });
      this.state.activeMissionId = targetMission.id;
      this.broadcast({ type: 'mission_updated', data: targetMission });
      this.addTerminalLog('system', `[Session Continued] ID: ${targetMission.id} | New Goal: ${goal}`);
    } else {
      const missionId = `mission_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      targetMission = {
        id: missionId,
        userId: options.userId,
        title: options.title || goal,
        status: 'ACTIVE',
        progress: 5,
        startedAt: Date.now(),
        steps: [
          {
            id: `step_user_init`,
            role: 'user',
            title: goal,
            userPrompt: goal,
            status: 'DONE',
          },
        ],
        conversationMessages: [],
      };

      this.state.missions.unshift(targetMission);
      this.state.activeMissionId = missionId;

      if (options.userId) {
        try {
          const { saveUserMission } = await import('@/lib/user-store');
          saveUserMission(options.userId, targetMission);
        } catch (e) {
          // ignore
        }
      }

      this.broadcast({ type: 'mission_created', data: targetMission });
      this.addTerminalLog('system', `[Mission Started] ID: ${missionId} | Goal: ${goal}`);
    }

    const abortController = new AbortController();
    this.activeAbortControllers.set(targetMission.id, abortController);

    // 异步执行任务生命周期
    (async () => {
      try {
        // 1. 获取当前登录用户专属沉淀的长效记忆与画像
        let userMemoryPrompt = '';
        if (options.userId) {
          try {
            const { getUserMemories } = await import('@/lib/user-store');
            const mems = getUserMemories(options.userId);
            if (mems.length > 0) {
              userMemoryPrompt = [
                '【当前用户的专属个性画像与长期记忆】:',
                ...mems.map((m: any) => `- [${m.category}] ${m.title}: ${m.content}`),
                '请严格遵守上述用户的个性偏好与安全规则进行思考与输出。',
              ].join('\n');
            }
          } catch (e) {
            // fallback
          }
        }

        // 2. 获取当前登录用户自定义的连接器密钥与默认模型覆盖
        let userConfigOverride: any = undefined;
        let userHasLlm = false;

        if (options.userId) {
          try {
            const { getUserConnectors } = await import('@/lib/user-store');
            const uConfigs = getUserConnectors(options.userId);
            const activeModelId = uConfigs.activeModelId || 'custom_llm';

            if (activeModelId === 'custom_llm') {
              const apiKey = uConfigs.configs['CUSTOM_LLM_API_KEY'] || process.env.CUSTOM_LLM_API_KEY;
              if (apiKey) userHasLlm = true;
              userConfigOverride = {
                activeModelId: 'custom_llm',
                apiKey,
                baseURL: uConfigs.configs['CUSTOM_LLM_BASE_URL'] || process.env.CUSTOM_LLM_BASE_URL,
                modelName: uConfigs.configs['CUSTOM_LLM_MODEL_NAME'] || process.env.CUSTOM_LLM_MODEL_NAME || 'gpt-4o',
              };
            } else if (activeModelId === 'openai') {
              const apiKey = uConfigs.configs['OPENAI_API_KEY'] || process.env.OPENAI_API_KEY;
              if (apiKey) userHasLlm = true;
              userConfigOverride = {
                activeModelId: 'openai',
                apiKey,
                baseURL: uConfigs.configs['OPENAI_BASE_URL'] || process.env.OPENAI_BASE_URL,
                modelName: uConfigs.configs['OPENAI_MODEL_NAME'] || process.env.OPENAI_MODEL_NAME || 'gpt-4o',
              };
            } else {
              const apiKey = uConfigs.configs['DEEPSEEK_API_KEY'] || process.env.DEEPSEEK_API_KEY;
              if (apiKey) userHasLlm = true;
              userConfigOverride = {
                activeModelId: 'deepseek',
                apiKey,
                baseURL: uConfigs.configs['DEEPSEEK_BASE_URL'] || process.env.DEEPSEEK_BASE_URL,
                modelName: uConfigs.configs['DEEPSEEK_MODEL_NAME'] || process.env.DEEPSEEK_MODEL_NAME || 'deepseek-chat',
              };
            }
          } catch (e) {
            // fallback
          }
        }

        const hasLlm =
          userHasLlm ||
          Boolean(
            process.env.CUSTOM_LLM_API_KEY ||
            process.env.DEEPSEEK_API_KEY ||
            process.env.OPENAI_API_KEY
          );

        if (hasLlm) {
          // 调用真正的大模型 + 工具链编排 (Vercel AI SDK + Cordis 工具集)
          const result = await this.ctx.orchestrator.runTask({
            taskId: targetMission.id,
            abortSignal: abortController.signal,
            configOverride: userConfigOverride,
            historyMessages: targetMission.conversationMessages,
            prompt: goal,
            system: `你是基于 Cordis 微内核架构驱动的个人全自主智能体驾驶舱 (AgtPilot)。
你拥有强大的推理能力与丰富的原子工具生态（包括浏览器实时自动化 browser_navigate、沙箱隔离命令执行 sandbox_run_command 等）。
${userMemoryPrompt ? `\n${userMemoryPrompt}\n` : ''}
【核心行为准则 (Behavioral Steering)】：
1. 【区分对话与执行】：如果用户的请求只是自我介绍、询问你能做什么、概念解释或一般性闲聊，请直接运用你渊博的知识用清晰、亲切、优雅的中文回复，【严禁】无缘无故调用外部搜索或终端工具！
2. 【按需调用工具】：只有当用户的任务确实需要实时信息检索、网页交互抓取、执行代码或特定环境诊断时，才调用对应的原子工具。
3. 【结构化交付】：在完成任务后，清晰总结执行结果并给出交付物。`,
          });

          if (result.success && result.messages) {
            targetMission.conversationMessages = result.messages;
            this.broadcast({ type: 'mission_updated', data: targetMission });
          }

          if (!result.success && result.error) {
            targetMission.status = 'DONE';
            targetMission.steps.push({
              id: `step_err`,
              title: `执行异常: ${result.error}`,
              status: 'FAILED',
            });
            this.addTerminalLog('stderr', `[Mission Error] ${result.error}`);
            this.broadcast({ type: 'mission_updated', data: targetMission });
          }
        } else {
          // 未配置任何可用大模型时，给出明确配置提示，杜绝乱走假工具流程
          targetMission.status = 'DONE';
          targetMission.progress = 100;
          targetMission.steps = [
            {
              id: 'step_no_key',
              title: '未检测到可用的大模型连接配置',
              status: 'FAILED',
              duration: '0ms',
            },
          ];
          this.broadcast({ type: 'mission_updated', data: targetMission });
          this.addTerminalLog('stderr', '[Config Required] 当前用户未配置大模型 API Key。请前往顶部「连接器」添加自定义 OpenAI、DeepSeek 或中转站 Key。');
        }
      } catch (err: any) {
        targetMission.status = 'DONE';
        targetMission.steps.push({
          id: `step_err`,
          title: `Execution error: ${err.message}`,
          status: 'FAILED',
        });
        this.addTerminalLog('stderr', `[Mission Error] ${err.message}`);
        this.broadcast({ type: 'mission_updated', data: targetMission });
      } finally {
        this.activeAbortControllers.delete(targetMission.id);
      }
    })();

    return targetMission;
  }

  public initCronScheduler() {
    if (this.cronSchedulerInitialized) return;
    this.cronSchedulerInitialized = true;

    try {
      const { getAllUsersData } = require('@/lib/user-store');
      const allUsers = getAllUsersData();
      let activeCount = 0;
      for (const user of allUsers) {
        if (Array.isArray(user.cronJobs)) {
          for (const job of user.cronJobs) {
            if (job.status === 'active') {
              this.registerUserCronJob(user.userId, job);
              activeCount++;
            }
          }
        }
      }
      this.addTerminalLog('system', `[Cron Scheduler] 调度器已激活，已挂载 ${activeCount} 个后台巡航任务。`);
    } catch (err: any) {
      console.error('Failed to init cron scheduler in AgentBackend:', err);
    }
  }

  public registerUserCronJob(userId: string, jobInfo: any) {
    this.unregisterUserCronJob(jobInfo.id);

    if (jobInfo.status !== 'active') return;

    try {
      const cronJob = new Cron(jobInfo.pattern, { timezone: 'Asia/Shanghai' }, async () => {
        this.addTerminalLog('system', `[自动巡航触发] 任务 "${jobInfo.name}" 到达预定时间，开始自主执行...`);

        // 更新执行计数与下一次触发时间
        jobInfo.runCount = (jobInfo.runCount || 0) + 1;
        jobInfo.lastRunAt = Date.now();
        jobInfo.nextRun = cronJob.nextRun()?.toISOString();

        try {
          const { saveUserCronJob } = require('@/lib/user-store');
          saveUserCronJob(userId, jobInfo);
        } catch (e) {
          console.error('Failed to save updated cron job status:', e);
        }

        this.broadcast({
          type: 'cron_job_triggered',
          data: { jobId: jobInfo.id, userId, runCount: jobInfo.runCount, nextRun: jobInfo.nextRun },
        });

        // 启动真正智能体生命周期执行任务
        try {
          await this.runMission(jobInfo.prompt, {
            title: `【自动巡航】${jobInfo.name}`,
            userId,
          });
        } catch (err: any) {
          this.addTerminalLog('stderr', `[自动巡航执行异常] ${jobInfo.name}: ${err.message}`);
        }
      });

      jobInfo.nextRun = cronJob.nextRun()?.toISOString();
      this.activeCronJobs.set(jobInfo.id, { job: cronJob, userId, info: jobInfo });
      this.addTerminalLog(
        'system',
        `[Cron] 任务 "${jobInfo.name}" (${jobInfo.pattern}) 已挂载，下次触发: ${cronJob.nextRun()?.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) || '无'}`
      );
    } catch (e: any) {
      console.error(`Failed to register cron job ${jobInfo.name}:`, e);
    }
  }

  public unregisterUserCronJob(jobId: string) {
    const existing = this.activeCronJobs.get(jobId);
    if (existing) {
      try {
        existing.job.stop();
      } catch {}
      this.activeCronJobs.delete(jobId);
      this.addTerminalLog('system', `[Cron] 任务 "${existing.info?.name || jobId}" 已从后台定时池注销。`);
    }
  }

  public async triggerUserCronJob(userId: string, jobId: string) {
    const { getUserCronJobs, saveUserCronJob } = require('@/lib/user-store');
    const jobs = getUserCronJobs(userId);
    const jobInfo = jobs.find((j: any) => j.id === jobId);
    if (!jobInfo) return;

    this.addTerminalLog('system', `[手动触发巡航] 任务 "${jobInfo.name}" 开始立即执行...`);
    jobInfo.runCount = (jobInfo.runCount || 0) + 1;
    jobInfo.lastRunAt = Date.now();
    saveUserCronJob(userId, jobInfo);

    this.broadcast({
      type: 'cron_job_triggered',
      data: { jobId: jobInfo.id, userId, runCount: jobInfo.runCount },
    });

    try {
      await this.runMission(jobInfo.prompt, {
        title: `【自动巡航】${jobInfo.name}`,
        userId,
      });
    } catch (err: any) {
      this.addTerminalLog('stderr', `[自动巡航执行异常] ${jobInfo.name}: ${err.message}`);
    }
  }
}

export function getAgentBackend(): AgentBackend {
  return AgentBackend.getInstance();
}
