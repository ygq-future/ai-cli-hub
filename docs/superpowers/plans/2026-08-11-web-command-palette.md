# Web Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared bilingual command catalog, a fast keyboard/mouse command palette, composer focus shortcuts, and clearly highlighted notification-enabled states to the Web console.

**Architecture:** A dependency-free catalog in `src/shared/` is the static source for Web suggestions and command rows in shared help text. Pure search and placeholder-selection functions stay separate from the React palette, while `main.tsx` only owns composer state, selection index, dialog-aware shortcut lifecycle, and insertion. Existing Core routing, HTTP APIs, persistence, and browser notification permission behavior remain unchanged.

**Tech Stack:** Bun 1.3, TypeScript strict, React 19, project CSS/Tailwind tokens, Lucide, Vite, Bun test, Prettier, ESLint, dependency-cruiser.

## Global Constraints

- Use Bun commands only; do not add a runtime dependency.
- Preserve Graphite / Porcelain Glass themes, accent switching, responsive layouts, and `prefers-reduced-motion`.
- The palette opens only when the first composer character is `/`.
- Prefix matches have absolute priority; fuzzy search runs only when no prefix match exists.
- `Enter` on a selected suggestion inserts but never sends it.
- Select the first complete `[...]` or `<...>` placeholder after insertion, including brackets.
- `Ctrl+I` / `Cmd+I` focuses the composer only when no dialog is open.
- All modified code must pass `bun run format` before validation.
- Every completed implementation slice is committed; no push is authorized.

---

## File Structure

- Create `src/shared/command-catalog.ts`: catalog types and all slash-command display metadata.
- Create `src/shared/command-catalog.test.ts`: catalog uniqueness, variants, and bilingual completeness.
- Modify `src/shared/index.ts`: barrel-export catalog APIs.
- Modify `src/transport/messages.ts`: render primary command help rows from the catalog.
- Create `src/webui/command-palette-model.ts`: prefix/fuzzy ranking and first-placeholder selection.
- Create `src/webui/command-palette-model.test.ts`: pure model behavior.
- Create `src/webui/command-palette.tsx`: accessible palette UI and overflow-aware description marquee.
- Modify `src/webui/main.tsx`: composer ref, palette state, insertion, keyboard handling, focus shortcut, notification classes.
- Modify `src/webui/react.css`: palette Glass styling, selected state, marquee, responsive/reduced-motion rules, notification highlights.
- Modify `test/vite-config.test.ts`: static integration guards for shortcut, palette, and notification classes.
- Modify `docs/07-Command-UX.md`: document Web discovery and shortcut behavior; correct `/file` notation.
- Modify `docs/08-Web-Control-Plane-Task-Book.md`: record the Web composer interaction contract.
- Modify `PROGRESS.md`: add the decision and completion changelog with final verification counts.

---

### Task 1: Shared command catalog and synchronized help

**Files:**

- Create: `src/shared/command-catalog.ts`
- Create: `src/shared/command-catalog.test.ts`
- Modify: `src/shared/index.ts`
- Modify: `src/transport/messages.ts`
- Test: `src/shared/command-catalog.test.ts`
- Test: existing Telegram and WebSocket Transport tests that assert `/help`

**Interfaces:**

- Produces `CommandCatalogEntry`, `COMMAND_CATALOG`, `getCommandDescription(entry, language)`, and `getPrimaryHelpCommands()`.
- Consumed by Task 2 search and Task 3 React UI.

- [ ] **Step 1: Write failing catalog tests**

Add assertions:

```ts
expect(new Set(COMMAND_CATALOG.map(item => item.id)).size).toBe(COMMAND_CATALOG.length)
expect(COMMAND_CATALOG.find(item => item.id === 'model')?.insertText).toBe('/model [model_name|model_id]')
expect(COMMAND_CATALOG.find(item => item.id === 'update-confirm')?.command).toBe('/update confirm')
expect(COMMAND_CATALOG.find(item => item.id === 'restart-confirm')?.primaryHelp).toBe(false)
expect(COMMAND_CATALOG.every(item => item.description.zh && item.description.en)).toBe(true)
```

- [ ] **Step 2: Run the catalog test and verify failure**

Run: `bun test src/shared/command-catalog.test.ts`

Expected: FAIL because `command-catalog` does not exist.

- [ ] **Step 3: Implement the dependency-free catalog**

Define:

```ts
export type CommandCatalogCategory = 'general' | 'session' | 'memory' | 'operations'

export interface CommandCatalogEntry {
  id: string
  category: CommandCatalogCategory
  command: string
  insertText: string
  description: Readonly<{ zh: string; en: string }>
  keywords: Readonly<{ zh: readonly string[]; en: readonly string[] }>
  primaryHelp: boolean
}
```

