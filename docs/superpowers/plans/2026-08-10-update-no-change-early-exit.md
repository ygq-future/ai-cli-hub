# Update No-Change Early Exit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/update confirm` immediately after pull when the repository HEAD did not change, without running deployment checks or restarting the service.

**Architecture:** Keep the existing clean-worktree and pull checks. Reuse the already captured before/after HEAD values as the single reliable no-update signal, then return a dedicated result before configuration, database, build, and restart side effects.

**Tech Stack:** Bun, TypeScript, Bun test, Markdown documentation.

## Global Constraints

- A clean worktree is not proof that the remote repository has no updates.
- The early exit condition is `before HEAD === after HEAD` after a successful `git pull --ff-only`.
- No dependency sync, validation, WebUI build/promotion, settings migration, database migration, restart notice, or scheduled restart may run after the condition is met.
- Changed HEAD behavior remains unchanged.
- Run `bun run format` before verification and commit all completed changes.

---

### Task 1: Return immediately when pull changes no commits

**Files:**
- Modify: `src/ops/update.ts`
- Modify: `src/ops/update.test.ts`
- Modify: `docs/03-Interface-Contracts.md`
- Modify: `docs/07-Command-UX.md`
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: existing `GitUpdateReport.before`, `GitUpdateReport.after`, `formatGitReport()` and `UpdateRunnerDeps.scheduleRestart`.
- Produces: an unchanged-HEAD success response that performs no commands after the second `git rev-parse HEAD`.

- [ ] **Step 1: Tighten the existing unchanged-revision test**

Update the successful no-change test so its expected calls are exactly:

```ts
expect(calls).toEqual([
  'git status --short',
  'git rev-parse HEAD',
  'git pull --ff-only',
  'git rev-parse HEAD',
])
expect(restarts).toEqual([])
expect(report).toContain('已是最新版本')
expect(report).toContain('无需重启')
```

- [ ] **Step 2: Run the target test and confirm it fails**

Run: `bun test src/ops/update.test.ts`

Expected: the current implementation calls dependency/check/build/migration commands and schedules PM2 restart.

- [ ] **Step 3: Add the early return**

Immediately after `inspectGitUpdate()` succeeds:

```ts
if (git.before === git.after) return formatNoUpdate(git.after)
```

The dedicated formatter must show the short current commit and explicitly state that subsequent update stages and restart were skipped.

- [ ] **Step 4: Preserve and verify changed-HEAD behavior**

Keep the changed-revision test asserting commit/config/database summaries and confirm its restart callback is still scheduled.

- [ ] **Step 5: Synchronize contracts and progress**

Document that no-change detection occurs after pull and skips all later stages. Add the completed behavior and final verification count to `PROGRESS.md`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
bun run format
bun run format:check
bun run typecheck
bun run lint
bun test
git diff --check
```

Expected: all checks pass; only the existing deferred WebUI chunk warning may remain if a WebUI build is run.

Commit:

```bash
git add src/ops/update.ts src/ops/update.test.ts docs/03-Interface-Contracts.md docs/07-Command-UX.md PROGRESS.md docs/superpowers/specs/2026-08-10-update-report-notification-design.md docs/superpowers/plans/2026-08-10-update-no-change-early-exit.md
git commit -m "fix: skip update workflow when already current"
```
