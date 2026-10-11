/**
 * 只读并行门控(读写锁)
 *
 * 背景:Vercel AI SDK 对同一轮模型请求的全部工具调用是 Promise.all 并发触发的
 * ——不加干预时写操作也会并行执行(落盘/外部状态变更交错的风险)。本门控在
 * 编排器的工具包装层收敛这件事:
 * - 声明 readOnly 的工具彼此并行执行(保留 SDK 的并发红利:同轮多路检索/读取同时完成);
 * - 非只读工具独占串行:先等在途只读调用结束,执行期间不放行任何读写,
 *   之后的调用一律排队 —— 即「同轮全只读 → 并行;含写 → 写单独执行」。
 *
 * 锁的持有不跨越人工审批:high danger 的审批等待发生在门控之外
 * (orchestrator 包装层顺序:熔断 → 审批 → 门控 → execute),避免拿独占锁等人。
 *
 * 无死锁设计:门控按 runTask 实例化(一次任务循环一把),工具 execute 内部不会
 * 再次进入同一门控;子任务走新的 runTask、持新门控,不构成嵌套持锁。
 * 纯内存 promise 调度,无定时器、无外部依赖。
 */
export class ToolGate {
  /** 独占队列尾:后续操作(无论读写)都要先等排在它前面的独占调用结束 */
  private tail: Promise<void> = Promise.resolve();
  /** 在途只读调用(供独占侧等待);集合内 promise 自身永不 reject */
  private reads = new Set<Promise<void>>();

  /**
   * 只读调用:与其他只读调用并行;若前面排了独占调用,先等它结束。
   * 注册必须发生在 `await this.tail` 恢复后的同一同步块内,保证
   * 后到的独占调用做在途快照时一定能看到本调用(微任务顺序即到达顺序)。
   */
  async runReadonly<T>(fn: () => Promise<T>): Promise<T> {
    await this.tail;
    const running = fn();
    const tracked = running.then(
      () => undefined,
      () => undefined
    );
    this.reads.add(tracked);
    void tracked.finally(() => this.reads.delete(tracked));
    return running;
  }

  /**
   * 独占调用:等待先前排队的独占调用与在途只读调用,执行期间不放行任何调用;
   * fn 抛错也会释放队列(finally),后续调用不受影响。
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    await Promise.allSettled([...this.reads]);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
