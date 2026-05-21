# Changelog

All notable changes to omp-deck. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] — V1 routines: multi-step pipelines + visual builder

Routines graduate from "single-action cron jobs" to a first-class Pattern-3
agent platform: multi-step pipelines, multiple trigger types per routine,
shared context across steps, cross-run state, budget caps, and a form-mode
visual builder so authoring doesn't require YAML literacy.

### Routine engine
- Multi-step pipeline runner at `apps/server/src/routines/v1-runner.ts`
  dispatching 8 step types: `run`, `agent`, `write`, `http`, `mcp` (stubbed
  for V1.5), `transform`, `wait`, `set_state`. Each step type has its own
  executor file under `apps/server/src/routines/steps/`.
- `RoutineSpec` is a YAML document persisted in `routines.spec_yaml` (V1
  source of truth) with derived columns (`cron`, `concurrency`, `budget_json`,
  `tags`, `timezone`) mirrored for query speed. V0 single-action routines
  keep working unchanged — the runner branches on `spec_version`.
- Per-step record persistence: `routine_step_runs` table populated with
  status, stdout/stderr excerpts, structured JSON output, error, model used,
  tokens in/out, cost micros, duration, retry attempt.
- Templating engine (`{{ run.id }}`, `{{ run.date }}`, `{{ steps.X.json.field }}`,
  `{{ steps.X.stdout }}`) at `apps/server/src/routines/template.ts`. Value-mode
  preserves type for single-expression payloads; string-mode for embedded use.
- Sandboxed `when:` + `transform` evaluator at `apps/server/src/routines/sandbox.ts`
  using quickjs-emscripten with a 100ms wall-clock cap. Secrets are redacted
  at marshal time so adversarial expressions can't exfiltrate them.

### Triggers
- Three trigger sources per routine: `cron` (multi-cron supported per
  routine), `webhook` (POST to `/hooks/*` with `X-Routine-Signature: sha256=...`
  HMAC verification), `manual` (POST to `/api/routines/:id/run` with optional
  params).
- `event:` triggers reserved in the schema for V1.5.
- Internal HMAC-signed bearer token for the `http` step's localhost calls
  (`apps/server/src/routines/internal-auth.ts`) — wired but unused in V1,
  ready for managed-hosting V1.5.

### Runtime controls
- Concurrency policies: `skip` (default), `queue`, `cancel-previous`,
  `parallel`. In-memory controller at `routines/concurrency.ts`.
- Budget enforcer (`routines/budget.ts`): `max_duration_secs`,
  `max_llm_cost_usd`, `max_llm_tokens_input/output`, `max_steps_executed`.
  Checked between steps; hard-aborts with `abort_reason: 'budget'` on excess.
  Cost estimation uses a static `PRICES_PER_MILLION` table (documented as
  estimate, not invoice).
- Cross-run persistent state: `routine_state` table keyed by (routine_id, key).
  The `set_state` step UPSERTs; `state.*` is in the template + sandbox context.
- Per-step `on_failure` (`abort` / `continue` / `retry`) + retry policy
  (`times`, `backoff: linear | exponential`, `max_delay_secs`, `after_retry`).

### Visual builder (Tier 1)
- Form-mode editor for V1 routines at `apps/web/src/components/routines/`,
  driven by the same JSON Schemas Ajv validates against — single source of
  truth, two renderings.
- Tabs: **Steps** (one card per step, expandable, with up/down/delete and
  the type-specific form), **Triggers** (cron with next-5-runs preview,
  webhook with path + secret_env, manual), **Settings** (name, description,
  concurrency dropdown, IANA timezone, tags, full budget grid, declared
  state keys), **Spec (YAML)** (raw YAML buffer with Apply-to-form).
- Form ↔ YAML round-tripping. Form edits update the YAML buffer; valid
  YAML edits parse back into the form. Invalid YAML disables the apply
  with a line-numbered parse error + schema error list.
- Add-step picker with one-line descriptions per type. Up/down reorder
  (DnD ships in V1.5).
- "Pipeline" vs "Single-action" toggle on the editor header. New routines
  default to V1; existing V0 routines continue to render in the legacy
  single-action form.
