# Web Command Palette Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the slash-command palette readable and touch-safe, close it at the correct interaction boundaries, improve header spacing, and prevent the login card from shifting after first paint.

**Architecture:** Keep command discovery and keyboard behavior in the existing React composer. Add dismissal at the document/textarea boundary, use CSS for touch selection suppression and denser visual treatment, and put only layout-critical login CSS in the HTML shell.

**Tech Stack:** Bun, React 19, TypeScript strict, Tailwind/Vite build pipeline, project CSS, Bun test.

## Global Constraints

- Do not change HTTP, WebSocket, command catalog, storage, or configuration contracts.
- Preserve keyboard command navigation and complete-placeholder selection.
- Preserve Graphite / Porcelain themes and all accent colors.
- Run `bun run format` before validation.

---

### Task 1: Lock interaction and first-paint regressions

**Files:**
- Modify: `test/vite-config.test.ts`

**Interfaces:**
- Consumes: source files `src/webui/main.tsx`, `src/webui/command-palette.tsx`, `src/webui/react.css`, and `src/webui/index.html`.
- Produces: static regression assertions for dismissal, touch safety, spacing, opacity, density, and critical layout.

- [ ] **Step 1: Add failing source-level assertions**

Assert that the composer installs a `pointerdown` dismissal listener and textarea blur/focus handlers, that command options prevent pointer defaults, that CSS includes `user-select: none`, `-webkit-touch-callout: none`, an opaque panel background and header gap, and that the HTML shell includes `.login{display:grid;place-items:center}` critical CSS.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `bun test test/vite-config.test.ts`

Expected: the new assertions fail because these behaviors and styles are absent.

### Task 2: Implement palette, header, and login fixes

**Files:**
- Modify: `src/webui/main.tsx`
- Modify: `src/webui/command-palette.tsx`
- Modify: `src/webui/react.css`
- Modify: `src/webui/index.html`

**Interfaces:**
- Consumes: existing `CommandPaletteProps`, composer textarea ref, and palette open state.
- Produces: unchanged component APIs with corrected dismissal and touch behavior.

- [ ] **Step 1: Add interaction-boundary dismissal**

Add a composer form ref. While the palette is open, register a capture-phase document `pointerdown` listener that closes it when the pointer target is outside the form. Close on textarea blur, reopen on focus when the current value starts with `/`, and retain item selection by preventing pointer default inside each option.

- [ ] **Step 2: Make palette touch-safe and denser**

Apply selection/callout suppression to the palette and options, replace transparent color mixing with an opaque `panel`/`bg` surface, reduce desktop item minimum height and padding, and reduce the mobile override while retaining a practical touch target.

- [ ] **Step 3: Add stable header spacing**

Give `.app-header` a consistent gap and adjust `.connection` margins at desktop and mobile breakpoints so the status dot and adjacent notification control do not collide.

- [ ] **Step 4: Add critical login layout**

Inline minimal layout-only CSS in the HTML head for full viewport sizing, zero body margin, centered `.login`, and stable login section width before the external stylesheet finishes loading.

- [ ] **Step 5: Run focused verification**

Run: `bun test test/vite-config.test.ts`

Expected: all source-level WebUI regressions pass.

### Task 3: Validate, document, and commit

**Files:**
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: the completed UI behavior and verification output.
- Produces: current milestone/changelog truth and committed implementation.

- [ ] **Step 1: Format**

Run: `bun run format`

- [ ] **Step 2: Validate production and repository quality**

Run: `bun run format:check`, `bun run typecheck`, `bun run lint`, `bun run webui:build`, `bun test`, and `git diff --check`.

Expected: all commands pass; only the already deferred frontend chunk-size warning may remain.

- [ ] **Step 3: Update progress**

Record root causes, behavior changes, verification counts, and the unchanged deferred maintenance list in `PROGRESS.md`.

- [ ] **Step 4: Commit**

Stage the implementation, tests, docs, and progress update, then create a focused Git commit describing the WebUI interaction polish.
