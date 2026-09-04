# pi-claude-cli

> **This is a maintenance fork.** The upstream project's last commit was in March 2026, and it had stopped working against current [pi](https://github.com/earendil-works/pi). This fork updates it for compatibility with the current pi version, and folds in three open upstream pull requests that hadn't been merged:
>
> - **[#25](https://github.com/rchern/pi-claude-cli/pull/25)** — don't resume a Claude CLI session that was never created (fixes empty replies when switching to this provider mid-conversation), and surface CLI errors instead of silently returning nothing.
> - **[#26](https://github.com/rchern/pi-claude-cli/pull/26)** — fix a false "not authenticated" warning on Claude Code 2.x, and correct the outdated login instructions.
> - **[#29](https://github.com/rchern/pi-claude-cli/pull/29)** — let all models use the full thinking-effort range (up to `max`), not just Opus.
>
> Together these resolve the widely-reported problem where prompting a `pi-claude-cli` model just returned an empty response ([#3](https://github.com/rchern/pi-claude-cli/issues/3)). Credit for the three fixes goes to their original PR authors.

A [pi](https://github.com/earendil-works/pi) extension that routes LLM calls through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a subprocess. Use your Claude Pro/Max subscription as the LLM backend — no API key, no separate billing.

## Best experienced in pidex

This fork is developed against [pidex](https://github.com/agustinsacco/pidex) —
the pi coding agent extended into a desktop IDE, and the most advanced
multi-provider agentic IDE you can run on your own machine. pidex works with
every pi provider (Anthropic, OpenAI, Google, Bedrock, and the rest), and with
this extension it turns a Claude Pro/Max subscription into a full desktop IDE:
chat with real diffs, file explorer, terminal, versioned artifacts, and an
orchestrator that manages sessions — no API key needed.

![A pidex session: streaming transcript with an expandable edit diff](https://raw.githubusercontent.com/agustinsacco/pidex/main/docs/img/chat.png)

Everything this extension emits has a first-class surface there:

- The `[Claude Code · Tool]` activity markers render as expandable steps in
  the transcript, not raw text.
- The `claude-rate-limit` status key feeds pidex's context meter, so your
  plan's usage window and reset time are always visible.
- The `claude-subagents` status key turns a `Task` fan-out into live
  per-agent progress instead of a blank pane.
- pidex sets `PI_CLAUDE_CLI_STRICT_MCP=1` on every session, so the CLI's MCP
  traffic stays under the host's tool guards.

[Install pidex →](https://github.com/agustinsacco/pidex#install)

## How it works

The extension registers as a custom pi provider exposing all Claude models. It runs in **observer mode**: the Claude Code CLI is a first-class agent that owns its loop, its tools and its session — pi is the system of record and observes the stream. One CLI session per pi session, resumed with `--resume` on every follow-up turn, so token use matches using the CLI directly. Built-in tools (Read, Bash, …) execute natively inside the CLI and surface to pi as `[Claude Code · Name]` activity markers. Custom pi tools are advertised via a schema-only MCP server and **handed off**: the provider interrupts the turn cleanly, pi executes the tool (all pi hooks fire), and the next turn resumes with the result.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on PATH)
- A Claude Pro or Max subscription
- [pi](https://github.com/earendil-works/pi) or [GSD](https://github.com/gsd-build/gsd-2)

## Installation

```bash
pi install npm:@saccolabs/pi-claude-cli
```

Or declare it in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "packages": ["npm:@saccolabs/pi-claude-cli"]
}
```

Then select a Claude model via `/model` in the interactive UI. All Claude models appear under the `pi-claude-cli` provider.

Requires the `claude` binary on your login-shell PATH (`npm install -g @anthropic-ai/claude-code`), authenticated with your Claude Pro/Max account.

## Features

- Streams text, thinking, and tool call tokens in real-time
- Maps tool names and arguments bidirectionally between Claude and pi
- Exposes custom pi tools to Claude via MCP; the schema server proxies each
  call back to pi over a local socket, so the CLI never has to be interrupted
  to let pi run a tool
- One CLI **process** per pi session (0.7.0): it lives through custom-tool
  handoffs and across turns, so Claude Code builds its system prompt — git
  snapshot included — once per session rather than once per call. A commit
  or branch rename between turns no longer re-bills the whole context
- One CLI session per pi session (sidecar-mapped), resumed on every follow-up turn — native caching, no history replay
- Native tool execution: the CLI runs its own tools; guards are injected as Claude Code PreToolUse hooks via `PI_CLAUDE_CLI_SETTINGS`
- Reports account rate-limit state (window, reset, overage) to the front-end
  on the `claude-rate-limit` status key — never mixed into turn content
- Surfaces sub-agent fan-outs: one marker when a `Task` agent starts and one
  when it reports, plus live per-agent progress on the `claude-subagents`
  status key — so a fan-out is no longer a blank pane
- Background sub-agents get to finish: a `result` while agents are still
  running ends a cycle, not the turn, so their reports reach the model
  instead of dying with the subprocess
- Configurable thinking effort across the full ladder (low to max), mapped 1:1 for every model: the level the host asks for is the level the CLI gets
- Cross-platform subprocess management (Windows, macOS, Linux)
- Inactivity timeout and process registry for cleanup

## Architecture

`docs/ARCHITECTURE.md` covers the turn lifecycle, the three-way tool split,
the two-ledger session model, error recovery, and the CLI compatibility
notes (including the 2.x control-protocol shape).

Two of its sections are **contracts a front-end can depend on**, so read
them before changing what this extension emits: the
`[Claude Code · Tool {args}]` marker string, and the `claude-rate-limit`
status key.

## What your Claude environment contributes

Each turn runs a real `claude -p` subprocess in your workspace, so your
Claude Code environment participates through three doors:

1. **Bridged tools** — the six built-ins (Read/Write/Edit/Bash/Grep/Glob)
   and pi custom tools become pi tool calls; pi executes them.
2. **CLI-side execution** — your personal/project MCP servers, WebSearch,
   and sub-agents run _inside_ the CLI between cycles. They appear in the
   transcript as one-line markers (`[Claude Code · WebSearch {…}]`) and
   bill your plan.
3. **Prompt-level osmosis** — the CLI auto-loads project CLAUDE.md and
   memory, your hooks fire, and skills can load twice (natively via
   claude, and again via pi's own `~/.claude/skills` support).

### Hermetic mode

Set `PI_CLAUDE_CLI_HERMETIC=1` to keep that environment out of pi turns:
the subprocess runs with `--strict-mcp-config` (only this extension's
schema-only custom-tools server loads) and an empty `--setting-sources`
(no user/project/local settings — hooks, auto-memory, permission
allowlists). Model access and your subscription login are unaffected.

### Strict MCP mode

`PI_CLAUDE_CLI_STRICT_MCP=1` passes `--strict-mcp-config` **on its own**, with
no `--setting-sources` blackout. Use it to route every MCP call through pi's
own tool registry — typically `pi-mcp-adapter`'s `mcp` gateway — while leaving
the CLI's settings, hooks and `CLAUDE.md` auto-memory alone.

Reach for this instead of hermetic mode when the host suppresses pi's copy of
`CLAUDE.md` and relies on the CLI to load it: hermetic mode would leave the
model with project instructions from neither side. Hermetic mode still implies
strict MCP, so setting both is safe.

Why a host wants it: MCP servers the host did not configure are invisible to
it, bypass its tool guards, and are never counted by pi-side status or context
accounting.

Related knobs: `PI_CLAUDE_CLI_TIMEOUT_MS` overrides the 300s inactivity
timeout (CLI-side tools can be silent on stdout for minutes).

### Tool result forwarding

In observer mode the CLI executes its own tools, and pi's transcript records
each one as a marker text block — `[Claude Code · Bash {"command":…}]` — with
**no result**. A front-end can show what was invoked but never what came back,
so its tool rows have nothing to expand into.

`PI_CLAUDE_CLI_TOOL_RESULTS=1` forwards the results. Two richer marker shapes
go on the wire, paired by `tool_use_id`:

```
[Claude Code · <ToolName> #<toolUseId> <argsJson>]   ← call, now id-tagged
[Claude Code · result #<toolUseId> <payloadJson>]    ← its result
```

`payloadJson` is complete, parseable JSON:
`{"status":"ok"|"error","preview":string,"length":number,"truncated"?:true}`.
The preview is capped at 2,000 characters (`length` always reports the full
size); the full output remains in the CLI's own transcript. Results are only
forwarded for tools that produced a call marker — handoff tools are executed
by pi, which already has their real result, and their replayed `tool_result`
envelopes are ignored.

This is a host **opt-in** because it changes the marker wire contract: a
front-end that has not learned the id-tagged shapes would render them as
prose. Leave it unset and the wire format is byte-identical to pre-0.6.0.

### Persistent CLI process

Before 0.7.0 every pi call was its own `claude -p` process: a custom-tool
handoff denied the permission, interrupted the CLI, ran the tool in pi and
`--resume`d a new process with the result pasted in as text; every user turn
started another. Each new process rebuilt Claude Code's system prompt, and
that prompt snapshots `git status`, the recent commits and the branch. So a
commit, a branch rename or a new untracked file between two processes
re-billed the **entire** context as cache write — measured 2026-09-01 on one
session: 64k, 106k and 190k tokens on three separate restarts, 1.87M tokens
across three sessions that day. The restart also left `tool use was
rejected` / `[Request interrupted]` / `No response requested.` filler in the
CLI transcript on every custom tool call.

Now the process stays up. A custom tool call is **allowed** and proxied: the
schema-only MCP server forwards `tools/call` to pi over a local socket, pi
runs the tool, and the next pi call answers the CLI on the same process — its
transcript records a real `tool_result`. After a turn ends the process is
parked and the next user message goes to the same stdin. Measured live
(`tests/live-persistent.test.ts`): a turn after a commit costs 91 cache-write
tokens on the persistent process versus 8,827 on a fresh one.

| Variable                        | Default   | Meaning                                                                                                                                    |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PI_CLAUDE_CLI_KEEPALIVE_MS`    | `600000`  | How long a parked process waits for the next turn. `0`/`off`: end it at `result` as before (handoffs still keep it alive within a turn).   |
| `PI_CLAUDE_CLI_HANDOFF_WAIT_MS` | `1800000` | Ceiling on a process blocked in a handoff that pi never answers (aborted tool, crashed host); it is interrupted and retired when it fires. |
| `PI_CLAUDE_CLI_HANDOFF_PROXY`   | on        | `0` restores interrupt-and-resume for custom tools (the MCP server then answers `tools/call` with an error result).                        |
| `MCP_TOOL_TIMEOUT`              | `3600000` | Passed to the CLI when unset: a proxied call blocks until pi has run the tool, and sub-agents take minutes.                                |

A parked process is retired — cleanly, never mid-turn — when the next call
does not match it: a different model or effort, a changed system-prompt
mode, a rewritten tool schema (a new MCP server connected), a pi history the
CLI never saw, or a delta that is not exactly the awaited tool results. The
next call then `--resume`s the CLI session in a fresh process, exactly as
every call did before. Ending pi ends its parked processes: their stdin is a
pipe from pi, and the CLI exits on EOF.

### Auto-compact window

The provider resumes **one** CLI session for a pi session's whole life, and
nothing else ever shrinks it. On 1M-context models the CLI's own auto-compact
default lets that session ratchet toward a million tokens — measured across 26
real sessions, contexts reached 480k+, the average request carried 202k
tokens, and every request re-reads the full context. So the provider passes
`--autocompact 200000` **by default**: Claude Code compacts the session itself
when its context nears 200k, keeping the cached system-prompt prefix and full
transcript fidelity.

`PI_CLAUDE_CLI_AUTOCOMPACT` configures it (read per spawn, like the flags
above):

| Value                   | Behaviour                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| _(unset)_               | `--autocompact 200000` — the 200k budget these models run under everywhere the 1M beta is off. |
| `400k`, `400000`, `400` | Any window from 100k to 1M; bare numbers are thousands (CLI shorthand).                        |
| `auto`                  | `--autocompact auto` — the CLI's own default (≈ the model's full window).                      |
| `off`                   | Omit the flag entirely (use on CLIs that predate `--autocompact`).                             |

The value is a token **count**, not a percentage: cache read/write bill per
token and every request re-reads the whole context, so the sane budget is the
same on a 200k model and a 1M one. Invalid values warn and fall back to the
default instead of reaching the CLI, which rejects them by refusing to start.

Note for pre-existing sessions: the first resumed turn of a session already
past the window compacts immediately — one summarization pass, then the
session continues small. That is the remediation, not a bug. pi's own
compaction is separate (it rewrites pi's transcript, never the CLI session's)
and with this cap it should rarely trigger.

### Which system prompt

`PI_CLAUDE_CLI_SYSTEM_PROMPT` chooses whose system prompt the subprocess
runs under. It is read per spawn, so a host can change it between sessions.

| Value                | Behaviour                                                                      |
| -------------------- | ------------------------------------------------------------------------------ |
| `claude` _(default)_ | `--append-system-prompt-file`: pi's prompt layers on top of Claude Code's own. |
| `pi`                 | `--system-prompt-file`: pi's prompt replaces Claude Code's entirely.           |

The `-file` suffix matters: `--system-prompt` / `--append-system-prompt`
(unsuffixed) take a **literal string**, not a path. Passing a temp-file path
to the unsuffixed flag makes the path itself the prompt — pi's instructions
never reach the model, silently, with no error. This shipped unnoticed since
the provider's system-prompt support was first added; see the correction
below.

`minimal` is accepted as an alias for `pi`, `append` for `claude`; anything
unrecognised falls back to the default rather than failing a session.

**Why you might want `pi`.** The point of a minimal harness is not inheriting
another agent's preamble. Measured on a real session, the CLI's fixed cached
prefix was 17,475 tokens; the tool schemas (~4.3k) stay either way, but the
rest is Claude Code's prompt, and pi's own — after the tool-section rewrite
below — is ~674 tokens. That frees roughly 12k tokens of context window per
call. It is a window win, not a cost win: the prefix is cached and bills at
0.1x.

**Why the default is still `claude`.** Claude Code's prompt carries operating
guidance for its own tools. Replacing it leaves the model with pi's
instructions plus the raw tool schemas. To stop that being actively
misleading, `pi` mode rewrites pi's tool sections — which name pi's tools
(`read`, `edit`, `grep`, `find`, `ls`) and pi's parameters (`path`,
`oldText`, `newText`) — into Claude Code's vocabulary (`Read`, `Edit`,
`Grep`, `Glob`, with `file_path`, `old_string`, `new_string`). If pi ever
restyles its prompt so the `Available tools:` / `Guidelines:` anchors are
missing, the prompt passes through untouched rather than being mangled.

The system prompt goes on **every** spawn, not just the session-creating one:
the CLI does not keep `--system-prompt-file` across `--resume`, and a resumed
session without it silently reverts to Claude Code's default prompt from turn
2 onwards. Because an identical prefix is what keeps the prompt cache warm,
the prompt a session was created with is stored in the sidecar
(`~/.pi/agent/pi-claude-cli/sysprompt/<cli-session-id>.txt`) and replayed
verbatim rather than rebuilt. A change to the mode therefore takes effect on
the next new session, not the current one.

> **Correction (2026-08-29).** Both bullets above named the unsuffixed flags
> until this date. They were wrong the whole time the provider has supported a
> system prompt: `--system-prompt` / `--append-system-prompt` take a literal
> string, and the provider was handing them a temp-file path. That path string
> either became the entire "system prompt" (`pi` mode) or got appended as
> noise Claude Code's model ignored (`claude` mode) — either way, pi's actual
> instructions never reached the model, on ANY turn, since the very first spawn.
> Fixed by switching to `--system-prompt-file` / `--append-system-prompt-file`,
> which take a path. See
> [pidex's write-up](https://github.com/agustinsacco/pidex/blob/main/docs/log/2026-08-29-claude-cli-lifecycle-verification.md)
> for the live before/after.

## License

MIT
