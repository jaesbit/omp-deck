# Kanban polish — PR plan

Closes **T-78** (column reorder), **T-79** (recency sort), **T-80** (card timestamps).

One PR, five commits. Each commit is independently green (`bun typecheck` + `bun test` in `apps/server` and `apps/web`). Surface area is the same handful of files (`apps/web/src/views/TasksView.tsx`, `apps/web/src/components/tasks/*`, `apps/server/src/db/tasks.ts`, `apps/server/src/routes-tasks.ts`, `packages/protocol/src/index.ts`, one new migration) — splitting into three PRs would just thrash the same files.

## Why one PR

- All three tasks live in the kanban surface. They share the same drag-context wiring, the same column header, and the same card body.
- T-79's sort change relaxes the `orderInState`-based reorder logic; T-78 reuses dnd-kit at the column level. Landing them separately would force two passes over `TasksView.onDragEnd`.
- T-80 is read-only on existing data and stands alone, but is small (~40 LOC) and ships free with the others.

## Commit order

### 1. `task-states: add reorder endpoint`

Server-only, no UI. Lays the foundation for commit 2.

- `apps/server/src/db/tasks.ts` — `reorderStates(orderedIds: string[]): TaskState[]`. Validates that `orderedIds` is a permutation of the current `task_states.id` set (rejects on missing/extra/dup with a thrown error). Renumbers `position` in 100-unit gaps inside a transaction.
- `apps/server/src/routes-tasks.ts` — `POST /api/task-states/reorder` body `{ orderedIds: string[] }`. Calls `reorderStates`, calls `notifyTasksChanged()`, returns `{ states: TaskState[] }`.
- `packages/protocol/src/index.ts` — `ReorderTaskStatesRequest { orderedIds: string[] }`.
- `apps/web/src/lib/tasks-api.ts` — `reorderStates(ids: string[]): Promise<{ states: TaskState[] }>`.
- Test: `reorderStates(['s_done','s_blocked','s_active','s_backlog','s_01ksanbn3wfb'])` produces the expected position order; passing a missing id throws; passing a duplicate throws.

### 2. `task-states: drag-reorder columns in TasksView`

Wires commit 1 into the UI.

- `TasksView.tsx` — wrap the columns row in `SortableContext` with `horizontalListSortingStrategy`. Reuse the existing `DndContext`. Distinguish column drags from task drags via `event.active.data.current?.type === "column"`. Optimistic local reorder; rollback on API failure.
- `Column.tsx` — accept a `useSortable({ id: state.id, data: { type: "column" } })`. Bind the drag handle to a **dedicated grip icon** (`GripVertical` from lucide) inserted left of the color dot — NOT the whole header, so clicking the column name still triggers rename, and the per-column droppable for task cards still receives `over`.
- Activation constraint already `distance: 6` — covers both pointer-down-to-rename and pointer-drag-to-reorder.
- `onDragStart` / `onDragEnd` branch on `data.current?.type`. Column-drag path: compute new `orderedIds[]`, call `tasksApi.reorderStates(ids)`, on success merge the returned `TaskState[]` into local state.

### 3. `tasks: track state-entry time, sort columns by recency`

T-79's substance.

- **Migration `004-state-entered-at.sql`**:
  ```sql
  ALTER TABLE tasks ADD COLUMN state_entered_at TEXT;
  UPDATE tasks SET state_entered_at = updated_at WHERE state_entered_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_tasks_state_entered
    ON tasks(state_id, state_entered_at DESC);
  ```
- `apps/server/src/db/tasks.ts`:
  - `TaskRow` adds `state_entered_at: string | null`; `rowToTask` exposes `stateEnteredAt`.
  - `createTask`: insert with `state_entered_at = now`.
  - `moveTask`: when the destination `state_id` **differs** from the source's, update `state_entered_at = now` on the moved row only. Same-column drops leave it untouched (peers keep their entry timestamps).
  - `listTasks` and `getTask` SELECT the new column.
  - `listTasks` `ORDER BY state_id, state_entered_at DESC, order_in_state ASC` — `state_entered_at` is the primary sort; `order_in_state` is the tiebreaker for rows backfilled to the same `updated_at`.
