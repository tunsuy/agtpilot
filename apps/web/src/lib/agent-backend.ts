import { Context } from '@deepseek-ai/cordis';
import { OrchestratorService, AgentService } from '@agtpilot/core';
import { createAgentRuntime } from '@agtpilot/app-kit';
import { ApprovalRequest, ConnectorSuggestion, PlanData, PlanTask } from '@agtpilot/protocol';
import type { MCPService } from '@agtpilot/plugin-mcp';

import { Mission, MissionStep, ViewportState, TerminalLog } from '../types/agent';
import {
  applyDelta,
  closeLiveStep,
  ensureLiveStep,
  finalizeWithAnswer,
  resolveMission,
} from './live-steps';
import { resolveCronPrompt } from './cron-scenario';

export interface AgentBackendState {
  missions: Mission[];
  activeMissionId: string | null;
  viewport: ViewportState;
  /**
   * 当前视口归属用户（浏览器自动化单例的当前占用者）。多用户部署时
   * viewport_update（含网页截图）只推给占用者本人，其他用户 init 拿空白视口。
   */
  viewportUserId?: string | null;
  terminalLogs: TerminalLog[];
  approvalRequests: ApprovalRequest[];
  /** 任务中途连接器授权建议（等待用户一键授权/跳过） */
  connectorSuggestions: ConnectorSuggestion[];
  latestArtifact?: any;
}

class AgentBackend {
  private static instance: AgentBackend;
  public ctx!: Context;
  public orchestrator!: OrchestratorService;
  public agentService!: AgentService;
  public state: AgentBackendState;
  private subscribers: Set<(event: any) => void> = new Set();
  /** 装配 Promise（resolve 即全部插件就绪；单插件失败只跳过不拖垮内核） */
  private runtimePromise: Promise<void> | null = null;
  private activeAbortControllers: Map<string, AbortController> = new Map();
  /** 已挂进调度池的 cron 任务：jobId → 归属用户（调度本体在 plugin-cron 的 CronService） */
  private activeCronJobs: Map<string, { userId: string; name?: string }> = new Map();
  private cronSchedulerInitialized = false;
  /** 各任务检查点最近一次落盘时间（节流：≥5s 一次） */
  private checkpointSavedAt: Map<string, number> = new Map();
  /**
   * 流式增量合并缓冲（taskId → { segments, timer, userId }）：
   * 后端 ~100ms / 160 字符合并一次再广播轻量 assistant_delta SSE 事件，
   * 避免逐 token 广播 + 前端整树重渲染。绝不走 mission_updated（那会
   * 全量落盘 + 重发整个 mission）。
   */
  private deltaBuffers: Map<
    string,
    { segments: Array<{ delta: string; kind: 'text' | 'reasoning' }>; timer: ReturnType<typeof setTimeout> | null; userId?: string }
  > = new Map();
  /**
   * in-flight 任务运行时把手(治理「回退弧→前向弧」传导入口):
   * missionId → { userId, env(taskEnv 活引用,删键即时生效), sandbox(taskSandbox
   * 活引用,权限提案批准即热更新), notices(治理提示队列) }。
   * governance-bus 收到记忆删除/授权撤销/权限提案裁决事件后写这里,内核 prepareStep
   * 经 getStepNotice 逐条取出注入模型上下文(见 initGovernanceSubscriptions)。
   */
  private taskRuntimes: Map<string, { userId?: string; env?: Record<string, string>; sandbox?: import('@agtpilot/core').SandboxSessionPolicy; notices: string[] }> = new Map();

  private constructor() {
    this.state = {
      missions: [],
      activeMissionId: null,
      viewport: {
        activeTab: 'browser',
        url: 'about:blank',
        title: 'Ready',
        status: 'idle',
      },
      viewportUserId: null,
      terminalLogs: [
        {
          id: 'log-init',
          timestamp: Date.now(),
          type: 'system',
          text: '[System] AgtPilot Core Kernel Initialized. 15 plugins and 43 atomic tools ready.',
        },
      ],
      approvalRequests: [],
      connectorSuggestions: [],
      latestArtifact: undefined,
    };
    // 治理总线订阅(回退弧传导到 in-flight 任务);失败只降级不拖垮后端
    this.initGovernanceSubscriptions();
  }

  public static getInstance(): AgentBackend {
    const g = globalThis as any;
    if (!g.__agtPilotBackend) {
      g.__agtPilotBackend = new AgentBackend();
      // 微内核 + 插件统一装配（app-kit），后台启动；调用方经 whenReady() 等待就绪
      g.__agtPilotBackend.ensureRuntime().catch((err: any) => {
        console.error('Failed to init agent runtime in AgentBackend:', err);
      });
      g.__agtPilotBackend.initCronScheduler();
    }
    return g.__agtPilotBackend;
  }

  /** 等待微内核与全部插件就绪（幂等；API 路由入口处 await） */
  public whenReady(): Promise<void> {
    return this.runtimePromise ?? this.ensureRuntime();
  }

  /** MCP 连接器服务（类型化访问；未就绪时 undefined，需要确保就绪请先 await whenReady()） */
  public get mcp(): MCPService | undefined {
    return (this.ctx as Context | undefined)?.mcp;
  }

  private ensureRuntime(): Promise<void> {
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = (async () => {
      // composition root 统一装配：core 走插件形态，单插件失败只跳过并记录
      const runtime = await createAgentRuntime();
      this.ctx = runtime.ctx;
      this.agentService = runtime.agent;
      this.orchestrator = runtime.orchestrator;

      this.bindEvents();
      this.bindCheckpoint();
      this.sweepInterruptedMissions();

      const failed = runtime.loaded.filter((l) => !l.ok);
      this.addTerminalLog(
        'system',
        `[Cordis] 微内核与插件装配完成（${runtime.loaded.length - failed.length}/${runtime.loaded.length} 就绪${failed.length ? `，跳过: ${failed.map((f) => f.plugin).join(', ')}` : ''}）。`
      );
    })();
    return this.runtimePromise;
  }

  /**
   * 重启清扫：持久化任务里停留在执行中/等审批状态的（进程重启即中断，
   * 无自动恢复）标记为 INTERRUPTED，避免历史列表出现永远"进行中"的僵尸任务。
   * 会话历史已随运行中检查点落盘，用户点开继续即可续跑。
   */
  private sweepInterruptedMissions() {
    try {
      const { getAllUsersData, saveUserMission } = require('@/lib/user-store');
      let swept = 0;
      for (const user of getAllUsersData()) {
        for (const m of user.missions || []) {
          if (m.status === 'ACTIVE' || m.status === 'WAITING_APPROVAL' || m.status === 'QUEUED') {
            m.status = 'INTERRUPTED';
            if (Array.isArray(m.steps)) {
              // 中断时 RUNNING 的步骤（含流式 live step）一并标 FAILED，不留僵尸"执行中"
              m.steps.forEach((st: any) => {
                if (st.status === 'RUNNING') st.status = 'FAILED';
              });
              m.steps.push({
                id: `step_intr_${Date.now()}`,
                title: '服务重启：任务执行中断（会话已保留，可继续对话续跑）',
                status: 'FAILED',
              });
            }
            saveUserMission(user.userId, m);
            swept++;
          }
        }
      }
      if (swept > 0) {
        this.addTerminalLog('system', `[Recovery] 重启清扫：${swept} 个中断任务已标记为 INTERRUPTED。`);
      }
    } catch {
      // 清扫失败不影响启动
    }
  }

