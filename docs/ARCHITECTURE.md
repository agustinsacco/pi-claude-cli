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
       ├─ session-map     → resume the pi session's CLI session, or import
       ├─ prompt-builder  → delta (resume) or flattened history (import)
       ├─ process-manager → spawn claude -p --output-format stream-json …
       ├─ stream-parser   → NDJSON lines (never throws)
       ├─ event-bridge    → pi stream events; CLI-executed tools as markers,
       │                    HANDOFF (custom pi) tools as toolCall blocks
       ├─ control-handler → answers can_use_tool permission requests
       └─ handoff         → clean `interrupt` at message_stop so pi executes
                            custom tools; the CLI is never SIGKILLed mid-turn
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

### Billed usage and context are different numbers (0.4.10)

`usage.input/output/cacheRead/cacheWrite` are **cumulative across cycles** —
that is what the account is charged for. `usage.totalTokens` is **not their
sum**: it carries the _last_ cycle's prompt size
(`input + cache_read + cache_creation`), because that is the only figure that
describes the conversation the model is actually holding.

The distinction is load-bearing, not cosmetic. pi's
`calculateContextTokens()` short-circuits on `totalTokens` and feeds it to
both the host's context gauge and `shouldCompact()`. Every cycle re-sends the
same cached prefix, so the sum counts that prefix once per cycle:

| captured 3-cycle episode | tokens |
| ------------------------ | ------ |
| cycle 0 prompt           | 25,396 |
| cycle 1 prompt           | 28,106 |
| cycle 2 prompt           | 28,243 |
| **summed usage**         | 82,174 |

The model never held more than 28,243. Reporting 82,174 showed 41% of a 200k
window instead of 14%, and a long turn (26 cycles was observed in the wild,
summing to 2.08M against a real 104k) pushed pi past its compaction threshold
at a tenth of true occupancy — discarding history the window had ample room
for. Guarded by `tests/multi-cycle.test.ts`.

### Billing reads `modelUsage`, not `usage` (0.4.10)

`result.usage` is the **main agent only**. Claude Code sub-agents run inside
the CLI: they never appear in the parent SSE stream, and their tokens are not
in `result.usage`. Neither is the haiku auto-titler's.

`result.modelUsage` is the per-model account of everything the episode spent,
and it is what the bridge folds into the cumulative components. Verified on a
captured episode with one synchronous sub-agent:

|                             | cache read  | cache write |
| --------------------------- | ----------- | ----------- |
| main agent (`result.usage`) | 74,562      | 26,808      |
| sub-agent (own transcript)  | 28,079      | 30,112      |
| `modelUsage` summed         | **102,641** | **56,920**  |

Exact to the token. Without this, a lane that fanned out to seven sub-agents
reported \$2.34 for a turn that really spent about \$24 — the sub-agents'
28.6M cache-read tokens were simply absent.

Two caveats, both deliberate:

- Folded tokens are priced at the **session's** model rates. Exact for
  sub-agents, which inherit the session model; slightly off for a cheaper
  helper model, which is worth far less than the tokens it stops hiding.
- Older CLIs send no `modelUsage`. The bridge falls back to `result.usage`,
  and an empty object is treated as absent rather than as a zero bill.

### Effort maps 1:1, and never upward (0.4.12)

`--effort` used to be shifted up a rung for opus: `medium` became `high` and
`high` became `max`. That compensated for a cap the CLI no longer has, and it
made `high` unrequestable on opus at all.

Re-verified 2026-08-27 on claude CLI 2.1.231 with `claude-opus-5`: `--effort
high`, `--effort xhigh` and `--effort max` are each accepted and recorded
distinctly in the session transcript's `effort` field. The cap is gone.

The shift was not a private detail. Claude Code **skills size their own
sub-agent fan-out from this flag** — `code-review` in 2.1.231 carries three
tiers (`angleCount:8, cap:8`, `angleCount:8, cap:10`, `angleCount:10,
cap:15`) — so a host asking for `high` on opus silently bought the widest one.
A pidex turn on 2026-08-27 did exactly that: 14 nested agents, 743 API calls
and 43.4M cache-read tokens in eight minutes, from a UI whose chip read
"High".

Every level now passes through unchanged. `minimal` still floors at `low`
because the CLI has no rung below it; that is a floor, and the invariant the
tests enforce is one-directional — **no level ever maps above what the host
asked for**.

### Thinking blocks are materialized lazily (0.4.4)