- Webhook secret rotation button: mints a fresh server-side secret on
  demand, shown once with a copy-to-clipboard control.

### Templates
- Curated YAML templates under `apps/server/src/templates/`. `GET
  /api/routine-templates` lists; `POST /api/routine-templates/:slug` installs
  the routine in disabled state for review.
- V1 ships **daily-briefing** as the proof-point: 7 steps (should_run gate,
  fetch_tasks, fetch_inbox, digest, agent summary, write to inbox, persist
  state). Verified end-to-end with a real LLM call (1483 tokens, ~$0.011).

### Run observability
- New route `/routines/:id/runs/:runId` — **RunDetailView** with polling
  live updates, per-step expansion (stdout / stderr / structured json /
  error), status pill, replay button.
- Metrics endpoint `GET /api/routines/:id/metrics` returns total,
  successCount, successRate30d, p50/p95 duration, mtdCostMicros, last-30
  sparkline data.
- WS broadcasts: `routine_run_started`, `routine_step_event`,
  `routine_run_finished` frames consumed by the client for live updates.

### Integrations stub
- New nav-rail entry **Integrations** at `/integrations`. V1 ships a stub
  pointing at the V1.5 plan: install MCP servers via `/mcp install` in chat
  for now; Workspace MCP (taylorwilsdon/google_workspace_mcp) lands as the
  curated install in V1.5.

### Schema + protocol
- DB migration `003-routines-v1.sql`: extends `routines` (`spec_yaml`,
  `concurrency`, `budget_json`, `tags`, `timezone`, `spec_version`),
  extends `routine_runs` (`trigger_payload`, `total_llm_tokens`,
  `total_llm_cost_micros`, `aborted_at`, `abort_reason`, `step_count_*`),
  adds `routine_step_runs`, `routine_webhook_secrets`, `routine_state`.
- Protocol: new types `RoutineSpec`, `RoutineStep` (8-variant discriminated
  union), `RoutineTrigger` (4-variant union), `RoutineBudget`,
  `RoutineRetryPolicy`, `RoutineStepRun`, `RoutineConcurrency`,
  `RoutineStepStatus`. New WS frames per above. Ajv validator at
  `packages/protocol/src/validate.ts` over 14 JSON Schemas.

### What's deferred to V1.5
- DnD step reordering (uses the existing dnd-kit DragOverlay pattern)
- MCP step type real implementation (currently stubbed with a clear V1.5
  pointer; use `agent` step with `mcp_servers_allowed` for now)
- Smart-reorder warnings when reordering breaks a downstream context
  reference
- `mcp` step form auto-completes (`server` + `tool` dropdowns from installed
  MCP servers) once the Integrations page ships
- Workspace MCP integration (Gmail / Calendar / Drive / Docs) for the
  inbox-triager template
- Skill / MCP-server allowlist enforcement on `agent` steps (the SDK does
  not yet expose per-invocation surface restriction)

### Dependencies
- `apps/server`: `quickjs-emscripten@^0.31.0`, `yaml@^2.9.0`
- `packages/protocol`: `ajv@^8.17.1`, `ajv-formats@^3.0.1`
- `apps/web`: `yaml@^2.9.0`

## [0.2.0] — KB Cockpit + Maintenance Gate

Two big surfaces land alongside several smaller refinements.

### Skills cockpit — omp-native pivot
- `SkillsService` now reads through `loadCapability(skillCapability.id)`, so
  every skill omp loads is surfaced — `native` (`~/.omp/agent/skills/`),
  `claude-plugins` (marketplace), `claude` / `codex` / `opencode` config
  dirs, plus any future provider. The marketplace path is no longer the
  only source. Default sort puts `native` first; source filter rail in the
  sidebar replaces the prior plugin-only filter.
- Detail route switched to opaque server-issued `:id` (base64url of the
  SKILL.md absolute path) — clients pass it back verbatim.
- Watcher widens to `~/.omp/agent/skills/`, `<defaultCwd>/.omp/skills/`,
  and the marketplace cache. Missing roots skipped silently.
- Mobile master/detail nav: tree visible by default, picking a file slides
  to viewer with a back arrow.