Populate stable entries for these insertion templates:

```text
/start
/help
/chatid
/switch <cli> [path]
/model [model_name|model_id]
/close
/status
/sessions
/clear
/reset
/audit [conversationId]
/file [limit] [keyword]
/autoapprove [on|off] [seconds]
/remember <text>
/memory
/forget <memoryId>
/env
/health
/update
/update confirm
/restart
/restart confirm
/lang <zh|en>
```

For parameterized commands, `command` is only the fixed left-column command such as `/model`; for fixed variants, it includes fixed words such as `/update confirm`. Mark confirm variants `primaryHelp: false` so help describes execution through the parent row without duplication.

- [ ] **Step 4: Export the catalog and derive help rows**

Export catalog APIs from `src/shared/index.ts`. In `src/transport/messages.ts`, map primary entries into the existing localized category headings while retaining explanatory blockquotes. Add `/start` and `/help` rows so shared help covers every primary slash command.

- [ ] **Step 5: Run catalog and Transport tests**

Run:

```bash
bun test src/shared/command-catalog.test.ts src/transport/telegram/telegram-transport.test.ts src/transport/websocket/websocket-transport.test.ts
```

Expected: PASS with no `/help` regression.

- [ ] **Step 6: Format and commit Task 1**

Run: `bun run format`

Commit:

```bash
git add src/shared/command-catalog.ts src/shared/command-catalog.test.ts src/shared/index.ts src/transport/messages.ts
git commit -m "feat: share slash command catalog"
```

---

### Task 2: Search ranking and insertion selection model

**Files:**

- Create: `src/webui/command-palette-model.ts`
- Create: `src/webui/command-palette-model.test.ts`

**Interfaces:**

- Consumes `COMMAND_CATALOG`, `CommandCatalogEntry`, and `UserLanguage`.
- Produces `searchCommandCatalog(input, language)` and `findFirstPlaceholderRange(template)`.

- [ ] **Step 1: Write failing search and selection tests**

Cover:

```ts
expect(searchCommandCatalog('/', 'zh')[0]?.command).toBe('/start')
expect(searchCommandCatalog('/mo', 'zh').map(item => item.id)).toEqual(['model'])
expect(searchCommandCatalog('/更换模型', 'zh')[0]?.id).toBe('model')
expect(searchCommandCatalog('/restart c', 'en')[0]?.id).toBe('restart-confirm')
expect(findFirstPlaceholderRange('/model [model_name|model_id]')).toEqual({ start: 7, end: 28 })
expect(findFirstPlaceholderRange('/switch <cli> [path]')).toEqual({ start: 8, end: 13 })
expect(findFirstPlaceholderRange('/update confirm')).toBeNull()
```

- [ ] **Step 2: Run the model test and verify failure**

Run: `bun test src/webui/command-palette-model.test.ts`

Expected: FAIL because the model module does not exist.

- [ ] **Step 3: Implement prefix-first search**

Normalize text with `normalize('NFKC').toLocaleLowerCase()` and remove only the leading slash. Prefix candidates are entries whose normalized fixed command or insertion text starts with the query; sort by command length and catalog order.

Only when prefix candidates are empty, score command text, both descriptions, and all keywords. Direct substring ranks above token substring, which ranks above ordered subsequence. Active-language matches receive a tie-break boost. Exclude zero-score entries.

- [ ] **Step 4: Implement complete-placeholder selection**

Use the first match of `/\[[^\]]+\]|<[^>]+>/`. Return its index and exclusive end for `textarea.setSelectionRange(start, end)`. Return `null` for fixed templates.

- [ ] **Step 5: Run tests, format, and commit Task 2**

Run:

```bash
bun test src/webui/command-palette-model.test.ts
bun run format
```

Commit:

```bash
git add src/webui/command-palette-model.ts src/webui/command-palette-model.test.ts
git commit -m "feat: add command palette search model"
```

---

### Task 3: React palette, keyboard flow, shortcut, and notification highlights

**Files:**

- Create: `src/webui/command-palette.tsx`
- Modify: `src/webui/main.tsx`
- Modify: `src/webui/react.css`
- Modify: `test/vite-config.test.ts`

**Interfaces:**

- Consumes Task 1 catalog entries and Task 2 search/range helpers.
- Produces `CommandPalette` with `items`, `language`, `selectedIndex`, `onSelectedIndexChange`, and `onSelect` props.

- [ ] **Step 1: Add failing integration guards**

Extend `test/vite-config.test.ts` to check:

```ts
expect(source).toContain('<CommandPalette')
expect(source).toContain("event.key.toLowerCase() !== 'i'")
expect(source).toContain('composer.current?.focus()')
expect(source).toContain('setSelectionRange(range.start, range.end)')
expect(source).toContain('notification-trigger active')
```

