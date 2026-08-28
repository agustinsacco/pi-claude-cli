#!/usr/bin/env bash
# End-to-end smoke through a real `pi` binary using the deterministic Claude
# CLI stub — no credentials or network model calls needed.
#
# Exercises: extension load, provider + api-registry registration (the print
# mode path from rchern/pi-claude-cli#32), subprocess spawn, stream-json
# NDJSON parsing, and the event bridge.
#
# Requires `pi` on PATH (npm i -g @earendil-works/pi-coding-agent).
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

STUB_DIR="$(mktemp -d)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR" "$WORK_DIR"' EXIT

cp "$EXT_DIR/tests/e2e/claude-stub.cjs" "$STUB_DIR/claude"
chmod +x "$STUB_DIR/claude"

echo "pi version: $(pi --version 2>/dev/null || true)"

# macOS has neither `timeout` nor `gtimeout` unless coreutils is installed, so
# the guard is best-effort: CI (Linux) gets the watchdog, a local run just runs.
# `${TIMEOUT[@]+...}` because bash 3.2 (macOS) treats an empty array as unbound
# under `set -u`.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout 120)
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=(gtimeout 120)
else
  TIMEOUT=()
fi
# `-ne` is load-bearing, not tidiness: a developer whose pi settings already
# list `npm:@saccolabs/pi-claude-cli` gets the INSTALLED copy discovered
# alongside `-e`, and the published provider wins the name. The suite then
# silently tests the release instead of the working tree — which is how a
# green run reported the exact bug it was written to catch.
run_pi() {
  # `</dev/null` because print mode still reads stdin: inherit a pipe that
  # never closes (a CI runner, an agent shell) and pi waits on EOF forever.
  cd "$WORK_DIR" && PATH="$STUB_DIR:$PATH" ${TIMEOUT[@]+"${TIMEOUT[@]}"} \
    pi -ne -e "$EXT_DIR" -p --model "pi-claude-cli/claude-haiku-4-5" "$1" \
    </dev/null
}

OUT="$(run_pi "magic word")"

echo "--- pi output ---"
echo "$OUT"
echo "-----------------"

if ! grep -q "PORT-OK" <<<"$OUT"; then
  echo "e2e FAILED: expected PORT-OK in output" >&2
  exit 1
fi

# Background sub-agents must survive the turn's first `result`. The stub emits
# one there and only reports the agent afterwards, so a provider that kills on
# it prints LAUNCHED-WAITING and nothing else.
FAN="$(run_pi "fanout")"

echo "--- fan-out output ---"
echo "$FAN"
echo "----------------------"

if ! grep -q "AGENT-REPORT" <<<"$FAN"; then
  echo "e2e FAILED: sub-agent never reported back (killed on the first result)" >&2
  exit 1
fi
if ! grep -q "Dig into the thing" <<<"$FAN"; then
  echo "e2e FAILED: expected a sub-agent lifecycle marker" >&2
  exit 1
fi
if grep -q "Search for a local checkout" <<<"$FAN"; then
  echo "e2e FAILED: an auto-backgrounded Bash was reported as a sub-agent" >&2
  exit 1
fi
echo "e2e OK"
