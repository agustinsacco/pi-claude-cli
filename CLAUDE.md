# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [pi](https://github.com/earendil-works/pi) extension that registers a custom LLM provider (`pi-claude-cli`) whose backend is the **Claude Code CLI itself**, run as a subprocess. Instead of calling the Anthropic API with a key, each request spawns `claude -p` and talks to it over the stream-json NDJSON wire protocol, so the user's Claude Pro/Max subscription becomes the model backend. There is no build step — pi loads `index.ts` (and the `.ts` files it imports) directly via its own runtime.

## Commands

```bash
npm test                       # vitest run, verbose
npm run test:coverage          # with coverage (thresholds enforced: lines/functions/statements 92%, branches 88%)
npm run typecheck              # tsc --noEmit (noEmit is set; there is no compiled output)
npm run lint                   # eslint .
npm run format:check           # prettier --check .

npx vitest run tests/provider.test.ts              # single test file
npx vitest run -t "some test name"                 # single test by name
npx vitest                                          # watch mode
```

CI (`.github/workflows/ci.yml`) runs lint + format:check, typecheck, and `test:coverage` on Ubuntu/Windows/macOS. A husky pre-commit hook runs lint-staged (eslint --fix + prettier). Cross-platform correctness is a real constraint — Windows is in the test matrix, so subprocess and path handling must not assume POSIX.

## Architecture

The request flow, entry to exit:

1. **`index.ts`** — extension entry. Validates the CLI is present/authenticated, registers the provider exposing all `anthropic` models from pi's catalog, and lazily builds the MCP config on the first request (`getAllTools()` is not safe to call at load time). On `session_start` it force-activates every registered tool so pi will execute them, and stashes the `ctx` used to publish account status. Registration happens **twice** — `pi.registerProvider()` and `registerApiProvider()` from `@earendil-works/pi-ai/compat` — because pi 0.84 has two dispatch paths; drop the second and print mode and nested agent loops throw `No API provider registered`.
2. **`src/provider.ts`** (`streamViaCli`) — the orchestrator. Builds the prompt, spawns the subprocess, writes the user message to stdin, reads stdout line-by-line, and drives the whole lifecycle (inactivity timeout, abort, cleanup). Returns an `AssistantMessageEventStream` that pi consumes.
3. **`src/prompt-builder.ts`** — flattens pi's message history into the text/blocks prompt. First turn → full history via `buildPrompt`; resumed turns → only the new tail via `buildResumePrompt`. Also builds the system prompt (merges `AGENTS.md`, sanitizing `.pi` → `.claude`).
4. **`src/process-manager.ts`** — spawns `claude` with the correct flags via `cross-spawn`, writes NDJSON to stdin, force-kills (SIGKILL), and keeps a registry of live subprocesses so they can all be reaped on exit.
5. **`src/stream-parser.ts`** — resilient NDJSON line parser; never throws, returns `null` for junk/debug/malformed lines.
6. **`src/event-bridge.ts`** — translates each Claude API streaming event into pi stream events (`text_*`, `thinking_*`, `toolcall_*`) and accumulates the final `AssistantMessage` with usage/cost.
7. **`src/control-handler.ts`** — answers the CLI's `can_use_tool` control requests.
8. **`src/tool-mapping.ts`** — the single source of truth for name/argument translation between Claude (`Read`, `Write`, `Glob`…) and pi (`read`, `write`, `find`…). All lookup maps derive from the `TOOL_MAPPINGS` array.
9. **`src/thinking-config.ts`** — maps pi's `ThinkingLevel` to the CLI's `--effort` flag.

### Observer mode (the central idea)

The CLI is a first-class agent, not a bare model. It owns its loop, its tools
and its session; pi is the system of record and an observer of the stream
(docs/SPEC-observer-mode.md). Do not push pi's agenda onto the CLI — where pi
needs a say, use the CLI's extension points (hooks via `PI_CLAUDE_CLI_SETTINGS`,
MCP), never process surgery.

- **Built-in and CLI-side tools run natively.** They surface to pi as
  `[Claude Code · Name {args}]` marker text blocks (a wire contract front-ends
  parse), never as pi toolCall blocks, and never end the turn early.
- **Handoff tools are the one exception.** Custom pi tools
  (`mcp__custom-tools__*`, advertised by the schema-only MCP server
  `src/mcp-schema-server.cjs`) are pi's to execute. When the model calls one,
  the provider sends a clean `interrupt` control request at `message_stop`
  (`sendInterrupt` — NEVER `forceKillProcess`), emits the pi toolCall, and ends
  the stream `stopReason: toolUse`. pi executes (its hooks fire), and the next
  turn resumes with the result. The interrupted turn's `result` envelope is
  `error_during_execution` **by design** — expected, not an error.