  /**
   * 运行中消息检查点：内核每步 prepareStep 时广播 agtpilot/checkpoint，
   * 这里把会话历史写回 mission（节流落盘）——崩溃/重启后任务可从最近
   * 检查点续跑，而不是只有收尾时才落一版。
   */
  private bindCheckpoint() {
    this.ctx.on('agtpilot/checkpoint', ({ taskId, messages }: { taskId: string; messages: any[] }) => {
      const mission = this.state.missions.find((m) => m.id === taskId);
      if (!mission || !Array.isArray(messages) || messages.length === 0) return;
      mission.conversationMessages = messages;

      const now = Date.now();
      const last = this.checkpointSavedAt.get(mission.id) || 0;
      if (now - last < 5000) return; // 节流：每 5s 至多落盘一次
      this.checkpointSavedAt.set(mission.id, now);

      if (mission.userId) {
        try {
          const { saveUserMission } = require('@/lib/user-store');
          saveUserMission(mission.userId, mission);
        } catch {
          // 落盘失败不影响主流程
        }
      }
    });
  }

  private bindEvents() {
    this.ctx.on('agtpilot/event', (event) => {
      this.handleEvent(event);
    });
  }

  /**
   * 事件归属（串台修复）：优先事件自带的 payload.taskId（orchestrator 对
   * 每个事件盖章，多任务并发/用户切换会话时步骤不再挂错），兜底
   * activeMissionId（viewport/terminal 等无 taskId 的全局事件仍走后者）。
   */
  private resolveMissionFromEvent(event: any): Mission | undefined {
    return resolveMission(this.state.missions, this.state.activeMissionId, event?.payload);
  }

  /** 入列一个流式增量段（同 kind 相邻合并），满 100ms 或 160 字符即 flush */
  private queueDelta(taskId: string, delta: string, kind: 'text' | 'reasoning', userId?: string) {
    let buf = this.deltaBuffers.get(taskId);
    if (!buf) {
      buf = { segments: [], timer: null, userId };
      this.deltaBuffers.set(taskId, buf);
    }
    if (userId) buf.userId = userId;
    const lastSeg = buf.segments[buf.segments.length - 1];
    if (lastSeg && lastSeg.kind === kind) {
      lastSeg.delta += delta;
    } else {
      buf.segments.push({ delta, kind });
    }

    const totalChars = buf.segments.reduce((n, s) => n + s.delta.length, 0);
    if (totalChars >= 160) {
      this.flushDeltas(taskId);
      return;
    }
    if (!buf.timer) {
      buf.timer = setTimeout(() => this.flushDeltas(taskId), 100);
    }
  }

  /** 立即 flush 某任务的增量缓冲（边界事件入口同步调用，保证 SSE 顺序） */
  private flushDeltas(taskId: string) {
    const buf = this.deltaBuffers.get(taskId);
    if (!buf) return;
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
    if (buf.segments.length === 0) return;
    const segments = buf.segments;
    buf.segments = [];
    this.broadcast({ type: 'assistant_delta', data: { taskId, segments, userId: buf.userId } });
  }

