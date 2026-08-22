# Web Administration Control Plane Implementation Plan

> **Execution contract:** Implement tasks in order and track completion with the checkboxes below. Use test-first changes for schema, repositories, lifecycle behavior, request validation, and pure WebUI models. Do not commit or push unless the user explicitly requests it.

**Goal:** Expand the Web Control Plane into a complete visual administration surface for all conversations, user and CLI preferences, conversation files, global memories, and approval audits while preserving the existing chat experience.

**Architecture:** Introduce a deep `web-admin/` module behind shared DTO and operation interfaces. `server/` remains an authenticated HTTP adapter, repositories remain the only SQL outlet, runtime shutdown stays behind an injected orchestrator interface, and `main.ts` remains a composition root. The WebUI is split before feature work into app shell, API clients, hooks, feature modules, shared UI, and scoped styles; `main.tsx` becomes bootstrap-only.

**Tech Stack:** Bun, strict TypeScript, Postgres, Drizzle ORM, typed EventBus, React 19, Tailwind/CSS design tokens, Radix-style UI, Lucide, Vite, Bun test, Prettier, ESLint, dependency-cruiser.

## Accepted Product Decisions

- The Web administrator can list and inspect all conversations across every platform and user stored by this Hub.
- Hard deletion of a conversation deletes its messages, approval timeline rows, `audit_logs`, and `conversation_files` rows.
- `/close` keeps its current lifecycle: the conversation becomes `closed`, while its file mappings and managed files are cleaned immediately.
- A deleted current Web conversation leaves the selected CLI/CWD preference intact; the next ordinary message creates a new conversation for that target.
- Conversations from Telegram and QQ are inspectable and deletable in Web administration. The Web chat composer continues to use the selected Web target and does not impersonate another Transport.
- Global memories from `namespace='global'` are visible. Records tagged `env.*` are read-only; other records may be edited or deleted.
- The audit page manages the existing approval audit domain. Administrative CRUD operations do not introduce a second audit model in this scope.

## Global Engineering Constraints

- `src/main.ts` remains the only Composition Root and contains assembly only.
- `src/webui/main.tsx` becomes a minimal React bootstrap and contains no feature state, HTTP calls, WebSocket handling, page markup, or domain formatting.
- SQL and Drizzle expressions stay in `repository/` and `storage/`.
- `server/` imports shared interfaces and DTOs, not repositories, Core internals, concrete CLI adapters, or Drizzle.
- The `web-admin/` module depends on repository interfaces, EventBus, and injected runtime/media/preference interfaces.
- EventBus remains the broadcast mechanism for lifecycle changes; synchronous destructive work uses injected async interfaces so HTTP completion reflects actual completion.
- All collection endpoints use bounded cursor pagination. No route may load an unbounded table.
- Every ID supplied by the browser is revalidated server-side. Conversation/file ownership is checked by repository lookup.
- Managed file paths are resolved and checked against `MEDIA_DOWNLOAD_DIR` before physical deletion or download.
- Environment-memory immutability is enforced on the server.
- Existing Telegram, QQ, HTTP message endpoints, Web chat, approval flow, settings, uploads, restart, themes, i18n, and responsive behavior remain supported.
- Run `bun run format` after every implementation slice and before validation.
- Update `PROGRESS.md` after each completed milestone or accepted implementation decision.

## Target Module Structure

### Backend

```text
src/
├── main.ts                         # assembly only
├── web-admin/
│   ├── index.ts                    # public factory/barrel
│   ├── web-admin.ts                # orchestration behind WebAdmin interface
│   ├── conversation-admin.ts       # list/detail/delete lifecycle
│   ├── preference-admin.ts         # user + CLI preference snapshots/mutations
│   ├── memory-admin.ts             # global memory list/edit/delete/refresh
│   ├── audit-admin.ts              # global approval-audit pages
│   ├── timeline.ts                 # pure message/audit timeline hydration
│   └── *.test.ts
├── server/
│   ├── server.ts                   # Bun server lifecycle + top-level dispatch
│   ├── types.ts                    # AppServerDeps and server-only transport types
│   ├── request.ts                  # JSON/query/cursor validation helpers
│   └── routes/
│       ├── auth.ts
│       ├── conversations.ts
│       ├── preferences.ts
│       ├── memories.ts
│       ├── audits.ts
│       ├── files.ts
│       ├── settings.ts
│       └── messages.ts
└── shared/types/
    └── web-admin.ts                # browser/server DTOs and WebAdmin interface
```