- **Why never SIGKILL a healthy turn:** a kill truncates the CLI's session
  file before the assistant turn is written; every later `--resume` then
  splices in a synthetic `No response requested.` assistant turn, which the
  model eventually imitates, silently ending sessions. This happened in
  production; the whole design exists to prevent it. Abort is interrupt-first
  with a 2s SIGKILL backstop.
- `isHandoffClaudeTool` (custom prefix only) is the gate for both the
  interrupt decision and toolCall emission. `isPiKnownClaudeTool` remains only
  for name translation contexts.

### Session model: one CLI session per pi session

The sidecar `~/.pi/agent/pi-claude-cli/session-map.json` (override:
`PI_CLAUDE_CLI_STATE_DIR`) maps pi session id → CLI session id
(`src/session-map.ts`). Per turn:

- **Resume** (`--resume <cliId>`) when a mapping exists and the CLI session is
  not stale — send only the delta via `buildResumePrompt` (messages after the
  last assistant turn), no system prompt.
- **Create/import** otherwise: fresh provider-minted UUID (`--session-id`),
  full history via `buildPrompt`, system prompt attached, mapping recorded.
  Never reuse pi's session id — the CLI refuses an id it has seen
  ("Session ID already in use"), and forks copy pi ids.
- **Stale** = an assistant turn from another provider follows (or replaces)
  our last one (`cliSessionIsStale`): the CLI never saw that exchange, so
  reimport. A failed turn clears the mapping too — a turn that dies can leave
  the CLI transcript ending on a user entry, and resuming that splices filler.
- **Resume miss** ("No conversation found with session ID") clears the mapping
  and the driver retries once through the import path.

Two invariants here caused real outages; both are explained in
docs/ARCHITECTURE.md:

- **`buildResumePrompt` anchors on the last _assistant_ message**, never the
  last user message. If a change makes the resume prompt grow with
  conversation length, it has regressed.
- **A resume can miss.** `streamViaCli` is a driver over
  `runOnce(forceFullReplay)`; the retry must not touch pi's stream.

### Episodes, not messages

One subprocess run is a full agentic **episode** — N API cycles with CLI-side tool executions between them — and SSE `content_block` indexes **reset every cycle**. `event-bridge.ts` keys tracked blocks by `(cycle, index)` and banks per-cycle usage at each `message_start`. Treating an episode as one message is what used to fold later-cycle content into earlier blocks and lose final answers.

Thinking blocks are materialized **lazily**, on the first `thinking_delta` carrying actual text: most models stream encrypted thinking (signature only, empty-string deltas) and materializing eagerly produces empty "thoughts" in every front-end.

### Other lifecycle details worth knowing

- Long system prompts are written to a temp file and passed to `--append-system-prompt` as a path (avoids `ENAMETOOLONG`, especially on Windows); the temp file is cleaned up in `finally`.
- The CLI hangs after emitting its `result` message (known upstream bug) — `cleanupProcess` force-kills after a 500ms grace flush.
- Inactivity timeout is **300s** of no stdout (`PI_CLAUDE_CLI_TIMEOUT_MS` overrides). It is deliberately generous: CLI-side tools are legitimately silent for minutes. Abort uses SIGKILL; a `streamEnded`/`broken` guard pair prevents double `end()`/error races.
- **Context overflow** is rewritten by `src/overflow.ts` to the `context_length_exceeded:` prefix pi's auto-compaction recognizes. The matcher is deliberately narrow and must never catch rate-limit errors, which belong on pi's retry/backoff path.
- `PI_CLAUDE_CLI_HERMETIC=1` adds `--strict-mcp-config --setting-sources ""` so the user's own MCP servers, hooks and CLAUDE.md stay out of pi turns.
- **Account rate-limit state travels outside the stream** — `onRateLimit` → `ctx.ui.setStatus("claude-rate-limit", json)`. It must never be folded into turn content, which would put account state in the user's transcript and pi's session file.

## Conventions

- ESM throughout. Imports of local `.ts` modules use `.js` extensions in the specifier (bundler-style resolution) — match this or resolution breaks at runtime.
- `mcp-schema-server.cjs` is intentionally CommonJS (it's spawned as a standalone `node` process) and is excluded from coverage.
- New tool translations go in the `TOOL_MAPPINGS` array only; do not add ad-hoc lookup maps. Unknown tool names and unknown arguments must pass through unchanged rather than being dropped.
- Coverage thresholds are enforced in CI — new modules generally need tests to land.
