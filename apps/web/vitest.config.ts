import { defineConfig, type Plugin } from 'vitest/config';
import * as path from 'path';
import * as fs from 'fs';

/**
 * .md 提示词模板原样读入(默认导出 = 文件全文)。覆盖两处:
 * - src/workshops:工坊提示词模板;
 * - 仓库根 skills/humanizer:工坊内置去 AI 化清单(shared/humanizer.ts 注入)。
 * 与 next.config.mjs 的 asset/source 规则语义一致:同一个 .md 文件在
 * webpack(客户端预览)与 vitest(golden 快照)里拿到的字节相同。
 */
function workshopMdPlugin(): Plugin {
  return {
    name: 'workshop-md-raw',
    load(id) {
      if (
        id.endsWith('.md') &&
        (/[\\/]src[\\/]workshops[\\/]/.test(id) || /[\\/]skills[\\/]humanizer[\\/]/.test(id))
      ) {
        return `export default ${JSON.stringify(fs.readFileSync(id, 'utf8'))}`;
      }
      return null;
    },
  };
}

/**
 * apps/web 单测配置(持久状态治理 G1-G5,见
 * docs/design/persistent-state-governance.md §3.6)。
 * 只跑 node 环境的 lib 层测试;页面/组件测试仍归 e2e。
 */
export default defineConfig({
  plugins: [workshopMdPlugin()],
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