The exact internal file count may be consolidated when two files would be shallow pass-throughs. The external seam remains the shared `WebAdmin` interface.

### WebUI

```text
src/webui/
├── main.tsx                        # createRoot(<App />) + global style import
├── app/
│   ├── app.tsx                     # authenticated page selection and shell assembly
│   ├── app-shell.tsx               # desktop/mobile navigation frame
│   ├── navigation-model.ts         # URL/hash page model, labels, icons
│   └── navigation-model.test.ts
├── api/
│   ├── http-client.ts              # authenticated JSON/error handling
│   ├── chat-api.ts
│   ├── conversation-api.ts
│   ├── preference-api.ts
│   ├── memory-api.ts
│   ├── audit-api.ts
│   └── settings-api.ts
├── hooks/
│   ├── use-auth-session.ts
│   ├── use-websocket.ts
│   ├── use-local-preferences.ts
│   └── use-cursor-page.ts
├── features/
│   ├── chat/
│   │   ├── chat-page.tsx
│   │   ├── use-chat-controller.ts
│   │   ├── chat-timeline.tsx
│   │   ├── chat-composer.tsx
│   │   ├── approval-card.tsx
│   │   ├── message-attachments.tsx
│   │   └── chat-model.ts
│   ├── conversations/
│   │   ├── conversations-page.tsx
│   │   ├── conversation-list.tsx
│   │   ├── conversation-detail.tsx
│   │   ├── conversation-history.tsx
│   │   ├── conversation-files.tsx
│   │   └── conversation-model.ts
│   ├── preferences/
│   │   ├── preferences-page.tsx
│   │   ├── user-preference-form.tsx
│   │   └── cli-preference-form.tsx
│   ├── memories/
│   │   ├── memories-page.tsx
│   │   ├── memory-editor.tsx
│   │   └── memory-model.ts
│   ├── audits/
│   │   ├── audits-page.tsx
│   │   ├── audit-detail.tsx
│   │   └── audit-model.ts
│   └── settings/
│       ├── settings-page.tsx
│       ├── config-group.tsx
│       └── appearance-settings.tsx
├── components/
│   ├── ui/                         # existing primitive controls
│   ├── data-table.tsx
│   ├── filter-bar.tsx
│   ├── cursor-pager.tsx
│   ├── confirm-dialog.tsx
│   ├── empty-state.tsx
│   └── loading-state.tsx
└── styles/
    ├── index.css
    ├── tokens.css
    ├── base.css
    ├── shell.css
    ├── chat.css
    ├── forms.css
    ├── administration.css
    ├── dialogs.css
    └── responsive.css
```

### WebUI dependency rules

- `main.tsx` imports only `App`, React bootstrap, and `styles/index.css`.
- Feature views do not call `fetch` or construct WebSocket instances; they consume API functions and hooks.
- API files do not import React.
- Feature modules do not import another feature's internal files. Shared behavior moves to `components/`, `hooks/`, `api/`, or a pure model.
- Server DTOs come from `src/shared/types/web-admin.ts`; feature-local view state stays local to the feature.
- `App` owns authentication, current page, global local UI preferences, and cross-feature invalidation only.
- Chat streaming, optimistic messages, history merging, upload staging, and approval reconciliation remain inside `features/chat/use-chat-controller.ts`.
- Administration pages are loaded with `React.lazy`; chat and login remain eager.
- CSS selectors are grouped by feature. `styles/index.css` is the only global style entry.
- Soft size targets: bootstrap under 40 lines, `app.tsx` under 250 lines, feature view/controller files under 400 lines. Exceeding a target requires a cohesive reason in the implementation notes.

