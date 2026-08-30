/**
 * Auto-compact window resolution (PI_CLAUDE_CLI_AUTOCOMPACT).
 *
 * Claude Code compacts a session automatically when its context approaches
 * the auto-compact window (`--autocompact <auto|tokens>`, claude 2.1.x). On
 * 1M-context models the CLI's own default lets a long-lived session ratchet
 * toward a million tokens, and this provider resumes ONE CLI session for a
 * pi session's whole life — nothing else ever shrinks it. Measured across
 * 26 real pidex sessions (2026-08-30): contexts ratcheted to 480k+, the
 * average request carried 202k tokens, and cache reads alone were ~53% of
 * total spend. Sessions that stayed near 100–150k did the same work at a
 * fraction of the cost.
 *
 * So the provider caps the window at 200k tokens BY DEFAULT — the budget
 * these models run under everywhere the 1M beta is not enabled — and lets
 * the host raise, lower, or disable it:
 *
 *   PI_CLAUDE_CLI_AUTOCOMPACT=200k      cap at 200k (the default)
 *   PI_CLAUDE_CLI_AUTOCOMPACT=400000    plain token counts work too
 *   PI_CLAUDE_CLI_AUTOCOMPACT=400       bare numbers are thousands (CLI shorthand)
 *   PI_CLAUDE_CLI_AUTOCOMPACT=auto      the CLI's own default behaviour
 *   PI_CLAUDE_CLI_AUTOCOMPACT=off       omit the flag entirely (also: 0, none,
 *                                       disable, disabled — for CLIs that
 *                                       predate --autocompact)
 *
 * The value is a token COUNT, not a percentage of the model's window. The
 * costs this guards against are absolute — cache read/write bill per token,
 * and every request re-reads the whole context — so "half the window" means
 * something completely different on a 200k model than on a 1M one, while
 * 200k tokens costs the same everywhere.
 *
 * An invalid or out-of-range value falls back to the default with a warning
 * rather than being passed through: the CLI rejects bad values by refusing
 * to start, which would kill every turn of every session over a typo.
 */

/** Default auto-compact window, in tokens. */
export const DEFAULT_AUTOCOMPACT_TOKENS = 200_000;

/** The CLI accepts 100k–1M (claude 2.1.231: "It must be 'auto', or between 100k and 1M"). */
const MIN_TOKENS = 100_000;
const MAX_TOKENS = 1_000_000;

const OFF_VALUES = new Set([
  "off",
  "0",
  "none",
  "disable",
  "disabled",
  "false",
]);

/**
 * Parse a user-supplied window size into a token count.
 * Mirrors the CLI's accepted forms: `500k`, `1M`, `200000`, and bare `200`
 * meaning thousands. Returns undefined when unparseable.
 */
export function parseAutocompactTokens(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const suffix = (m[2] ?? "").toLowerCase();
  if (suffix === "k") return Math.round(n * 1_000);
  if (suffix === "m") return Math.round(n * 1_000_000);
  // Bare number: the CLI reads `200` as 200k shorthand; anything that already
  // looks like a token count (>= 100k) is taken literally.
  return n < MIN_TOKENS ? Math.round(n * 1_000) : Math.round(n);
}

/**
 * Resolve the `--autocompact` argument from the environment.
 *
 * Returns the string to pass to the flag, or undefined to omit the flag
 * entirely (explicit off). Unset resolves to the 200k default; `auto` is
 * passed through so the CLI applies its own default; invalid values warn
 * and fall back to the default.
 */
export function resolveAutocompact(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = (env.PI_CLAUDE_CLI_AUTOCOMPACT ?? "").trim();
  if (raw === "") return String(DEFAULT_AUTOCOMPACT_TOKENS);

  const lowered = raw.toLowerCase();
  if (OFF_VALUES.has(lowered)) return undefined;
  if (lowered === "auto") return "auto";

  const tokens = parseAutocompactTokens(raw);
  if (tokens === undefined || tokens < MIN_TOKENS || tokens > MAX_TOKENS) {
    console.warn(
      `[pi-claude-cli] PI_CLAUDE_CLI_AUTOCOMPACT=${JSON.stringify(raw)} is not ` +
        `'auto', 'off', or a window between 100k and 1M — using the default ` +
        `${DEFAULT_AUTOCOMPACT_TOKENS} tokens`,
    );
    return String(DEFAULT_AUTOCOMPACT_TOKENS);
  }
  return String(tokens);
}
