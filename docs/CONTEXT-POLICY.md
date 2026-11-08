# Pi-owned context and execution

This is the default from 0.9.0. `PI_CLAUDE_CLI_CONTEXT=pi` is accepted but not required. The explicit `legacy` value retains the observer implementation documented in [ARCHITECTURE.md](ARCHITECTURE.md).

## Request contract

The provider accepts both legacy pi `Context` and pi 0.87 `TranscriptContext`. For the latter it resolves the current prompt and tools through pi-ai's `getCurrentSystemPrompt` / `getCurrentTools`, including section replacements and tool removals. System messages are not mistaken for user conversation.

The current prompt is passed through `--system-prompt-file`, without editing user instructions or loading AGENTS/CLAUDE files independently. One short suffix binds pi tool names to `mcp__custom-tools__<name>` with unchanged argument schemas.

Only tools in the model request are exposed through MCP. No registry-wide activation, native-tool substitutions, schema translation, or default Claude agent tools. All actual execution happens in pi, so tool-call guards, tool-result transformations and complete results have the same owner on every provider.

## CLI launch

The default launches with:

- `--system-prompt-file`, even for an empty pi prompt
- `--tools "" --no-session-persistence`
- `--strict-mcp-config --setting-sources "" --disable-slash-commands --no-chrome`
- the explicit pi MCP bridge and optional host `--settings`

Child-only environment disables independent CLAUDE.md/auto-memory discovery, claude.ai MCP connectors, tool search and CLI auto-compaction. Subscription OAuth/keychain access is retained. `--bare`, inherited simple mode and safe mode are not substitutes. Explicit host guards and managed policy still apply. Standalone Claude Code settings are never modified.

## Conversation synchronization

A CLI process is a disposable cache, not another source of truth. After each successful provider episode, the provider records a hash and length of the pi history it acknowledged, including the emitted assistant message. It hashes model-visible content, excluding timestamps, usage and thinking signatures.

Reuse requires an unchanged history prefix and launch signature. A tool handoff must contain the awaited tool results, optionally followed by user messages pi sent while the tool ran (steering): those are written to the live process before the results, and Claude Code folds them into the same turn. Changed history, a rewritten base prompt or changed tools retire the process and import pi's current context in order.

The system prompt is not part of the launch signature. A section change or appended text (an MCP server list, an extension's request-local patch) is rendered the way pi renders a mid-conversation system message, wrapped in `<system-reminder>`, and sent ahead of the next user message to the live process. A tool loop keeps the prompt it started on; the update rides with the next user input. Only a rewritten base prompt needs a fresh process.

An aborted reply leaves the process warm: pi gets its aborted error at once, the CLI is interrupted, and the process parks once it settles (at most 5 seconds; a prompt that arrives first waits for it). A failed or aborted assistant message is not history, matching pi's own transports.

A call that is not the session's next step never takes or retires the session's process: a call with `cacheRetention: "none"` (pi-web-access answers `fetch_content` this way, with the session's model and id), or one whose history does not extend a turn that is waiting on a tool. It runs on a process of its own, which is never parked. The MCP schema version is a content hash, so such a call's other tools do not make the session's own surface look changed. This covers native-provider turns, branch edits, compaction, extension context rewrites and process restarts. No stale saved prompt or CLI transcript is resumed. The thinking level is not part of the launch signature: a new level is applied to the live process through Claude Code's control requests before the next user turn, and only a refused change retires it ([ARCHITECTURE.md](ARCHITECTURE.md#thinking-the-same-request-pi-would-send-0100)).

Model selection, session start/shutdown, tree navigation and compaction retire parked processes. Rate-limit and agent status are cleared on lifecycle resets. Old policy pairings and saved prompt sidecars are detached on the next pi-owned request; archived Claude transcripts are not deleted or read.

A CLI import uses ordered, role-labelled content because print mode does not accept an arbitrary structured transcript. Every supplied user/tool image and tool result is retained, including errors; internal thinking is not replayed. This is semantic continuity, not identical wire requests or guaranteed identical model behavior.

## Compaction and failure

pi owns compaction and retry. Hosts must stop forcing `set_auto_compaction: false` for this provider. A compacted pi history invalidates the disposable Claude process before the next request. Errors and aborts return structured assistant errors, not raw strings or success messages (an abort no longer retires the process, see above); the existing overflow normalizer enables pi's recovery path.

A failed process is not reused. Default runs write no Claude conversation file or resume sidecar. Temporary MCP configuration is removed on retirement/exit; prompt staging files are removed after an episode and the private runtime directory on pi exit. SIGKILL cannot run cleanup and may leave its private directory.

## Verification

Unit coverage includes changed prompts, branch/compaction rewrites, foreign-provider turns, unchanged-prefix reuse, complete replay, inactive/removed tools, current pi transcript format, lifecycle retirement and structured errors. Legacy tests explicitly select `legacy`.

```sh
npm run typecheck
npm run lint
npm run test:coverage
npm run test:e2e
PI_OWNED_LIVE=1 npx vitest run tests/live-context-policy.test.ts tests/live-pi-roundtrip.test.ts
```

Live checks use isolated fixtures, not user integrations. The CLI check verifies the tool inventory, handoff execution, host hooks, warm follow-ups and absence of new transcript/sidecar files. The real-pi RPC check executes read/edit, enforces a pi guard, switches through a deterministic native provider, then performs pi compaction and verifies recall. They spend subscription tokens and do not assert a universal token saving.