---

## Task 1: Freeze shared contracts and add RED test scaffolding

**Files:**

- Create: `src/shared/types/web-admin.ts`
- Modify: `src/shared/index.ts`
- Modify: `docs/03-Interface-Contracts.md`
- Create: `src/web-admin/timeline.test.ts`
- Modify: `src/storage/schema.test.ts`
- Modify: `test/repository.integration.test.ts`
- Modify: `src/server/server.test.ts`

**Shared interface:**

```ts
export interface WebAdmin {
  listConversations(query: ConversationListQuery): Promise<ConversationPage>
  getConversation(id: ConversationId): Promise<ConversationDetail | null>
  getConversationTimeline(id: ConversationId, page: CursorPageQuery): Promise<TimelinePage | null>
  getConversationFiles(id: ConversationId, page: CursorPageQuery): Promise<ConversationFilePage | null>
  getConversationFile(id: ConversationId, fileId: string): Promise<ManagedFileResult | null>
  deleteConversation(id: ConversationId): Promise<ConversationDeletionResult | null>
  listPreferenceScopes(query: CursorPageQuery): Promise<PreferenceScopePage>
  getPreferences(scope: PreferenceScope): Promise<PreferenceSnapshot>
  updatePreferences(scope: PreferenceScope, input: PreferenceUpdate): Promise<PreferenceSnapshot>
  updateCliPreference(scope: PreferenceScope, cli: CliType, input: CliPreferenceUpdate): Promise<CliPreferenceView>
  listMemories(query: MemoryListQuery): Promise<MemoryPage>
  updateMemory(id: string, input: MemoryUpdate): Promise<MemoryView | null>
  deleteMemory(id: string): Promise<'deleted' | 'not_found' | 'read_only'>
  refreshEnvironmentMemories(): Promise<void>
  listAudits(query: AuditListQuery): Promise<AuditPage>
}
```

- [ ] Define exact DTOs, enum filters, cursor shape, nullable fields, and error outcomes.
- [ ] Use opaque cursor strings at the HTTP seam; repositories receive parsed `{ timestamp, id }` values.
- [ ] Add failing schema assertions for audit cascade behavior.
- [ ] Add failing repository integration expectations for conversation cascade deletion and global pages.
- [ ] Add failing server tests for authentication, method restrictions, validation, and unavailable module behavior.
- [ ] Add failing pure timeline hydration tests for mixed chat/approval rows.
- [ ] Run focused tests and record expected RED failures.

Run:

```bash
bun test src/storage/schema.test.ts src/web-admin/timeline.test.ts src/server/server.test.ts test/repository.integration.test.ts
```

---

## Task 2: Split the existing WebUI into stable feature modules

**Purpose:** Establish the target WebUI seams while preserving current behavior before administration pages are added.

**Files:**

- Create the `app/`, `api/`, `hooks/`, `features/chat/`, `features/settings/`, and `styles/` files listed above.
- Modify: `src/webui/main.tsx`
- Remove after migration: `src/webui/react.css`
- Modify: `test/vite-config.test.ts`
- Preserve and relocate as needed: `command-palette.tsx`, `command-palette-model.ts`, and their tests.

- [ ] Extract shared WebUI domain types from `main.tsx` into feature models or shared DTO imports.
- [ ] Extract authentication/session renewal into `use-auth-session.ts`.
- [ ] Extract WebSocket connect/reconnect/verification into `use-websocket.ts`; expose typed connection state and event subscription.
- [ ] Extract chat timeline state, initial-history buffering, optimistic message reconciliation, approval updates, uploads, and notifications into `use-chat-controller.ts`.
- [ ] Extract chat feed, composer, approval card, attachment preview/download, status panel, and login into cohesive view files.
- [ ] Extract browser-local appearance/input/notification preferences into `use-local-preferences.ts`.
- [ ] Extract `settings.json` loading, dirty-state comparison, saving, and form rendering into `features/settings/` plus `settings-api.ts`.
- [ ] Move CSS by responsibility into `styles/`; preserve current design tokens and responsive behavior.
- [ ] Replace static tests that assume functionality lives in `main.tsx` or `react.css` with source-structure assertions and pure behavior tests.
- [ ] Add an architecture guard asserting `main.tsx` contains no `fetch(`, `new WebSocket`, feature DTO definitions, or page markup.
- [ ] Build and test before adding new screens.

