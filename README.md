# pi-claude-cli

**Your Claude Pro/Max subscription, as a first-class provider for the
[pi coding agent](https://github.com/earendil-works/pi).** No API key, no
second bill. pi drives the
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a
subprocess and observes the stream.

[![npm](https://img.shields.io/npm/v/@saccolabs/pi-claude-cli?color=eca03d&labelColor=1e1c18)](https://www.npmjs.com/package/@saccolabs/pi-claude-cli)
[![CI](https://github.com/agustinsacco/pi-claude-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/agustinsacco/pi-claude-cli/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-8ec9a0)

Install it, pick a Claude model, work. It behaves the same in pi's terminal UI
and in [Phosphor](https://github.com/agustinsacco/Phosphor), the desktop IDE
built on pi — **no configuration in either**. Every default is the one you
want; the environment variables further down are for hosts with an opinion.

```bash
pi install npm:@saccolabs/pi-claude-cli
```

Then `/model` and choose any Claude model under the `pi-claude-cli` provider.

**Requirements:** the `claude` binary on your login-shell PATH
(`npm install -g @anthropic-ai/claude-code`), authenticated with a Claude Pro
or Max account, and [pi](https://github.com/earendil-works/pi) (or
[GSD](https://github.com/gsd-build/gsd-2)). Claude Code 2.1.263+ if you turn on
the pi context policy.

To declare it instead of installing imperatively, put it in
`~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "packages": ["npm:@saccolabs/pi-claude-cli"]
}
```

## This is not a maintenance fork anymore

It started as one. Upstream's last commit was March 2026 and it had stopped
working against current pi, so this repo picked it up, fixed compatibility and
folded in three stranded upstream PRs
([#25](https://github.com/rchern/pi-claude-cli/pull/25),
[#26](https://github.com/rchern/pi-claude-cli/pull/26),
[#29](https://github.com/rchern/pi-claude-cli/pull/29) — credit to their
authors) to resolve the widely-reported empty-response bug.

That job finished months ago. Since the fork point: **35 commits, 66 files,
+18.7k / −4.8k lines**, and eight releases through 0.8.3. What is here now that
upstream never had:

- **Observer mode** — the CLI is a first-class agent that owns its loop, its
  tools and its session; pi is the system of record and watches the stream.
- **One persistent CLI process per pi session**, parked between turns.
- **A private, authenticated handoff broker** so pi's own tools run without
  ever restarting the CLI.
- **Tool-result forwarding** with per-tool metrics, so a host can show what
  came back and not just what was called.
- **Compaction ownership** — a real `--autocompact` budget, and a marker on the
  wire when the cut happens.
- **A context-loading policy** that puts pi in charge of project instructions
  while keeping Claude Code's native tools.
- **Sub-agent visibility**, rate-limit reporting, full thinking ladder,
  cross-platform process management, and 595 tests across 30 files over ~6.4k
  lines of source.

Treat it as its own project that happens to share an ancestor.

## Why it is efficient

Every design decision here answers one question: _are we paying for the same
context twice?_

**One CLI process per session.** Before 0.7.0 every pi call spawned its own
`claude -p`. Claude Code rebuilds its system prompt at process start, and that
prompt embeds a git snapshot — status, recent commits, branch. So a commit, a
branch rename or a new untracked file between two calls invalidated the cache
and re-billed the **entire** context as a cache write. Measured 2026-09-01 on
one session: 64k, 106k and 190k tokens on three restarts; 1.87M tokens across
three sessions that day. Now the process stays up through tool handoffs and
across turns. A turn taken right after a commit costs **91 cache-write tokens
on the parked process versus 8,827 on a fresh one** (`tests/live-persistent.test.ts`).

**One CLI session per pi session.** Resumed with `--resume` on every follow-up
turn, so the CLI's own prompt cache does the work and pi never replays history
into a prompt. Token use matches using the CLI directly.

**A real compaction budget.** The provider passes `--autocompact 200000` by
default. Left alone on 1M-context models, a session ratchets: across 26 real
sessions, contexts reached 480k+ and the average request carried 202k tokens —
and every request re-reads the whole context.

**Custom tools no longer restart anything.** A pi tool call is _allowed_ and
proxied over a private local socket: pi runs the tool, the same process gets a
real `tool_result`. No interrupt, no resume, none of the `[Request interrupted]`
filler the old path left in every transcript.

**Optional: pi's prompt instead of Claude Code's.** Roughly 12k tokens of
context window back per call, if you want a minimal harness.

## In the terminal

Nothing to configure. Install, `/model`, go. CLI-side tools execute natively
and appear in the transcript as one-line markers
(`[Claude Code · Bash {"command":"npm test"}]`); your own CLAUDE.md, hooks,
MCP servers and skills are loaded by the CLI exactly as they are when you run
`claude` yourself. Thinking effort maps 1:1 for every model across the full
ladder, so the level you ask for is the level you get.

## Best experienced in Phosphor

[**Phosphor**](https://github.com/agustinsacco/Phosphor) is the pi coding agent
extended into a desktop IDE for macOS, Linux and Windows. Open a folder,
describe a task, work beside the agent: streaming chat with real expandable
diffs, a file explorer with a Monaco editor, real terminals in the workspace, a
Changes panel with per-file revert, a session tree you can fork from, and
versioned artifacts. It speaks every provider pi speaks — and with this
extension, a Claude Pro/Max subscription drives the entire IDE with no API key.

![A Phosphor session: streaming transcript with an expandable edit diff](https://raw.githubusercontent.com/agustinsacco/Phosphor/main/docs/img/chat.png)

Everything this extension emits has a first-class surface there:

- `[Claude Code · Tool {…}]` activity markers render as **expandable steps**
  with their arguments, not as raw text.
- Paired `[Claude Code · result #id {…}]` markers **fold into the row the call
  already made**, so a row says what came back: line counts, diff stats, exit
  codes.
- The `claude-rate-limit` status key feeds Phosphor's **context meter** — your
  plan's usage window and reset time stay visible.
- The `claude-subagents` status key turns a `Task` fan-out into **live
  per-agent progress** instead of a blank pane.
- The `[Claude Code · compact {…}]` marker draws the **compaction divider**
  exactly where the CLI cut.

Phosphor configures the provider for you: `PI_CLAUDE_CLI_CONTEXT=pi` (pi owns
project context and skills, strict MCP implied), `PI_CLAUDE_CLI_TOOL_RESULTS=1`
for outcome-bearing rows, and pi's own auto-compaction switched off so
`--autocompact` is the single budget.

```bash
npm install -g @earendil-works/pi-coding-agent   # the engine
curl -fsSL https://github.com/agustinsacco/Phosphor/releases/latest/download/install.sh | sh
```

[Install Phosphor →](https://github.com/agustinsacco/Phosphor#install)

## How it works

The extension registers a custom pi provider exposing all Claude models, and
runs in **observer mode**: the Claude Code CLI owns its loop, its tools and its
session while pi stays the system of record and observes the stream. One CLI
session per pi session, resumed on every follow-up turn. Built-in tools (Read,
Bash, …) execute natively inside the CLI and surface to pi as
`[Claude Code · Name]` activity markers. Custom pi tools are advertised through
a schema-only MCP server and **proxied**: the schema server forwards
`tools/call` to pi over a local socket, pi executes the tool (all pi hooks
fire), and the CLI receives a real result without ever stopping.

`docs/ARCHITECTURE.md` covers the turn lifecycle, the three-way tool split, the
two-ledger session model, error recovery, and CLI compatibility notes
(including the 2.x control-protocol shape).

Two of its sections are **contracts a front-end can depend on**, so read them
before changing what this extension emits: the `[Claude Code · Tool {args}]`
marker string, and the `claude-rate-limit` status key.

## Feature list

- Streams text, thinking and tool-call tokens in real time
- Maps tool names and arguments bidirectionally between Claude and pi
- Exposes custom pi tools over MCP, proxied back to pi without interrupting the
  CLI
- One CLI process per pi session (0.7.0), parked between turns
- One CLI session per pi session (sidecar-mapped), resumed on every turn —
  native caching, no history replay
- Native tool execution, with host guards injected as Claude Code PreToolUse
  hooks via `PI_CLAUDE_CLI_SETTINGS`
- Reports account rate-limit state (window, reset, overage) on the
  `claude-rate-limit` status key — never mixed into turn content
- Surfaces sub-agent fan-outs: markers on start and report, plus live progress
  on `claude-subagents`
- Background sub-agents get to finish — a `result` while agents are still
  running ends a cycle, not the turn
- Thinking effort across the full ladder (low → max), mapped 1:1 for every model
- Cross-platform subprocess management (Windows, macOS, Linux), inactivity
  timeout and process registry for cleanup

## Configuration

Every variable is read **per spawn**, so a host can change one between
sessions. All are optional.

| Variable                        | Default                     | What it does                                                                                |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `PI_CLAUDE_CLI_AUTOCOMPACT`     | `200000`                    | The CLI's self-compaction budget. `400k` / `400000` / `400`, `auto`, or `off`.              |
| `PI_CLAUDE_CLI_CONTEXT`         | _(legacy)_                  | `pi` makes pi the source of project context while keeping Claude's native tools. 0.7.1+.    |
| `PI_CLAUDE_CLI_SYSTEM_PROMPT`   | `claude`                    | `claude` appends pi's prompt to Claude Code's; `pi` replaces it.                            |
| `PI_CLAUDE_CLI_TOOL_RESULTS`    | off                         | `1` forwards CLI-side tool results as id-paired markers.                                    |
| `PI_CLAUDE_CLI_HERMETIC`        | off                         | `1` keeps your Claude environment out of pi turns (strict MCP + empty `--setting-sources`). |
| `PI_CLAUDE_CLI_STRICT_MCP`      | off                         | `1` passes `--strict-mcp-config` alone, leaving settings, hooks and CLAUDE.md in place.     |
| `PI_CLAUDE_CLI_SETTINGS`        | unset                       | Path to a Claude Code settings file — the injection point for host PreToolUse guards.       |
| `PI_CLAUDE_CLI_KEEPALIVE_MS`    | `600000`                    | How long a parked process waits for the next turn. `0`/`off` ends it at `result`.           |
| `PI_CLAUDE_CLI_HANDOFF_PROXY`   | on                          | `0` restores pre-0.7.0 interrupt-and-resume for custom tools.                               |
| `PI_CLAUDE_CLI_HANDOFF_WAIT_MS` | `1800000`                   | Ceiling on a process blocked in a handoff pi never answers.                                 |
| `PI_CLAUDE_CLI_TIMEOUT_MS`      | `300000`                    | Inactivity timeout (CLI-side tools can be silent on stdout for minutes).                    |
| `PI_CLAUDE_CLI_AGENT_WAIT_MS`   | `900000`                    | Hard ceiling on holding a turn open for background sub-agents.                              |
| `PI_CLAUDE_CLI_NO_AGENT_WAIT`   | off                         | `1` ends the turn at `result` even with sub-agents still running.                           |
| `PI_CLAUDE_CLI_STATE_DIR`       | `~/.pi/agent/pi-claude-cli` | Where the session sidecar map and stored system prompts live.                               |
| `MCP_TOOL_TIMEOUT`              | `3600000`                   | Passed to the CLI when unset — a proxied call blocks until pi has run the tool.             |

The sections below explain the ones with real consequences.

## What your Claude environment contributes

By default a real `claude -p` process lives across turns in your workspace, so
your Claude Code environment participates through three doors:

1. **Tools** — the six built-ins (Read/Write/Edit/Bash/Grep/Glob) execute
   natively in Claude Code. Only custom pi tools become pi tool calls.
2. **CLI-side execution** — your personal/project MCP servers, WebSearch, and
   sub-agents run _inside_ the CLI between cycles. They appear in the
   transcript as one-line markers (`[Claude Code · WebSearch {…}]`) and bill
   your plan.
3. **Prompt-level osmosis** — the CLI auto-loads project CLAUDE.md and memory,
   your hooks fire, and skills can load twice (natively via claude, and again
   via pi's own `~/.claude/skills` support).

### Pi context with native tools (0.7.1+)

`PI_CLAUDE_CLI_CONTEXT=pi` makes pi the source for project instructions, skills
and custom integrations, while **retaining Claude Code's default prompt and
native tools**. The generated pi tool guidance is aligned to native schemas;
artifact guidance, user instructions and `.pi` paths are preserved. Duplicate
Claude discovery is disabled, but explicit host guards remain enabled.

Requires Claude Code **2.1.263+**. Hosts must retain pi context-file discovery
(no `--no-context-files`) and start fresh sessions when changing policies. Do
not combine this with system-prompt replacement or bare mode. See
[the context-policy contract](docs/CONTEXT-POLICY.md) for launch controls,
limitations, and the opt-in live verification.

### Hermetic mode

Set `PI_CLAUDE_CLI_HERMETIC=1` to keep that environment out of pi turns: the
subprocess runs with `--strict-mcp-config` (only this extension's schema-only
custom-tools server loads) and an empty `--setting-sources` (no user/project/
local settings — hooks, auto-memory, permission allowlists). Model access and
your subscription login are unaffected.

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

## Tool markers

### What a call marker contains

`argsJson` is complete, parseable JSON as of 0.8.0. It used to be
`JSON.stringify(input)` cut at 120 characters, which meant it usually did not
parse, and the cut took the END off values — so `Read` of a deep worktree path
rendered as `Read cl…` while the marker spent its whole budget on directory
names. `src/tool-markers.ts` now picks each tool's identifying arguments in
priority order, clips values one at a time (paths from the front, so the
filename survives), replaces bulk arguments with measurements rather than
dumping them, and enforces its 700-character budget by dropping trailing fields
instead of cutting the document:

```
[Claude Code · Read {"file_path":"…/features/chat/items/transcriptRows.ts"}]
[Claude Code · Write {"file_path":"/repo/poem.txt","lines":3,"bytes":70}]
[Claude Code · Edit {"file_path":"/repo/a.ts","new_lines":3,"old_lines":2}]
[Claude Code · TodoWrite {"todos":4,"done":2,"active":"Wiring the marker"}]
```

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

`payloadJson` is complete, parseable JSON. Every payload carries `status`
(`"ok"` / `"error"`), the `tool` it answers, a printable `summary`, the
`preview` (capped at 2,000 characters) and the full `length` — plus whatever
metrics the tool's own result made available:

| Tool             | Metrics                                 | `summary`                                       |
| ---------------- | --------------------------------------- | ----------------------------------------------- |
| `Read`           | `path`, `lines`, `totalLines`           | `419 lines` / `lines 201-300 of 900`            |
| `Bash`           | `lines`, `bytes`, `stderrLines`         | `4 lines out · 2 on stderr`                     |
| `Bash` (failed)  | `exitCode`, `error`                     | `exit 1 · ls: /nope: No such file or directory` |
| `Edit` / `Write` | `path`, `added`, `removed`, `lines`     | `+1 -1 in poem.txt` / `created poem.txt`        |
| `Grep`           | `files`, `matches`                      | `1 match` / `12 matches in 3 files`             |
| `Glob`           | `files`, `durationMs`, `filesTruncated` | `4 files`                                       |
| anything else    | `lines`                                 | `12 lines` / `empty`                            |

These come from the CLI's own `tool_use_result` object, which it publishes on
the `user` envelope beside each `tool_result`. A tool whose shape this provider
does not recognise still gets `status`, `summary` and a line count, so a row is
never reduced to "ok". The full output stays in the CLI's own transcript.

Results are only forwarded for tools that produced a call marker — handoff
tools are executed by pi, which already has their real result, and their
replayed `tool_result` envelopes are ignored.

This is a host **opt-in** because it changes the marker wire contract: a
front-end that has not learned the id-tagged shapes would render them as prose.
Leave it unset and the call marker keeps its pre-0.6.0 shape (`0.8.0` still
improves what is inside `argsJson` — see above).

## The persistent CLI process

Before 0.7.0 every pi call was its own `claude -p` process: a custom-tool
handoff denied the permission, interrupted the CLI, ran the tool in pi and
`--resume`d a new process with the result pasted in as text; every user turn
started another. Each new process rebuilt Claude Code's system prompt, and that
prompt snapshots `git status`, the recent commits and the branch. So a commit,
a branch rename or a new untracked file between two processes re-billed the
**entire** context as cache write — measured 2026-09-01 on one session: 64k,
106k and 190k tokens on three separate restarts, 1.87M tokens across three
sessions that day. The restart also left `tool use was rejected` /
`[Request interrupted]` / `No response requested.` filler in the CLI transcript
on every custom tool call.

Now the process stays up. A custom tool call is **allowed** and proxied: the
schema-only MCP server forwards `tools/call` to pi over a local socket, pi runs
the tool, and the next pi call answers the CLI on the same process — its
transcript records a real `tool_result`. After a turn ends the process is
parked and the next user message goes to the same stdin. Measured live
(`tests/live-persistent.test.ts`): a turn after a commit costs 91 cache-write
tokens on the persistent process versus 8,827 on a fresh one.

Reaching that socket means being able to make pi run a tool, so since 0.8.2 it
is private. The socket, the tool schemas, every `--mcp-config` and every staged
system prompt live in a randomly-named `0700` per-process directory and are
written `0600`; each request carries a per-process secret, which the schema
server reads from a file rather than taking on its command line (argv is
world-readable). Before that they were pid-named files in a shared `/tmp` with
default permissions — see
[the runtime directory](docs/ARCHITECTURE.md#the-runtime-directory-and-who-may-reach-the-broker).

A parked process is retired — cleanly, never mid-turn — when the next call does
not match it: a different model or effort, a changed system-prompt mode, a
rewritten tool schema (a new MCP server connected), a pi history the CLI never
saw, or a delta that is not exactly the awaited tool results. The next call then
`--resume`s the CLI session in a fresh process, exactly as every call did
before. Ending pi ends its parked processes: their stdin is a pipe from pi, and
the CLI exits on EOF.

## Compaction

### The auto-compact window

The provider resumes **one** CLI session for a pi session's whole life, and
nothing else ever shrinks it. On 1M-context models the CLI's own auto-compact
default lets that session ratchet toward a million tokens — measured across 26
real sessions, contexts reached 480k+, the average request carried 202k tokens,
and every request re-reads the full context. So the provider passes
`--autocompact 200000` **by default**: Claude Code compacts the session itself
when its context nears 200k, keeping the cached system-prompt prefix and full
transcript fidelity.

`PI_CLAUDE_CLI_AUTOCOMPACT` configures it:

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
past the window compacts immediately — one summarization pass, then the session
continues small. That is the remediation, not a bug.

### Compaction has one owner, and it is the CLI

pi's own compaction rewrites pi's transcript and never the CLI session's, so on
this provider it is pure loss: the model's context does not shrink and pi's
record of the session does. It is also not rare. pi compacts when the reported
context passes `contextWindow - reserveTokens` (about 183k on a 200k model), a
line a Claude session crosses long before a roomy `--autocompact` cap — one
captured session compacted pi's record nine times while the CLI compacted four.
A host should switch pi's auto-compaction off for sessions on this provider
(`set_auto_compaction` over RPC) and let `--autocompact` be the one budget.

When the CLI does compact, the stream carries a `system` envelope with
`subtype: "compact_boundary"`, and the provider (0.8.3+) does two things with
it. It resets the reported context to the compacted size — until then the latch
held the summarization pass's prompt, which is the whole pre-compaction
conversation, and pi was told 360k for a session the CLI had just cut to 37k.
And it appends a `[Claude Code · compact {"trigger":"auto","preTokens":…,
"postTokens":…,"durationMs":…}]` marker, so a host can draw its compaction
divider where the cut actually happened. The CLI continues the turn on the
compacted context by itself; nothing is written to stdin to make that happen.

## Which system prompt

`PI_CLAUDE_CLI_SYSTEM_PROMPT` chooses whose system prompt the subprocess runs
under.

| Value                | Behaviour                                                                      |
| -------------------- | ------------------------------------------------------------------------------ |
| `claude` _(default)_ | `--append-system-prompt-file`: pi's prompt layers on top of Claude Code's own. |
| `pi`                 | `--system-prompt-file`: pi's prompt replaces Claude Code's entirely.           |

The `-file` suffix matters: `--system-prompt` / `--append-system-prompt`
(unsuffixed) take a **literal string**, not a path. Passing a temp-file path to
the unsuffixed flag makes the path itself the prompt — pi's instructions never
reach the model, silently, with no error. That shipped unnoticed from the
provider's first system-prompt support until it was fixed in 0.4.16 by
switching to the `-file` flags.

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
instructions plus the raw tool schemas. To stop that being actively misleading,
`pi` mode rewrites pi's tool sections — which name pi's tools (`read`, `edit`,
`grep`, `find`, `ls`) and pi's parameters (`path`, `oldText`, `newText`) — into
Claude Code's vocabulary (`Read`, `Edit`, `Grep`, `Glob`, with `file_path`,
`old_string`, `new_string`). If pi ever restyles its prompt so the
`Available tools:` / `Guidelines:` anchors are missing, the prompt passes
through untouched rather than being mangled.

The system prompt goes on **every** spawn, not just the session-creating one:
the CLI does not keep `--system-prompt-file` across `--resume`, and a resumed
session without it silently reverts to Claude Code's default prompt from turn 2
onwards. Because an identical prefix is what keeps the prompt cache warm, the
prompt a session was created with is stored in the sidecar
(`~/.pi/agent/pi-claude-cli/sysprompt/<cli-session-id>.txt`) and replayed
verbatim rather than rebuilt. A change to the mode therefore takes effect on the
next new session, not the current one.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — turn lifecycle, the three-way
  tool split, the two-ledger session model, error recovery, CLI compatibility.
- [docs/CONTEXT-POLICY.md](docs/CONTEXT-POLICY.md) — the `PI_CLAUDE_CLI_CONTEXT=pi`
  host contract.
- [docs/SPEC-observer-mode.md](docs/SPEC-observer-mode.md) — the spec observer
  mode was built from.
- [CLAUDE.md](CLAUDE.md) — commands, release flow, and the repo's own rules.

## License

MIT
