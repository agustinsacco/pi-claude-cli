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

The extension registers as a custom pi provider exposing all Claude models. Each request spawns a `claude -p` subprocess using the stream-json wire protocol, with `--resume` on follow-up turns to reuse the CLI's session state instead of replaying full history. Claude proposes tool calls, pi executes them natively. Custom pi tools are exposed to Claude via a schema-only MCP server.

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
- Session resume via `--resume` eliminates history replay on follow-up turns
- Configurable thinking effort across the full ladder (low to max) for all models, with elevated mapping for Opus
- Cross-platform subprocess management (Windows, macOS, Linux)
- Inactivity timeout and process registry for cleanup

## License

MIT