Run:

```bash
bun test src/webui/command-palette-model.test.ts test/vite-config.test.ts
bun run typecheck
bun run webui:build
```

Acceptance:

- Existing login, chat, streaming, history pagination, uploads, approvals, command palette, settings, notifications, themes, and mobile status continue working.
- `main.tsx` is bootstrap-only.
- `app.tsx` assembles modules and contains no chat transport implementation.
- `react.css` has been fully replaced by scoped style files.

---

## Task 3: Add conversation cascade schema and migration

**Files:**

- Modify: `src/storage/schema/audit-logs.ts`
- Modify: `src/storage/schema/messages.ts`
- Modify: `src/storage/schema.test.ts`
- Create: `drizzle/0020_conversation_cascade.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `docs/04-Data-Model.md`

- [ ] Change `audit_logs.conversation_id` to `ON DELETE CASCADE`.
- [ ] Set the `messages.audit_log_id` referential action so approval timeline rows cannot block audit deletion.
- [ ] Add an index supporting global audit order by `(created_at, id)`.
- [ ] Write migration SQL that drops and recreates the relevant foreign-key constraints without changing existing audit data.
- [ ] Add schema and migration-order tests.
- [ ] Run the migration against an isolated PostgreSQL database when `TEST_DATABASE_URL` is available.
- [ ] Verify deleting one conversation removes only its messages, audit rows, and file mappings.

Run:

```bash
bun test src/storage/schema.test.ts test/repository.integration.test.ts
bun run db:migrate
```

`bun run db:migrate` is executed only against the explicitly configured development/test database during implementation, not an unspecified production database.

---

## Task 4: Implement repository pages and aggregate deletion

**Files:**

- Modify: `src/repository/types.ts`
- Modify: `src/repository/conversation-repository.ts`
- Modify: `src/repository/message-repository.ts`
- Modify: `src/repository/conversation-file-repository.ts`
- Modify: `src/repository/audit-repository.ts`
- Modify: `src/repository/memory-repository.ts`
- Modify: `src/repository/user-preference-repository.ts`
- Modify: `test/repository.integration.test.ts`

- [ ] Add cursor-paged conversation summaries with optional platform/user/CLI/status filters.
- [ ] Compute message/file/audit counts without multiplying joined rows; use grouped subqueries or separate batched aggregates.
- [ ] Add arbitrary-conversation message timeline pagination using the existing message cursor semantics.
- [ ] Add cursor-paged file metadata and exact conversation/file lookup.
- [ ] Add global cursor-paged approval audits with conversation metadata and filters.
- [ ] Add preference-scope listing and complete per-scope CLI preference retrieval.
- [ ] Add cursor-paged memory listing with type/search filters.
- [ ] Add memory update that clears stale embedding whenever content or type changes.
- [ ] Add conversation hard delete that returns managed file paths and deleted-row counts while the database transaction removes the aggregate.
- [ ] Keep Repository interfaces domain-specific; do not introduce a generic query or generic CRUD interface.

Acceptance tests cover cursor ties, empty pages, exact filters, missing IDs, count accuracy, environment-tag visibility, and deletion isolation.

---

## Task 5: Add awaited runtime and managed-file deletion interfaces

**Files:**

- Modify: `src/orchestrator.ts`
- Modify: `src/orchestrator.test.ts`
- Modify: `src/media/conversation-file-lifecycle.ts`
- Modify: `src/media/conversation-file-lifecycle.test.ts`
- Modify: `src/event/event-map.ts`
- Modify: `src/transport/websocket/websocket-transport.ts`
- Modify: `src/transport/websocket/websocket-transport.test.ts`

- [ ] Extend `SessionOrchestrator` with `stopConversation(conversationId): Promise<void>`.
- [ ] Ensure stopping clears adapter subscriptions, idle/turn timers, approval timers, resolved-approval cache entries, and aggregator state.
- [ ] Expose an awaited managed-file removal operation that accepts paths already returned by aggregate deletion.
- [ ] Reuse the existing media-directory containment check and missing-file idempotency.
- [ ] Add `ConversationDeleted` to `EventMap`.
- [ ] Make WebSocket Transport remove deleted conversation IDs and resolved approval entries from its internal maps.
- [ ] Broadcast a `conversation_deleted` envelope to connected browsers.

Deletion ordering implemented by the administration module is:

```text
load aggregate and paths
  → stop conversation runtime
  → database transaction deletes conversation aggregate
  → remove managed files
  → emit ConversationDeleted
