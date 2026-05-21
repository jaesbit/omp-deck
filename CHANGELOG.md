# Changelog

All notable changes to omp-deck. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
