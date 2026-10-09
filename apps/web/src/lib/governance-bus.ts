/**
 * 治理事件总线 (Governance Bus) —— 零依赖进程内事件通道
 *
 * 背景(见 docs/design/persistent-state-governance.md §3.2/§3.3):
 * 持久状态的「回退弧」(遗忘/撤销)发生点(user-store / memory-service / API 路由)
 * 与需要即时感知的消费点(agent-backend 的 in-flight 任务)分属不同层,且
 * user-store 作为最底层存储不能反向 import 上层。本总线提供最小解耦通道:
 *
 * - memory-revoked:   一条记忆被(软)删除 —— in-flight 任务下一步注入治理提示;
 * - authority-revoked: 连接器凭证/OAuth 授权被撤销(权限纪元 +1)—— in-flight
 *   任务的 session.env 立即移除对应 Key、断开 MCP 连接、注入治理提示。
 *
 * 挂 globalThis 单例:Next.js dev 热重载时模块会被重复求值,
 * 订阅方(agent-backend)与发布方(user-store)必须拿到同一个 emitter。
 */

export interface MemoryRevokedEvent {
  userId: string;
  memoryId: string;
  title?: string;
  requestedBy: 'user' | 'auto' | 'propagated';
  reason?: string;
}

export interface AuthorityRevokedEvent {
  userId: string;
  /** MCP 连接器 id(deleteMcpAuth 路径);普通 Key 删除时可能为空 */
  connectorId?: string;
  /** 被移除的凭证环境变量名(saveUserConnector 清空路径);MCP 撤销时由订阅方按 connectorId 解析 */
  envVars?: string[];
  /** 撤销后的新纪元值 */
  epoch: number;
}

export interface GovernanceBus {
  onMemoryRevoked(handler: (e: MemoryRevokedEvent) => void): () => void;
  onAuthorityRevoked(handler: (e: AuthorityRevokedEvent) => void): () => void;
  emitMemoryRevoked(e: MemoryRevokedEvent): void;
  emitAuthorityRevoked(e: AuthorityRevokedEvent): void;
}

function createBus(): GovernanceBus {
  const memoryHandlers = new Set<(e: MemoryRevokedEvent) => void>();
  const authorityHandlers = new Set<(e: AuthorityRevokedEvent) => void>();
  return {
    onMemoryRevoked(handler) {
      memoryHandlers.add(handler);
      return () => memoryHandlers.delete(handler);
    },
    onAuthorityRevoked(handler) {
      authorityHandlers.add(handler);
      return () => authorityHandlers.delete(handler);
    },
    emitMemoryRevoked(e) {
      for (const h of memoryHandlers) {
        try {
          h(e);
        } catch {
          // 单个订阅者异常不阻断其他订阅者
        }
      }
    },
    emitAuthorityRevoked(e) {
      for (const h of authorityHandlers) {
        try {
          h(e);
        } catch {
          // 同上
        }
      }
    },
  };
}

export function getGovernanceBus(): GovernanceBus {
  const g = globalThis as any;
  if (!g.__agtPilotGovernanceBus) {
    g.__agtPilotGovernanceBus = createBus();
  }
  return g.__agtPilotGovernanceBus as GovernanceBus;
}