```

Physical-file failures emit `ErrorOccurred` with the deleted conversation ID and failed path summary. Database deletion remains committed, matching the existing file-cleanup behavior.

---

## Task 6: Implement the Web administration module

**Files:**

- Create: `src/web-admin/index.ts`
- Create: `src/web-admin/web-admin.ts`
- Create internal implementation files from the target structure as complexity requires.
- Create: `src/web-admin/*.test.ts`
- Modify: `src/main.ts`

- [ ] Implement the shared `WebAdmin` interface behind one factory.
- [ ] Move existing Web status, current history hydration, and file lookup logic out of `main.ts` into this module.
- [ ] Compose repositories, `stopConversation`, managed-file removal, user preferences, memory refresh, model validation, and EventBus through injected dependencies.
- [ ] Implement hard deletion with deterministic outcomes and idempotent `not_found` handling.
- [ ] Keep selected Web CLI/CWD unchanged when its current conversation is deleted.
- [ ] Implement preference snapshots for every stored `(platform,userId)` scope.
- [ ] Validate cwd through the existing resolver and return conflict when an open conversation for that scope/CLI has another cwd.
- [ ] Validate model changes through the existing adapter model interface; require an open conversation for model selection and return a typed conflict when unavailable.
- [ ] Enforce `env.*` memory read-only behavior before repository mutation.
- [ ] Emit memory invalidation so all active adapters reload the shared global namespace on their next message.
- [ ] Keep `main.ts` assembly to factory creation and dependency injection.

Unit tests use fake repository/runtime/media/preference interfaces and treat the `WebAdmin` interface as the test surface.

---

## Task 7: Split Server routing and add authenticated administration endpoints

**Files:**

- Create: `src/server/types.ts`
- Create: `src/server/request.ts`
- Create: `src/server/routes/*.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/server.test.ts`
- Modify: `src/server/index.ts`

**Routes:**

```text
GET    /api/web/conversations
GET    /api/web/conversations/:conversationId
GET    /api/web/conversations/:conversationId/messages
GET    /api/web/conversations/:conversationId/files
GET    /api/web/conversations/:conversationId/files/:fileId
DELETE /api/web/conversations/:conversationId

GET    /api/web/preference-scopes
GET    /api/web/preferences/:platform/:userId
PUT    /api/web/preferences/:platform/:userId
PUT    /api/web/preferences/:platform/:userId/cli/:cli

GET    /api/web/memories
PATCH  /api/web/memories/:memoryId
DELETE /api/web/memories/:memoryId
POST   /api/web/memories/environment/refresh

GET    /api/web/audits
```

- [ ] Centralize authentication, method, JSON-body-size, query, enum, ID, and cursor validation helpers.
- [ ] Preserve existing auth/session, status, history, upload, settings, restart, file, and compatibility message behavior.
- [ ] Return consistent JSON errors with `400`, `401`, `403`, `404`, `405`, `409`, `413`, and `501` semantics.
- [ ] Use `Content-Disposition` and MIME handling from the current file route for arbitrary conversation files.
- [ ] Keep Bun server startup, static assets, SPA fallback, and WebSocket upgrade in `server.ts`; move route bodies to route files.
- [ ] Replace the many Web-specific callbacks in `AppServerDeps` with one injected `webAdmin` interface plus existing orthogonal ops interfaces.

Run:

```bash
bun test src/server/server.test.ts src/web-admin
bun run typecheck
bun run lint
```

---

## Task 8: Add app navigation and typed administration clients

**Files:**

- Create: `src/webui/app/navigation-model.ts`
- Create: `src/webui/app/navigation-model.test.ts`
- Modify: `src/webui/app/app.tsx`
- Modify: `src/webui/app/app-shell.tsx`
- Create administration API clients under `src/webui/api/`.
- Create shared table/filter/pager/confirmation components.

- [ ] Define pages: chat, conversations, preferences, memories, audits, and service settings.
- [ ] Keep page selection in a small pure URL/hash model so refresh and browser back/forward restore the page without a router dependency.
- [ ] Lazy-load administration and service-settings pages.
- [ ] Implement one typed HTTP client that parses JSON errors and maps unauthenticated responses back to the login state.
- [ ] Implement reusable cursor-page state without embedding endpoint-specific filters.
- [ ] Add desktop navigation and mobile drawer using the existing design tokens.
- [ ] Ensure page changes do not tear down the authenticated WebSocket connection used by chat and invalidation events.

---

## Task 9: Build the conversation administration page

**Files:**

- Create files under `src/webui/features/conversations/`.
- Modify: `src/webui/styles/administration.css`
- Add pure model tests for filtering, cursor merge, count formatting, and deletion-state transitions.

- [ ] Render all conversations with platform, user, CLI, cwd, status, timestamps, and aggregate counts.
- [ ] Add platform/user/CLI/status filters with reset and bounded query behavior.
- [ ] Load conversation detail independently from the list page.
- [ ] Render arbitrary conversation timeline with the existing chat/approval presentation components where appropriate.
- [ ] Render conversation files with preview/download actions.
- [ ] Display the closed-file lifecycle explicitly when a closed conversation has no file records.
- [ ] Add a destructive confirmation dialog showing the exact conversation ID and deletion scope.
- [ ] Disable duplicate delete submissions and surface partial physical-file cleanup warnings.
- [ ] Handle `conversation_deleted` by removing list/detail state without a full page reload.

The chat composer remains on the chat page. Inspecting Telegram/QQ conversations does not route Web input into those Transports.

---

## Task 10: Build user and CLI preference administration

**Files:**

- Create files under `src/webui/features/preferences/`.
- Add pure validation/view-model tests.

- [ ] Add paged platform/user scope selection.
- [ ] Edit language, default CLI, automatic approval enabled state, and countdown.
- [ ] Edit each supported CLI's cwd and validated model preference.
- [ ] Show a clear conflict when cwd differs from an open conversation.
- [ ] Show CLI-default state when model ID/name are null.
- [ ] Keep browser-local appearance/input/notification settings separate and immediate.
- [ ] Keep `settings.json` service configuration in the service-settings feature with restart-required semantics.
- [ ] Refresh affected status and preference views after save or WebSocket invalidation.

---

## Task 11: Build global memory administration

**Files:**

- Create files under `src/webui/features/memories/`.
- Add pure memory form/model tests.

- [ ] List all global semantic, preference, and episodic memories with type/search filters.
- [ ] Display ID, type, tag, content, importance, access count, last access, and creation time.
- [ ] Mark `env.*` rows read-only and expose environment refresh.
- [ ] Allow non-environment content, type, and importance edits.
- [ ] Confirm deletion and handle already-removed records idempotently.
- [ ] Show embedding refresh state for edited episodic memories.
- [ ] React to global memory invalidation without resetting unrelated page state.

---

## Task 12: Build global approval-audit administration

**Files:**

- Create files under `src/webui/features/audits/`.
- Add pure query/detail-format tests.

- [ ] List approval audits across all conversations and users.
- [ ] Filter by exact conversation ID, platform, user, CLI, and approval status.
- [ ] Display request command/detail, status, operator, automatic/manual state, and creation time.
- [ ] Link existing conversation IDs to conversation detail.
- [ ] Update pending rows in response to realtime approval terminal events.
- [ ] Remove rows after a `conversation_deleted` event when their conversation filter/list page is active.

---

## Task 13: Responsive, accessibility, and bundle verification

**Files:**

- Modify scoped WebUI styles and feature views.
- Modify: `vite.config.ts` only if measured chunking needs explicit grouping.
- Modify: `test/vite-config.test.ts`

- [ ] Verify 320px, 390px, 768px, 1280px, and wide desktop layouts.
- [ ] Verify keyboard navigation, visible focus, dialog focus trapping, table alternatives on narrow screens, and touch targets.
- [ ] Verify all static text, aria labels, empty states, filters, validation, and errors in Chinese and English.
- [ ] Respect `prefers-reduced-motion` for new page/dialog/list transitions.
- [ ] Confirm lazy administration pages produce separate build chunks and do not increase the eager login/chat entry unnecessarily.
- [ ] Confirm the app shell and chat remain usable while an administration request fails.
- [ ] Replace brittle source-string tests with structure or pure-model tests wherever extraction changed file ownership.

---

## Task 14: Documentation, progress, and complete verification

**Files:**

- Modify: `AGENTS.md`
- Modify: `docs/02-Architecture.md`
- Modify: `docs/03-Interface-Contracts.md`
- Modify: `docs/04-Data-Model.md`
- Modify: `docs/05-Implementation-Plan.md`
- Modify: `docs/06-Memory-Design.md`
- Modify: `docs/07-Command-UX.md`
- Modify: `docs/08-Web-Control-Plane-Task-Book.md`
- Modify: `README.md`
- Modify: `PROGRESS.md`

- [ ] Add `web-admin/` to the dependency matrix and directory responsibilities.
- [ ] Document every HTTP route, shared DTO, cursor, validation rule, status code, and WebSocket invalidation envelope.
- [ ] Document conversation hard deletion and audit cascade semantics.
- [ ] Document `/close` file cleanup as distinct from hard deletion.
- [ ] Document global memory visibility and `env.*` immutability.
- [ ] Document WebUI feature/module ownership and bootstrap-only `main.tsx`.
- [ ] Update milestone status and exact verification counts in `PROGRESS.md`.

Run all quality gates:

```bash
bun run format
bun run format:check
bun run typecheck
bun run lint
bun run webui:build
bun test
git diff --check
```

When `TEST_DATABASE_URL` is configured, also run:

```bash
bun test test/repository.integration.test.ts
```

Final review:

```bash
git status --short
git diff --stat
git diff
```

Confirm that source, migrations, tests, contracts, and progress agree; no generated WebUI build output, local settings, uploaded media, credentials, or unrelated user changes are included.

## Completion Criteria

- The authenticated Web administrator can browse every stored conversation across all platforms/users.
- Every conversation detail can show its persisted timeline and currently retained files.
- Hard deletion stops runtime work, deletes the database aggregate including approval audits, cleans managed files, and updates connected browsers.
- `/close` continues cleaning files immediately and leaves the closed conversation history available until hard deletion.
- Every stored user/platform scope and per-CLI preference is visually inspectable and editable under existing invariants.
- All global memories are visible; `env.*` records are server-enforced read-only; other memories can be edited or deleted.
- All approval audits are pageable and filterable by conversation and scope metadata.
- Existing Web chat behavior remains intact after extraction.
- `src/webui/main.tsx` is bootstrap-only, `src/main.ts` is assembly-only, and Server route files contain no business persistence logic.
- Format, format check, typecheck, lint, WebUI production build, full tests, integration tests when configured, and diff check pass.
