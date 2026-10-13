/**
 * npm 发布构建:把 src/bin.ts 连同 workspace 内的 @agtpilot/protocol 一起
 * bundle 成单文件 dist/bin.mjs(零运行时依赖,Node 内置模块除外)。
 *
 * 为什么 bundle 而不是 tsc 多包输出:
 * - runner 的 bin 目前是 tsx 直跑 TS 源码,npm 消费者没有 tsx;
 * - protocol 以源码形态被 workspace 消费(web/core 直接吃 TS),单独发
 *   @agtpilot/protocol 再让 runner 依赖它,会把「协议包也要发版」的治理
 *   负担提前引入 v1——bundle 后发布物自包含,协议单一事实源不变;
 * - runner 全部代码只用 Node 内置模块(fs/os/path/crypto/child_process/https),
 *   bundle 结果天然零 dependencies,与 §9「依赖刻意薄」一致。
 *
 * 用法: node scripts/build.mjs  (或 pnpm --filter @agtpilot/runner build)
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const outfile = path.join(pkgRoot, 'dist', 'bin.mjs');

await esbuild.build({
  entryPoints: [path.join(pkgRoot, 'src', 'bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false, // 保持可读:这是要跑在用户机器上做 git push 的代码,可审计优先
  logLevel: 'warning',
});

// 源码 shebang 是 env tsx(仓内开发路径);发布产物改为 env node
let code = fs.readFileSync(outfile, 'utf-8');
if (!code.startsWith('#!')) code = `#!/usr/bin/env node\n${code}`;
else code = code.replace(/^#!.*\n/, '#!/usr/bin/env node\n');
fs.writeFileSync(outfile, code, { mode: 0o755 });

const size = (fs.statSync(outfile).size / 1024).toFixed(1);
console.log(`✓ 构建完成: dist/bin.mjs (${size} KB, 零运行时依赖)`);
