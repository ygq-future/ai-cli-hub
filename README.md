# AI CLI Remote Control Hub

A lightweight, secure, and extensible remote control hub for AI CLI tools (Claude Code, OpenCode CLI, Codex CLI, etc.). 

This project acts as an intelligent "Session Manager", allowing you to interact with local AI CLIs remotely via instant messaging platforms (Telegram, QQ, Web) while maintaining strict security controls and minimal resource overhead.

---

## 🌟 Key Features

- **Extremely Lightweight:** Built on Bun and Postgres, designed to run seamlessly on personal VPS or local environments with minimal memory footprint.
- **Adapter-Driven Architecture:** The core system is completely agnostic to the underlying AI CLI. Integrating a new CLI tool requires only writing a new Adapter, with zero changes to the core business logic.
- **Transport Layer Isolation:** Native support for Telegram and QQ bots, easily extensible to WebSocket, HTTP APIs, or MCP.
- **Human-in-the-Loop Security:** Intercepts risky tool calls and pushes an interactive approval card (Markdown + inline buttons) to the client. Approval is a runtime adapter state, not a persisted conversation status.
- **Smart Resource Management:** Lazily starts CLI adapters on demand and stops idle adapters to free memory, while preserving the logical conversation as `idle`.
- **Event-Driven:** Modules (Core, Transport, Storage, Logger) communicate strictly via an Event Bus, ensuring high cohesion and low coupling.

---

## 🛠 Tech Stack

- **Runtime:** [Bun](https://bun.sh/)
- **Language:** TypeScript (Strict Mode)
- **CLI Adapter:** Claude Agent SDK first; `node-pty` is reserved for CLI tools without SDK support.
- **Database:** Postgres (with `pgvector` for long-term memory)
- **ORM:** [Drizzle ORM](https://orm.drizzle.team/)
- **Bot Frameworks:** `telegraf` (Telegram), `napcat` / `koishi` (QQ)
- **Validation & Config:** `zod`
- **Logging:** `pino`

---

## 📂 Project Structure

The project strictly follows a decoupled architectural pattern:

```text
.
├── src/
│   ├── core/         # Core Hub: Session management, state machines, and message routing.
│   ├── event/        # Event Bus: Global event definitions (SessionCreated, MessageReceived, etc.).
│   ├── config/       # Config Module: The ONLY place allowed to read environment variables (Zod validation).
│   ├── transport/    # Transport Layer: Client integration (telegram/, qq/, websocket/).
│   ├── cli/          # CLI Adapters: Interface implementations for target CLIs (base/, claude/).
│   ├── runtime/      # PTY runtime for CLI tools without SDK support.
│   ├── approval/     # PTY-only approval scraping fallback.
│   ├── repository/   # Repository Layer: Database operations interface.
│   ├── storage/      # Storage Layer: Postgres connection and Drizzle schema definitions.
│   ├── logger/       # Global logging utilities.
│   └── shared/       # Global types, interfaces, and utilities.
├── docs/             # PRDs and architecture documents.
└── .env.example      # Example environment variables.