- `protocol/index.ts` — `Task.stateEnteredAt: string` (required after migration).
- `TasksView.tsx`:
  - Same-column drop becomes a no-op visually — the optimistic `reorderTasksLocal` already moves the card in-array, but the next `refresh()` will re-sort by `stateEnteredAt DESC`, returning it to its natural slot. Acceptable: spec is explicit that within-column order is no longer user-controlled.
  - Cross-column drop: optimistic splice at index 0 of the destination column (top). Server response will confirm via the recency sort.
- `daily-briefing` routine's `list_tasks deck` step gets a behavior nudge: `state_ref: done since_hours: 24 limit: 20` now returns the 20 *most recently moved-to-done* — strictly better for the briefing.

### 4. `tasks: brief date/time on card top-right`

T-80.

- `apps/web/src/lib/time.ts` (new) — pure function:
  ```ts
  export function formatBriefTime(iso: string, now = Date.now()): string;
  ```
  Tiers:
  - `< 60s` → `"just now"`
  - `< 60m` → `"5m"`
  - same calendar day → `"5pm"` (exact hour) or `"5:30pm"` (non-hour); lowercased, no zero-pad
  - `< 365d` → `"05/08"` (zero-padded MM/DD)
  - `≥ 365d` → `"05/08/25"`
- Render in `TaskCardBody` header row: `<time dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString()} className="font-mono text-[10px] uppercase tracking-meta text-ink-3 ml-auto">{formatBriefTime(task.updatedAt)}</time>`. The `ml-auto` pushes it to the right; `T-{displayId}` stays on the left.
- Unit test: `formatBriefTime` for each tier boundary (+/-1 second around 60s, 60m, midnight, 365d). Use a fixed `now` arg.

### 5. `docs: kanban polish CHANGELOG`

- `CHANGELOG.md` — one entry under unreleased: "Kanban: drag-reorder columns; cards sorted by most-recent activity per column; brief date/time on each card."
- Callout: "Manual within-column ordering no longer persists — columns auto-sort by when each card last entered the column. Cross-column drag-and-drop is unchanged."

## Acceptance, end-to-end

- Drag column header by the grip → columns reorder; refresh → persists.
- Drop a backlog card on `done` → card appears at top of `done`; refresh → still on top; older done cards trail by entry time.
- Edit a task body in the modal → its card's date/time bumps to "just now" but its **position does not move** (body edits don't reset `stateEnteredAt`).
- Reorder a card within the same column → drop animation plays, then card snaps back to its sorted position. No spec-violating UX, but document this in the CHANGELOG.
- `formatBriefTime` unit tests pass.
- `bun typecheck` clean across workspace.

## Risks

- **Existing curated within-column order is lost** on first deploy. Acceptable per the T-79 spec, but worth a one-line CHANGELOG flag.
- **Column-drag grip placement** — putting it left of the colored dot keeps the existing column-header rename click intact. If the grip is too subtle, users will try dragging the dot itself; the dot stays a presentational `<span>` (no listeners), so they'll get no feedback. Mitigation: tooltip on the grip ("Drag to reorder").
- **`state_entered_at` backfill** = `updated_at`, which is monotonic but coarse — cards that were edited (body changes) more recently than they were moved will sort higher than cards that were actually moved later. Self-corrects after the first move post-deploy.

## Out of scope

- Per-column sort mode (`manual | updated_desc | entered_desc`). Could add later as a `task_states.sort_mode` column if anyone misses manual within-column ordering.
- Drag-handle styling polish beyond the grip icon.
- Tooltip on the date showing relative time as well as absolute (`<time>` `title` already shows absolute; relative is in the visible text).
