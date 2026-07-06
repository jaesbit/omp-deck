---
name: review-auto-work
description: Use when the user invokes `/skill:review-auto-work T-<N>` (or just names a T-N auto-work task) to check on one of the stacked `feat/tNN-*` Auto Work branches -- produces a test plan scoped to that PR's own diff, and fixes squash-merge rebase conflicts in the stacked branch chain. Symptom this targets: "conflictos que van apareciendo a medida que avanzo" on a chain of `origin`-only branches merged with GitHub squash.
tags: [git, testing, auto-work, omp-deck, stacked-prs]
---

# Review Auto Work

Every Auto Work task (T-58 onward) lives in its own worktree at
`.worktrees/tNN-<slug>`, on branch `feat/tNN-<slug>`, opened as a PR
**stacked on the previous task's branch** (T-63's branch was created on top
of T-62's branch tip, T-64 on top of T-63, etc -- see each task body's
trailing `**Auto Work manual run** -- worktree ..., PR #N ..., stacked on
#M` line). All merges to `origin/main` are **squash merges**.

Squash + stacked branches is a known-bad combination: once PR #M (say T-62)
squash-merges, GitHub deletes its branch and silently retargets the PR
built on top of it (T-63) to `main`. But T-63's branch *history* still
contains T-62's original multi-commit history, which no longer has a common
ancestor with the new squashed commit on `main` -- so `mergeStateStatus`
flips to `DIRTY`/`CONFLICTING` even though nothing about T-63's own change
is wrong. Plain `git rebase origin/main` in this state replays T-62's
commits too and conflicts against the squash commit line-by-line. This
keeps happening one branch further down the stack every time the branch
below it gets squash-merged -- that's the "conflicts keep appearing as I
advance" symptom this skill exists for.

The user's invocation carries the task id as trailing text, e.g. `User:
T-63` appended after this skill body -- parse the `T-<N>` (or bare `<N>`)
from it.

## Step 1 -- Resolve the task and its PR

1. `GET /api/tasks`, find the entry with `displayId == N`. Read its body --
   the trailing block gives you the worktree path, branch name, PR number,
   and what it's stacked on (`stacked on #M`).
