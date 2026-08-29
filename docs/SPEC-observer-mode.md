# Observer mode — Claude Code as a first-class agent

**Status:** implementing · **Supersedes:** break-early (0.4.x), the never-resume
PR (#16, closed), and the interrupt/resident prototypes.
**Verified against:** Claude Code CLI 2.1.231, pi 0.84.1, 2026-08-25/26.

## The idea

Stop using Claude Code as a bare model and stripping the agent off it. For
sessions on this provider, **the CLI owns its loop, its tools, and its session**;
pi is the system of record and an _observer_ — it starts turns, streams what
happened into its own transcript, and renders it. Token use is native by
construction: real `--resume`, native caching, native compaction, turns that
complete instead of being killed.

Do not push pi's agenda onto the CLI. Where pi needs a say, use the CLI's own
extension points (hooks, MCP), not process surgery.

## Rules

1. **pi's session file stays the system of record.** The CLI session is the
   model's working memory; everything pi needs is taken from the observed
   stream, and losing every CLI session must never lose a conversation
   (reimport rebuilds one from pi history).
2. **Never kill a healthy turn.** The only mid-turn intervention is the CLI's
   own `interrupt` control request — identical to a human pressing Esc.
3. **Native tools run natively.** Read/Write/Edit/Bash/Grep/Glob and every
   CLI-side tool (WebSearch, Task, user MCP) execute inside the CLI.
4. **Guards move to CLI hooks.** Path guards (pidex `worktree-paths`) are
   PreToolUse hooks, passed via `--settings`. pi extensions no longer veto
   tool calls on this provider — that is the accepted trade.
5. **pi custom tools survive via handoff.** Tools registered by pi extensions
   (pidex orchestrator tools) are still advertised through the schema-only MCP
   server. When the model calls one, the provider interrupts cleanly at
   `message_stop`, hands the toolCall to pi's loop (all pi hooks fire for
   these), and the next turn resumes with the result.
6. **One CLI session per pi session,** resumed across turns and process
   restarts. The mapping lives in a provider-owned sidecar.

## Measured basis (why this design)