Most Claude models stream **encrypted** thinking: a multi-kilobyte
`signature_delta` plus `thinking_delta` events whose text is the empty
string, and no plaintext ever. Measured with identical prompts at
`--thinking medium` on real turns: fable-5, opus-5 and sonnet-5 all do this;
**haiku-4-5 is the only family that sends plaintext**.

Materializing on `content_block_start` therefore produced thinking blocks
with a 3k signature and zero characters of text, which front-ends faithfully
render as a "thought" that expands to nothing. So a thinking block is now
created on the **first `thinking_delta` that actually carries text** — an
empty-string delta must not bring one into existence — and dropped at
`content_block_stop` if none ever arrived. A signature that precedes the
plaintext is buffered and applied on materialization, so genuine thinking
keeps its signature.

This is why `TrackedContentBlock` carries an explicit `contentIndex` instead
of a parallel-array invariant with `output.content`: a dropped block must not
shift the indexes of the blocks after it.

Sessions recorded before 0.4.4 still hold empty thinking blocks on disk
forever, so front-ends need their own guard regardless — pidex skips them on
settled items.

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
- **Sub-agent episodes.** The _launch_ is visible — `Task` is a CLI-side
  tool, so it surfaces as an ordinary marker and pidex renders those as
  sub-agent rows — but everything the sub-agent then does arrives with
  `parent_tool_use_id` set and is filtered out in both `provider.ts` and
  `handleAssistantEnvelope`. Those events carry a full nested episode; a
  front-end that wanted a live sub-agent tree would consume them there.
  Until then, a consumer knows an agent was **launched** and nothing more —
  no progress, no result, and no liveness (the CLI does not outlive the
  turn), so it must not imply otherwise.

### Enforcement is belt-and-suspenders

The belt is `control-handler.ts`: custom-tools requests get
`{behavior:"deny"}` (so pi runs them), everything else `allow`. The
suspenders are the **handoff interrupt** in `provider.ts`: at the first
top-level `message_stop` after a HANDOFF `tool_use`
(`mcp__custom-tools__*` only), the provider sends the CLI's own `interrupt`
control request and freezes the stream until the result envelope arrives.
Built-in tools never trigger either mechanism — the CLI executes them
natively and pi renders the markers.

**Never SIGKILL a healthy turn.** A kill truncates the CLI's session file
before the assistant turn is written; every later `--resume` then splices a
synthetic `No response requested.` assistant turn into the replayed
transcript, and the model eventually imitates it — observed in production
as sessions silently dying mid-task. SIGKILL remains only as the abort
backstop (2s after an interrupt) and the post-result reaper.

## Session model: one CLI session per pi session

pi's session JSONL is the **only** authoritative record; the CLI session is
the model's working memory. The sidecar map
`~/.pi/agent/pi-claude-cli/session-map.json` (`PI_CLAUDE_CLI_STATE_DIR`
overrides; `src/session-map.ts`) links pi session id → CLI session id.

- **Resume:** mapping present and not stale → `--resume <cliId>` with a
  **delta** prompt (only what follows the last assistant turn), no system
  prompt. This is what makes token use native: measured 60 cache-write
  tokens on a follow-up turn.
- **Create/import:** no mapping, stale, resume miss, or failed prior turn →
  fresh provider-minted UUID under `--session-id`, full flattened history,
  system prompt attached, mapping recorded. Never pi's id — the CLI refuses
  an id it has already seen, and forks copy pi ids.
- **Stale** (`cliSessionIsStale`): an assistant turn from another provider
  follows or replaces our last one, i.e. the CLI never saw that exchange.
- **Resume miss** ("No conversation found with session ID"): clear the
  mapping; the driver retries once through the import path without touching
  pi's stream.

Forks, model switches, copied machines and lost sidecars all collapse into
one recovery path: a single full-history import. Never a lost turn.

### The delta anchor is load-bearing (0.4.6)

`buildResumePrompt` anchors on the **last assistant message** and sends only
what follows it. It must not anchor on the last _user_ message: pi's tool
loop appends `[user, assistant(toolUse), toolResult, assistant(toolUse),
toolResult, …]`, so the single `user` entry stays at index 0 for the life of
the loop, and anchoring there replays the whole transcript on **every
iteration** — content the CLI already holds.

That bug was expensive rather than visible, and it compounded: when the
first user message carried an image, the image branch returned early with
just the image and discarded every tool result, so the model never saw any
tool output and re-issued the same call indefinitely. One observed session
made 66 API calls of which 65 produced no work, transmitted one screenshot
48 times, and peaked at 1.44M tokens of context per call — while looking,
from the outside, like a slow session.

