#!/usr/bin/env bash
# One-time per clone: point git at the committed hooks in .githooks/ so the
# pre-push compile gate runs. Safe to re-run.
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git -C "$ROOT" config core.hooksPath .githooks
chmod +x "$ROOT/.githooks/"* "$ROOT/scripts/"*.sh 2>/dev/null || true
echo "✅ hooks active (core.hooksPath=.githooks). Pre-push runs the FULL scripts/gates.sh on code pushes."
