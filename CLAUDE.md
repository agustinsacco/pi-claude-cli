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

1. **`index.ts`** — extension entry. Validates the CLI is present/authenticated, registers the provider exposing all `anthropic` models from pi's catalog, and lazily builds the MCP config on the first request (`getAllTools()` is not safe to call at load time). On `session_start` it force-activates every registered tool so pi will execute them.
2. **`src/provider.ts`** (`streamViaCli`) — the orchestrator. Builds the prompt, spawns the subprocess, writes the user message to stdin, reads stdout line-by-line, and drives the whole lifecycle (inactivity timeout, abort, cleanup). Returns an `AssistantMessageEventStream` that pi consumes.
3. **`src/prompt-builder.ts`** — flattens pi's message history into the text/blocks prompt. First turn → full history via `buildPrompt`; resumed turns → only the new tail via `buildResumePrompt`. Also builds the system prompt (merges `AGENTS.md`, sanitizing `.pi` → `.claude`).
4. **`src/process-manager.ts`** — spawns `claude` with the correct flags via `cross-spawn`, writes NDJSON to stdin, force-kills (SIGKILL), and keeps a registry of live subprocesses so they can all be reaped on exit.
5. **`src/stream-parser.ts`** — resilient NDJSON line parser; never throws, returns `null` for junk/debug/malformed lines.
6. **`src/event-bridge.ts`** — translates each Claude API streaming event into pi stream events (`text_*`, `thinking_*`, `toolcall_*`) and accumulates the final `AssistantMessage` with usage/cost.
7. **`src/control-handler.ts`** — answers the CLI's `can_use_tool` control requests.
8. **`src/tool-mapping.ts`** — the single source of truth for name/argument translation between Claude (`Read`, `Write`, `Glob`…) and pi (`read`, `write`, `find`…). All lookup maps derive from the `TOOL_MAPPINGS` array.
9. **`src/thinking-config.ts`** — maps pi's `ThinkingLevel` to the CLI's `--effort` flag.

### The break-early pattern (the central, non-obvious idea)

pi must execute tools itself; the Claude CLI would otherwise execute them. So the CLI is used only to _propose_ tool calls, never to run them:

- Custom pi tools are exposed to the CLI through a **schema-only MCP server** (`src/mcp-schema-server.cjs`, wired up by `src/mcp-config.ts`). It answers `initialize` and `tools/list` only — `tools/call` is intentionally never implemented.
- In `provider.ts`, when a top-level `tool_use` block for a pi-known tool is seen, at the next `message_stop` the subprocess is **force-killed before the CLI can execute the tool** (`broken = true`, then `forceKillProcess` + `rl.close()`). pi then runs the tool and the next turn resumes the CLI session with the result.
- `control-handler.ts` complements this: custom MCP tools (`mcp__custom-tools__*`) get `behavior: "deny"` so pi owns them; everything else (built-in and user MCP tools) is allowed.

Consequences to keep in mind when editing:

- **Only top-level events matter.** Events with `parent_tool_use_id` are sub-agent internals and must be filtered out (both for forwarding and for the break-early decision).
- **`isPiKnownClaudeTool`** is the gate: built-in mapped tools and `mcp__custom-tools__*` are "known"; internal CLI tools (`Task`, `Agent`, `ToolSearch`, …) are not and must be dropped, never surfaced to pi as tool calls.
- The stream terminates with a **`done`** event (never `error`) — pi's `extractResult()` treats `error` as a bare string and later calls `.content` on it, which crashes. `endStreamWithError` deliberately pushes a well-formed `done` with `content: []` instead.
- The `done` event is pushed **after** readline closes (async), not inside `message_stop`; pushing it synchronously would let the CLI execute tools before the kill lands.

### Session resume

pi passes a `sessionId` on every call. `provider.ts` resumes (`--resume <id>`, sending only the new tail via `buildResumePrompt`) **only when the conversation already contains a prior assistant turn from this provider** (`provider`/`api === "pi-claude-cli"`); otherwise it starts a fresh CLI session (`--session-id <id>`, full history via `buildPrompt`). This provider-aware check — not a bare `messages.length` test — is what keeps a mid-session `/model` switch from another provider from `--resume`-ing a CLI session that was never created (which fails silently as an empty message). Resuming also skips re-sending the system prompt, since it's already in the CLI's session context.

### Other lifecycle details worth knowing

- Long system prompts are written to a temp file and passed to `--append-system-prompt` as a path (avoids `ENAMETOOLONG`, especially on Windows); the temp file is cleaned up in `finally`.
- The CLI hangs after emitting its `result` message (known upstream bug) — `cleanupProcess` force-kills after a 500ms grace flush.
- Inactivity timeout is 180s of no stdout; abort uses SIGKILL; a `streamEnded`/`broken` guard pair prevents double `end()`/error races.

## Conventions

- ESM throughout. Imports of local `.ts` modules use `.js` extensions in the specifier (bundler-style resolution) — match this or resolution breaks at runtime.
- `mcp-schema-server.cjs` is intentionally CommonJS (it's spawned as a standalone `node` process) and is excluded from coverage.
- New tool translations go in the `TOOL_MAPPINGS` array only; do not add ad-hoc lookup maps. Unknown tool names and unknown arguments must pass through unchanged rather than being dropped.
- Coverage thresholds are enforced in CI — new modules generally need tests to land.
