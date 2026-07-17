# Spec-kit integration

[GitHub spec-kit](https://github.com/github/spec-kit) is a spec-driven
development toolkit: `/speckit-specify` writes a feature spec,
`/speckit-plan` derives a technical plan, `/speckit-tasks` breaks the plan
into a dependency-ordered task list (`specs/<slug>/tasks.md`), and
`/speckit-implement` executes it.

omp-deck plugs into that pipeline at the tasks stage: the bundled
**`speckit-taskstokanban`** starter skill pushes a feature's `tasks.md` onto
the deck kanban as individual board tasks — titles prefixed
`[<slug>] T<NNN>`, spec dependencies mapped to board `dependsOn` links,
user-story priorities mapped to board priorities, checked-off tasks landing
directly in Done. The sync is idempotent: re-running skips tasks already on
the board and only creates new ones.

## Setup

1. **Install spec-kit in the project** (once per repo). The deck's agent
   loads Claude-format skills natively, so use the `claude` integration:

   ```sh
   uv tool install specify-cli --from git+https://github.com/github/spec-kit.git
   cd <your-project>
   specify init . --here --integration claude --script sh
   ```

   This drops `/speckit-*` skills under `.claude/skills/` and templates
   under `.specify/`.

2. **Make the project a deck workspace** so sessions open there and pick up
   the project's spec-kit skills:

   ```sh
   OMP_DECK_WORKSPACES=/path/to/your-project
   ```

   (comma-separated list; or `OMP_DECK_DEFAULT_CWD` for the default). See
   [configuration.md](./configuration.md).

3. Nothing to install for the bridge itself — `speckit-taskstokanban` ships
   as a [starter skill](../starter-skills/README.md) and lands in
   `~/.omp/agent/skills/` on deck boot.

## Usage

In a deck chat session on the project workspace:

```
/speckit-specify Users can export their workout history as CSV
/speckit-plan
/speckit-tasks
/speckit-taskstokanban        ← tasks appear on the kanban
```

`/speckit-taskstokanban` takes an optional feature-dir argument
(`/speckit-taskstokanban 042-csv-export`) and defaults to the most recently
modified feature. From there, `T-N` display ids are addressable in chat as
usual, and the board drives implementation (`/speckit-implement`, or
cherry-picking tasks one at a time).

## Automating the pipeline with spec-kit hooks

Spec-kit's extension hooks (`.specify/extensions.yml`) can chain the stages
so a single `/speckit-specify` runs spec → plan → tasks → kanban with no
further commands:

```yaml
extensions:
  omp-deck-kanban:
    description: "Sync spec-kit tasks to the omp-deck kanban board"
  pipeline-chain:
    description: "Auto-advance the pipeline: specify -> plan -> tasks -> kanban"

hooks:
  after_specify:
    - extension: pipeline-chain
      command: speckit.plan
      description: "Generate the technical plan for the just-specified feature"
      optional: false
  after_plan:
    - extension: pipeline-chain
      command: speckit.tasks
      description: "Generate the task list from the plan"
      optional: false
  after_tasks:
    - extension: omp-deck-kanban
      command: speckit.taskstokanban
      description: "Push the generated tasks.md onto the omp-deck kanban"
      optional: false
```

Set `optional: true` on any hook to have the agent *suggest* the next stage
instead of running it — a sensible choice for `after_specify` when you want
to review the spec before planning. `/speckit-implement` is deliberately not
chained: generating documents and board tasks is cheap and reversible;
changing code should stay a human decision.

## Environment

| Variable | Effect |
| --- | --- |
| `OMP_DECK_API` | Full API base the skill talks to (default `http://127.0.0.1:${OMP_DECK_PORT:-8787}/api`) |
| `OMP_DECK_PORT` | Used to derive the default API base |

## Notes

- Deck builds older than the task-dependency feature silently ignore
  `dependsOn`/`priority` on create — the sync still works, tasks just land
  unlinked.
- The skill never mutates `tasks.md`; spec-kit remains the source of truth
  for the spec artifacts, the board is the execution surface.
