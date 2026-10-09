import { defineConfig } from 'vitest/config';
import * as path from 'path';

/**
 * apps/web 单测配置(持久状态治理 G1-G5,见
 * docs/design/persistent-state-governance.md §3.6)。
 * 只跑 node 环境的 lib 层测试;页面/组件测试仍归 e2e。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
  },
});