- New starter `create-skill` skill bundled in `starter-skills/` and
  installed to `~/.omp/agent/skills/` on deck boot (idempotent). Zero
  Claude-Code dependencies — uses only omp's standard tools.
- Bundled starter installer logs what it copied vs skipped; opt out with
  `OMP_DECK_INSTALL_STARTER_SKILLS=0`.

### KB Cockpit (new feature)
Karpathy-style llm-wiki cockpit over `~/kb`. New `/kb` route between
Skills and Settings (BookOpen icon).

- **Browse**: lazy-loading tree of every markdown file under `OMP_DECK_KB_ROOT`
  (default `~/kb`). Top-level vendor noise (`.venv`, `node_modules`,
  `__pycache__`, `dist`, `build`, etc.) excluded automatically. Custom
  exclusions via `OMP_DECK_KB_EXCLUDE_DIRS=foo,bar,private`.
- **Read**: markdown viewer with wikilink resolution. `[[stem]]` matches
  by filename (deterministic same-dir tiebreaker on collision);
  `[[dir/path]]` is absolute; `[[target|label]]` and `[[target#anchor]]`
  supported. Unresolved wikilinks render with dotted-underline + tooltip.
  Code-block contents preserved verbatim so regex literals like
  `[[:alpha:]]` don't get parsed as wikilinks. URL state `?path=<rel>`
  drives the open file; browser back/forward works.
- **Edit**: in-pane textarea editor with Ctrl-S to save, Esc to discard.
  Atomic write via temp + rename. YAML frontmatter validated on save
  with the `yaml` package — invalid YAML returns 400 with the parser
  message in an inline error.
