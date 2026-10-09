# agtpilot

> 🚀 **agtpilot** (Agent Pilot) is an open-source, pluggable, autonomous personal AI agent framework designed for real-world computer use, deep research, and day-to-day task automation.

Inspired by **OpenMuse**, **DeepSeek Harness**, and **CopilotKit**, `agtpilot` decouples agent capabilities into atomic, pluggable modules powered by TypeScript, a durable state machine, and Generative UI interaction.

---

## 🌟 Key Features

- 🧩 **Pluggable Microkernel Architecture**: Everything is a plugin. Easily swap models, sandboxes, tools, and UI components.
- 🌐 **Persistent Browser Automation**: Autonomous web browsing, form filling, login state persistence, and research driven by Playwright.
- 📦 **Isolated Code Execution Sandbox**: Safe execution of Bash scripts, Python, and Node.js code within containerized environments (Docker / E2B).
- 🔄 **Durable Session & Checkpoints**: Missions and conversation history persist to disk; each agent step emits a message checkpoint, so after a server restart an interrupted mission is marked and can be resumed by continuing the conversation (the in-flight loop itself is not auto-restarted).
- 🎨 **Generative UI / AG-UI Protocol**: Returns rich, interactive React components (charts, approval cards, tables) directly in chat rather than boring plain text.
- 🤝 **Human-in-the-Loop (HITL)**: Built-in safety approval mechanism for sensitive operations (emailing, purchasing, deleting files).

---

## 🏗️ Architecture Overview

```mermaid
flowchart TD
    subgraph Client ["Client Layer"]
        WebUI["Web App (Next.js / Generative UI)"]
        CLI["Terminal CLI (agtpilot run)"]
    end

    subgraph Core ["agtpilot Core (Microkernel)"]
        Kernel["Plugin Context & Lifecycle"]
        EventBus["AG-UI Event Bus"]
        Contracts["ModelGateway / PlannerNotifier 契约"]
        Orchestrator["Agent Loop (熔断/审批/压缩/检查点)"]
    end

    subgraph Plugins ["Atomic Plugins"]
        BrowserPlugin["plugin-browser (Playwright)"]
        SandboxPlugin["plugin-sandbox (Docker / E2B)"]
        ModelPlugin["plugin-model (implements ModelGateway)"]
        MCPPlugin["plugin-mcp (Tool Registry)"]
    end

    Client < --> AppKit
    subgraph AppKit ["app-kit (Composition Root)"]
        Factory["createAgentRuntime()"]
    end
    AppKit < --> Core
    Core < --> Plugins
```

**依赖倒置**：微内核不 import 任何插件 —— 它只依赖 `ModelGateway` / `PlannerNotifier` 接口（`packages/core/src/contracts.ts`），由插件提供实现并以同名 cordis 服务注册。工具路由规则也由各插件自注册（`ctx.agent.registerToolRoute()`），新增插件无需修改内核。`packages/app-kit` 是唯一装配根（composition root）：CLI 与 Web 共用 `createAgentRuntime()` 统一加载内核与全套插件，返回的 Promise resolve 即全部就绪。

---

## 📂 Repository Structure (Monorepo)

```text
agtpilot/
├── packages/
│   ├── core/              # Microkernel: contracts (ModelGateway), orchestrator, event bus
│   ├── app-kit/           # Composition root: createAgentRuntime() 统一装配
│   ├── plugin-browser/    # Persistent Playwright browser control
│   ├── plugin-sandbox/    # Safe Docker / E2B code execution
│   ├── protocol/          # AG-UI and Generative UI event schema
│   └── plugin-*           # 15 个原子能力插件（model/planner/memory/mcp/...）
├── apps/
│   ├── cli/               # Command-line interface
│   └── web/               # Next.js Generative UI frontend
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── README.md
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js >= 20
- pnpm >= 9
- Docker (optional, for local code sandbox execution)

### 1. Clone & Install
```bash
git clone https://github.com/tunsuy/agtpilot.git
cd agtpilot
pnpm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Fill in your LLM API keys (DeepSeek / Anthropic / OpenAI)
```

### 3. Build & Run
```bash
pnpm build
pnpm dev
```

---

## 📜 License

MIT License © 2026 [tunsuy](https://github.com/tunsuy)
