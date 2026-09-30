# 🤖 AI CLI Remote Control Hub

<div align="center">

**Turn your local AI CLI into an omnipresent 24/7 personal assistant on Telegram, QQ, and Web.**

[![Bun](https://img.shields.io/badge/Bun-%3E=1.2-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-336791?style=flat-square&logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-v4-38bdf8?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](./LICENSE)

[English](./README.md) · [简体中文](./README_CN.md)

</div>

---

## 💡 Why AI CLI Hub?

When running agentic AI CLIs like **Claude Code** or **OpenCode CLI** on your VPS or home server, you inevitably run into these pain points:

* 📱 **Tied to the terminal**: Commuting or away from your desk? You can't comfortably check progress or instruct the agent from your phone.
* 🛑 **Tool approval blockages**: Agent encounters a bash command or file write, stops and waits for your terminal approval. If you're away, the entire task stalls.
* 💸 **Heavy memory overhead**: Keeping multiple node CLI processes running 24/7 on a budget VPS easily leads to OOM crashes.
* 🔕 **Isolated notifications**: Third-party CI/CD failures and monitoring alerts are scattered across emails or disparate channels instead of reaching your unified chat stream.

**AI CLI Hub solves all of this.** It acts as a lightweight, secure, and event-driven **Session Manager** that bridges your AI CLIs with instant messaging apps (**Telegram**, **Tencent Official QQ Bot**) and a modern **Web Control Plane**.

---

## ⚡ Comparison

| Feature | Direct Terminal / SSH | Standard Chatbot / Web UI | AI CLI Hub |
| :--- | :--- | :--- | :--- |
| **Mobile Experience** | ❌ Tedious typing, tiny fonts, drops on signal loss | ⚠️ Sandboxed, no local workspace access | ✅ Native Telegram & QQ chat with rich Markdown & streaming |
| **Tool Approval (Human-in-the-Loop)** | ❌ Must stay in front of computer | ❌ Either auto-accepts unsafely or unsupported | ✅ **Interactive cards with Approve / Reject buttons pushed to phone** |
| **Proactive Notifications & Alerts** | ❌ Terminal cannot push alerts | ⚠️ Reactive only | ✅ **Out-of-band push API** (Pairs with [webhook-backend](https://github.com/ygq-future/webhook-backend) as a unified notification hub) |
| **VPS Resource Usage** | ❌ Stale node processes consume massive RAM | ⚠️ Varies | ✅ **Bun-native; auto-sleeps idle CLIs without losing session state** |
| **Long-Term Memory** | ❌ Lost when session ends | ⚠️ Fixed context window | ✅ **pgvector semantic recall + automatic LLM summarization** |
| **Multi-CLI Switch** | ❌ Need multiple terminal tabs & scripts | ❌ Fixed model | ✅ Seamless `/switch <claude\|opencode>` in the same chat |

---
## 📸 Web Control Plane Showcase

### 💬 1. Interactive Chat & Tool Approval
Real-time streaming responses, interactive tool approval cards (manual & automatic), commit tracking, and active session context sidebar.

![Interactive Chat & Approval](docs/imgs/1790749814286.png)

### ⌨️ 2. Slash Command Palette & Auto-Complete
Type `/` to bring up the command menu with fuzzy jump-matching and instant template backfilling.

![Command Palette](docs/imgs/1790749832166.png)

### 🧠 3. Persistent Long-Term Vector Memory
Visual inspection and management for episodic memories (user/project preferences) and semantic snapshots (system environment).

![Memory Management](docs/imgs/1790749902097.png)

### 🛡️ 4. Global Security & Approval Audit Logs
Complete tamper-proof audit trails for every sensitive command execution (`git`, `ssh`, bash) with operator identity and decision status.

![Approval Audit Logs](docs/imgs/1790749915840.png)

### ⚙️ 5. Preferences & Live Server Configuration
Multi-language support, dark theme accents, enter-to-send preferences, and zero-downtime hot configuration for core server settings.

![Control Plane Settings](docs/imgs/1790749997432.png)

---


## 🌟 Key Features

### 📱 1. Multi-Channel Remote Control
* **Telegram**: Smooth streaming message updates, command menus, inline approval buttons, and media/file attachments.
* **Tencent Official QQ Bot**: Full official C2C private messaging support with Markdown rendering, streaming output, and native approval buttons.
* **Web Control Plane**: Modern dashboard built with React 19 and Tailwind CSS v4. Manage multi-platform sessions, inspect timeline history, browse generated files, and configure settings.

### 🛡️ 2. Human-in-the-Loop Security (Interactive Tool Approval)
* Intercepts high-risk tool actions (e.g. `Bash`, file writes, web fetches).
* Pushes an **interactive card with detailed parameter summaries and Approve / Reject buttons** directly to your phone.
* Fully audited and logged with zero risk of unattended rogue executions.

### 🔔 3. AI Dialogue & Isolated Proactive Notifications
* **AI Coding Partner**: Converse with your AI CLI in Telegram, QQ, or Web anytime to delegate coding tasks.
* **Isolated Push Channel**: Built-in `/api/msg` and `/api/session-msg` endpoints deliver messages directly via the Transport layer. These notifications **bypass conversation storage and AI context**, ensuring your project memories remain unpolluted by frequent monitoring alerts.
* **Ecosystem Integration**: Pairs seamlessly with [webhook-backend](https://github.com/ygq-future/webhook-backend) to forward webhooks from GitHub CI/CD, Sentry, or Prometheus into your personal Telegram or QQ chats without needing separate alert bots.

### 🧠 4. Cross-Session Long-Term Memory (pgvector)
* Automatically embeds user preferences and project knowledge into Postgres using `pgvector` (`bge-m3` or OpenAI embeddings).
* Asynchronously summarizes conversations in the background without blocking interactive dialogue.
* Injects relevant context automatically into new CLI sessions.

### 🪶 5. Ultra-Lightweight & Decoupled Architecture
* **Bun Runtime**: Minimal startup latency and tiny memory footprint.
* **Session ≠ Runtime**: Automatically unloads idle CLI runtimes to release VPS memory while maintaining persistent conversation state in Postgres.
* **Adapter Pattern**: Core orchestration has zero dependency on concrete CLIs or transports. Extensible to any agent SDK or PTY environment.

---

## 🏗️ Architecture & Message Flow

```text
       ┌────────────────────────────────────────────────────────┐
       │             External Triggers & Services               │
       │    (GitHub / CI-CD / Alertmanager / Sentry Alerts)     │
       └───────────────────────────┬────────────────────────────┘
                                   │ Webhook
                                   ▼
             ┌───────────────────────────────────────────┐
             │       webhook-backend (Message Router)    │
             │   https://github.com/ygq-future/          │
             │   webhook-backend                         │
             └─────────────────────┬─────────────────────┘
                                   │ HTTP POST (/api/msg)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           AI CLI Hub Core                               │
│                                                                         │
│   ┌────────────────────┐   Event Bus   ┌────────────────────────────┐   │
│   │  Transport Layer   │◀─────────────▶│   Session State Machine    │   │
│   │ (Telegram / QQ /   │               │   (Routing & Lifecycle)    │   │
│   │  Web Control Plane)│               └─────────────┬──────────────┘   │
│   └─────────▲──────────┘                             │                  │
│             │                                        ▼                  │
│             │ Interactive              ┌────────────────────────────┐   │
│             │ Approval                 │        CLI Adapters        │   │
│             │ Buttons                  │ (Claude Code, OpenCode...) │   │
│             ▼                          └─────────────┬──────────────┘   │
│   ┌────────────────────┐                             │                  │
│   │    User Mobile     │                             ▼                  │
│   │ (Phone / Tablet)   │               ┌────────────────────────────┐   │
│   └────────────────────┘               │  Postgres DB (pgvector)    │   │
│                                        │  Sessions / Logs / Memory  │   │
│                                        └────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites
* [Bun](https://bun.sh/) (>= 1.2)
* [PostgreSQL](https://www.postgresql.org/) with [pgvector](https://github.com/pgvector/pgvector) extension
* Node.js CLI installed (e.g. `claude` installed globally via `npm i -g @anthropic-ai/claude-code`)

### 1. Clone & Install

```bash
git clone https://github.com/ygq-future/ai-cli-hub.git
cd ai-cli-hub
bun install
```

> **Note**: The root `overrides` configuration replaces heavy native SDK CLI binaries with tiny stubs, ensuring `bun install` only pulls the lightweight JS control layer and uses your system's existing CLI installations.

### 2. Configure Settings

Generate the interactive configuration:

```bash
bun run setting:migrate
bun setting
```

You can also edit `settings.json` directly. The key setup guides for each channel are detailed below:

<details>
<summary><b>👉 Click to expand: Telegram Bot Setup & Whitelist</b></summary>

1. **Create Bot**: Talk to [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and follow the prompts to choose a name and username (must end with `bot`). Copy the generated **HTTP API Token** (e.g. `1234567890:ABCdef...`).
2. **Get Your User ID**: Send any message to [@userinfobot](https://t.me/userinfobot) to find your numeric `Id` (e.g. `123456789`).
3. **Update Configuration**:
   ```json
   "transport": {
     "telegramBotToken": "YOUR_TELEGRAM_BOT_TOKEN",
     "whitelistUserIds": ["YOUR_NUMERIC_USER_ID"],
     "httpsProxy": "http://127.0.0.1:7890" // optional proxy if your VPS has restricted access to Telegram
   }
   ```
</details>

<details>
<summary><b>👉 Click to expand: Tencent Official QQ Bot Setup & OpenID Discovery</b></summary>

1. **Create Bot**: Visit the [QQ Open Platform](https://q.qq.com/qqbot/openclaw/login.html), sign in, and create a personal bot.
2. **Get Credentials**: Copy your `AppID` and `AppSecret` from the developer settings.
3. **Retrieve Your User OpenID**:
   * QQ Bot API uses a encrypted, unique `OpenID` for each user instead of a raw QQ number.
   * Set `transport.qqBotOpenIdDiscovery` to `true` in `settings.json`.
   * Start the Hub (`bun run start`) and send one private C2C message to your bot in the QQ mobile app.
   * Check the server logs to copy the logged sender OpenID (`[QQ Discovery] Unapproved sender OpenID: D41D8CD98F00...`).
   * Add this OpenID to `transport.whitelistUserIds`.
   * **Immediately set `qqBotOpenIdDiscovery` back to `false`** and restart the service (unauthorized messages never enter Core).
4. **Update Configuration**:
   ```json
   "transport": {
     "qqBotAppId": "YOUR_QQ_APP_ID",
     "qqBotAppSecret": "YOUR_QQ_APP_SECRET",
     "qqBotOpenIdDiscovery": false,
     "whitelistUserIds": ["YOUR_QQ_USER_OPENID"]
   }
   ```
</details>

<details>
<summary><b>👉 Click to expand: PostgreSQL & Vector Memory Setup</b></summary>

1. **PostgreSQL**: Configure your database connection (Postgres with `pgvector` enabled):
   ```json
   "database": {
     "host": "127.0.0.1",
     "port": 5432,
     "db": "ai_cli_hub",
     "username": "postgres",
     "password": "your_password"
   }
   ```
2. **Embedding API**: Default uses `BAAI/bge-m3` (1024 dimensions). Any OpenAI-compatible embedding endpoint (SiliconFlow, DeepSeek, OpenAI) can be configured:
   ```json
   "memory": {
     "embedding": {
       "apiBaseUrl": "https://api.siliconflow.cn/v1",
       "apiKey": "sk-...",
       "model": "BAAI/bge-m3",
       "dimensions": 1024
     }
   }
   ```
</details>

<details>
<summary><b>👉 Click to expand: Web Control Plane Authentication</b></summary>

Configure `http.authToken` to secure the WebUI and REST APIs:
```json
"http": {
  "host": "127.0.0.1",
  "port": 8787,
  "authToken": "YOUR_STRONG_SECRET_TOKEN"
}
```
Visit `http://YOUR_VPS_IP:8787/webui/` in your browser and enter this token to sign in.
</details>

### 3. Initialize Database & Run

```bash
# Run database migrations (creates tables and vector indexes)
bun run db:migrate

# Start in development mode
bun run dev

# Or start for production
bun run start
```

---

## 🔗 Proactive Notifications & Webhook Integration

In addition to interactive AI dialogues, AI CLI Hub features an **isolated proactive notification channel**, serving as your mobile notification gateway.

> 📌 **Context Isolation**: Messages pushed via `/api/msg` are **out-of-band notifications**. They are delivered straight to your chat client and are **neither persisted in the message database nor injected into AI context**, keeping your engineering session memory clean and focused.

### Push Message API Example

```bash
# Push an alert directly to your Telegram or QQ chat
curl -X POST http://localhost:3000/api/msg \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_HTTP_AUTH_TOKEN" \
  -d '{
    "platform": "telegram",
    "chatId": "YOUR_WHITELISTED_CHAT_ID",
    "content": "🚨 [Alert] Production database latency exceeded 500ms!"
  }'
```

### Pairing with `webhook-backend`
By pairing with [webhook-backend](https://github.com/ygq-future/webhook-backend), you can turn your existing Telegram/QQ bot into a unified notification center:
1. Receive webhooks from GitHub Actions, Sentry errors, or Prometheus alerts.
2. Filter and reformat payloads with clean Markdown templates.
3. Forward them directly to AI CLI Hub (`/api/msg`) for immediate mobile delivery.
---

## 💬 Command Reference

Control your session in any chat platform with intuitive slash commands:

| Command | Description |
| :--- | :--- |
| `/switch <claude\|opencode> [path]` | Switch target CLI adapter and optionally set working directory |
| `/model [model_name]` | View or switch the AI model for the current CLI |
| `/status` | View current session status, active CLI, cwd, and token context usage |
| `/sessions` | List active sessions across all platforms |
| `/close` | Close the current session |
| `/remember <fact>` | Manually store a persistent memory item |
| `/memory` | Inspect stored long-term memories |
| `/forget <id>` | Remove a memory item |
| `/update` & `/update confirm` | Safely pull updates and hot-reload on VPS |
| `/health` | Run self-health check diagnostics |

---

## 🚢 VPS Production Deployment

### PM2 (Recommended)

```bash
bun install
bun run setting:migrate
bun run db:migrate
bun run webui:build

# Start with PM2
pm2 start deploy/pm2.config.cjs
pm2 save
```

### systemd

A sample unit file is provided at `deploy/ai-cli-hub.service`. Edit `User` and `WorkingDirectory`, then install:

```bash
sudo cp deploy/ai-cli-hub.service /etc/systemd/system/ai-cli-hub.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-cli-hub
sudo journalctl -u ai-cli-hub -f
```

---

## 🛠️ Tech Stack

* **Runtime:** [Bun](https://bun.sh/)
* **Language:** TypeScript (Strict mode)
* **Storage:** PostgreSQL + [pgvector](https://github.com/pgvector/pgvector) + [Drizzle ORM](https://orm.drizzle.team/)
* **Transports:** `telegraf` (Telegram), Official Tencent QQ Bot Gateway/API (`ws` + `fetch`), WebSocket
* **CLI Adapters:** `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`
* **Web UI:** React 19, Tailwind CSS v4, Radix UI, Vite
* **Logging & Validation:** Pino, Zod

---

## 📄 License

Distributed under the [MIT License](./LICENSE).
