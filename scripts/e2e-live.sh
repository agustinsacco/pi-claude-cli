#!/usr/bin/env bash
# Live observer-mode suite against the REAL Claude CLI. Spends tokens; not CI.
# Covers: native multi-tool turn, cheap resume of the same CLI session,
# custom-tool handoff round-trip, PreToolUse guard hook, abort/steer.
set -euo pipefail
cd "$(dirname "$0")/.."
PI_CLAUDE_CLI_LIVE=1 npx vitest run tests/live-observer.test.ts