The invariant to preserve: **delta size stays flat as the tool loop
deepens.** If a change makes the resume prompt grow with conversation
length, it has regressed.

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

## Account state: rate limits (0.4.5)

The CLI emits a `rate_limit_event` envelope describing the **account's**
plan window. This is not turn content and must never become any: it says
nothing about the answer being streamed, and folding it into the message
would put account state into the user's transcript and into pi's session
file. It travels a separate path end to end:

```
provider.ts   rate_limit_event → options.onRateLimit(info)   (never touches pi's stream)
index.ts      publishRateLimit → ctx.ui.setStatus("claude-rate-limit", json)
front-end     reads the status key, renders it however it likes
```

The key is **`claude-rate-limit`** — deliberately neutral rather than
namespaced to any one front-end, since it is account state any pi front-end
can use. The payload is JSON:

```jsonc
{
  "status": "allowed", // "rejected" once the window is capped
  "resetsAt": 1787368800, // unix seconds
  "rateLimitType": "five_hour",
  "overageStatus": "rejected",
  "isUsingOverage": false,
  "observedAt": 1787363602,
} // when we saw it, not from the CLI
```

Two behaviors worth knowing before you build on it. The CLI repeats the
event **every turn**, so `publishRateLimit` pushes only when the payload
changes (comparing with `observedAt` stripped) — a status that rewrites
itself constantly is noise for whatever renders it. And `session_start`
stashes its `ctx` in module scope, because the stream runs deep inside
`streamSimple`, which has no `ExtensionContext` of its own.

**What this does not carry: utilization percentages.** The "12% of your 5-hour
limit" figures in Claude Code's own TUI come from
`anthropic-ratelimit-unified-*` **response headers**, which the CLI consumes
in-process and never forwards to stdout. So a consumer can honestly say
_when capacity returns_ and whether the account is capped or on overage —
never _how much is left_. Getting the percentages would mean making
authenticated Anthropic requests outside the CLI, which is exactly the line
this extension exists not to cross.

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

| Version | Change                                                                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.4.0   | Port to `@earendil-works` pi 0.84; api-registry registration; scoped release                                                                                                                          |
| 0.4.1   | 2.x control protocol; cycle-aware bridge (ordering, cumulative usage, final-answer safety net); CLI-side tool markers; 300s timeout                                                                   |
| 0.4.2   | Resume-miss → one full-replay retry (fixes forked sessions)                                                                                                                                           |
| 0.4.3   | Overflow → `context_length_exceeded` rewrite (pi auto-compaction); hermetic mode                                                                                                                      |
| 0.4.4   | Lazy thinking materialization (no empty blocks for encrypted thinking); explicit `contentIndex` per tracked block                                                                                     |
| 0.4.5   | `rate_limit_event` → `claude-rate-limit` status key for front-ends                                                                                                                                    |
| 0.4.6   | Resume delta anchors on the last **assistant** message — stops full-transcript replay on every tool iteration                                                                                         |
| 0.4.9   | `utilization` on `claude-rate-limit` (percentage of the binding window)                                                                                                                               |
| 0.4.10  | `usage.totalTokens` = last cycle's prompt, not the summed cycles (fixes inflated context gauges and premature auto-compaction); billing reads `modelUsage`, so sub-agent spend is no longer invisible |
| 0.4.12  | `--effort` maps 1:1 for every model; the opus up-shift (`high`→`max`) is gone, so a host asking for `high` gets `high`                                                                                |

## Testing

- `npm test` — unit suites with mocked `cross-spawn`; includes
  `tests/fixtures/multi-cycle-episode.jsonl`, a **real captured 3-cycle
  episode** (claude 2.1.237) used to assert ordering, markers, and both
  usage modes.
- `npm run test:e2e` — full pipeline through a real `pi` binary against a
  deterministic CLI stub (`tests/e2e/claude-stub.cjs`); no credentials.
- CI runs both on three OSes plus a weekly canary against `pi@latest`.
- `scripts/e2e-live.sh` (= `PI_CLAUDE_CLI_LIVE=1 vitest run
tests/live-observer.test.ts`) — live observer-mode suite against the real
  CLI; spends plan quota, so it is not in CI. Covers: a native multi-tool
  turn, a cheap resume of the same CLI session (asserts cacheRead > 5k and
  cacheWrite < 2k), the custom-tool handoff round-trip, a PreToolUse guard
  hook blocking an out-of-workspace read, and abort/steer + resume.
