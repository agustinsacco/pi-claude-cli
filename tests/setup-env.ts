/**
 * Drop this extension's own knobs before any test runs.
 *
 * Every `PI_CLAUDE_CLI_*` variable changes what the provider does, and the
 * most likely place to run these tests is a session that is ITSELF driven by
 * this extension — a pidex Claude session exports `PI_CLAUDE_CLI_CONTEXT=pi`,
 * `PI_CLAUDE_CLI_STRICT_MCP=1` and `PI_CLAUDE_CLI_AUTOCOMPACT` into every
 * shell it spawns. Inherited, `PI_CLAUDE_CLI_CONTEXT=pi` alone made 125 tests
 * fail: `spawnClaude` shells out to `claude --version` under that policy, so
 * the mocked spawn was never reached, and the failures looked exactly like a
 * regression on main.
 *
 * Tests that need a knob set it themselves (and restore it), so clearing the
 * environment here can only remove ambient state.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_CLAUDE_CLI_")) delete process.env[key];
}