Read `command-palette.tsx` and assert `role="listbox"`, `role="option"`, `aria-selected`, and `scrollIntoView` are present.

- [ ] **Step 2: Run integration guards and verify failure**

Run: `bun test test/vite-config.test.ts`

Expected: FAIL because the component and shortcut are absent.

- [ ] **Step 3: Build the accessible palette component**

Render a bounded `role="listbox"` above the composer. Each option shows fixed command text and localized description. Keep a selected-row ref and call `scrollIntoView({ block: 'nearest' })` when selection changes.

An internal `MarqueeDescription` measures `scrollWidth - clientWidth` with `ResizeObserver`, stores only overflow-distance changes, sets `--marquee-distance`, and delegates frame animation to CSS transforms. It uses no timers or animation-frame state updates.

- [ ] **Step 4: Integrate composer palette state**

Add:

```ts
const composer = useRef<HTMLTextAreaElement>(null)
const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
const [commandSelection, setCommandSelection] = useState(0)
const commandSuggestions = useMemo(
  () => searchCommandCatalog(text, preferences.language),
  [text, preferences.language],
)
```

Text changes open only for `value.startsWith('/')` and reset selection. Before send handling, Arrow keys cycle, Escape closes, and Enter inserts the selected item. IME composition bypasses palette and send behavior. Insertion closes the palette and uses `requestAnimationFrame` to focus, select the first full placeholder, or put the caret at the end.

- [ ] **Step 5: Add dialog-aware focus shortcut**

Attach `keydown` while authenticated. Accept Ctrl/Cmd + I without Alt/Shift. When settings, mobile status, or image preview is open, do nothing. Otherwise prevent default and focus the composer. Remove the listener on cleanup.

- [ ] **Step 6: Add notification active classes**

Compute:

```ts
const notificationsActive = preferences.notificationsEnabled && notificationPermission === 'granted'
```

Apply `notification-trigger active` to the header button and `notification-field active` to the settings row only when true. Preserve the denied icon and copy.

- [ ] **Step 7: Add Glass and motion styles**

Style the panel above the composer with one accent edge, accent-tinted selected surface, blur, inner highlight, restrained shadow, short entrance motion, bounded height, transparent scrollbar, and mobile touch targets. Descriptions use ellipsis at rest and CSS-transform marquee only on selected/hover overflow rows. Disable translate and marquee motion under `prefers-reduced-motion`.

- [ ] **Step 8: Run targeted tests and WebUI build**

Run:

```bash
bun test src/webui/command-palette-model.test.ts test/vite-config.test.ts
bun run webui:build
bun run typecheck
```

Expected: PASS; only the already deferred chunk-size warning may remain.

- [ ] **Step 9: Format and commit Task 3**

Run: `bun run format`

Commit:

```bash
git add src/webui/command-palette.tsx src/webui/main.tsx src/webui/react.css test/vite-config.test.ts
git commit -m "feat: add web command palette interactions"
```

---

### Task 4: Contracts, progress, and complete verification

**Files:**

- Modify: `docs/07-Command-UX.md`
- Modify: `docs/08-Web-Control-Plane-Task-Book.md`
- Modify: `PROGRESS.md`

**Interfaces:**

- Consumes completed behavior from Tasks 1–3.
- Produces the current project truth for future coding sessions.

- [ ] **Step 1: Document the final interaction contract**

Document prefix-first/fuzzy fallback, keyboard selection, complete-placeholder selection, Ctrl/Cmd + I dialog isolation, and notification highlighting. Change `/file` parameter notation to `[limit] [keyword]` because Core already defaults limit to 10.

- [ ] **Step 2: Update `PROGRESS.md`**

Add a decision recording the shared catalog and non-sending palette semantics. Add a dated changelog row with exact validation counts. Keep deferred maintenance limited to PDF parsing security, backend code splitting, and frontend bundle splitting.

- [ ] **Step 3: Run all quality gates**

Run:

```bash
bun run format
bun run format:check
bun run typecheck
bun run lint
bun run webui:build
bun test
git diff --check
```

Expected: all commands exit zero; repository integration tests may remain skipped without `TEST_DATABASE_URL`; the known bundle-size warning remains deferred.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git status --short
git diff --stat
git diff
```

Confirm only scoped source, tests, contracts, and progress files changed.

- [ ] **Step 5: Commit documentation and final progress**

```bash
git add docs/07-Command-UX.md docs/08-Web-Control-Plane-Task-Book.md PROGRESS.md
git commit -m "docs: record web command palette behavior"
```

- [ ] **Step 6: Verify clean handoff**

Run:

```bash
git status --short
git log -6 --oneline
```

Expected: clean worktree and separate commits for design, shared catalog, search model, React interaction, and final documentation.

