#!/usr/bin/env bash
# Live end-to-end check against the REAL Claude Code CLI.
#
# Unlike scripts/e2e-stub.sh this spends real model tokens, so it is not part of
# `npm test` or CI. It exists because the bug this provider had could only be
# seen across several real tool iterations: with `--resume`, the CLI splices a
# synthetic `No response requested.` assistant turn into the replayed
# transcript, and the model eventually imitates it and ends the session.
#
# Usage:  bash scripts/e2e-live.sh [model]
# Requires: `pi` and `claude` on PATH, and an authenticated Claude CLI.
set -euo pipefail

MODEL="${1:-claude-haiku-4-5}"
EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Three files so the task genuinely needs several tool iterations.
printf 'alpha word is TANGERINE\n' >"$WORK_DIR/one.txt"
printf 'beta word is CORDUROY\n' >"$WORK_DIR/two.txt"
printf 'gamma word is PARAPET\n' >"$WORK_DIR/three.txt"

SESSION_ROOT="$HOME/.pi/agent/sessions"
BEFORE_SESSIONS="$(find "$SESSION_ROOT" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
CLI_ROOT="$HOME/.claude/projects"
BEFORE_CLI="$(find "$CLI_ROOT" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"

echo "pi:     $(pi --version 2>/dev/null || echo '?')"
echo "claude: $(claude --version 2>/dev/null || echo '?')"
echo "model:  $MODEL"
echo "work:   $WORK_DIR"
echo

TASK='Read one.txt, then two.txt, then three.txt in the current directory, one at a time using the read tool. Then reply with exactly the three words in order, separated by single spaces, and nothing else.'

set +e
# -ne is essential: without it pi also loads the PUBLISHED @saccolabs/pi-claude-cli
# from ~/.pi/agent/settings.json, which registers the same provider id and can
# win, so the run would silently test the installed version instead of this tree.
OUT="$(cd "$WORK_DIR" && pi -ne -e "$EXT_DIR" -p --model "pi-claude-cli/$MODEL" "$TASK" 2>&1)"
STATUS=$?
set -e

echo "--- pi output ---"
echo "$OUT"
echo "-----------------"
echo "exit status: $STATUS"
echo

FAIL=0

# 1. The three words prove the tool loop actually ran to completion.
for word in TANGERINE CORDUROY PARAPET; do
  if grep -q "$word" <<<"$OUT"; then
    echo "PASS: found $word"
  else
    echo "FAIL: missing $word — the tool loop did not complete"
    FAIL=1
  fi
done

# 2. The filler must never appear in pi's transcript.
if grep -qi "No response requested" <<<"$OUT"; then
  echo "FAIL: the synthetic filler leaked into pi output"
  FAIL=1
else
  echo "PASS: no 'No response requested.' in pi output"
fi

# 3. Inspect the pi session file this run produced.
NEWEST_SESSION="$(find "$SESSION_ROOT" -name '*.jsonl' -newer "$WORK_DIR/one.txt" 2>/dev/null | head -1)"
if [ -n "$NEWEST_SESSION" ]; then
  echo
  echo "pi session: $NEWEST_SESSION"
  FILLER="$(grep -c "No response requested" "$NEWEST_SESSION" 2>/dev/null || true)"
  TOOLCALLS="$(grep -o '"type":"toolCall"' "$NEWEST_SESSION" 2>/dev/null | wc -l | tr -d ' ')"
  echo "  assistant turns containing the filler: $FILLER"
  echo "  tool calls recorded:                   $TOOLCALLS"
  if [ "${FILLER:-0}" -ne 0 ]; then
    echo "FAIL: filler present in pi's session file"
    FAIL=1
  else
    echo "PASS: pi's session file is clean"
  fi
  if [ "${TOOLCALLS:-0}" -lt 3 ]; then
    echo "FAIL: expected at least 3 tool calls, got $TOOLCALLS"
    FAIL=1
  fi
fi

# 4. Report CLI scratch-session growth (informational — one per turn is expected
#    now that every spawn creates a fresh session).
AFTER_CLI="$(find "$CLI_ROOT" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
echo
echo "CLI scratch sessions created this run: $((AFTER_CLI - BEFORE_CLI)) (informational)"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "LIVE E2E OK"
else
  echo "LIVE E2E FAILED"
  exit 1
fi
