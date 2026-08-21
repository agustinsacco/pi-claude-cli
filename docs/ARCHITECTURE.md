# Architecture

How this extension turns the Claude Code CLI into a pi model provider, what
crosses the boundary in each direction, and why each non-obvious decision is
the way it is.

## The inversion

pi normally streams from a provider API. This extension implements pi's
`streamSimple` contract by spawning a **fresh `claude -p` subprocess per LLM
turn** and translating its stdout back into pi's stream events. Claude Code
is demoted from "agent" to "model server": it contributes model access, the
user's Pro/Max entitlement and prompt caching, while **pi keeps the agent
loop, the tools, the session file, compaction, forks and everything a
front-end sees**.

Registration happens twice in `index.ts`, because pi 0.84 has two dispatch
paths:

- `pi.registerProvider()` — feeds pi's provider composer.
- `registerApiProvider()` from `@earendil-works/pi-ai/compat` — feeds pi-ai's
  global api registry, which pi's default stream fn resolves through. Print
  mode and nested agent loops take that path; without this they throw
  `No API provider registered for api: pi-claude-cli`.

The model list is pi's own Anthropic catalogue re-parented under the
`pi-claude-cli` provider id, with `thinkingLevelMap` widened so the full
effort range (through `max`) is selectable.

## One turn on the wire

```
pi agent loop
  └─ streamSimple(model, context, options)
       ├─ prompt-builder  → flattened history (first turn) or delta (resume)
       ├─ process-manager → spawn claude -p --output-format stream-json …
       ├─ stream-parser   → NDJSON lines (never throws)
       ├─ event-bridge    → pi stream events (text/thinking/toolcall deltas)
       ├─ control-handler → answers can_use_tool permission requests
       └─ break-early     → SIGKILL before the CLI executes pi-owned tools
```

### Prompt in

`claude -p` accepts one user message, not a structured history, so
`prompt-builder.ts` flattens pi's `Context.messages` into a labeled
transcript (`USER:` / `ASSISTANT:` / `TOOL RESULT (historical <tool>):`).
Images in the **final** user message are translated from pi-ai's
`{data, mimeType}` shape to Anthropic's `{source:{type:"base64",…}}` blocks;
images earlier in history degrade to placeholder text. pi's system prompt
rides in through `--append-system-prompt` (written to a temp file to avoid
Windows `ENAMETOOLONG`).

### Spawn

```
claude -p --input-format stream-json --output-format stream-json
       --verbose --include-partial-messages
       --model <id> --permission-prompt-tool stdio
       (--session-id <pi session id> | --resume <pi session id>)
       [--effort <level>] [--mcp-config <tmp>]
       [--strict-mcp-config --setting-sources ""]   # hermetic mode
```

stdin stays **open** after the user message: the CLI sends permission
requests on stdout and expects answers on stdin mid-episode.

### Stream out

stdout is NDJSON. Five envelope types matter:

| Envelope          | Handling                                                   |
| ----------------- | ---------------------------------------------------------- |
| `stream_event`    | Raw Anthropic SSE — bridged 1:1 into pi stream events      |
| `assistant`       | Complete-block echo — used for CLI-side tool markers       |
| `user`            | Tool results the CLI feeds itself between cycles — ignored |
| `control_request` | Permission prompt — answered on stdin                      |
| `result`          | Episode end: authoritative usage, final answer, errors     |