| turn shape                     | cache_write tokens                  |
| ------------------------------ | ----------------------------------- |
| full history replay (PR #16)   | ~10,000                             |
| old `--resume` + kill (0.4.7)  | ~1,000, and corrupts the transcript |
| **native resume, clean turns** | **60** (follow-up turn, measured)   |

Corruption root cause (decompiled 2.1.231): on `--resume`, a transcript ending
on a _user_ entry gets a synthetic `No response requested.` assistant spliced
in. The old design produced that tail every turn by SIGKILLing at
`message_stop`. Clean turns end on assistant entries → no splice. Verified:
multi-turn native sessions, steer-interrupt + resume, zero filler, guard hook
blocking with reason, tool_use/tool_result fully observable on the stream.

## Session model

Sidecar: `~/.pi/agent/pi-claude-cli/session-map.json` (override:
`PI_CLAUDE_CLI_STATE_DIR`), a flat `{ piSessionId: cliSessionId }` map.

Per turn, in order:

1. `cliId = map[piSessionId]`.
2. **Stale check:** if any assistant message _after_ the last `pi-claude-cli`
   assistant message came from another provider, the CLI session is behind
   pi's history → discard mapping, reimport.
3. **Resume** (`--resume <cliId>`): send only the delta — messages after the
   last assistant turn (new user text; handoff tool results as labeled text).
   The system prompt IS re-sent: the CLI does not keep `--system-prompt`
   across `--resume`, and a resumed session without it reverts to Claude
   Code's default prompt. It is replayed verbatim from the sidecar rather
   than rebuilt, because only byte-identical bytes keep the prefix cached.
4. **Create/import** (no mapping, resume-miss, or stale): mint a fresh UUID,
   `--session-id <uuid>`, send the full flattened history (`buildPrompt`) with
   the system prompt, store the mapping and the prompt. Resume-miss retries
   once through this path (existing driver, kept).

Fork, model switch, copied machines — all collapse into "no valid mapping →
reimport". One recovery path.

## Turn lifecycle

```
pi turn start ──► spawn `claude -p … --resume <cliId>` (stdin stream-json)
   model streams: text/thinking → pi stream (as today)
   built-in / CLI-side tool_use → CLI executes it natively
        → provider emits `[Claude Code · Name {args}]` marker (wire contract)
   custom (mcp__custom-tools__*) tool_use → handoff:
        at message_stop: send control_request{interrupt} (NOT kill)
        emit pi toolCall block; end stream stopReason=toolUse
        pi executes (pi hooks fire) → next turn resumes with result-as-text
   result envelope → done(stop), usage applied, process reaped
```

- **Interrupted-result handling:** after a self-issued interrupt, the CLI's
  `result` is `error_during_execution`. That is expected, not an error; the
  stream ends `toolUse` with the captured toolCalls.
- **Abort/steer:** send `interrupt`, grace 2s, then SIGKILL as backstop. The
  CLI writes its native interruption records; resume stays coherent (verified).
- **Timeouts, stderr surfacing, rate-limit passthrough:** unchanged.

## Stream contract changes (what pi/pidex sees)

- Built-in tools no longer arrive as pi `toolCall` blocks — they arrive as
  `[Claude Code · Name {args}]` markers, the same contract already used for
  WebSearch/Task. `stopReason: toolUse` occurs **only** for handoff tools.
- pi's transcript for a native turn is: markers + prose, one assistant message,
  no toolResult messages. Handoff turns look exactly like today's custom-tool
  turns.
- Front-end note (pidex): live tool cards for built-ins become activity rows.
  Tool _results_ are visible in the stream (`type:"user"` envelopes) and may be
  surfaced later; v1 does not forward them.

## Configuration

| knob                          | default  | meaning                                                                               |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `PI_CLAUDE_CLI_HERMETIC`      | off      | on: `--strict-mcp-config --setting-sources ""` — user's MCP/skills/CLAUDE.md stay out |
| `PI_CLAUDE_CLI_SETTINGS`      | unset    | path passed to `--settings` — where hosts inject PreToolUse guard hooks               |
| `PI_CLAUDE_CLI_SYSTEM_PROMPT` | `claude` | unchanged                                                                             |
| `PI_CLAUDE_CLI_TIMEOUT_MS`    | 300000   | unchanged                                                                             |

Non-hermetic default is deliberate: "use the subscription the way the CLI
uses it" includes the user's own MCP servers and skills. Hosts that need
isolation (pidex fleets) set hermetic + their own settings file.

## What is deleted

- Break-early SIGKILL for built-in tools, and `isPiKnownClaudeTool` as the
  break gate (replaced by `isHandoffClaudeTool` = custom prefix only).
- The claim that pi executes file tools on this provider.

## Known limits (accepted)

- pi extensions cannot veto/rewrite native tool calls; guards must be CLI
  hooks. Path guards port cleanly (verified); arbitrary rewriting does not.
- Hook settings paths must be **realpaths** (macOS `/var` → `/private/var`).
- One interruption record per handoff tool round — the same record a human
  Esc produces. Native turns produce none.
- `Task` sub-agents now actually work (no kill), but their internals stream
  with `parent_tool_use_id` and stay filtered — surfaced later.

## Test plan

Unit (mocked CLI): session-map load/save/corrupt; stale-detection; resume vs
import arg selection; delta building; handoff interrupt at message_stop (no
SIGKILL); interrupted-result → toolUse not error; markers for built-ins,
toolCalls only for handoff; abort sends interrupt then kill; settings flag
passthrough. Existing suites for parser/bridge/overflow/thinking unchanged.

Live (`scripts/e2e-live.sh`, spends tokens, not CI): multi-tool native task
completes; resume across pi restarts recalls prior turns with cache_write
< 1k; steer mid-turn; guard hook blocks an outside read; custom-tool handoff
round-trip; zero `No response requested` in the CLI session file.
