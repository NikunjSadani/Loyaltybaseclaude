#!/usr/bin/env bash
#
# Canonical gate runner for Loyaltybase. Runs the full test / build / type-check
# suites and exits NON-ZERO if any gate fails — using each command's REAL exit
# code, never a piped one.
#
# WHY THIS EXISTS: running a gate as `npx nest build | tail` reports the pipe's
# (tail's) exit code — always 0 — so a RED build looks green. On 2026-11-03 a
# `nest build` failure was masked exactly this way and nearly shipped. This
# script removes the exit-code handling from human/agent discretion: run it,
# read ITS exit code. (See CLAUDE.md gate #6.)
#
# Usage:
#   bash scripts/gates.sh          # full gates (api jest + api build + platform vitest + platform tsc)
#   bash scripts/gates.sh --fast   # compile gates only (api build + platform tsc) — the class a pipe can mask
#
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1
fail=0

run() { # run <name> <dir> <cmd...>
  local name="$1" dir="$2"; shift 2
  local log; log="$(mktemp)"
  printf '── %s ──\n' "$name"
  # Run the command DIRECTLY (output captured to a log, not piped) so $? is the
  # command's own exit code, not a pipeline tail's.
  ( cd "$ROOT/$dir" && "$@" ) > "$log" 2>&1
  local rc=$?
  tail -4 "$log"
  if [ "$rc" -ne 0 ]; then
    printf '❌ %s FAILED (exit %s) — full log: %s\n\n' "$name" "$rc" "$log"
    fail=1
  else
    printf '✅ %s\n\n' "$name"
    rm -f "$log"
  fi
}

[ "$FAST" -eq 0 ] && run "api jest"        api      npx jest --no-coverage
run                      "api build"       api      npx nest build
[ "$FAST" -eq 0 ] && run "platform vitest" platform npx vitest run
run                      "platform tsc"    platform npx tsc --noEmit

if [ "$fail" -ne 0 ]; then
  echo "GATES: ❌ FAILED — do NOT push."
  exit 1
fi
echo "GATES: ✅ all passed."
exit 0