- **Create**: clicking an unresolved wikilink prompts for a target path
  (defaults to current file's directory) and POSTs a stub with required
  frontmatter.
- **Graph**: Obsidian-style force-directed view (`?view=graph`) via
  `react-force-graph-2d`. Nodes colored by top-level directory
  (`native` rust, `cryptocracy` violet, `tools` emerald, `system` amber,
  `writing` pink, `domains` blue, `music` cyan, `projects` red), sized
  by inbound degree. Click a node to open the file in a 28rem right-pane
  preview while the graph stays mounted. Browser-back collapses the
  preview cleanly. Click-to-isolate per directory in the bottom-left
  legend; orphans toggle; full-text filter.
- **Inspector**: frontmatter as a definition list, tag chips, clickable
  outbound link list, backlinks list with line-bounded snippets, orphan
  badge when 0 backlinks.
- **Search**: `GET /api/kb/search?q=<query>` with hybrid scoring across
  stem (100/80/60), title (60/40/25), tag (50/20), body (10+) with a
  centered 160-char snippet for body hits. Ctrl-P / Cmd-P opens a
  quick-open palette anywhere in /kb with debounced search, arrow-key
  nav, Enter to open. Tree sidebar header gets a clickable Ctrl-P pill
  for non-keyboard users.
- **Setup flow**: a missing or empty kb root surfaces a Welcome panel
  inside `/kb` with a one-click scaffold of a starter `README.md`.
- **Live updates**: WS `kb_changed` debounced 250ms; the viewer + tree
  + graph + inspector all refetch on counter change. Disable with
  `OMP_DECK_WATCH_KB=0`.
- **Cross-platform**: CRLF-tolerant frontmatter parser, atomic-write
  uses `rename` (single-drive assumption documented), wikilink
  resolution normalizes path separators.

### Maintenance gate (new feature)
Ports the calibrated `maintenance-gate` pattern from
[vincitamore/opus-extensions](https://github.com/vincitamore/misc/tree/main/opus-extensions)
as a first-party omp SDK extension, plus the in-bridge wiring that makes
it actually fire in deck sessions.

- **The extension** (`starter-extensions/maintenance-gate/`): installed
  to `~/.omp/agent/extensions/maintenance-gate/` on deck boot. Watches
  `turn_end` events; when ~10+ turns have passed since the last capture
  pass, synthesizes a follow-up user message containing a markdown
  "Maintenance check" prompt with the OMP-native signal table:

  | Signal | Action if present |
  |--------|-------------------|
  | Reusable insight or pattern | → `knowledge/<subfolder>/<topic>.md` |
  | Project status changed | → update `context/current-state.md` |
  | New task identified | → `tasks/<name>.md` |
  | Question worth preserving | → `queries/<question>.md` |
  | Feature idea / future project | → `inbox/ideas/<item>.md` |
  | Decision needed | → `inbox/decisions/<item>.md` |
  | Bug to investigate | → `inbox/investigations/<item>.md` |
  | Quick unsorted capture | → `inbox/captures/<item>.md` |
  | New capability learned | → create a skill |

  Writing into any canonical capture path releases the check
  automatically; stating the literal phrase "No maintenance needed"
  also releases. Cadence + throttle constants are env-overridable
  (`OMP_MAINTENANCE_GATE_TRIVIAL`, `_STALENESS`, `_FIRE_FLOOR_MS`,
  `_ROOTS`).
- **Structural org-root detection**: replaces the upstream's hardcoded
  `documents/opus|materia` substring check with a sniff (`inbox/` +
  `tasks/` + (`knowledge/` or `context/`) present). Walks up ancestors
  so deeply-nested sessions still activate against the right org root.
- **Bridge wiring**: `InProcessAgentBridge` now constructs the session's
  `ExtensionRunner` and calls `initialize()` with 13 session-bound
  action callbacks + 8 context-action callbacks. Mirrors the pattern in
  `modes/acp/acp-agent.ts` and `task/executor.ts`. Without this, the
  SDK loads extensions but their lifecycle handlers never fire. Now
  works universally across deck, TUI, and ACP sessions.

### Web polish
- External links (`http://`, `https://`, `mailto:`) in any markdown
  surface (chat, kb viewer, skill detail) open in a new tab with
  `rel="noopener noreferrer"`. In-app wikilinks and relative paths
  unchanged.
- Mobile master/detail navigation pattern extended from SkillsView to
  KbView — list visible by default at `< lg`, picking a row slides to
  detail with a back arrow.
- **Horizon** theme — third option in Settings → Appearance (pink-on-deep-
  navy with mint + peach + cyan syntax bias). Ported from
  [opus-extensions/omp-themes/horizon.json](https://github.com/vincitamore/misc/tree/main/opus-extensions/omp-themes).
  Pre-paint script recognizes it so first paint never flashes.

### Server polish
- CRLF-tolerant YAML frontmatter parsing across kb and skill loaders —
  fixes "Unexpected scalar at node end" errors on Windows-saved files.
- All new endpoints debounce + cache aggressively; the watcher
  invalidates per-source rather than wholesale.

### Internal
- New top-level dirs: `starter-skills/`, `starter-extensions/`,
  `docs/proposals/`.
- New web deps: `react-force-graph-2d` (graph view), `yaml` (server
  frontmatter).
- Protocol additions: `SkillSummary` extended; `KbTreeEntry`,
  `KbFileResponse`, `KbWikilink`, `KbGraphNode/Edge/Response`,
  `KbBacklink/BacklinksResponse`, `KbSearchResult/Response`,
  `KbStatusResponse`, `KbInitResponse`, plus `kb_changed` /
  `skills_changed` server frames.
- New bundled starter installer pattern: `StarterExtensionsInstaller`
  mirrors `StarterSkillsInstaller` (idempotent, opt-out via
  `OMP_DECK_INSTALL_STARTER_EXTENSIONS=0`).

## [0.1.0] — Initial public release

First release. End-to-end verified against a live omp turn.

### Chat
- Multi-session sidebar with workspace filter.
- Live streaming text, thinking blocks, tool-call lifecycle with per-tool
  renderers (`read` / `write` / `edit` / `bash` / `search` / `lsp` / `task` /
  `web_search` / `eval` / `todo_write` / `generate_image` / `browser` /
  `ast_grep` / `ast_edit`).
- Hashline-diff renderer for the `edit` tool.
- Todos panel from `todo_reminder`.
- Cost/usage rollup (input/output/cache/reasoning, USD).
- Image paste / drag / attach with thumbnail strip and `[Image #N]` placeholder.
- Compaction, retry, and TTSR indicators inline.
- Slash command picker with four scopes — `deck` (kanban operations),
  `builtin` (omp SDK), `user`, `project`.
- Built-in slash command dispatch in-process (no model round-trip) for SDK
  commands with text-mode handlers: `/context`, `/usage`, `/tools`, `/compact`,
  `/rename`, `/dump`, `/memory *`, `/mcp *`, etc.
- Deck-native slash commands: `/task add`, `/task list`, `/task done`,
  `/task move`. Operate directly on the kanban; zero token cost.
- `@filepath` mention autocomplete in the composer.
- Copy buttons on every code block.
- Context-window indicator with manual `/compact` popover.
- Streaming caret, blink-on-idle.

### Tasks (kanban)
- Backlog / Active / Blocked / Done with drag-and-drop.
- User-configurable columns with reorder + recolor.
- Human-friendly display IDs (`T-1`, `T-2`, ...) via a monotonic sequence.
- Promote-from-inbox flow.
- Live WS broadcast — any mutation (UI, deck slash, agent REST) refetches all
  open kanbans without polling.

### Routines
- Cron scheduler (`croner`) for `bash` / `prompt` / `script` actions.
- Run history with stdout/stderr excerpts.
- Manual fire-now.

### Inbox
- Quick-capture with kind taxonomy (email / ticket / idea / decision /
  investigation / capture).
- Promote-to-task one-click flow.

### Settings
- **Env** — masked secret list, replace-or-unset modal, atomic `.env` write
  to `<dataDir>/.env`, append-only audit log, hot-apply for
  `LOG_LEVEL` / `OMP_DECK_IDLE_TIMEOUT_MS` / `OMP_DECK_AUTO_START` /
  `OMP_DECK_DEFAULT_CWD` / `OMP_DECK_WORKSPACES`, restart-required banner with
  one-click restart.
- **Messaging** — Telegram credential rows, bridge supervisor with Start /
  Stop / Restart buttons, live logs panel, status pill (running / stopped /
  crashed).
- **Appearance** — Paper (warm cream) and Slate (dark) themes with swatch
  previews, system-preference following, FOUC-free pre-paint applied before
  React mounts. `data-theme` attribute on `<html>` swaps every Tailwind color
  + font token via CSS custom properties.

### Marketplace
- Three-panel browser over the SDK's `MarketplaceManager`.
- Suggested empty-state seeds with `anthropics/claude-plugins-official`.
- Install / uninstall / refresh per plugin or per source.
- Capability badges (`cmds` / `agents` / `hooks` / `mcp` / `lsp`).

### Native model picker
- Header label opens a modal listing every SDK model.
- Available (369) / All (2587) toggle.
- Provider grouping with the active model's provider floated to the top.
- Auth gating — picks against an unauthed model surface the SDK error inline.

### Messaging
- Standalone Telegram bridge in `apps/bridges/telegram/`.
- Long-poll, allowlist-gated, per-chat session map persisted to SQLite.
- Image attachments downloaded and forwarded as omp `ImageAttachment`.
- Debounced `editMessageText` to avoid Telegram rate-limits.
- Supervised by the deck server — Start / Stop / Restart from the Settings UI.

### First-run UX
- Auto-start (`OMP_DECK_AUTO_START`) **disabled by default**. Opt in by
  writing `~/.omp/agent/commands/start.md` and setting the env var.
- Empty `tasks` table seeds a `T-1: Welcome to omp-deck` backlog task with
  orientation pointers (nav rail, themes, deck slash commands, docs links).

### Deployment
- Loopback-only by default. Tailscale Serve, Docker, and SSH-tunnel patterns
  documented in `docs/deployment.md`.
- `POST /api/server/restart` graceful restart endpoint.

### Architecture
- Bun + Hono backend embedding `@oh-my-pi/pi-coding-agent`.
- `AgentBridge` interface so a subprocess-per-session impl can drop in later.
- WS event passthrough (`session_event`) with deck-side synthetic events for
  context-usage, slash-command round-trips, and model swaps.
- Dep-free `@omp-deck/protocol` package owns the wire types.
