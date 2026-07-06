#!/usr/bin/env bash
# Project helper for an isolated, throwaway omp-deck instance from a worktree.
#
# Spins up an isolated, throwaway omp-deck instance from a worktree under
# .worktrees/, so you can click around a branch without touching the main
# checkout or the live omp-deck.service (which backs whatever chat session
# is currently open against this repo).
#
# Usage:
#   scripts/test-worktree.sh <worktree-name-or-path> [port]
#
# Examples:
#   scripts/test-worktree.sh t51-ctrl-enter
#   scripts/test-worktree.sh t51-ctrl-enter 8801
#   scripts/test-worktree.sh .worktrees/t51-ctrl-enter
#
# Flags:
#   --no-build     skip the web build (reuse whatever apps/web/dist already exists)
#   --no-install   skip `bun install` even if node_modules is missing
#   --keep-db      don't wipe the scratch sqlite db from a previous run of this worktree

set -euo pipefail

usage() {
  grep '^#' "$0" | sed '1d;s/^# \{0,1\}//'
  exit 1
}

NO_BUILD=0
NO_INSTALL=0
KEEP_DB=0
POSITIONAL=()

for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --keep-db) KEEP_DB=1 ;;
    -h|--help) usage ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

[ "${#POSITIONAL[@]}" -ge 1 ] || usage

TARGET="${POSITIONAL[0]}"
PORT="${POSITIONAL[1]:-}"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || { echo "error: not inside a git repo" >&2; exit 1; }

# Resolve worktree path: bare name -> .worktrees/<name>, otherwise use as-is.
if [[ "$TARGET" == */* || "$TARGET" == /* ]]; then
  WT_PATH="$TARGET"
else
  WT_PATH="$REPO_ROOT/.worktrees/$TARGET"
fi
[ -d "$WT_PATH" ] || { echo "error: not a directory: $WT_PATH" >&2; exit 1; }
[ -f "$WT_PATH/.git" ] || { echo "error: $WT_PATH doesn't look like a git worktree (no .git file)" >&2; exit 1; }

# Absolutize. A relative $TARGET (the script's own `.worktrees/<name>` usage
# example is one) would otherwise stay relative past the `cd "$WT_PATH"`
# below, so the later `OMP_DECK_WEB_DIST="$WT_PATH/apps/web/dist"` export
# resolves against the *post-cd* cwd instead of the original one -- a
# doubled, nonexistent path. resolveWebDist() then falls through its
# cwd-relative fallbacks and walks two directories up from inside the
# worktree, straight into the root checkout's apps/web/dist -- serving the
# wrong build with no error.
WT_PATH="$(cd "$WT_PATH" && pwd)"

WT_NAME="$(basename "$WT_PATH")"
BRANCH="$(git -C "$WT_PATH" rev-parse --abbrev-ref HEAD)"

# Pick a free port starting at 8799 (the primary deck instance owns 8787).
if [ -z "$PORT" ]; then
  PORT=8799
  while ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${PORT}\$"; do
    PORT=$((PORT + 1))
  done
fi

DATA_DIR="/tmp/omp-deck-worktree-scratch/$WT_NAME"
DB_PATH="$DATA_DIR/deck.db"
mkdir -p "$DATA_DIR"
if [ "$KEEP_DB" -eq 0 ]; then
  rm -f "$DB_PATH" "$DB_PATH-shm" "$DB_PATH-wal"
fi

echo "worktree : $WT_PATH ($BRANCH)"
echo "port     : $PORT"
echo "db       : $DB_PATH"
echo

if [ "$NO_INSTALL" -eq 0 ] && [ ! -d "$WT_PATH/node_modules" ]; then
  echo "==> bun install"
  ( cd "$WT_PATH" && bun install )
fi

if [ "$NO_BUILD" -eq 0 ]; then
  echo "==> building web"
  ( cd "$WT_PATH" && bun run --filter '@omp-deck/web' build )
fi

echo
echo "==> starting server on http://localhost:$PORT (Ctrl+C to stop)"
# resolveWebDist() (apps/server/src/config.ts) walks up from process.cwd()
# assuming a `cd apps/server && bun src/index.ts`-style launch. Pin it
# explicitly so it always serves *this* worktree's dist, never whatever
# happens to sit two directories up (e.g. the root checkout's build).
cd "$WT_PATH"
exec env OMP_DECK_PORT="$PORT" OMP_DECK_DB_PATH="$DB_PATH" OMP_DECK_WEB_DIST="$WT_PATH/apps/web/dist" bun apps/server/src/index.ts