/**
 * 工坊参数规整(从 components/workshops/run.ts 平移):
 * 表单 params 是宽松的 Record<string, unknown>,各包 run() 用这两个助手收敛类型。
 */
export const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
export const num = (v: unknown, fallback = 1) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
