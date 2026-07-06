#!/usr/bin/env bash
# Rebase a stacked Auto Work branch cleanly onto the current tip of its
# (possibly auto-retargeted) base, after one or more upstream branches in
# the stack were squash-merged and deleted.
#
# Why this isn't `git rebase origin/<base>` or `git rebase --onto origin/<base>
# $(gh pr view <pr> --json commits -q '.commits[0].oid')^`: this branch's
# local history still contains the *original, non-squashed* commits of
# every ancestor task, going back to wherever this worktree was first
# branched. `gh pr view --json commits` reports ALL of those as "part of
# this PR" the moment even one of them is no longer a literal ancestor of
# the base (which is exactly what a squash merge does to EVERY ancestor,
# not just the immediately-preceding one) -- so using it verbatim replays
# already-merged tasks and conflicts against their own squash commits.
#
# Earlier version of this script matched the branch's own commit subjects
# against the pool of already-merged PRs' *titles* (`gh pr list --json
# title`). That is UNRELIABLE: a PR's title field can differ from its
# commit's actual subject line (seen for real on T-65 -- PR title "session
# continuation for mid-run tasks" vs commit subject "resume interrupted
# sessions on engine startup"), silently walking the boundary one ancestor
# too far back and re-conflicting an already-fixed commit.
#
# The reliable signal: when GitHub squash-merges a single-commit PR, the
# resulting commit on the base branch defaults to that commit's own
# original subject line with " (#<PR>)" appended -- not the PR title. So
# the boundary is: the newest commit in this branch's own history whose
# subject is either an exact match, or an exact-prefix-of-"<subject> (#"
# match, against some commit subject that already exists on origin/<base>.
# This compares real git history to real git history, with no GitHub API
# field (title, truncated GraphQL headline, etc.) in between.
#
# Usage:
#   rebase-stacked-pr.sh <pr-number> [--push]
#
# Run from anywhere inside the git worktree that has this PR's branch
# checked out (each Auto Work task has its own worktree at
# .worktrees/tNN-slug). Requires `gh`.
#
# --push force-pushes with --force-with-lease after a successful rebase.
# Without it, the script stops after rebasing so you can re-run tests and
# get explicit go-ahead before touching origin (force-push is a GitHub
# write op -- see kb://rules/github-access.md).
#
# IMPORTANT: a clean rebase here is necessary but not sufficient. Git's
# line-based merge can auto-resolve a hunk by picking one side even when
# the two sides represent genuinely incompatible schemas/shapes (seen in
# practice: an already-merged ancestor had refactored a DB column from two
# INTEGER fields to one JSON TEXT field; this branch's own commit still
# added columns assuming the old two-INTEGER shape). Always re-run this
# task's full test plan (Step 2 of SKILL.md) after this script, not just
# `git rebase`'s own conflict detection -- and skim any file the rebase
# touched that this task's own commit didn't originally add, since a silent
# semantic mismatch won't show up as a conflict marker at all. Also watch
# for a duplicate-numbered migration file after the rebase (`ls
# apps/server/src/db/migrations | sort -V`) -- this stack's tasks each add
# one, and the next free number keeps shifting as earlier tasks merge.
set -euo pipefail

pr="${1:?usage: rebase-stacked-pr.sh <pr-number> [--push]}"
push_flag="${2:-}"

info=$(gh pr view "$pr" --json baseRefName,headRefName,mergeStateStatus,mergeable)
base=$(jq -r '.baseRefName' <<<"$info")
head=$(jq -r '.headRefName' <<<"$info")
status=$(jq -r '.mergeStateStatus' <<<"$info")
mergeable=$(jq -r '.mergeable' <<<"$info")

echo "PR #$pr: $head -> $base (mergeStateStatus=$status, mergeable=$mergeable)"

git fetch origin "$base" "$head"

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "$head" ]; then
	echo "error: expected '$head' checked out in this worktree, found '$current_branch'." >&2
	echo "cd into the worktree for this PR's branch first." >&2
	exit 1
fi

base_subjects=$(git log --format='%s' "origin/$base")

boundary=""
while IFS=$'\t' read -r sha subj; do
	if grep -qxF -- "$subj" <<<"$base_subjects" || grep -qF -- "$subj (#" <<<"$base_subjects"; then
		boundary="$sha"
		break
	fi
done < <(git log --format='%H%x09%s' "$head")

if [ -z "$boundary" ]; then
	echo "error: no commit in '$head' matched a commit subject already on origin/$base." >&2
	echo "Either nothing upstream of this branch has merged yet (nothing to fix)," >&2
	echo "or this is genuinely the first PR in the stack -- check by hand:" >&2
	echo "  git log --oneline $head | head -20" >&2
	echo "  git log --oneline origin/$base | head -20" >&2
	exit 1
fi

echo "Boundary commit (last already-merged ancestor found in $head's history):"
git log -1 --format='  %H %s' "$boundary"
echo "Replaying everything after it onto origin/$base..."

git rebase --onto "origin/$base" "$boundary" "$head"

echo "Rebase complete. Re-run this task's FULL test plan before pushing --"
echo "a clean rebase does not rule out a silent schema/shape mismatch, or a"
echo "duplicate-numbered migration file (see this script's header comment)."

if [ "$push_flag" = "--push" ]; then
	echo "Pushing with --force-with-lease..."
	git push --force-with-lease origin "$head"
	gh pr view "$pr" --json mergeStateStatus,mergeable
else
	echo "Not pushed (pass --push once tests are green and the user has confirmed)."
fi
