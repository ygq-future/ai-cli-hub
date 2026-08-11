# Web Command Palette and Composer Shortcuts Design

Date: 2026-08-11
Status: Approved

## Goal

Improve the Web console composer without changing backend routing semantics:

- make the browser-notification enabled state visually obvious;
- add `Ctrl+I` / `Cmd+I` to focus the message composer;
- show a responsive command palette when the first input character is `/`;
- keep the command catalog synchronized with the shared `/help` command list.

The unfinished fourth item in the original request is intentionally out of scope until the user supplies it.

## Decisions

### Shared command catalog

Add a dependency-free TypeScript catalog under `src/shared/`. Each entry contains:

- category;
- fixed command text shown in the left column;
- insertion template;
- concise Chinese and English descriptions;
- Chinese and English search keywords;
- whether it is a primary help command or a separate execution variant.

The WebUI imports this catalog at build time. The shared help text derives its main command rows from the same catalog, while retaining the existing explanatory notes. This avoids a Web-only third command list and does not change Core routing.

Commands with distinct actions are separate palette entries. In particular, `/update`, `/update confirm`, `/restart`, and `/restart confirm` are four items. Parameterized commands show only the fixed command name in the left column but insert the full template, such as `/model [model_name|model_id]`.

### Search and selection

The palette opens only when the first composer character is `/`.

Search uses two stages:

1. Match and rank command prefixes first.
2. Only when no prefix match exists, fuzzy-match command text, the active-language description, the alternate-language description, and catalog keywords.

Matching is computed from the small static catalog with memoized React derivation. No network request or per-frame JavaScript animation is involved.

Keyboard behavior:

- `ArrowUp` and `ArrowDown` cycle through visible items and keep the selected item in view.
- `Enter` inserts the selected template and never submits it immediately.
- `Escape` dismisses the palette for the current input state.
- Regular composer send behavior remains unchanged when the palette is not handling the key.

Mouse or touch selection performs the same insertion action.

After insertion, the first complete placeholder segment is selected, including its brackets. For `/model [model_name|model_id]`, the selected text is `[model_name|model_id]`, so typing replaces the brackets too. Required placeholders such as `<cli>` follow the same rule. If there are several placeholder segments, only the first is selected. Fixed templates such as `/update confirm` place the caret at the end.

### Composer focus shortcut

A document-level `Ctrl+I` / `Cmd+I` shortcut focuses the composer and prevents the browser default only when:

- the authenticated chat console is active;
- no settings, status, or image-preview dialog is open;
- the event is not already composing text.

Dialogs retain their own focus scope and are never interrupted by the shortcut.

### Visual behavior

The palette appears directly above the composer at the same content width. It uses the existing Graphite / Porcelain Glass tokens: translucent surface, backdrop blur, subtle inner highlight, restrained shadow, and a short opacity/translate transition.

Each row has:

- a stable monospace command column on the left with no parameter placeholders;
- a single-line active-language description on the right;
- an accent-tinted selected state with one light edge indicator, avoiding nested borders.

Descriptions use ellipsis at rest. A description that actually overflows scrolls smoothly from right to left only while its row is selected or hovered, then returns to its origin. The marquee uses CSS transforms rather than React frame updates. `prefers-reduced-motion` disables marquee and translation effects.

The panel has a bounded height, the existing transparent scrollbar treatment, desktop keyboard density, and mobile-friendly touch targets.

### Notification state

The disabled state keeps the current neutral Glass treatment. When notifications are both enabled locally and granted by the browser, the header button and settings switch receive an accent border, accent-tinted surface, and restrained glow in addition to the existing icon/knob indicator. Browser-denied permission remains a distinct blocked state and is not presented as enabled.

## Component boundaries

- `src/shared/command-catalog.ts`: catalog types, catalog data, localized accessors.
- `src/webui/command-palette.tsx`: palette UI plus pure prefix/fuzzy ranking and placeholder-range helpers (or adjacent testable module if needed).
- `src/webui/main.tsx`: composer text/focus integration, shortcut lifecycle, and palette insertion callback.
- `src/webui/react.css`: palette, marquee, notification-enabled state, responsive and reduced-motion rules.
- `src/transport/messages.ts`: render the shared primary catalog in `/help` while preserving existing guidance paragraphs.

No backend endpoint, database migration, runtime configuration, or Core command-routing change is required.

## Error and edge handling

- Empty `/` shows all catalog items in stable category/order sequence.
- Fuzzy search with no result shows a compact no-match row and does not consume Enter as a send action unless an item is selected.
- IME composition never triggers command selection or message submission.
- Changing text after Escape can reopen the palette once the command query changes.
- Catalog entries are validated by tests for unique IDs/templates and complete bilingual metadata.

## Verification

Automated coverage will verify:

- prefix priority and fallback fuzzy matching;
- bilingual keyword matching;
- stable ranking and empty-query behavior;
- complete first-placeholder selection;
- fixed-command caret placement;
- separate confirm variants;
- shared catalog/help coverage;
- keyboard selection does not send;
- focus shortcut dialog isolation;
- enabled notification state classes;
- WebUI production build, formatting, strict typecheck, lint/dependency rules, targeted tests, full test suite, and `git diff --check`.

