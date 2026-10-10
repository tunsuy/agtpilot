# Security Policy

## Supported versions

The project is at `0.1.x` pre-stable. Security fixes land on `main` and are released in the next tagged image; please run a recent build.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security problems.

Use GitHub's **private vulnerability reporting** on this repository
([Security → Report a vulnerability](https://github.com/tunsuy/agtpilot/security)), which keeps the report private and lets us coordinate a fix and disclosure.

Include when possible: a minimal reproduction (prompt + tool sequence), the affected package(s) (`packages/plugin-*`, `apps/*`), and the impact you see. Please avoid including real credentials or customer data in the report.

## Security model you're running

agtpilot is an autonomous agent that **executes model-chosen code and shell commands by design**. If you deploy it, understand what the built-in controls do and don't do:

- **Path fencing** jails local execution to a per-task working directory.
- **Child-process env allowlist**: sub-processes get only `PATH/HOME/LANG/TZ/TMPDIR` plus task-scoped user credentials — the host's `process.env` is never forwarded wholesale.
- **Egress guard** blocks private/metadata IP ranges from sandboxed HTTP requests.
- **Optional hardening**: bwrap kernel-level fence (Linux) or E2B cloud MicroVM isolation (`E2B_API_KEY`).
- **Human-in-the-Loop**: tools marked `dangerLevel: high` suspend until a user approves.
- **Multi-user scoping** partitions process-level state (browser profiles, RAG indexes, artifacts) by `session.userId`.

Design rationale: [docs/design/sandbox-control-hardening.md](./docs/design/sandbox-control-hardening.md) (Chinese).

### Deployment notes

- Set a strong `AUTH_SECRET` in production and disable `AUTH_ALLOW_MOCK` (it is off by default in production builds).
- The Docker image runs as a non-root user; mount persistent volumes (`/opt/agtpilot/data`, `/opt/agtpilot/sandbox`) with least-possible privileges.
- Any MCP server or connector you enable runs as a child process with the env rules above — audit third-party MCP servers before connecting them.
