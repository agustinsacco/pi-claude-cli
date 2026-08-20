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

OUT="$(cd "$WORK_DIR" && PATH="$STUB_DIR:$PATH" timeout 120 \
  pi -e "$EXT_DIR" -p --model "pi-claude-cli/claude-haiku-4-5" "magic word")"

echo "--- pi output ---"
echo "$OUT"
echo "-----------------"

if ! grep -q "PORT-OK" <<<"$OUT"; then
  echo "e2e FAILED: expected PORT-OK in output" >&2
  exit 1
fi
echo "e2e OK"
