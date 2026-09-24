# pi-claude-cli

A pi provider that uses the official Claude Code CLI for subscription authentication and model access. No build step: pi loads `index.ts` and its TypeScript imports.

Read [README.md](README.md) and [docs/CONTEXT-POLICY.md](docs/CONTEXT-POLICY.md) before changing behavior. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the explicit legacy observer path and old transcript marker contracts, not the default.

## Commands

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage
npm run test:e2e
PI_OWNED_LIVE=1 npx vitest run tests/live-context-policy.test.ts
```

CI runs lint, formatting, typecheck, coverage and deterministic e2e on Linux, macOS and Windows. Coverage floors: 92% lines/functions/statements, 88% branches. Live tests spend subscription tokens and are opt-in.

## Architecture

- `index.ts`: register with both pi's provider composer and pi-ai's compatibility registry. Build MCP schemas from the current request, never activate registry tools. Retire parked processes at lifecycle changes and clear provider UI status.
- `src/pi-context.ts`: normalize old/new pi context formats, import ordered messages and images, hash acknowledged history, and bind MCP tool names.
- `src/provider.ts`: orchestrate a provider episode, stream events, park only a matching process, hand tools back to pi, return structured failures.
- `src/process-manager.ts`: launch flags/environment and subprocess lifecycle. Default replaces the prompt, disables native tools and session persistence, preserves explicit host guards and OAuth. Never use bare mode.
- `src/cli-process.ts`: warm process and authenticated tool handoff lifecycle. One episode attached at a time. Retirement cleans MCP config and releases pending calls.
- `src/handoff-broker.ts`, `mcp-schema-server.cjs`: schema-only MCP bridge. Execution always occurs in pi. Private per-process runtime directory, authenticated local requests, match the actual tool-use id and name.
- `src/event-bridge.ts`: convert events to pi messages. Content indexes restart each model cycle, so track `(cycle,index)`. Empty encrypted thinking must not create visible blocks.
- `src/session-map.ts`, native tool mappings, legacy prompt conversion: retained for explicit legacy compatibility. The default never creates pairings or stored prompts and detaches old pairings on use.

## Invariants

1. pi owns the prompt, active tools, complete tool results and compaction. Claude is a disposable process cache, not a second conversation ledger.
2. A warm process may continue only when its acknowledged pi-history prefix and launch signature match. Context rewrites, model changes and compaction must not resume stale history.
3. Handoffs return real pi toolCall blocks; the CLI waits for the matching pi result. Do not re-execute historical tools. Native tools are disabled by default; explicit legacy mode preserves marker behavior.
4. Do not mutate another provider's active tools or auto-compaction setting. Provider switches clear parked processes and UI status.
5. Default CLI sessions do not persist. Existing legacy archives remain available but are not used on the default path. Do not delete user archives as a cleanup shortcut.
6. Preserve host/managed guards and official subscription authentication. Never extract OAuth tokens or disable all hooks.
7. Keep rate limits and other provider UI state out of conversation content.
8. Report errors as assistant error messages and aborts as aborted. Never return a raw string where pi expects an assistant message.

## Conventions

ESM imports use `.js` specifiers for local TypeScript. The standalone MCP server is intentionally CommonJS. Tests live in `tests/`. Old observer fixtures explicitly select `legacy`; new default tests must unset `PI_CLAUDE_CLI_CONTEXT`.

## Releases

The publish workflow only ships when `package.json` has a version not already on npm. Bump in the release PR (`npm version minor --no-git-tag-version` for a changed default). A merge without a bump publishes nothing. Do not call a source change installed until the package is published and the user's pi installation has been updated.
