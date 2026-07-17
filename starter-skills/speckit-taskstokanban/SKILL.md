---
name: speckit-taskstokanban
description: Push the tasks of a GitHub spec-kit tasks.md onto the omp-deck kanban as individual, dependency-linked board tasks. Use after /speckit-tasks generates a task list, when the user wants spec-kit tasks on the kanban, or as a spec-kit after_tasks hook. Re-running syncs — existing board tasks are skipped.
argument-hint: "[feature dir, e.g. 001-user-auth — defaults to the most recent feature]"
tags: [spec-kit, kanban, integration, omp-native]
---

# Spec-kit tasks → kanban

Convert one feature's spec-kit task list (`specs/<slug>/tasks.md`) into
omp-deck kanban tasks over the deck HTTP API. Work with `curl` (plus
`python3` or `jq` for JSON); never guess IDs — always read them back from
API responses. Keep the run quiet: no narration between API calls, just the
final report.

## 1. Resolve the deck API

- Base URL: `$OMP_DECK_API` if set, else `http://127.0.0.1:${OMP_DECK_PORT:-8787}/api`.
- Verify with `GET ${API}/health`. Unreachable → stop and tell the user the
  deck server is not running at that address.

## 2. Locate the feature

- Argument given → `specs/<argument>/tasks.md` (fuzzy-match the dir name).
- No argument → the most recently modified `specs/*/tasks.md`.
- No tasks.md anywhere → stop: the user must run `/speckit-tasks` first.
- The feature directory name (e.g. `001-user-auth`) is the **feature slug**.

## 3. Read board state

- `GET ${API}/task-states` → the id of the `backlog`-named state
  (case-insensitive), falling back to the `isDefault: true` state. Note the
  `done`-named state id too, if any.
- `GET ${API}/tasks` → titles of existing non-archived tasks. A board task
  whose title starts with `[<slug>] T<NNN>` is already synced — record its
  spec-ID → server-id mapping and never create it again.

## 4. Parse tasks.md

Task lines follow spec-kit's checklist format:

```
- [ ] T001 [P] [US1] Description with exact file paths
```

- `T001` — spec task ID (always present).
- `[P]` — parallelizable (optional). `[USn]` — user story tag (optional).
- `- [x]` — already completed.

Track the `## Phase N:` heading above each task and any explicit dependency
notes (a "Dependencies" section, or "depends on TXXX" prose).

## 5. Create board tasks (file order)

For each unsynced spec task, `POST ${API}/tasks`:

- `title` — `[<slug>] T<NNN> — <description>` (trim to ~90 chars, keep it meaningful).
- `body` — full description, then a metadata block: phase, user story,
  parallel flag, file paths, `Source: specs/<slug>/tasks.md`.
- `stateId` — backlog; use the done state instead when the line was `- [x]`.
- `priority` — `P1` for Setup/Foundational phases, else map `USn` → `Pn`
  (cap `P5`), default `P2`.
- `dependsOn` — server ids (`t_…`) resolved through the spec-ID map built
  during this run plus step 3's pre-existing entries:
  - Explicit dependency notes win.
  - Else: a non-`[P]` task depends on the previous task in its phase; the
    first task of a phase depends on the last task of the previous phase;
    `[P]` tasks share the `dependsOn` of their phase's first task.
  - Drop dependencies whose spec ID has no server id (older deck builds
    ignore the field entirely — that's fine, don't warn).

Record each response's `id` and `displayId` before continuing — later tasks
reference them.

## 6. Report

One compact table — spec ID → `T-<displayId>` → title — plus counts:
created / skipped (already on board) / done-on-arrival. Close by noting the
board is live in the deck's Tasks view and that re-running this skill after
tasks.md changes is safe.
