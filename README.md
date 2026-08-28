# pi-claude-cli

> **This is a maintenance fork.** The upstream project's last commit was in March 2026, and it had stopped working against current [pi](https://github.com/earendil-works/pi). This fork updates it for compatibility with the current pi version, and folds in three open upstream pull requests that hadn't been merged:
>
> - **[#25](https://github.com/rchern/pi-claude-cli/pull/25)** — don't resume a Claude CLI session that was never created (fixes empty replies when switching to this provider mid-conversation), and surface CLI errors instead of silently returning nothing.
> - **[#26](https://github.com/rchern/pi-claude-cli/pull/26)** — fix a false "not authenticated" warning on Claude Code 2.x, and correct the outdated login instructions.
> - **[#29](https://github.com/rchern/pi-claude-cli/pull/29)** — let all models use the full thinking-effort range (up to `max`), not just Opus.
>
> Together these resolve the widely-reported problem where prompting a `pi-claude-cli` model just returned an empty response ([#3](https://github.com/rchern/pi-claude-cli/issues/3)). Credit for the three fixes goes to their original PR authors.

A [pi](https://github.com/earendil-works/pi) extension that routes LLM calls through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a subprocess. Use your Claude Pro/Max subscription as the LLM backend — no API key, no separate billing.

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
- Exposes custom pi tools to Claude via MCP (schema-only, no execution)
- Break-early pattern prevents Claude CLI from auto-executing tools
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
- AskUserQuestion works when the host can answer it: if the pi session has
  an `ask_user` tool (e.g. a host extension that renders real dialogs), the
  CLI's native question tool is bridged onto it — denied CLI-side, handed to
  pi, answers fed back next episode. Without such a tool it stays disallowed
  so the model asks in prose instead of hearing "the user did not answer"
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

Related knobs: `PI_CLAUDE_CLI_TIMEOUT_MS` overrides the 300s inactivity
timeout (CLI-side tools can be silent on stdout for minutes).

### Which system prompt

`PI_CLAUDE_CLI_SYSTEM_PROMPT` chooses whose system prompt the subprocess
runs under. It is read per spawn, so a host can change it between sessions.

| Value                | Behaviour                                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| `claude` _(default)_ | `--append-system-prompt`: pi's prompt layers on top of Claude Code's own. |
| `pi`                 | `--system-prompt`: pi's prompt replaces Claude Code's entirely.           |

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

Only the session-creating turn sends a system prompt — the CLI keeps it for
the life of the session — so a change takes effect on the next new session,
not the current one.

## License

MIT
