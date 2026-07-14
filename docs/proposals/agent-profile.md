# Proposal: AgentProfile — declarative chat profiles

Status: draft — pending approval (T-43 exit criteria 1 and 2)
Author: omp-deck team
Tracks: T-43. Content priority P5 (deferred by product decision), board priority P0.

This document is the T-43 deliverable: the **technical contract** and the
**UX contract** for `AgentProfile`. Per the task's exit criteria, building the
UI selector is authorized only after both contracts are approved. Nothing in
this proposal ships code.

## Why

Session launch today lets the user pick exactly three things: model, thinking
level, and Plan Mode (`CreateSessionRequest`, `packages/protocol/src/index.ts:72-81`).
Everything else that shapes an agent — system prelude, tool availability,
subagent policy, permissions — is either global process state (SDK settings
singleton), deck-wide (kb://system prelude), or unreachable from REST.

Users who alternate between "careful reviewer", "fast refactorer", and
"read-only analyst" personas re-configure by hand every launch, and can't
express most of the persona at all. An `AgentProfile` names that bundle once
and makes it selectable at session start.

## What exists today (grounding)

Verified against the codebase at `devel` tip (`a69c345`):

- **Launch chain**: `POST /sessions` (`apps/server/src/routes.ts:222-288`) →
  `bridge.createSession(CreateSessionOpts)` (`apps/server/src/bridge/types.ts:107-138`)
  → `createAgentSession` (SDK `src/sdk.ts:1098`). REST only carries
  `cwd / resumeFromPath / model / planMode / thinking`.
- **Model precedence**: request → `workspace_preferences` row → SDK
  `modelRoles.default` → first available (`routes.ts:256-266`, SDK
  `sdk.ts:1253-1311`). Invalid refs are rejected with 400 via
  `validateModelRef`, never silently degraded.
- **Prelude**: `getEffectivePrelude()` (`apps/server/src/orientation-store.ts:141-145`)
  builds the kb://system injection and the bridge passes it as the SDK
  `systemPrompt` callback, ordered `[prelude, append, ...defaults]`
  (`apps/server/src/bridge/in-process.ts:193-195, 270`).
- **Tools**: SDK supports a creation-time whitelist `toolNames`
  (`sdk.ts:495-496`, filter in `src/tools/index.ts:489-641`) and a runtime
  slate `setActiveToolsByName` (`agent-session.ts:6289`) already used by
  PlanModeBridge and GoalModeBridge. The deck does not plumb `toolNames`.
- **Subagents**: SDK creation option `spawns?: string` (policy string, default
  `"*"`, `sdk.ts:384-385`), plus settings `task.disabledAgents` and
  `task.agentModelOverrides` (`settings-schema.ts:4170-4178`). Declarative
  `AgentDefinition` markdown files exist for the task tool
  (`src/task/types.ts:314-329`, discovery `src/task/discovery.ts:61-133`) but
  cannot be injected into `createAgentSession` programmatically.
- **Permissions**: creation boolean `autoApprove` (`sdk.ts:565-566`) and
  settings `tools.approvalMode` (`always-ask | write | yolo`, default `yolo`)
  plus per-tool `tools.approval` records (`settings-schema.ts:3313-3339`).
- **Settings caveat**: `Settings.init` is a process-wide singleton
  (`settings.ts:276-283`). `session.settings.override(...)` therefore leaks
  across sessions in the same worker. True per-session settings require
  passing an isolated `Settings` instance (`Settings.loadIsolated`,
  `settings.ts:315`) to `createAgentSession` — the SDK supports it, the deck
  does not use it yet.

### Field-by-field feasibility

| Profile field | SDK mechanism | Deck plumbing today | Phase |
|---|---|---|---|
| Identity | none needed (deck-side entity) | — | 1 |
| Model | `options.model` | plumbed (`CreateSessionOpts.model`) | 1 |
| Thinking | `options.thinkingLevel` | plumbed (`CreateSessionOpts.thinking`) | 1 |
| Prelude | `options.systemPrompt` callback | plumbed for kb://system, not per-session | 1 |
| Tools | `options.toolNames` whitelist | **not plumbed** | 1 |
| Subagents: spawn policy | `options.spawns` | **not plumbed** | 1 |
| Subagents: disabled/model overrides | settings keys | needs isolated `Settings` | 2 |
| Permissions | `autoApprove` + settings keys | needs isolated `Settings` | 2 |
| Scope | none needed (deck-side persistence) | — | 1 |

Phase 1 fields are implementable end-to-end with plumbing changes only
(protocol → routes → bridge types → worker RPC → in-process). Phase 2 fields
are gated on adopting `Settings.loadIsolated` per session, which is a bridge
change with process-wide blast radius and deserves its own task.

## Explicit non-goals and constraints

These come from the task card and hold for the whole design:

1. **`ModelInfo` is not a profile.** `ModelInfo`
   (`packages/protocol/src/index.ts:291-316`) is a per-request catalog
   projection — `isAvailable` and `isCurrent` are computed for the requesting
   session and go stale immediately. `AgentProfile` stores a `ModelRef` and
   re-resolves it against the catalog at every launch, exactly like workspace
   preferences do today.
2. **Subagents are not profiles.** The SDK's `AgentDefinition` files configure
   *delegation targets* consumed by the task tool. An `AgentProfile`
   configures the *main session*. The profile may carry a policy **about**
   subagents (spawn policy, disabled agents), but selecting a profile never
   routes the chat through the task-tool mechanism, and profiles are not
   written to `.omp/agents/`.
3. **No UI until approval.** This document is the gate. The UX contract below
   describes what will be built, not what this task builds.

## Technical contract

### Schema

Protocol types (`packages/protocol/src/index.ts`, dep-free, doc-commented per
convention):

```ts
/** A named, declarative chat profile. Applied at session creation. */
export interface AgentProfile {
	/** App-generated ULID-ish id (`ap_...`). Never synthesized by clients. */
	id: string;
	/** Display name, unique within its scope. 1-64 chars. */
	name: string;
	/** Optional one-line description shown in pickers. */
	description?: string;
	/** Scope: absent cwd = global profile, present = workspace profile. */
	cwd?: string;
	/** Payload format version. Bumped only on breaking payload changes. */
	specVersion: number;
	/** Referenced model. Resolved and validated at launch, never embedded. */
	model?: ModelRef;
	/** Thinking level. Validated against the resolved model's
	 *  `thinkingLevels` at launch. `"off"` is explicit-off, absent = default
	 *  chain (workspace preference, then SDK). */
	thinking?: string;
	/** System prelude contributed by this profile. */
	prelude?: AgentProfilePrelude;
	/** Builtin-tool whitelist. Absent = all tools (today's behavior). */
	tools?: AgentProfileTools;
	/** Subagent policy. */
	subagents?: AgentProfileSubagents;
	/** Permission policy. Phase 2 — see Phasing. */
	permissions?: AgentProfilePermissions;
	createdAt: string;
	updatedAt: string;
}

export interface AgentProfilePrelude {
	/** `append` (default) adds `content` after the deck prelude and before
	 *  the SDK defaults. `replace` substitutes the deck prelude entirely
	 *  (kb://system injection included) — the SDK defaults always remain. */
	mode: "append" | "replace";
	/** Markdown, injected as a system block. 0-32 KiB. */
	content: string;
}

export interface AgentProfileTools {
	/** Names of builtin tools to allow (SDK `toolNames` whitelist).
	 *  SDK force-includes (goal/yield/memory/extension tools) still apply. */
	allow: string[];
}

export interface AgentProfileSubagents {
	/** SDK spawn policy string (default "*"). "" or "none" forbids spawns. */
	spawns?: string;
	/** Phase 2: agent names removed from the task-tool roster. */
	disabledAgents?: string[];
	/** Phase 2: per-agent model overrides (agent name → model selector). */
	agentModelOverrides?: Record<string, string>;
}

export interface AgentProfilePermissions {
	/** Phase 2: maps to SDK `tools.approvalMode`. */
	approvalMode?: "always-ask" | "write" | "yolo";
	/** Phase 2: per-tool decisions, maps to SDK `tools.approval`. */
	toolApproval?: Record<string, "allow" | "prompt" | "deny">;
}
```

Request shapes follow the existing conventions (`SetWorkspacePreferenceRequest`
style). On PATCH, `null` clears a field and omitted (`undefined`) leaves it
untouched, so the update type declares `| null` explicitly instead of hiding
behind `Partial<...>` (which cannot express "clear"):

```ts
export interface CreateAgentProfileRequest {
	name: string;
	/** Absent = global profile. Must be an absolute path when present. */
	cwd?: string;
	description?: string;
	model?: ModelRef;
	thinking?: string;
	prelude?: AgentProfilePrelude;
	tools?: AgentProfileTools;
	/** `spawns` accepted in phase 1. `disabledAgents`/`agentModelOverrides`
	 *  are rejected with 400 until phase 2 (see Phasing). */
	subagents?: AgentProfileSubagents;
	/** Rejected with 400 until phase 2 (see Phasing). */
	permissions?: AgentProfilePermissions;
}

/** PATCH body. `null` clears, omitted leaves untouched. `name` and `cwd`
 *  are never nullable: a profile always has a name, and scope changes are
 *  a delete+create, not a patch. */
export interface UpdateAgentProfileRequest {
	name?: string;
	description?: string | null;
	model?: ModelRef | null;
	thinking?: string | null;
	prelude?: AgentProfilePrelude | null;
	tools?: AgentProfileTools | null;
	subagents?: AgentProfileSubagents | null;
	permissions?: AgentProfilePermissions | null;
}

export interface ListAgentProfilesResponse { profiles: AgentProfile[]; }
```

`CreateSessionRequest` gains one field:

```ts
export interface CreateSessionRequest {
	// ...existing fields unchanged...
	/** Profile to launch with. Mutually exclusive with resumeFromPath. */
	profileId?: string;
}
```

### Field semantics

- **Identity** (`id`, `name`, `description`): deck-side only. `id` is the
  stable reference stored elsewhere (sessions, workspace defaults). `name` is
  unique per scope (global names unique among globals, workspace names unique
  per cwd) so pickers are unambiguous. Renames are allowed and do not change
  `id`.
- **Model** (`model?: ModelRef`): stored by reference. At launch it passes the
  same `validateModelRef` gate as today — unknown or unauthenticated model
  fails the launch with 400, never a silent substitute. Absent = fall through
  to the existing chain (workspace preference → SDK default).
- **Thinking** (`thinking?`): same value domain as today
  (`off/minimal/low/medium/high/xhigh`). Validated at launch against the
  *resolved* model's `thinkingLevels`. A profile with `thinking` set but a
  model that doesn't support thinking fails validation at save time only when
  the profile also pins the model, otherwise at launch (the resolved model is
  unknowable at save time).
- **Prelude**: contributes system content through the existing
  `buildSessionSystemPrompt` path. Effective order with `mode: "append"`:
  `[deck prelude (kb://system), profile prelude, internal append, ...SDK defaults]`.
  With `mode: "replace"` the profile content substitutes the deck prelude
  slot. SDK default blocks are never removed — a profile cannot strip the
  harness's own contract. Content is stored verbatim, no template expansion
  in v1.
- **Tools** (`tools.allow`): forwarded as SDK `toolNames`. Semantics are the
  SDK's: whitelist over builtins, custom/extension tools and force-includes
  are unaffected. An empty `allow` array is invalid at save time (a session
  with zero tools is not a chat profile, it's a mistake). Validation warns —
  but does not fail — on names absent from the current builtin roster, since
  the roster varies by SDK version.
- **Subagents** (`subagents.spawns`): forwarded as SDK `spawns`. Phase 2
  fields (`disabledAgents`, `agentModelOverrides`) persist in the schema from
  day one but are rejected with 400 by the routes until the isolated-Settings
  plumbing lands, so no stored profile can silently not-apply.
- **Permissions**: same phase-2 gating and rationale as above. The degenerate
  shortcut (`autoApprove: true` when `approvalMode === "yolo"`) is
  intentionally not offered early — shipping half a permissions model creates
  false confidence.
- **Scope** (`cwd?`): absent = global (visible in every workspace), present =
  workspace profile (visible only when launching in that cwd). Same
  key-normalization rules as `workspace_preferences` (exact-string cwd match).

### Resolution and precedence

At `POST /sessions` with `profileId`:

1. Load profile, 404 if unknown, 400 if its `cwd` doesn't match the request
   cwd (workspace profiles cannot be launched elsewhere).
2. Per-field effective value: **explicit request field → profile field →
   workspace preference → SDK default**. The request keeps working exactly as
   today when `profileId` is absent, and a user picking a profile can still
   override its model or thinking for one launch without editing the profile.
3. Resolved model+thinking validated exactly as today (`routes.ts:256-266`).
4. Bridge receives the merged `CreateSessionOpts` (new fields: `toolNames?`,
   `spawns?`, `profilePrelude?`). Worker RPC forwards verbatim, matching how
   every existing opt travels (`process.ts:122-124`).

Sessions record the applied profile: the create response and the session
snapshot (`SessionUi`) carry `profile?: { id, name }`. The applied
configuration is whatever was merged at creation — **later edits to the
profile never retro-apply to running or resumable sessions**. Resume
(`resumeFromPath`) restores persisted session state and takes no `profileId`,
consistent with the existing T-39 rule that model/planMode are
creation-time-only (400, `routes.ts:246-251`).

### Persistence

SQLite, dedicated table, migration `NNN-agent-profiles.sql` (next free number,
immutable once merged, repairs via new migrations per the 018 pattern):

```sql
-- agent_profiles: declarative chat profiles (T-43).
-- One row per profile. cwd NULL = global scope, else workspace scope.
-- spec/payload columns follow the routines spec_version precedent (003):
-- structured fields that routes validate live in real columns, the
-- declarative payload lives in spec_json and is versioned by spec_version.
CREATE TABLE IF NOT EXISTS agent_profiles (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    cwd          TEXT,
    description  TEXT,
    spec_version INTEGER NOT NULL DEFAULT 1,
    spec_json    TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_scope_name
    ON agent_profiles (COALESCE(cwd, ''), name);
```

Rules:

- `spec_json` holds `{ model?, thinking?, prelude?, tools?, subagents?,
  permissions? }`. Parsers are tolerant (try/catch, fill missing keys with
  absent) per the `rowToConfig` convention (`db/auto-work.ts:103-152`).
- `spec_version` versions the payload **format**, not the row. v1 = this
  document. A breaking payload change bumps the version and the reader keeps
  a compatibility path per version, exactly like `routines.spec_version`
  (`003-routines-v1.sql:51`). Additive payload fields do not bump it.
- No per-row edit history and no optimistic locking, matching every existing
  config table. `updated_at` via `nowIso()` on each write.
- One profile-shaped side effect on an existing table: `workspace_preferences`
  MAY later gain `default_profile_id TEXT` (additive migration) so a
  workspace can preselect a profile in the launch modal. Deferred until the
  selector exists — listed here so the approval covers the direction.
- Deleting a profile does not touch sessions (they hold a snapshot and a
  dangling `{id, name}` label is acceptable). Delete clears
  `default_profile_id` references.

Access module `apps/server/src/db/agent-profiles.ts`:

```ts
listAgentProfiles(cwd?: string): AgentProfile[]   // global + matching-cwd rows
getAgentProfile(id: string): AgentProfile | undefined
createAgentProfile(input: CreateAgentProfileRequest): AgentProfile
updateAgentProfile(id: string, patch: UpdateAgentProfileRequest): AgentProfile
deleteAgentProfile(id: string): void
```

### REST API

`buildAgentProfilesRouter()` in `apps/server/src/routes-agent-profiles.ts`,
mounted from `routes.ts` like every feature router (`routes.ts:504-524`):

- `GET /agent-profiles?cwd=` — global profiles plus the cwd's workspace
  profiles when `cwd` is present. No cwd = globals only.
- `POST /agent-profiles` — create. 400 on: missing/oversized name, duplicate
  name in scope, invalid prelude mode/size, empty `tools.allow`, phase-2
  fields present, model ref failing `validateModelRef`, cwd not absolute.
- `PATCH /agent-profiles/:id` — partial update, `null` clears a field,
  omitted leaves it. Same validation. 404 unknown id.
- `DELETE /agent-profiles/:id` — 404 unknown id.
- Responses return the re-read row, no wrapper, per convention. Errors are
  `{ error: string }` with 400/404/500 semantics matching `routes-auto-work.ts`.
- No broadcast frame in v1 (pull refresh, same as workspace preferences). If
  live invalidation proves necessary the counter-frame pattern
  (`sessions_changed`-style) is the designated extension point.

### Phasing

- **Phase 1** (unlocked by this approval, still selector-less until the UX
  contract is also approved): protocol types, table + migration, access
  module, REST CRUD, `CreateSessionOpts` plumbing for `toolNames` /
  `spawns` / profile prelude, `POST /sessions` merge logic, session snapshot
  labeling.
- **Phase 2** (separate task, requires `Settings.loadIsolated` per session in
  the worker): `permissions.*`, `subagents.disabledAgents`,
  `subagents.agentModelOverrides`. Until then routes reject those fields.

## UX contract

Four surfaces, all reusing established patterns. No new visual language.

### 1. Selection — SessionLaunchModal

- A **Profile** row appears above the model list: a compact select listing
  `Default (no profile)` plus global profiles plus the current workspace's
  profiles (grouped, workspace group first). Data comes from
  `GET /agent-profiles?cwd=` fetched on modal open, like the model catalog
  hook does today (`useModelCatalog`, `lib/model-catalog.ts:38`).
- Picking a profile **preselects** model and thinking in the existing
  controls (same `!modelTouched` / `!thinkingTouched` guards the workspace
  default uses, `SessionLaunchModal.tsx:122-131`). The user can still change
  either — that's a per-launch override, the profile is not edited.
- Non-representable fields (prelude, tools, spawns) render as a one-line
  summary under the select ("prelude +2.1 KB, 12 tools, spawns: none") so the
  choice is inspectable without opening an editor.
- Launch sends `profileId` plus any explicit overrides in
  `CreateSessionRequest`. Resume flows never show the profile row.
- If the workspace has a `default_profile_id`, it is preselected, and
  `Default (no profile)` remains one click away.

### 2. Management — ProjectConfigView and SettingsView

- **Workspace profiles**: new "Agent profiles" card in `ProjectConfigView`
  (the per-project settings home since T-112), listing the cwd's profiles
  with New / Edit / Delete. Same card visual grammar
  (`rounded-md border border-line bg-paper-2 p-4`).
- **Global profiles**: same card component hosted in a SettingsView section,
  scoped to globals. One component, two hosts, matching how
  `AgentPickerModal` is shared today.
- **Editor**: a modal following `WorkspaceDefaultAgentModal`'s structure
  (`AgentPickerModals.tsx:90-254`) extended with: name + description inputs,
  model picker (reusing the catalog list), thinking chips (only when the
  picked model has `thinkingLevels`), prelude textarea with mode toggle and
  byte counter, tools multi-select over the builtin roster fetched from the
  server, spawns policy input. Phase-2 fields don't render until phase 2.
- Saving calls `POST` / `PATCH` and the hosting card re-fetches — the local
  `refresh()` pattern `ProjectConfigView` already uses (`:46-67`).

### 3. Live session — ChatHeader

- When a session was launched with a profile, the header shows the profile
  name as a static badge next to the model button. It is a label of what was
  applied at creation, not a live control.
- Changing model or thinking mid-session keeps working exactly as today
  (`PATCH /sessions/:id`) and visibly does not mutate the profile — the badge
  gains a `*` marker (matching the "overridden" affordance pattern) when the
  live model/thinking diverges from the profile snapshot.
- No mid-session profile switching in v1. The knobs a profile controls beyond
  model/thinking (prelude, tools at creation, spawns) are creation-time in
  the SDK, so switching would be a lie.

### 4. Persistence semantics visible to the user

- Profiles are saved server-side (SQLite) and appear on every device/browser.
  No sessionStorage state beyond the usual view-selection persistence.
- Editing a profile never changes running sessions — the editor states this
  in a footnote, mirroring the Codebase Memory MCP card's "applies to new
  sessions" note (`ProjectConfigView.tsx:279-281`).
- Deleting a profile leaves past sessions labeled with the stale name and
  clears any workspace default pointing at it.

## Decisions locked by this proposal

1. Profiles persist in SQLite (deck-managed entity with REST CRUD), not as
   `.omp/agents/` markdown. The SDK's `AgentDefinition` format stays the
   task-tool delegation surface. Rationale: profiles are cross-workspace UI
   entities with validation and referential uses (workspace default,
   session labels) — filesystem discovery gives none of that.
2. Reference-not-embed for models (`ModelRef` + launch-time validation).
3. Merge precedence: request > profile > workspace preference > SDK default,
   per field.
4. Creation-time application only. No retro-apply, no mid-session switch.
5. Phase-2 fields persist in the schema but are rejected by routes until the
   isolated-Settings plumbing exists.

## Open questions for the approval gate

1. Should `prelude.mode: "replace"` exist at all in v1, or is `append`
   enough? Replace weakens the kb://system contract guarantees.
2. Does the workspace default profile (`default_profile_id`) land with the
   selector, or later? This proposal assumes with the selector.
3. Naming in UI copy: "Agent profile" vs "Profile" vs "Agente". The protocol
   name `AgentProfile` is fixed either way.
4. Should auto-work eventually launch through a profile instead of its own
   model-by-difficulty tables? Out of scope here, but the schema was kept
   compatible with that future (profiles are cwd-scoped and model-bearing).

## Exit criteria mapping (T-43)

1. Technical contract — sections "Technical contract" plus "What exists
   today" (schema, per-field semantics, persistence and versioning rules).
2. UX contract — section "UX contract" (selection, editing, persistence from
   the UI).
3. UI selector construction — **not authorized by this document**. It becomes
   authorized when the user approves both contracts and moves the follow-up
   implementation tasks out of backlog.