2. `gh pr view <PR> --json number,title,baseRefName,headRefName,mergeStateStatus,mergeable`
   -- `baseRefName` is the PR's **current** base (already auto-retargeted by
   GitHub if the original base merged). Don't trust `gh pr view --json
   commits` to isolate "this task's own commits" once more than one
   upstream branch in the chain has merged -- it reports `origin/<base>..head`
   reachability, which re-lists EVERY ancestor task whose original commit
   SHA isn't literally on the base anymore, not just the newest one. The
   rebase script (Step 3) uses a more reliable signal instead.

## Step 2 -- Build and run a test plan scoped to this PR's own diff

Don't test the whole stack -- isolate what this task's own commit touched.
In the worktree: `git show --stat <top-commit-of-the-branch>` (the branch
tip *is* this task's own commit in this repo's one-task-per-commit
convention; confirm by checking it's not an ancestor of the stacked-on
PR's tip).

Classify the changed files and react accordingly -- most tasks are a mix:

- **Pure logic module** (e.g. `auto-work/*.ts` with no `app.get/post/...`
  calls) -- the dedicated `*.test.ts` next to it IS the test. Run it
  targeted first (`bun test apps/server/src/path/to/thing.test.ts`), then
  check the acceptance criteria in the task body against what the test file
  actually asserts (don't take "tests exist" as sufficient -- check they
  assert the specific acceptance bullets, e.g. "default used when
  sampleSize=0", "buffer actually multiplies, not silently 1.0").
- **New or changed route** (`routes-*.ts` gains an `app.get/post/put/patch/delete`) --
  grep the diff for the route path + method, then exercise it for real
  against a **scratch instance**, never the live `omp-deck.service` (see
  Notes):
  ```
  cd .worktrees/tNN-slug/apps/server
  OMP_DECK_PORT=8799 OMP_DECK_DB_PATH=/tmp/omp-deck-tNN-scratch/deck.db bun src/index.ts &
  curl -s http://127.0.0.1:8799/api/... | jq .
  kill %1; rm -rf /tmp/omp-deck-tNN-scratch
  ```
- **DB/migration change** (`db/*.ts`, `migrations/*.sql`) -- the scratch
  instance boot above is also what proves the migration applies cleanly
  (server crashes on boot if a migration is broken); plus that module's
  `*.test.ts`.
- **Web change** (`apps/web/src/**`) -- needs `bun run --filter
  '@omp-deck/web' build` in the worktree, then the same scratch instance
  with the `browser` tool pointed at `http://127.0.0.1:8799`, per the
  pattern already used for T-55 (see `.ai/devel.md`).

Always finish with the two regression checks regardless of category:
- `bun test` in `apps/server` (and `apps/web` if web files changed) -- full
  suite, not just the targeted files, since Auto Work tasks share
  `auto_work_config`/`auto_work_runs` fixtures across tickets.
- `bun run typecheck` from the repo root (covers all 4 workspaces; catches
  a `packages/protocol` type change that a single workspace's own
  typecheck would miss).

Report pass/fail counts, not just "tests ran".

## Step 3 -- Resolve a stacked-branch conflict, if any

Only when `mergeStateStatus` is `DIRTY`/`CONFLICTING` (Step 1). The fix is
the same regardless of which upstream branch got squash-merged:

```
scripts/rebase-stacked-pr.sh <PR-number>
```

(from this skill's directory -- see the script's header comment for the
full reasoning: it walks this branch's own commit log from the tip and
finds the newest commit whose subject line already exists on
`origin/<base>` -- either verbatim, or as the "<subject> (#N)" form
GitHub's squash merge produces for a single-commit PR -- then replays
only what comes after that boundary. Comparing real git history to real
git history this way is what stays correct no matter how many upstream
branches have squash-merged; do NOT reintroduce a check against `gh pr
list`'s *title* field, which can (and did, for real, on T-66's rebase)
differ from the actual commit subject and silently pick the wrong,
too-far-back boundary.) Run it without `--push` first.

After it returns:
1. Re-run Step 2's test plan against the rebased branch -- the rebase can
   introduce a genuine content conflict if this task's own commit and the
   new base touch the same lines (rare, but resolve by hand if `git
   rebase` stops and reports one -- don't blindly `--skip`).
   **This happened for real on T-63**: git auto-merged everything except
   two raw SQL strings in `db/auto-work.ts`, and resolving those needed
   understanding *why* they differed (an already-merged ancestor had
   refactored two `INTEGER` columns into one `TEXT` JSON column; this
   task's stale copy still assumed the old shape) -- not just picking a
   side. Read both versions, understand the current (post-merge) shape
   from the surrounding *unconflicted* code in the same file, and graft
   this task's own new columns onto that current shape.
2. Check for a duplicate-numbered migration file (`ls
   apps/server/src/db/migrations/ | sort -V` -- if the rebase leaves two
   files with the same numeric prefix, e.g. `012-*.sql` twice, `git mv` this
   task's own migration to the next free number and fix the `-- NNN-name.sql`
   comment on its first line; it'll still apply correctly either way since
   migrations are independent ALTERs, but a duplicate prefix is a real
   hygiene bug worth fixing while you're already in this file).
3. `gh pr view <PR> --json mergeStateStatus,mergeable` -- confirm it now
   reads `CLEAN`/`MERGEABLE`.
4. **Do not push yet.** Force-pushing a branch is a GitHub write op --
   surface the diff/test summary to the user and get explicit go-ahead in
   this same reply before running
   `scripts/rebase-stacked-pr.sh <PR-number> --push` (or a plain `git push
   --force-with-lease origin <branch>` if you already rebased manually).

## Step 4 -- Check the cascade

Rebasing branch N's tip changes its SHA. The PR stacked directly on top of
it (base = branch N) will go `DIRTY` the moment N is force-pushed, even if
it was `CLEAN` a minute ago -- same root cause, one branch further down.

After the user approves the push for the target PR:
1. `gh pr list --state open --json number,headRefName,baseRefName --jq
   'map(select(.baseRefName == "<branch-N>"))'` -- find the PR(s) stacked
   directly on top.
2. If one exists, tell the user it's about to go conflicting (or already
   has) and offer to run the same Step 3 recipe for it too, one
   confirmation covering the whole remaining chain rather than asking
   per-branch -- most sessions want the full remaining stack fixed in one
   pass since it's all the same solo Auto Work sequence.
3. Repeat Steps 2-4 for each PR down the chain the user opts into.

## Notes / gotchas

- **Never restart or point tests at `omp-deck.service`** -- per
  `.ai/devel.md`, that live systemd process serves whatever chat session
  is doing this review. Always use an isolated worktree + scratch
  `OMP_DECK_PORT`/`OMP_DECK_DB_PATH` pair, killed and `rm -rf`'d afterward.
- Work inside the task's own worktree (`.worktrees/tNN-slug`), never the
  repo-root checkout -- the root checkout may be mid-flight on unrelated
  work (see `.ai/devel.md`'s "gotcha" entries for precedent).
- `git push --force-with-lease`, never bare `--force` -- this repo has
  multiple agents/sessions touching sibling worktrees; lease fails loudly
  instead of clobbering someone else's push.
- If the rebase script can't find a boundary commit, or the worktree's
  branch lags behind `origin` (another session pushed to it since this
  worktree was set up), `git fetch origin <headRefName>` first, then
  re-run.
- **A branch's own new tests can carry a stale field name from *any*
  earlier ancestor's rename, not just the immediately-preceding one.**
  Concretely: T-64 renamed `getSubscriptionUsage`'s result field
  `pctUsed` → `weeklyPct`. T-65, T-66, and T-67 were each branched
  *before* that rename existed, so every one of them needed the exact
  same fixup applied to their own new test cases when rebased, not just
  the branch immediately after T-64. After a clean rebase, `grep` the
  branch's own diff for field/type names touched by earlier fixes in
  this same session before assuming a passing `bun run typecheck` (which
  only catches type-level drift, not a same-shaped-but-wrong-value mock)
  means nothing is stale.
- **Migration numbering keeps shifting as the stack merges.** Each Auto
  Work task in this stack adds its own migration file, so the "next free
  number" when a branch was created is frequently already taken by the
  time it's rebased (seen on 4 of 5 rebases in a single session: T-63,
  T-64, T-66, T-67 each collided and needed renumbering by 1-2). Always
  re-check `ls apps/server/src/db/migrations | sort -V` after every
  rebase, not just once.
- `bun run typecheck` failing on files this task's own commit **didn't
  touch** (check with `git diff --stat origin/main...<branch>`, Step 2) is
  a pre-existing bug already on `origin/main`, not something to fix as
  part of this task -- confirm by checking out a clean `origin/main` and
  running `bun run typecheck` there before assuming the rebase caused it.
  Report it to the user as a separate finding; don't silently absorb an
  unrelated fix into this task's commit.
- This skill covers **testing + conflict resolution only**. Moving the
  task to `validate`, merging the PR, and updating `.ai/devel.md` are
  separate, already-covered steps (see `kb://rules/control-file.md`,
  `kb://rules/github-access.md`) -- do them as normal once this skill's
  checks are green, not as part of this playbook.