  private handleEvent(event: any) {
    const timestamp = event.timestamp || Date.now();

    switch (event.type) {
      case 'step_started': {
        // 每步模型调用开始（或步数耗尽强制总结前）：确保 live assistant
        // step 存在 —— 模型生成期间时间线不再"静止"，打字机卡片自此就位。
        const mission = this.resolveMissionFromEvent(event);
        if (!mission) break;
        this.flushDeltas(mission.id);
        ensureLiveStep(mission, event.payload?.stepNumber, event.payload?.reason);
        this.broadcast({ type: 'mission_updated', data: mission });
        break;
      }

      case 'assistant_delta': {
        // 流式增量：内存累积进 live step（浅层），合并后再广播轻量事件。
        // 注意不广播 mission_updated —— 逐 token 落盘/重发全量 mission 会压垮
        // 磁盘与 SSE；边界事件（tool_call/done/error）会先 flush 再发
        // mission_updated，SSE 单连接有序，前端两种流不会交错错位。
        const mission = this.resolveMissionFromEvent(event);
        if (!mission || !event.payload?.delta) break;
        const kind = event.payload.kind === 'reasoning' ? 'reasoning' : 'text';
        applyDelta(mission, String(event.payload.delta), kind);
        this.queueDelta(mission.id, String(event.payload.delta), kind, mission.userId);
        break;
      }

      case 'viewport_update': {
        this.state.viewport.url = event.payload.url || this.state.viewport.url;
        this.state.viewport.title = event.payload.title || this.state.viewport.title;
        if (event.payload.screenshotBase64) {
          this.state.viewport.screenshotBase64 = event.payload.screenshotBase64;
        }
        this.state.viewport.status = 'idle';

        // 视口归属：事件自带 taskId（缺失时兜底 activeMission）对应的用户。
        // 浏览器自动化是单例 —— 占用期间 viewport_update（含截图）只推给占用者
        const mission = this.resolveMissionFromEvent(event);
        if (mission?.userId) {
          this.state.viewportUserId = mission.userId;
        }
        if (mission) {
          mission.viewport = { ...this.state.viewport };
          this.broadcast({ type: 'mission_updated', data: mission });
        }

        this.broadcast({
          type: 'viewport_update',
          data: { ...this.state.viewport, userId: this.state.viewportUserId ?? undefined },
        });
        break;
      }

      case 'terminal_output': {
        // 沙盒命令输出按任务归属用户标记（SSE 过滤锚点）
        const owner = this.resolveMissionFromEvent(event)?.userId;
        if (event.payload.command) {
          this.addTerminalLog('command', `$ ${event.payload.command}`, owner);
        }
        if (event.payload.stdout) {
          this.addTerminalLog('stdout', event.payload.stdout, owner);
        }
        if (event.payload.stderr) {
          this.addTerminalLog('stderr', event.payload.stderr, owner);
        }
        break;
      }

      case 'sandbox_deny': {
        // 沙箱拒绝日志 → 审计留痕 + (端点不匹配时)自动生成权限提案待人工审核
        // (docs/design/sandbox-control-hardening.md §4.4:deny-log → proposal → review → hot update)
        const p = event.payload || {};
        this.broadcast({ type: 'sandbox_deny', data: p });
        try {
          const userId = p.userId;
          if (userId) {
            const us = require('@/lib/user-store');
            us.appendSandboxAudit(userId, {
              userId,
              tool: p.tool,
              reason: p.reason,
              url: p.url,
              credentialRef: p.credentialRef,
              taskId: p.taskId,
              detail: p.detail,
            });
            let proposed = false;
            if (p.reason === 'credential_endpoint_mismatch' && p.credentialRef && p.url) {
              let host = '';
              try {
                host = new URL(String(p.url)).hostname;
              } catch {
                // 非法 URL 不生成提案,仅审计
              }
              if (host) {
                // 去重:同一 envVar+host 已有 pending 提案时不重复生成
                const pending = (us.getPolicyProposals(userId, 'pending') as any[]).some(
                  (x) => x.kind === 'credential-binding' && x.detail?.envVar === p.credentialRef && (x.detail?.hosts || []).includes(host)
                );
                if (!pending) {
                  const proposal = us.addPolicyProposal(userId, {
                    kind: 'credential-binding',
                    detail: { envVar: String(p.credentialRef), hosts: [host], reason: String(p.reason) },
                    source: { taskId: p.taskId, tool: p.tool, url: String(p.url) },
                  });
                  const { getGovernanceBus } = require('@/lib/governance-bus');
                  getGovernanceBus().emitPermissionProposed({
                    userId,
                    proposalId: proposal.id,
                    kind: 'credential-binding',
                    detail: `${p.credentialRef} → ${host}`,
                  });
                  this.addTerminalLog(
                    'system',
                    `[Sandbox] 凭据端点不匹配已拦截(${p.credentialRef} → ${host}),已生成权限提案待审核。`
                  );
                  proposed = true;
                }
              }
            }
            if (!proposed) {
              this.addTerminalLog('stderr', `[Sandbox] 出站/凭据请求被拒绝: ${p.reason}${p.url ? `(${p.url})` : ''}`);
            }
          }
        } catch {
          // 审计/提案失败不阻断主流程(降级:仅终端日志)
          this.addTerminalLog('stderr', `[Sandbox] 拒绝事件已收到(审计落盘失败): ${p.reason || 'unknown'}`);
        }
        break;
      }

      case 'tool_call': {
        const toolName = event.payload.tool;
        if (toolName === 'browser_navigate') {
          this.state.viewport.url = event.payload.url || event.payload.args?.url;
          this.state.viewport.status = 'navigating';
          // 视口归属（同 viewport_update）：占用者的导航才广播给占用者本人
          const navMission = this.resolveMissionFromEvent(event);
          if (navMission?.userId) {
            this.state.viewportUserId = navMission.userId;
          }
          if (navMission) {
            navMission.viewport = { ...this.state.viewport };
          }
          this.broadcast({
            type: 'viewport_update',
            data: { ...this.state.viewport, userId: this.state.viewportUserId ?? undefined },
          });
        }

        // 按事件自带 taskId 归属（串台修复）；工具开始 = 模型解说段收尾
        const mission = this.resolveMissionFromEvent(event);
        if (mission) {
          this.flushDeltas(mission.id);
          closeLiveStep(mission, { status: 'DONE' });

          // 挂载到该任务的步骤（去重逻辑：如果最后一步是相同的处于 RUNNING 状态的工具，则复用更新参数，避免插件与核心双重广播导致的成对重复步骤）
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
              startedAt: Date.now(),
            });
          }
          this.broadcast({ type: 'mission_updated', data: mission });
        }
        break;
      }

      case 'tool_result': {
        const toolName = event.payload.tool;
        if (toolName === 'browser_navigate' || !toolName) {
          this.state.viewport.status = 'idle';
          const vpMission = this.resolveMissionFromEvent(event);
          if (vpMission && vpMission.viewport) {
            vpMission.viewport.status = 'idle';
          }
          this.broadcast({
            type: 'viewport_update',
            data: { ...this.state.viewport, userId: this.state.viewportUserId ?? undefined },
          });
        }

        // 按事件自带 taskId 归属（串台修复）
        const mission = this.resolveMissionFromEvent(event);
        if (mission && mission.steps.length > 0) {
          // 找到最后处于 RUNNING 的该工具步骤并将其标记为完成
          const targetStep = [...mission.steps].reverse().find((s) => s.status === 'RUNNING' && (!toolName || s.tool === toolName)) || mission.steps[mission.steps.length - 1];
          if (targetStep && targetStep.status === 'RUNNING') {
            targetStep.status = 'DONE';
            targetStep.output = event.payload.output;
            // 回滚把手随步骤快照落盘(治理不变量 I5:每个行动都留下
            // 可撤销性声明,irreversible 的在前端/审计里显式可见)
            if (event.payload.compensation) {
              targetStep.compensation = event.payload.compensation;
            }
            // 真实耗时（工具广播与核心广播双写时取首次完成时间）
            const elapsed = Date.now() - (targetStep.startedAt || Date.now());
            targetStep.duration = `${elapsed < 0 ? 0 : elapsed}ms`;
            this.broadcast({ type: 'mission_updated', data: mission });
          }
        }
        break;
      }

      case 'plan': {
        const plan: PlanData = event.payload;
        // 按任务键归属：plan.taskKey = 发起该任务的 mission id。
        // 多用户并发时事件流是全局的，不按 taskKey 过滤会把 A 用户的看板
        // 挂到 B 用户的 activeMissionId 上（看板串台）。
        const mission = plan.taskKey
          ? this.state.missions.find((m) => m.id === plan.taskKey)
          : this.state.missions.find((m) => m.id === this.state.activeMissionId);
        if (mission) {
            mission.title = plan.goal;
            // 合并式同步：看板任务按 id 增量更新/追加，【不】整体覆盖 steps ——
            // 旧实现每次 planner_update_task 都会把用户提问、已执行的工具步骤
            // 全部抹掉，时间线反复闪烁且回溯不可见
            for (const t of plan.tasks) {
              const status =
                t.status === 'completed' ? 'DONE' : t.status === 'in_progress' ? 'RUNNING' : t.status === 'failed' ? 'FAILED' : 'PENDING';
              const existing = mission.steps.find((s) => s.id === t.id);
              if (existing) {
                existing.title = t.title;
                existing.status = status;
                if (t.result) existing.output = t.result;
              } else {
                mission.steps.push({
                  id: t.id,
                  title: t.title,
                  status,
                  output: t.result,
                });
              }
            }
            const completedCount = mission.steps.filter((s) => s.status === 'DONE').length;
            mission.progress = Math.round((completedCount / (mission.steps.length || 1)) * 100);
            this.broadcast({ type: 'mission_updated', data: mission });
        }
        break;
      }

      case 'approval_request': {
        const req: ApprovalRequest = event.payload;
        // 盖章归属（taskId/userId）：SSE 按用户过滤审批卡片，多用户不串台
        req.taskId = event.payload.taskId;
        const mission = this.resolveMissionFromEvent(event);
        if (mission) {
          req.userId = mission.userId;
          this.state.approvalRequests.push(req);
          mission.status = 'WAITING_APPROVAL';
          this.broadcast({ type: 'mission_updated', data: mission });
        } else {
          this.state.approvalRequests.push(req);
        }
        this.broadcast({ type: 'approval_requested', data: req });
        break;
      }

      case 'connector_suggestion': {
        // 任务中途请求连接器授权：入 state 并广播，前端驾驶舱弹授权卡片
        const suggestion: ConnectorSuggestion = event.payload;
        this.state.connectorSuggestions = [
          ...this.state.connectorSuggestions.filter((s) => s.id !== suggestion.id),
          suggestion,
        ];
        this.broadcast({ type: 'connector_suggested', data: suggestion });
        break;
      }

      case 'connector_suggestion_resolved': {
        // 授权完成/跳过/超时：移除卡片
        const { id, outcome } = event.payload;
        this.state.connectorSuggestions = this.state.connectorSuggestions.filter((s) => s.id !== id);
        this.broadcast({ type: 'connector_suggestion_resolved', data: { id, outcome } });
        if (outcome === 'authorized') {
          // suggestion id 形如 `${userId}::${connectorId}`，取前半段作为归属
          const uid = typeof id === 'string' ? id.split('::')[0] : undefined;
          this.addTerminalLog('system', '[Connector] 用户已完成中途授权，任务继续执行', uid);
        }
        break;
      }

      case 'artifact': {
        // 按任务键归属（同 plan 的串台问题）；无 taskId 的产物走 activeMission 兜底
        const mission = event.payload.taskId
          ? this.state.missions.find((m) => m.id === event.payload.taskId)
          : this.state.missions.find((m) => m.id === this.state.activeMissionId);
        this.state.latestArtifact = event.payload;
        if (mission) {
          mission.artifact = event.payload;
          this.broadcast({ type: 'mission_updated', data: mission });
        }
        this.broadcast({ type: 'artifact_updated', data: event.payload });
        break;
      }

      case 'approval_resolved': {
        // 核心层审批超时自动拒绝（或中止释放）：撤下审批卡片，任务状态恢复
        const { id, reason } = event.payload || {};
        if (id) {
          this.state.approvalRequests = this.state.approvalRequests.filter((r) => r.id !== id);
        }
        // 按事件自带 taskId 归属（串台修复）
        const mission = this.resolveMissionFromEvent(event);
        if (mission && mission.status === 'WAITING_APPROVAL') {
          mission.status = 'ACTIVE';
          this.broadcast({ type: 'mission_updated', data: mission });
        }
        if (reason === 'timeout') {
          this.addTerminalLog(
            'stderr',
            '[Approval] 审批等待超时，已自动拒绝并继续执行（工具走 rejected 兜底路径）。',
            mission?.userId
          );
        }
        break;
      }

      case 'thought': {
        if (event.payload.text) {
          this.addTerminalLog('system', `[AI 思考与回复] ${event.payload.text}`, this.resolveMissionFromEvent(event)?.userId);
        }
        break;
      }

      case 'done': {
        const finalAnswer = event.payload?.finalAnswer || 'Task completed';
        // 按事件自带 taskId 归属（串台修复）
        const mission = this.resolveMissionFromEvent(event);
        if (mission) {
          // 先 flush 增量缓冲（SSE 顺序：全部 delta → 边界 mission_updated）
          this.flushDeltas(mission.id);
          // 只有真正执行过的 RUNNING 步骤标记完成；PENDING（未执行的看板步骤）
          // 保持原状态 —— 旧实现把所有 PENDING 强标 DONE、进度强设 100，
          // 未完成的计划步骤在 UI 上显示为"已完成"，效率面板系统性偏乐观
          mission.steps.forEach((st) => {
            if (st.status === 'RUNNING') {
              st.status = 'DONE';
              const elapsed = Date.now() - (st.startedAt || Date.now());
              st.duration = st.duration || `${elapsed < 0 ? 0 : elapsed}ms`;
            }
          });

          // 终稿合并去重：流式 live step 存在时原地升级为最终回复（权威全文
          // 覆盖累积部分，稳定 id 让 React 复用同一卡片，不产生重复回复块）；
          // 无 live step（纯工具任务/收尾总结路径）才追加独立回复步骤
          const merged = finalizeWithAnswer(mission, finalAnswer);
          if (!merged) {
            mission.steps.push({
              id: `step_assistant_${Date.now()}`,
              role: 'assistant',
              messageKind: 'final',
              title: '最终答复',
              status: 'DONE',
              answer: finalAnswer,
            });
          }

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
            // 进度按真实完成比例呈现（未执行的看板步骤不计入完成）
            const doneCount = mission.steps.filter((st) => st.status === 'DONE').length;
            mission.progress = Math.round((doneCount / (mission.steps.length || 1)) * 100);
            if (mission.viewport) {
              mission.viewport.status = 'idle';
            }
            this.broadcast({ type: 'mission_updated', data: mission });
          }

        this.state.viewport.status = 'idle';
        // 任务完成即释放视口占用（最后一帧仍带占用者 userId 只推给本人，
        // 之后无人占用，新的全局视口事件恢复全员可见）
        this.broadcast({
          type: 'viewport_update',
          data: { ...this.state.viewport, userId: this.state.viewportUserId ?? undefined },
        });
        this.state.viewportUserId = null;
        this.addTerminalLog('system', `[Agent] 回复完成: ${finalAnswer.slice(0, 100)}`, mission?.userId);
        break;
      }

      case 'error': {
        const errorMsg = event.payload?.error || 'Unknown execution error';
        // 按事件自带 taskId 归属（串台修复）；live step 收尾为 FAILED
        // （保留已流出的部分文本，用户能看到"进行到哪"）
        const mission = this.resolveMissionFromEvent(event);
        if (mission) {
          this.flushDeltas(mission.id);
          closeLiveStep(mission, { status: 'FAILED' });
          mission.status = 'DONE';
          mission.steps.push({
            id: `step_err_${Date.now()}`,
            title: `执行异常: ${errorMsg}`,
            status: 'FAILED',
          });
          this.broadcast({ type: 'mission_updated', data: mission });
        }
        // 失败同样释放视口占用，避免把其他用户永久挡在空白画面外
        this.state.viewportUserId = null;
        this.addTerminalLog('stderr', `[Agent Error] ${errorMsg}`, mission?.userId);
        break;
      }
    }
  }

  /**
   * 记终端日志。userId 标记归属用户（多用户部署时 SSE 只推给本人，
   * 未标记的视为全局系统日志）。
   */
  public addTerminalLog(type: TerminalLog['type'], text: string, userId?: string) {
    const entry: TerminalLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      type,
      text,
      userId,
    };
    this.state.terminalLogs.push(entry);
    if (this.state.terminalLogs.length > 500) {
      this.state.terminalLogs.shift();
    }

    if (userId) {
      // 归属明确的日志只挂到该用户的 in-flight 任务（按 userId 找，
      // 而不是 activeMission —— 切换会话时不再挂错）
      const mission = this.state.missions.find((m) => m.userId === userId && m.status !== 'DONE');
      if (mission) {
        if (!mission.terminalLogs) mission.terminalLogs = [];
        mission.terminalLogs.push(entry);
        if (mission.terminalLogs.length > 300) {
          mission.terminalLogs.shift();
        }
      }
    } else if (this.state.activeMissionId) {
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
          body: `${event.data.title || '任务'}：${(event.data.steps?.filter((s: any) => s.role === 'assistant' && s.answer)?.slice(-1)?.[0]?.answer || '').toString().slice(0, 80) || '点击查看交付成果'}`,
          tag: `mission-done-${missionId}`,
          url: '/',
        }).catch(() => {});
      }
    } catch {
      // push 不可用不影响主流程
    }
  }

  public submitApproval(approvalId: string, approved: boolean): boolean {
    // 内核未就绪（极早期请求）时必然没有挂起中的审批，直接返回未命中
    if (!this.orchestrator) return false;
    const success = this.orchestrator.submitApproval(approvalId, approved);
    // 先取归属再移除（userId 供该条日志的 SSE 过滤锚点）
    const req = this.state.approvalRequests.find((r) => r.id === approvalId);
    this.state.approvalRequests = this.state.approvalRequests.filter((r) => r.id !== approvalId);

    if (this.state.activeMissionId) {
      const mission = this.state.missions.find((m) => m.id === this.state.activeMissionId);
      if (mission && mission.status === 'WAITING_APPROVAL') {
        mission.status = 'ACTIVE';
        this.broadcast({ type: 'mission_updated', data: mission });
      }
    }

    this.broadcast({ type: 'approval_resolved', data: { approvalId, approved } });
    this.addTerminalLog('system', `[Approval] User ${approved ? 'AUTHORIZED' : 'REJECTED'} action ${approvalId}.`, req?.userId);
    return success;
  }

  /**
   * 订阅治理总线(持久状态治理「回退弧」→ in-flight 任务传导,设计文档 §3.2/§3.3):
   * - 记忆被(软)删除:通知该用户所有运行中任务,模型下一步显式感知,不再引用已删记忆(I3);
   * - 授权撤销(权限纪元 +1):从 taskEnv 活引用中移除对应 Key(工具 session.env 与其
   *   共享同一对象,立即生效)、断开对应 MCP 服务器连接,并注入治理提示(I1:权威只收窄)。
   */
  private initGovernanceSubscriptions() {
    try {
      const { getGovernanceBus } = require('@/lib/governance-bus');
      const bus = getGovernanceBus();

      bus.onMemoryRevoked((ev: any) => {
        const who =
          ev.requestedBy === 'user' ? '用户' : ev.requestedBy === 'propagated' ? '上游删除传导' : '系统';
        const notice = `记忆「${ev.title || ev.memoryId}」已被${who}删除${ev.reason ? `(原因:${ev.reason})` : ''}。后续步骤不得再引用或依赖该记忆内容;若当前计划基于它制定,请立即调整方案。`;
        for (const rt of this.taskRuntimes.values()) {
          if (rt.userId === ev.userId) rt.notices.push(notice);
        }
      });

      bus.onAuthorityRevoked((ev: any) => {
        // 解析受影响的 envVar 集合:事件显式携带,或由 connectorId → tokenEnvVar 推导
        const envVars: string[] = Array.isArray(ev.envVars) ? [...ev.envVars] : [];
        let label = envVars.join(', ');
        if (ev.connectorId) {
          try {
            const { getMcpConnectorDef } = require('@/lib/mcp-connectors');
            const def = getMcpConnectorDef(ev.connectorId);
            if (def?.tokenEnvVar && !envVars.includes(def.tokenEnvVar)) envVars.push(def.tokenEnvVar);
            label = label || def?.name || ev.connectorId;
            // 断开该用户对应 MCP 服务器连接(旧 token 的连接不再可复用)
            const mcpSvc = this.mcp;
            if (mcpSvc?.disconnectUser && Array.isArray(def?.servers)) {
              for (const s of def.servers) {
                Promise.resolve(mcpSvc.disconnectUser(ev.userId, s.name)).catch(() => {});
              }
            }
          } catch {
            label = label || ev.connectorId;
          }
        }
        const notice = `连接器授权已撤销(${label},权限纪元推进至 ${ev.epoch})。对应凭证已从当前任务运行环境移除,严禁继续调用依赖该授权的工具(mcp_ 前缀调用或需要该 Key 的工具);请调整计划,或引导用户重新授权后再继续。`;
        for (const rt of this.taskRuntimes.values()) {
          if (rt.userId !== ev.userId) continue;
          if (rt.env) {
            for (const k of envVars) delete rt.env[k];
          }
          rt.notices.push(notice);
        }
      });

      // 权限提案批准 → 热更新该用户 in-flight 任务的 taskSandbox 活引用
      // (docs/design/sandbox-control-hardening.md §4.4:审核通过后规则即时生效,
      // 不重启任务 —— 原地修改策略对象,工具下一次调用读取新值,铁律 7 不受影响)
      bus.onPermissionResolved((ev: any) => {
        if (!ev.approved) return;
        for (const rt of this.taskRuntimes.values()) {
          if (rt.userId !== ev.userId || !rt.sandbox) continue;
          if (ev.kind === 'credential-binding' && ev.payload?.envVar) {
            const cur = rt.sandbox.credentialBindings || {};
            const hosts = Array.isArray(ev.payload.hosts) ? ev.payload.hosts : [];
            rt.sandbox.credentialBindings = {
              ...cur,
              [ev.payload.envVar]: Array.from(new Set([...(cur[ev.payload.envVar] || []), ...hosts])),
            };
          } else if (ev.kind === 'expose-env' && ev.payload?.envVar) {
            const allow = rt.sandbox.exposeEnv || [];
            // 与任务启动时同一 ∩ 语义:只放行确实注入过 taskEnv 的键
            if (!allow.includes(ev.payload.envVar) && rt.env && ev.payload.envVar in rt.env) {
              rt.sandbox.exposeEnv = [...allow, ev.payload.envVar];
            }
          }
        }
      });
    } catch (e: any) {
      console.error('[Governance] 治理总线订阅失败(降级:回退弧事件不再传导到运行中任务):', e?.message || e);
    }
  }

  public stopMission(missionId: string) {
    // 清掉未广播的流式增量缓冲（残段丢弃，任务即将终止）
    this.flushDeltas(missionId);

    const controller = this.activeAbortControllers.get(missionId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(missionId);
    }

    // 清理并拒绝所有挂起的人机协同审批，避免终止后残留授权弹窗
    if (this.state.approvalRequests.length > 0) {
      for (const req of this.state.approvalRequests) {
        try {
          this.orchestrator?.submitApproval(req.id, false);
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
      this.addTerminalLog('system', `[Mission Aborted] ID: ${missionId} has been terminated.`, mission.userId);
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
    await this.ensureRuntime();

    // 续聊目标定位：内存 → 持久化库回水（重启后内存为空，但磁盘上的
    // 历史任务含会话消息，直接载入内存续聊，而不是静默开新任务丢上下文）
    let targetMission: Mission | undefined = this.state.missions.find((m) => m.id === options.missionId);
    if (!targetMission && options.missionId && options.userId) {
      try {
        const { getUserMissions } = await import('@/lib/user-store');
        const persisted = getUserMissions(options.userId).find((m: any) => m.id === options.missionId);
        if (persisted) {
          targetMission = persisted as Mission;
          this.state.missions.unshift(targetMission);
          this.addTerminalLog(
            'system',
            `[Session Restored] ID: ${targetMission.id} 已从持久化库回水（含 ${targetMission.conversationMessages?.length || 0} 条历史会话）`,
            targetMission.userId
          );
        }
      } catch {
        // 回水失败按新任务处理
      }
    }

    if (targetMission) {
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
      this.addTerminalLog('system', `[Session Continued] ID: ${targetMission.id} | New Goal: ${goal}`, targetMission.userId);
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
      this.addTerminalLog('system', `[Mission Started] ID: ${missionId} | Goal: ${goal}`, options.userId);
    }

    const abortController = new AbortController();
    this.activeAbortControllers.set(targetMission.id, abortController);

    // 异步执行任务生命周期
    (async () => {
      try {
        // 1. 注入当前登录用户专属沉淀的长效记忆与画像：
        // 执行红线(rule)全量注入,其余按与本次任务目标的相关性排序 + 条数/字符预算截断
        let userMemoryPrompt = '';
        if (options.userId) {
          try {
            const { buildMemoryPromptBlock } = await import('@/lib/memory-service');
            userMemoryPrompt = buildMemoryPromptBlock(options.userId, goal);
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

        // 2.5 挂载当前用户的 MCP 连接器（一键授权/粘贴凭证/免凭证直连）
        // 任务级注入（taskTools）：不进全局注册表，多用户互不可见
        let taskTools: any[] | undefined;
        let taskEnv: Record<string, string> | undefined;
        let taskSandbox: import('@agtpilot/core').SandboxSessionPolicy | undefined;
        if (options.userId) {
          const uid = options.userId;

          // 2.4 用户级长期记忆工具（独立于 MCP 挂载，不随连接器失败而失效）：
          // 同名覆盖 plugin-memory 的全局单文件版本 —— memory_store/recall/list
          // 全部读写该用户专属记忆库（user-store），多用户部署时 A 用户 Agent
          // 沉淀的记忆不会进入 B 用户的召回结果
          try {
            const { buildUserMemoryTools } = await import('@/lib/memory-service');
            taskTools = [...(taskTools || []), ...buildUserMemoryTools(uid)];
          } catch (e: any) {
            this.addTerminalLog('stderr', `[Memory] 用户记忆工具挂载异常: ${e?.message || e}`, uid);
          }

          // 2.45 用户级定时巡航工具（同名命名空间 cron_*，与插件路由前缀约定一致）：
          // 读写该用户 user-store、注册进本调度池（闭包捕获 userId）—— 模型经工具
          // 创建的任务与 UI cron 管理页创建的任务同一套存储与调度，无双轨
          try {
            const { buildUserCronTools } = await import('@/lib/cron-service');
            taskTools = [
              ...(taskTools || []),
              ...buildUserCronTools(uid, {
                register: (u, job) => this.registerUserCronJob(u, job),
                unregister: (jobId) => this.unregisterUserCronJob(jobId),
              }),
            ];
          } catch (e: any) {
            this.addTerminalLog('stderr', `[Cron] 用户定时任务工具挂载异常: ${e?.message || e}`, uid);
          }

          try {
            const { buildUserMcpServers } = await import('@/lib/mcp-connectors');
            const { buildConnectorBridgeTools } = await import('@/lib/connector-bridge');
            const mcpSvc = this.mcp;
            const injectedTools: any[] = [];

            if (mcpSvc?.syncUserServers) {
              const servers = buildUserMcpServers(uid);
              if (servers.length > 0) {
                const sync = await mcpSvc.syncUserServers(uid, servers);
                const userTools = await mcpSvc.getUserTools(uid);
                injectedTools.push(...userTools);
                this.addTerminalLog(
                  'system',
                  `[MCP] 用户连接器挂载: 新连 ${sync.connected.length} / 复用 ${sync.reused.length}，共 ${userTools.length} 个工具`,
                  uid
                );
                for (const f of sync.failed) {
                  this.addTerminalLog('stderr', `[MCP] 连接 ${f.name} 失败: ${f.error}`, uid);
                }
              }
            }

            // 中途授权桥：connector_authorize（弹卡片等授权）+ mcp_call（代理调用中途新授权的工具）
            // 始终注入 —— 即使当前一个连接器都没配，Agent 也能在任务中引导用户授权
            injectedTools.push(
              ...buildConnectorBridgeTools({
                userId: uid,
                emit: (e) => this.ctx.agent.emitEvent(e as any),
                getMcpSvc: () => this.mcp,
              })
            );

            // 微信公众号草稿箱直连:wechat_mp_check_setup / wechat_mp_create_draft
            // 始终注入(未配置时返回引导文案),凭证在 execute 时才从 user-store 按用户读取
            const { buildWechatMpTools } = await import('@/lib/wechat-mp');
            injectedTools.push(...buildWechatMpTools(uid));

            // 电子邮件 SMTP 直发:email_send(同样始终注入,凭证 execute 时按用户读取)
            const { buildEmailTools } = await import('@/lib/email-smtp');
            injectedTools.push(...buildEmailTools(uid));

            // 电子邮件 IMAP 收件:email_list / email_read(始终注入,凭证 execute 时按用户读取,未配置回退复用 SMTP 凭证)
            const { buildEmailImapTools } = await import('@/lib/email-imap');
            injectedTools.push(...buildEmailImapTools(uid));

            // 小红书托管模式(scenario-loop P2):读工具登录过即注入;
            // 存草稿工具仅在显式 opt-in + 风险已读时注入(dangerLevel high → 审批门)。
            // 浏览器服务来自 plugin-browser 的 ctx.browser,与登录通道共享同一 Page
            try {
              const { buildXhsManagedTools } = await import('@/lib/xhs-managed');
              const browserSvc = (this.ctx as any)?.browser;
              const xhsTools = buildXhsManagedTools(uid, browserSvc);
              if (xhsTools.length > 0) {
                injectedTools.push(...xhsTools);
                this.addTerminalLog(
                  'system',
                  `[XHS] 托管工具挂载: ${xhsTools.map((t: any) => t.name).join(' / ')}`,
                  uid
                );
              }
            } catch (e: any) {
              this.addTerminalLog('stderr', `[XHS] 托管工具挂载异常: ${e?.message || e}`, uid);
            }
            taskTools = [...(taskTools || []), ...injectedTools];

          } catch (e: any) {
            this.addTerminalLog('stderr', `[MCP] 连接器挂载异常: ${e?.message || e}`, uid);
          }

          // 用户级非 LLM 服务 Key（搜索/爬取/云端沙箱）：经 runTask taskEnv → session.env
          // 透传给插件，绝不写 process.env（多用户隔离）
          try {
            const { getUserConnectors } = await import('@/lib/user-store');
            const cfgs = getUserConnectors(uid).configs;
            const env: Record<string, string> = {};
            for (const k of [
              'EXA_API_KEY',
              'TAVILY_API_KEY',
              'FIRECRAWL_API_KEY',
              'E2B_API_KEY',
              // 通知类 Webhook（plugin-notify notify_send_webhook 按 session.env 解析）
              'FEISHU_WEBHOOK_URL',
              'SLACK_WEBHOOK_URL',
              'DINGTALK_WEBHOOK_URL',
              'WECOM_WEBHOOK_URL',
            ]) {
              const v = (cfgs[k] || '').trim();
              if (v) env[k] = v;
            }
            if (Object.keys(env).length > 0) {
              taskEnv = env;
              this.addTerminalLog('system', `[Key] 用户级服务密钥注入: ${Object.keys(env).join(', ')}`, uid);
            }
          } catch (e) {
            // ignore
          }

          // 沙箱控制策略(taskSandbox,docs/design/sandbox-control-hardening.md §4.4):
          // - exposeEnv: 仅用户显式 opt-in 白名单 ∩ 实际注入的 taskEnv 键(默认零 Key 进子进程);
          // - credentialBindings: core 默认绑定 ∪ 用户自定义(提案批准后热更新的落点);
          // - fence: 用户配置 → AGTPILOT_SANDBOX_FENCE → off(向后兼容)。
          // 该对象为活引用:权限提案批准后经 onPermissionResolved 原地修改,in-flight 任务即时生效。
          try {
            const { getSandboxConfig } = await import('@/lib/user-store');
            const { DEFAULT_CREDENTIAL_BINDINGS } = await import('@agtpilot/core');
            const sbxCfg = getSandboxConfig(uid);
            const envFence = process.env.AGTPILOT_SANDBOX_FENCE;
            const fence: 'off' | 'best_effort' | 'hard_requirement' =
              sbxCfg.fence ||
              (envFence === 'best_effort' || envFence === 'hard_requirement' || envFence === 'off'
                ? envFence
                : 'off');
            taskSandbox = {
              exposeEnv: (sbxCfg.exposeAllowlist || []).filter((k) => Boolean(taskEnv && k in taskEnv)),
              credentialBindings: { ...DEFAULT_CREDENTIAL_BINDINGS, ...(sbxCfg.credentialBindings || {}) },
              fence,
              net: 'allow',
            };
            if ((taskSandbox.exposeEnv || []).length > 0) {
              this.addTerminalLog(
                'system',
                `[Sandbox] 子进程环境暴露白名单: ${taskSandbox.exposeEnv!.join(', ')}(用户显式授权,其余 Key 不进子进程)`
              );
            }
          } catch (e: any) {
            this.addTerminalLog('stderr', `[Sandbox] 沙箱策略构建异常(降级为默认零暴露): ${e?.message || e}`);
            taskSandbox = { exposeEnv: [], fence: 'off', net: 'allow' };
          }
        }

        // 登记本任务运行时把手:治理事件(记忆删除/授权撤销)发生后仍能
        // 传导到 in-flight 任务(凭证即时清除 + 下一步注入治理提示)
        this.taskRuntimes.set(targetMission.id, {
          userId: options.userId,
          env: taskEnv,
          sandbox: taskSandbox,
          notices: [],
        });

        if (hasLlm) {
          // 调用真正的大模型 + 工具链编排 (Vercel AI SDK + Cordis 工具集)
          const result = await this.ctx.orchestrator.runTask({
            taskId: targetMission.id,
            userId: options.userId,
            abortSignal: abortController.signal,
            configOverride: userConfigOverride,
            historyMessages: targetMission.conversationMessages,
            prompt: goal,
            taskTools,
            taskEnv,
            taskSandbox,
            // 回退弧感知通道:每步 prepareStep 前取一条排队的治理提示注入
            getStepNotice: () => this.taskRuntimes.get(targetMission.id)?.notices.shift() ?? null,
            system: `你是基于 Cordis 微内核架构驱动的个人全自主智能体驾驶舱 (AgtPilot)。
你拥有强大的推理能力与丰富的原子工具生态（包括浏览器实时自动化 browser_navigate、沙箱隔离命令执行 sandbox_run_command 等）。
${userMemoryPrompt ? `\n${userMemoryPrompt}\n` : ''}
【核心行为准则 (Behavioral Steering)】：
1. 【区分对话与执行】：如果用户的请求只是自我介绍、询问你能做什么、概念解释或一般性闲聊，请直接运用你渊博的知识用清晰、亲切、优雅的中文回复，【严禁】无缘无故调用外部搜索或终端工具！
2. 【按需调用工具】：只有当用户的任务确实需要实时信息检索、网页交互抓取、执行代码或特定环境诊断时，才调用对应的原子工具。
3. 【连接器工具优先】：mcp_ 前缀的工具来自用户已授权的外部服务连接器（如地图、文档、日程），涉及对应平台的能力时优先使用它们。
4. 【中途授权】：当任务确实需要某平台专用能力（如读写 Notion、管理滴答清单日程）但对应连接器未授权时，调用 connector_authorize（action=request，附 connectorId 与一句话理由）向用户发起授权请求 —— 用户会看到授权卡片，工具会等待结果：授权成功则返回新工具清单，用 mcp_call 按名字调用；用户跳过或超时则立即改用 browser_ 系列工具在网页上直接完成操作作为兜底，不要空等或放弃任务。不确定有哪些连接器时先用 connector_authorize（action=list）查看。
5. 【结构化交付】：在完成任务后，清晰总结执行结果并给出交付物。
6. 【步数经济】：多个互相独立的工具调用，请在同一轮一次性并行发出，不要逐个串行等待结果后再发下一个；任务看板（planner）由系统随工具执行成功自动推进，【不要】调用 planner_update_task 汇报进度（仅在需要标记某步骤失败时才使用）；预计两步以内的简单任务直接执行，不要创建规划看板。
7. 【安静执行】：在工具调用前后不要反复输出“收到”“我先搜索”“我再继续”等过程播报；直接调用工具，由系统活动卡展示进度。只有需要用户补充信息、审批授权、报告不可恢复的阻塞，或给出最终交付时，才向用户输出完整消息。
8. 【小红书托管边界】：涉及用户小红书账号时 —— 读创作中心数据一律用 xhs_read_creator_data（只读）；把笔记存成草稿一律用 xhs_save_note_draft（需用户审批，终点是草稿箱）；任何情况下不得点击「发布」按钮 —— 发布永远由用户本人在小红书 App 内完成，这是平台合规红线。`,
          });

          if (result.success && result.messages) {
            targetMission.conversationMessages = result.messages;
            this.broadcast({ type: 'mission_updated', data: targetMission });
          }

          // 3. 会话结束自动记忆维护(双通道,Mem0 式 CRUD 决策环):
          // - 用户通道:从用户原话提炼/维护用户画像记忆(偏好/背景/约束);
          // - Agent 经验通道:从执行轨迹(工具调用/失败/熔断/效率)提炼环境事实、
          //   工具教训与流程策略 —— Agent 不再每个会话重踩同一个坑;
          // 用户手动固化的执行红线受保护不可改删。异步旁路执行,失败静默,
          // 不阻塞任务交付
          if (result.success && options.userId) {
            const uid = options.userId;
            void (async () => {
              try {
                const {
                  distillMissionMemories,
                  distillAgentExperience,
                  isAutoMemoryEnabled,
                } = await import('@/lib/memory-service');
                if (!isAutoMemoryEnabled()) return;

                const userOutcome = await distillMissionMemories(this.ctx, {
                  userId: uid,
                  goal,
                  messages: targetMission.conversationMessages || [],
                  missionId: targetMission.id,
                  configOverride: userConfigOverride,
                });
                // Agent 通道自带信息量门槛(纯闲聊任务不跑,省一次模型调用)
                const agentOutcome = await distillAgentExperience(this.ctx, {
                  userId: uid,
                  goal,
                  mission: targetMission,
                  efficiency: result.efficiency,
                  missionId: targetMission.id,
                  configOverride: userConfigOverride,
                });

                const fmt = (o: { added: any[]; updated: any[]; deletedIds: string[] }) =>
                  [
                    o.added.length > 0 ? `新增 ${o.added.length} 条(${o.added.map((m) => m.title).join('、')})` : '',
                    o.updated.length > 0 ? `更新 ${o.updated.length} 条(${o.updated.map((m) => m.title).join('、')})` : '',
                    o.deletedIds.length > 0 ? `删除 ${o.deletedIds.length} 条` : '',
                  ]
                    .filter(Boolean)
                    .join(' / ');
                const lines = [
                  fmt(userOutcome) ? `用户画像: ${fmt(userOutcome)}` : '',
                  fmt(agentOutcome) ? `Agent 经验: ${fmt(agentOutcome)}` : '',
                ].filter(Boolean);
                if (lines.length > 0) {
                  this.addTerminalLog('system', `[Memory] 会话结束记忆维护: ${lines.join('；')}`, uid);
                  this.broadcast({
                    type: 'memories_updated',
                    data: {
                      userId: uid,
                      userAdded: userOutcome.added.length,
                      userUpdated: userOutcome.updated.length,
                      userDeleted: userOutcome.deletedIds.length,
                      agentAdded: agentOutcome.added.length,
                      agentUpdated: agentOutcome.updated.length,
                      agentDeleted: agentOutcome.deletedIds.length,
                    },
                  });
                }
              } catch {
                // 提炼失败不影响任务结果
              }
            })();
          }

          if (!result.success && result.error) {
            targetMission.status = 'DONE';
            targetMission.steps.push({
              id: `step_err`,
              title: `执行异常: ${result.error}`,
              status: 'FAILED',
            });
            this.addTerminalLog('stderr', `[Mission Error] ${result.error}`, targetMission.userId);
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
          this.addTerminalLog('stderr', '[Config Required] 当前用户未配置大模型 API Key。请前往顶部「连接器」添加自定义 OpenAI、DeepSeek 或中转站 Key。', options.userId);
        }
      } catch (err: any) {
        targetMission.status = 'DONE';
        targetMission.steps.push({
          id: `step_err`,
          title: `Execution error: ${err.message}`,
          status: 'FAILED',
        });
        this.addTerminalLog('stderr', `[Mission Error] ${err.message}`, targetMission.userId);
        this.broadcast({ type: 'mission_updated', data: targetMission });
      } finally {
        this.activeAbortControllers.delete(targetMission.id);
        this.taskRuntimes.delete(targetMission.id);
      }
    })();

    return targetMission;
  }

  public initCronScheduler() {
    if (this.cronSchedulerInitialized) return;
    this.cronSchedulerInitialized = true;

    // 调度本体在 plugin-cron 的 CronService（无头引擎，ctx.cron），
    // 必须等微内核就绪后才能注册 —— 这里异步自驱动，不阻塞调用方
    this.whenReady()
      .then(() => {
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
      })
      .catch((err: any) => {
        console.error('Failed to init cron scheduler in AgentBackend:', err);
      });
  }

  /**
   * 把用户级 cron 任务挂进调度池。
   * 调度交给 ctx.cron（plugin-cron 无头引擎）；执行策略在这里：
   * 闭包捕获 userId，触发时以该用户身份 runMission（用其 API Key、
   * mission 归其名下），并回写 user-store 的执行计数与下次触发时间。
   */
  public registerUserCronJob(userId: string, jobInfo: any) {
    if (jobInfo.status !== 'active') return;

    const cronSvc = this.ctx?.cron;
    if (!cronSvc) {
      this.addTerminalLog('stderr', `[Cron] 调度引擎未就绪，任务 "${jobInfo.name}" 暂未挂载（重启后将自动恢复）。`, userId);
      return;
    }

    const ok = cronSvc.register(jobInfo.id, jobInfo.pattern, async () => {
      this.addTerminalLog('system', `[自动巡航触发] 任务 "${jobInfo.name}" 到达预定时间，开始自主执行...`, userId);

      // 更新执行计数与下一次触发时间
      jobInfo.runCount = (jobInfo.runCount || 0) + 1;
      jobInfo.lastRunAt = Date.now();
      jobInfo.nextRun = cronSvc.nextRun(jobInfo.id) || undefined;

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

      // 以任务归属用户的身份启动智能体生命周期执行。
      // scenario 订阅任务(如小红书每周选题)触发时用最新档案重建 prompt,不用建订阅时的快照
      try {
        const { getUserScenarioProfiles } = require('@/lib/user-store');
        const prompt = resolveCronPrompt(jobInfo, (key) => getUserScenarioProfiles(userId)[key]);
        await this.runMission(prompt, {
          title: `【自动巡航】${jobInfo.name}`,
          userId,
        });
      } catch (err: any) {
        this.addTerminalLog('stderr', `[自动巡航执行异常] ${jobInfo.name}: ${err.message}`, userId);
      }
    });

    if (!ok) {
      this.addTerminalLog('stderr', `[Cron] 任务 "${jobInfo.name}" 挂载失败（表达式 "${jobInfo.pattern}" 无效）。`, userId);
      return;
    }

    jobInfo.nextRun = cronSvc.nextRun(jobInfo.id) || jobInfo.nextRun;
    this.activeCronJobs.set(jobInfo.id, { userId, name: jobInfo.name });
    this.addTerminalLog(
      'system',
      `[Cron] 任务 "${jobInfo.name}" (${jobInfo.pattern}) 已挂载，下次触发: ${jobInfo.nextRun || '无'}`,
      userId
    );
  }

  public unregisterUserCronJob(jobId: string) {
    const existing = this.activeCronJobs.get(jobId);
    if (!existing) return;
    this.ctx?.cron?.cancel(jobId);
    this.activeCronJobs.delete(jobId);
    this.addTerminalLog('system', `[Cron] 任务 "${existing.name || jobId}" 已从后台定时池注销。`, existing.userId);
  }

  public async triggerUserCronJob(userId: string, jobId: string) {
    const { getUserCronJobs, saveUserCronJob } = require('@/lib/user-store');
    const jobs = getUserCronJobs(userId);
    const jobInfo = jobs.find((j: any) => j.id === jobId);
    if (!jobInfo) return;

    this.addTerminalLog('system', `[手动触发巡航] 任务 "${jobInfo.name}" 开始立即执行...`, userId);
    jobInfo.runCount = (jobInfo.runCount || 0) + 1;
    jobInfo.lastRunAt = Date.now();
    saveUserCronJob(userId, jobInfo);

    this.broadcast({
      type: 'cron_job_triggered',
      data: { jobId: jobInfo.id, userId, runCount: jobInfo.runCount },
    });

    // 与定时触发同源:scenario 订阅任务手动触发也按最新档案重建 prompt
    try {
      const { getUserScenarioProfiles } = require('@/lib/user-store');
      const prompt = resolveCronPrompt(jobInfo, (key) => getUserScenarioProfiles(userId)[key]);
      await this.runMission(prompt, {
        title: `【自动巡航】${jobInfo.name}`,
        userId,
      });
    } catch (err: any) {
      this.addTerminalLog('stderr', `[自动巡航执行异常] ${jobInfo.name}: ${err.message}`, userId);
    }
  }
}

export function getAgentBackend(): AgentBackend {
  return AgentBackend.getInstance();
}
