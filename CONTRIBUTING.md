# Contributing to agtpilot

Thanks for your interest in making agtpilot better! This guide covers setup, code rules, and how to ship a change.

> 📝 The deep-dive docs ([ARCHITECTURE.md](./ARCHITECTURE.md), [docs/design/](./docs/README.md)) are written in Chinese; issues and PRs in either English or Chinese are welcome.

## Development setup

```bash
git clone https://github.com/tunsuy/agtpilot.git
cd agtpilot
pnpm install
cp .env.example .env   # at least one LLM key for manual testing
pnpm dev               # web app at http://localhost:3000
```

- Node.js >= 20, pnpm >= 9.
- Workspace packages ship TypeScript sources directly (`main: src/index.ts`); the web app transpiles them, so `pnpm dev` needs no pre-build.
- Run the full check before opening a PR:

```bash
pnpm test    # vitest — kernel pure functions (routing/text/compaction) must stay covered
pnpm lint
pnpm build
```

## Repository layout & the layering laws

agtpilot is a cordis microkernel + plugins monorepo. The one legal dependency direction is:

**apps → app-kit → core ← plugins**

Read [ARCHITECTURE.md](./ARCHITECTURE.md) before changing anything structural — especially the 「分层的铁律」 (layering laws) and the anti-pattern list, which records real past mistakes. The non-negotiables:

1. **The kernel imports no plugin.** Need a new capability? Add an interface to `packages/core/src/contracts.ts` and implement it in a plugin.
2. **Assembly only happens in `packages/app-kit`** via `createAgentRuntime()`. Never import the plugin list in an app.
3. **New plugins require zero kernel changes.** Register tools and routing rules yourself: `ctx.agent.registerToolRoute({ id, prefixes, test })`.
4. **New pure functions must ship with vitest cases** (`packages/core/src/*.test.ts`), and the test script must fail for real — no silent no-op.
5. **README/docs must match actual behavior.** Promise only what's implemented.

### Adding a new plugin

The full checklist lives in [ARCHITECTURE.md](./ARCHITECTURE.md) (「新增插件检查单」); in short:

1. Create `packages/plugin-xxx/`, declare needed services with `inject` (contract names only).
2. `ctx.agent.registerToolRoute({ id, prefixes: ['xxx_'], test: /keyword/i })` for on-demand mounting; add `baseline: true` for small always-on tools.
3. Write honest tool descriptions; failures must return `success: false` + a reason — never fake success.
4. Partition any process-level state by `session.userId`.
5. Mount it with one `mount('plugin-xxx', XxxPlugin)` line in `createAgentRuntime()`, and add the dependency to `packages/app-kit/package.json`.

## Hard security rules for any code touching processes or secrets

These come from real incidents documented in the anti-pattern list:

- Spawn child processes with **`execFile` + argument arrays** — never `exec` with concatenated strings (shell injection).
- **Never forward `{...process.env}`** to a child process (sandbox, MCP stdio servers, anywhere). Use the env allowlist + task-scoped `session.env`.
- Sensitive side effects (file writes, clipboard, host reads) must declare `dangerLevel`.

## Commit style

Conventional Commits, subject in Chinese or English:

```
feat(plugin-search): support reranking in search_web
fix(web): 输入框提示遮挡修复
docs(design): sandbox 控制增强设计
```

## Pull requests

1. Fork & branch from `main` (`feat/...`, `fix/...`, `docs/...`).
2. Keep the diff focused; reference the issue number when one exists.
3. Make sure `pnpm test` / `pnpm lint` / `pnpm build` pass locally.
4. For behavior changes, update the affected docs in the same PR (README claims must stay truthful — that's a layering law, not a suggestion).

## Reporting security issues

Please don't open public issues for vulnerabilities — follow [SECURITY.md](./SECURITY.md).
