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
- **CLI Adapter:** Agent SDK first; `node-pty` is intentionally not installed until a CLI without an SDK is added.
- **Database:** Postgres (with `pgvector` for long-term memory)
- **ORM:** [Drizzle ORM](https://orm.drizzle.team/)
- **Bot Transports:** `telegraf` (Telegram), Tencent Official QQ Bot Gateway/API (`ws` + `fetch`)
- **Validation & Config:** `zod`
- **Logging:** `pino`

---

## 🚀 Run Locally

```bash
bun install
bun run db:migrate
bun run dev
```

Production start:

```bash
bun run start
```

Useful checks:

```bash
bun run format:check
bun run typecheck
bun run lint
bun test
```

---

## 🧩 Required Configuration

Generate and edit `settings.json` from the committed template:

```bash
bun run setting:migrate
bun setting
```

Configure at least:

- `database`: Postgres host, port, database, username, and password.
- `transport.telegramBotToken`: optional Telegram bot token.
- `transport.qqBotAppId` / `transport.qqBotAppSecret`: optional Tencent Official QQ Bot credentials; configure both or neither.
- `transport.qqBotOpenIdDiscovery`: temporarily enable it to log an unapproved QQ C2C sender OpenID.
- `transport.whitelistUserIds`: mixed Telegram numeric IDs and QQ user OpenIDs allowed to control the hub.
- User targets are stored in Postgres by `(platform, userId)`: language, default CLI, and one CWD per CLI. On first use, a CLI defaults to `~/ai-workspace/.<cli>`.
- `session.agentDescription`: optional role hint injected when the adapter starts.
- `session.claudeExecutablePath`: optional absolute path to the system Claude CLI. Leave empty to resolve `claude` from `PATH`.
- `ocr.apiBaseUrl`: optional Light OCR API base URL; leave empty to disable image OCR.

`settings.json` is local and gitignored. The application no longer loads business configuration from `.env`.

The root `overrides` map replaces every Agent SDK native CLI optional dependency with a tiny same-name local stub. A fresh `bun install` therefore installs only the SDK JS control layer and never downloads its bundled Claude binaries. PDF rendering is delegated to the external OCR service, so the Hub does not install `pdf-parse`, `pdfjs-dist`, or Canvas.

### Tencent Official QQ Bot

Open [QQ Bot quick registration](https://q.qq.com/qqbot/openclaw/login.html), create a bot, and copy its AppID and AppSecret into `transport.qqBotAppId` and `transport.qqBotAppSecret`. QQ does not expose a human-readable QQ number as the API user identity; it sends a user OpenID. To obtain it safely, set `transport.qqBotOpenIdDiscovery=true`, restart the service, send the bot one C2C message, copy the logged OpenID into `transport.whitelistUserIds`, then immediately disable the flag and restart. The discovery message is not replied to and never enters Core. QQ C2C text, official streaming replies, slash commands, and approval buttons are supported; Telegram and QQ can run together.

---

## 🏗 VPS Deployment

### PM2

```bash
bun install
bun run setting:migrate
bun run db:migrate
pm2 start deploy/pm2.config.cjs
pm2 logs ai-cli-hub
pm2 save
```

Restart after updating code:

```bash
pm2 restart ai-cli-hub
```

### systemd

The sample unit is in `deploy/ai-cli-hub.service`. Adjust `User` and `WorkingDirectory` for your VPS path, then install it:

```bash
sudo cp deploy/ai-cli-hub.service /etc/systemd/system/ai-cli-hub.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-cli-hub
sudo journalctl -u ai-cli-hub -f
```

The process handles `SIGTERM` by stopping all enabled Transport ingress, flushing message drafts, stopping active adapters, destroying modules, and closing the Bun SQL client. On startup, runtime-only conversation states left by a previous process are reconciled back to persisted-safe states.

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
│   ├── runtime/      # Optional: added with node-pty when a CLI has no SDK.
│   ├── approval/     # PTY-only approval scraping fallback.
│   ├── repository/   # Repository Layer: Database operations interface.
│   ├── storage/      # Storage Layer: Postgres connection and Drizzle schema definitions.
│   ├── logger/       # Global logging utilities.
│   └── shared/       # Global types, interfaces, and utilities.
├── docs/             # PRDs and architecture documents.
└── settings.json.example # Versioned settings template.