Two filters keep Claude Code's inner life out of pi's transcript: envelopes
with `parent_tool_use_id` set (the CLI's own sub-agents) are dropped, and
`tool_use` blocks for tools pi cannot execute are skipped by
`isPiKnownClaudeTool`.

## Episodes, not messages

**The single most important thing to understand.** One subprocess run is a
full agentic _episode_: N API calls ("cycles") with CLI-side tool
executions between them. SSE `content_block` indexes **reset every cycle**.

`event-bridge.ts` therefore keys tracked blocks by `(cycle, index)`. A
cycle counter increments on each top-level `message_start`; the previous
cycle's usage is banked at that moment, so per-cycle numbers accumulate
instead of overwriting. The final `result` envelope carries authoritative
cumulative usage and replaces the running sum when present. The **last**
cycle's `stop_reason` is the episode's stop reason.

Before this was understood, later-cycle content folded into earlier blocks,
usage reported roughly one cycle, and the final answer could be lost.

## Tools: the three-way split

**Built-ins** are pure renaming (`tool-mapping.ts` is the single source of
truth): `Read→read` (`file_path→path`), `Write→write`, `Edit→edit`
(`old_string→oldText`, `new_string→newText`), `Bash→bash`, `Grep→grep`
(`head_limit→limit`), `Glob→find`. Claude proposes them under its names; pi
executes under its own.

**Custom pi tools** (anything a pi extension registered — a front-end's
artifact tools, MCP-adapter tools) cannot be renamed into Claude's
vocabulary, so they are advertised over MCP: `mcp-config.ts` writes every
non-built-in tool's schema to a temp file and points `--mcp-config` at
`mcp-schema-server.cjs`, an MCP server that serves **schemas only and can
execute nothing**. Claude emits `mcp__custom-tools__<name>`; the bridge
strips the prefix; pi executes the real tool.

**Everything else** — WebSearch, WebFetch, ToolSearch, `Task` sub-agents,
the user's own MCP servers — is executed **by the CLI itself**, mid-episode.
These are surfaced as one-line marker text blocks so transcripts show what
happened:

```
[Claude Code · WebSearch {"query":"news headline today 2026"}]
```

### The marker is a wire contract

Front-ends parse the marker string, so its shape is API:

```
[Claude Code · <ToolName>]              # no arguments
[Claude Code · <ToolName> <argsJson>]   # preview, truncated at ~120 chars
```

pidex renders matches as activity rows and anything else as markdown prose,
so a format change that looks cosmetic here degrades rendering there. The
argument preview is deliberately opaque: truncation makes it invalid JSON
often enough that consumers must treat it as a display string.

### Not yet surfaced (extension seams)

Two things the CLI reports that this bridge deliberately drops. Both are the
natural starting points if a front-end ever wants richer Claude-Code-side UX:

- **Results of CLI-side tools.** The `user` envelopes between cycles carry
  `tool_result` blocks for tools the CLI executed itself. `provider.ts`
  ignores them, so markers show _what was invoked_ but never what came back.
  Surfacing them means pairing each result with its `tool_use_id`.
- **Sub-agent activity.** Everything with `parent_tool_use_id` set (the
  CLI's own `Task` agents) is filtered out in both `provider.ts` and
  `handleAssistantEnvelope`. Those events carry a full nested episode; a
  front-end that wanted a sub-agent tree would consume them there.

### Enforcement is belt-and-suspenders

The belt is `control-handler.ts`: custom-tools requests get
`{behavior:"deny"}` (so pi runs them), everything else `allow`. The
suspenders are **break-early** in `provider.ts`: at the first top-level
`message_stop` after any pi-executable `tool_use`, the subprocess is
SIGKILLed before Claude Code's executor can act. A `broken` flag is set
_before_ closing the reader so buffered lines cannot slip through.

## Session model: two ledgers

pi's session JSONL is the **only** authoritative record. The CLI session is
a disposable cache keyed by pi's session id.

- First provider turn: `--session-id <pi id>` creates the CLI session.
- Later turns: `--resume <pi id>` plus a **delta** prompt (only tool results
  since the last assistant turn, plus new user text) — this is also what
  keeps Anthropic's prompt cache warm.
- Resume is only attempted when the conversation already contains an
  assistant turn from this provider (`hasPriorCliTurn`).
- **Resume miss** (forks copy history into a _new_ pi session id, so the
  heuristic says resume while the CLI cache is keyed to the old id): the
  attempt aborts without touching pi's stream and the driver retries once
  with a full-history replay under `--session-id`, which re-registers the
  cache. Subsequent turns resume normally.

Switching models mid-session, forking, or losing the CLI cache therefore
costs one full replay — never a lost turn.

## Errors and recovery

- Any `result` with a non-success subtype, `is_error`, or an error field
  ends pi's stream as an error (never a silent empty message).
- **Context overflow** is rewritten by a provider-scoped `message_end`
  handler (`overflow.ts`) to the `context_length_exceeded:` prefix pi's
  auto-compaction recognizes — so pi compacts and retries instead of
  failing. The matcher is deliberately narrow (Anthropic's two overflow
  phrasings) and never touches rate limits, which must stay on pi's
  retry/backoff path.
- An inactivity timer (default 300s, `PI_CLAUDE_CLI_TIMEOUT_MS`) kills hung
  subprocesses. It is generous because CLI-side tools are legitimately
  silent on stdout for minutes.
- pi's abort signal SIGKILLs mid-stream; a process registry cleans up
  orphans at exit.

## Usage and cost

Usage comes from `message_start` / `message_delta` per cycle and the
`result` envelope for the episode total, then runs through pi's own
`calculateCost`. **Token counts are real; the dollar figure is notional** —
it is computed at API list prices while the user is actually spending plan
quota.

## Environment bleed

Unless hermetic mode is on, the subprocess runs in the user's full Claude
Code environment: personal/project MCP servers load and execute CLI-side,
hooks fire, project CLAUDE.md and memory are injected by the CLI, and skills
can load twice (natively via claude, and again via pi's own
`~/.claude/skills` support). `PI_CLAUDE_CLI_HERMETIC=1` adds
`--strict-mcp-config` and an empty `--setting-sources` to shut all of that
off; the schema-only custom-tools server and the subscription login are
unaffected.

## Compatibility notes

The CLI's control protocol changed between major lines. Claude Code **2.x**
expects `request_id` **inside** `response`, and allow decisions carry
`updatedInput`:

```jsonc
{ "type": "control_response",
  "response": { "subtype": "success", "request_id": "…",
                "response": { "behavior": "allow", "updatedInput": { … } } } }
```

The 1.x shape (`request_id` at the top level) is **silently ignored** by
2.1.x: the CLI keeps waiting, the episode stalls until the inactivity timer
fires, and the turn looks truncated. This was the root cause behind every
"web search / MCP turn returns only the preamble" report.

## Version history of behavioral fixes

| Version | Change                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0.4.0   | Port to `@earendil-works` pi 0.84; api-registry registration; scoped release                                                        |
| 0.4.1   | 2.x control protocol; cycle-aware bridge (ordering, cumulative usage, final-answer safety net); CLI-side tool markers; 300s timeout |
| 0.4.2   | Resume-miss → one full-replay retry (fixes forked sessions)                                                                         |
| 0.4.3   | Overflow → `context_length_exceeded` rewrite (pi auto-compaction); hermetic mode                                                    |

## Testing

- `npm test` — unit suites with mocked `cross-spawn`; includes
  `tests/fixtures/multi-cycle-episode.jsonl`, a **real captured 3-cycle
  episode** (claude 2.1.237) used to assert ordering, markers, and both
  usage modes.
- `npm run test:e2e` — full pipeline through a real `pi` binary against a
  deterministic CLI stub (`tests/e2e/claude-stub.cjs`); no credentials.
- CI runs both on three OSes plus a weekly canary against `pi@latest`.
- Live smokes that cannot be automated (they spend plan quota) are listed in
  the issue threads: fresh turn, `-c` resume, `--fork`, a CLI-side tool
  turn, and a break-early write round-trip.
