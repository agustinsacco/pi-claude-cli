/**
 * Payload builders for the two CLI-side tool markers.
 *
 * In observer mode the CLI executes its own tools and pi's transcript records
 * each one as a one-line text block that a front-end parses into an activity
 * row (`src/event-bridge.ts` owns the string shapes; this module owns what
 * goes inside them):
 *
 *   [Claude Code · <ToolName> #<toolUseId> <argsJson>]
 *   [Claude Code · result #<toolUseId> <payloadJson>]
 *
 * Both payloads are COMPLETE, PARSEABLE JSON. That is the whole point of this
 * module. The call payload used to be `JSON.stringify(input).slice(0, 120)` —
 * a blind cut through the middle of a JSON document — and the damage was not
 * cosmetic:
 *
 * - The cut lands wherever it lands, so `JSON.parse` fails on most markers
 *   and every consumer needs a fragment scanner to recover pairs (Phosphor grew
 *   ~90 lines of one, including a hand-written escape decoder, because a cut
 *   right after a backslash left an orphaned escape).
 * - It cuts the END off values, which for a file path is the ONLY part worth
 *   showing: an absolute path in a worktree spends its first 120 characters
 *   on directories, so `Read` rows read "Read cl…" instead of naming the
 *   file. Paths are clipped from the FRONT here.
 * - One bulk argument starves everything after it. `Write` sends the entire
 *   file in `content`, `Edit` sends both sides of the replacement, `Task`
 *   sends the sub-agent's whole prompt — all of them ahead of, or instead of,
 *   the fields that identify the call. Bulk fields are replaced by their
 *   measurements here (`lines`, `bytes`, `edits`), never dumped.
 *
 * The result payload gets the same treatment in reverse: the CLI publishes a
 * `tool_use_result` object on the `user` envelope with real structure —
 * `numLines`/`totalLines` for a read, `structuredPatch` for an edit,
 * `stdout`/`stderr`/`interrupted` for a command, `numFiles` for a glob — and
 * it was being thrown away in favour of a text preview. Those become typed
 * metrics plus a `summary` string a host can print verbatim.
 */

/** Longest a single argument value may be, after clipping. */
const FIELD_LIMIT = 200;

/**
 * Longest the whole call payload may be.
 *
 * Enforced by DROPPING trailing (lower-priority) fields, never by cutting the
 * JSON — the leading fields are the identifying ones, so what survives is
 * what a row needs. A marker is one line in pi's session file for every tool
 * the CLI runs, so the budget stays modest: 300 tools of headroom costs
 * ~200kB, and the CLI's own transcript keeps the unabridged arguments.
 */
const PAYLOAD_LIMIT = 700;

/** Longest a `summary` string may be. */
const SUMMARY_LIMIT = 160;

/**
 * Which arguments identify a call, per tool, in priority order.
 *
 * Anything not listed is dropped for a known tool — the CLI's own transcript
 * has the full arguments, and a marker exists to be scanned, not archived.
 * An unknown tool (MCP servers, tools added by a newer CLI) falls back to
 * every scalar argument it sent, in the order it sent them.
 */
const CALL_FIELDS: Record<string, string[]> = {
  Read: ["file_path", "offset", "limit"],
  NotebookRead: ["notebook_path"],
  Write: ["file_path"],
  Edit: ["file_path", "replace_all"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path", "cell_id", "edit_mode"],
  Bash: ["command", "description", "run_in_background", "timeout"],
  BashOutput: ["bash_id", "shell_id", "filter"],
  KillShell: ["shell_id"],
  Grep: [
    "pattern",
    "path",
    "glob",
    "type",
    "output_mode",
    "-i",
    "-n",
    "head_limit",
  ],
  Glob: ["pattern", "path"],
  LS: ["path"],
  WebFetch: ["url", "prompt"],
  WebSearch: ["query"],
  Task: ["description", "subagent_type", "prompt"],
  Agent: ["description", "subagent_type", "prompt"],
  Skill: ["command", "skill"],
  ToolSearch: ["query"],
  ExitPlanMode: ["plan"],
};

/**
 * Arguments clipped from the FRONT, keeping their tail.
 *
 * A path's information is at the end. So is a URL's, once the host is past.
 */
const TAIL_CLIPPED_FIELDS = new Set([
  "file_path",
  "notebook_path",
  "path",
  "url",
]);

/**
 * Bulk arguments, replaced by measurements instead of being shown.
 *
 * The metric names are deliberately the same ones the result payload uses,
 * so a front-end learns `lines`/`bytes` once.
 */
const MEASURED_FIELDS: Record<string, "lines" | "bytes"> = {
  content: "lines",
  new_string: "lines",
  old_string: "lines",
  plan: "lines",
};

/**
 * Clip one value, keeping its newlines.
 *
 * Collapsing whitespace here would spend less of the budget on a shell
 * heredoc, and it costs more than it saves: a front-end picks the OPERATIVE
 * line out of a multi-line command (skipping the `cd`/`export` preamble) and
 * counts the rest as "+N more". Flattened to one line, that logic sees a
 * single line and puts the setup on the row instead of the work. The marker
 * stays one line regardless — `JSON.stringify` escapes the newlines.
 */
function clip(value: string, limit: number, keep: "head" | "tail"): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  return keep === "tail"
    ? `…${text.slice(-(limit - 1))}`
    : `${text.slice(0, limit - 1)}…`;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  // A trailing newline does not start a line.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}

/**
 * One argument as it should appear in a marker: a clipped string, a number, a
 * boolean, an array's length, or nothing at all.
 */
function markerValue(
  key: string,
  value: unknown,
): string | number | boolean | undefined {
  if (typeof value === "string") {
    if (value.length === 0) return undefined;
    return clip(
      value,
      FIELD_LIMIT,
      TAIL_CLIPPED_FIELDS.has(key) ? "tail" : "head",
    );
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  // An array of edits, todos or queries is worth its count. An object is not
  // worth guessing at.
  if (Array.isArray(value)) return value.length;
  return undefined;
}

/** Field order for a tool: its own table, or whatever the CLI sent. */
function fieldOrder(tool: string, input: Record<string, unknown>): string[] {
  const known = CALL_FIELDS[tool];
  if (!known) return Object.keys(input);
  // Listed fields first, in table order; nothing else for a known tool.
  return known.filter((key) => key in input);
}

/**
 * Tool-specific fields derived from bulk arguments.
 *
 * `TodoWrite` is handled entirely here: its only argument is the whole list,
 * so the useful marker is the shape of the list plus the item now in flight —
 * which is the one line of a todo update anybody reads.
 */
function derivedFields(
  tool: string,
  input: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const derived: Record<string, string | number | boolean> = {};

  if (tool === "TodoWrite") {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    derived.todos = todos.length;
    let done = 0;
    let active: string | undefined;
    for (const todo of todos) {
      if (!todo || typeof todo !== "object") continue;
      const entry = todo as Record<string, unknown>;
      if (entry.status === "completed") done++;
      if (entry.status === "in_progress" && active === undefined) {
        const label = entry.activeForm ?? entry.content;
        if (typeof label === "string") active = clip(label, 80, "head");
      }
    }
    derived.done = done;
    if (active !== undefined) derived.active = active;
    return derived;
  }

  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    derived.edits = input.edits.length;
  }

  for (const [key, metric] of Object.entries(MEASURED_FIELDS)) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) continue;
    // `Edit` sends both sides; report the one being written.
    const name =
      key === "old_string"
        ? "old_lines"
        : key === "new_string"
          ? "new_lines"
          : metric;
    if (derived[name] === undefined) derived[name] = countLines(value);
    if (key === "content" && derived.bytes === undefined) {
      derived.bytes = Buffer.byteLength(value, "utf8");
    }
  }

  return derived;
}

/**
 * Build the argument payload for a call marker.
 *
 * Returns the JSON text, or an empty string when there is nothing worth
 * saying — a zero-argument tool call, which stays `[Claude Code · Bash]`.
 * The result always parses.
 */
export function buildCallPayload(
  tool: string,
  input: Record<string, unknown> | undefined,
): string {
  if (!input || typeof input !== "object") return "";

  const derived = derivedFields(tool, input);
  const entries: Array<[string, string | number | boolean]> = [];
  for (const key of fieldOrder(tool, input)) {
    // A bulk argument is reported as its measurement instead, and a field the
    // derivation already summarised (`todos`, `edits`) must not be doubled.
    if (key in MEASURED_FIELDS || derived[key] !== undefined) continue;
    const value = markerValue(key, input[key]);
    if (value !== undefined) entries.push([key, value]);
  }
  for (const [key, value] of Object.entries(derived)) {
    entries.push([key, value]);
  }
  if (entries.length === 0) return "";

  // Add fields while they fit. The first field is the identifying one, so it
  // is shortened rather than dropped if it alone blows the budget.
  const payload: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    const candidate = { ...payload, [key]: value };
    const size = JSON.stringify(candidate).length;
    if (size <= PAYLOAD_LIMIT) {
      payload[key] = value;
      continue;
    }
    if (Object.keys(payload).length > 0) break;
    if (typeof value !== "string") break;
    const room = PAYLOAD_LIMIT - JSON.stringify({ [key]: "" }).length - 8;
    if (room <= 0) break;
    payload[key] = clip(
      value,
      room,
      TAIL_CLIPPED_FIELDS.has(key) ? "tail" : "head",
    );
    break;
  }

  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : "";
}

/**
 * Cap on the forwarded result preview. The full output lives in the CLI's
 * own transcript; this preview exists so a front-end can show "what came
 * back" without pi's session file growing by megabytes on a 300-tool
 * session. `length` in the payload always reports the uncapped size.
 */
export const RESULT_PREVIEW_LIMIT = 2000;

/** What the bridge knows about one finished CLI-side tool call. */
export interface ToolOutcome {
  /** Claude tool name from the paired call marker, when the bridge has it. */
  tool?: string;
  isError: boolean;
  /** The `tool_result` content, flattened to text. */
  text: string;
  /** The envelope's `tool_use_result`, when the CLI published one. */
  detail?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `+3 -1` from a `structuredPatch`, the shape `Edit`/`Write` report. */
function patchStats(detail: Record<string, unknown>): {
  added: number;
  removed: number;
} | null {
  const hunks = detail.structuredPatch;
  if (!Array.isArray(hunks)) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    const lines = asRecord(hunk)?.lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

/**
 * Metrics and a one-line summary for a finished tool call.
 *
 * Keyed off the CLI's `tool_use_result` shapes, verified against a live
 * `claude --output-format stream-json` capture (2026-09-09, claude 2.1.x):
 *
 *   Read   {type:"text", file:{filePath, numLines, startLine, totalLines}}
 *   Write  {type:"create", filePath, content, structuredPatch}
 *   Edit   {filePath, structuredPatch:[{lines:[…]}], replaceAll}
 *   Bash   {stdout, stderr, interrupted, isImage}          (string on error)
 *   Grep   {mode, numFiles, filenames, numLines, totalLines}
 *   Glob   {filenames, numFiles, totalMatches, truncated, durationMs}
 *
 * Every branch is optional: a CLI that publishes no `tool_use_result`, or a
 * tool whose shape is new, falls through to counting the text. Nothing here
 * may throw — a marker is written inside a turn.
 */
function describeOutcome(outcome: ToolOutcome): {
  metrics: Record<string, string | number | boolean>;
  summary?: string;
} {
  const metrics: Record<string, string | number | boolean> = {};
  const detail = asRecord(outcome.detail);
  const tool = outcome.tool ?? "";

  // An error reported as a bare string ("Error: Exit code 1\n…") is the CLI's
  // shape for a failed Bash, and the only place the exit code appears.
  const errorText =
    typeof outcome.detail === "string" && outcome.detail.length > 0
      ? outcome.detail
      : outcome.text;
  if (outcome.isError) {
    const exit = /(?:^|\n)(?:Error:\s*)?Exit code (\d+)/.exec(errorText);
    if (exit) metrics.exitCode = Number(exit[1]);
    // First non-empty line, minus the CLI's own "Error:" and exit-code
    // preamble: what is left is the message worth putting on a row.
    const message = errorText
      .split("\n")
      .map((line) => line.replace(/^Error:\s*/, "").trim())
      .filter((line) => line.length > 0 && !/^Exit code \d+$/.test(line))[0];
    if (message) metrics.error = clip(message, SUMMARY_LIMIT, "head");
    const summary =
      metrics.exitCode !== undefined
        ? `exit ${metrics.exitCode}${metrics.error ? ` · ${metrics.error}` : ""}`
        : typeof metrics.error === "string"
          ? metrics.error
          : "failed";
    return { metrics, summary: clip(summary, SUMMARY_LIMIT, "head") };
  }

  const file = asRecord(detail?.file);
  if (file) {
    // Read: the file's own numbers, which say more than the text preview
    // (whose line numbers the CLI has already stamped in).
    const path = typeof file.filePath === "string" ? file.filePath : undefined;
    if (path) metrics.path = clip(path, FIELD_LIMIT, "tail");
    const lines = num(file.numLines);
    const total = num(file.totalLines);
    const start = num(file.startLine);
    if (lines !== undefined) metrics.lines = lines;
    if (total !== undefined) metrics.totalLines = total;
    let summary: string | undefined;
    if (lines !== undefined && total !== undefined && lines < total) {
      const from = start ?? 1;
      summary = `lines ${from}-${from + lines - 1} of ${total}`;
    } else if (lines !== undefined) {
      summary = plural(lines, "line");
    }
    return { metrics, summary };
  }

  if (detail && (typeof detail.stdout === "string" || tool === "Bash")) {
    const stdout = typeof detail.stdout === "string" ? detail.stdout : "";
    const stderr = typeof detail.stderr === "string" ? detail.stderr : "";
    metrics.lines = countLines(stdout);
    metrics.bytes = Buffer.byteLength(stdout, "utf8");
    if (stderr.length > 0) metrics.stderrLines = countLines(stderr);
    if (detail.interrupted === true) metrics.interrupted = true;
    const parts: string[] = [];
    parts.push(
      metrics.lines === 0
        ? "no output"
        : `${plural(metrics.lines, "line")} out`,
    );
    if (metrics.stderrLines !== undefined) {
      parts.push(`${metrics.stderrLines} on stderr`);
    }
    if (metrics.interrupted) parts.push("interrupted");
    return { metrics, summary: parts.join(" · ") };
  }

  const patch = detail ? patchStats(detail) : null;
  if (detail && patch && (patch.added > 0 || patch.removed > 0)) {
    const path =
      typeof detail.filePath === "string" ? detail.filePath : undefined;
    if (path) metrics.path = clip(path, FIELD_LIMIT, "tail");
    metrics.added = patch.added;
    metrics.removed = patch.removed;
    const where = path ? ` in ${basename(path)}` : "";
    return { metrics, summary: `+${patch.added} -${patch.removed}${where}` };
  }

  if (detail && detail.type === "create") {
    const path =
      typeof detail.filePath === "string" ? detail.filePath : undefined;
    const content = typeof detail.content === "string" ? detail.content : "";
    if (path) metrics.path = clip(path, FIELD_LIMIT, "tail");
    metrics.lines = countLines(content);
    metrics.bytes = Buffer.byteLength(content, "utf8");
    return {
      metrics,
      summary: `created${path ? ` ${basename(path)}` : ""} · ${plural(metrics.lines, "line")}`,
    };
  }

  if (detail && Array.isArray(detail.filenames)) {
    // Glob and Grep both report `filenames`; Grep in content mode also
    // reports the matching lines, which is the number that matters there.
    const files = num(detail.numFiles) ?? detail.filenames.length;
    const matches = num(detail.numLines);
    metrics.files = files;
    if (matches !== undefined) metrics.matches = matches;
    const duration = num(detail.durationMs);
    if (duration !== undefined) metrics.durationMs = duration;
    // NOT `truncated`: that key belongs to the text preview at the bottom of
    // the payload, and the two truncations mean different things.
    if (detail.truncated === true) metrics.filesTruncated = true;
    const summary =
      matches !== undefined && files === 0
        ? plural(matches, "match", "matches")
        : matches !== undefined && matches > 0
          ? `${plural(matches, "match", "matches")} in ${plural(files, "file")}`
          : plural(files, "file");
    return { metrics, summary };
  }

  // Nothing structured: count what came back. Still beats silence — a row
  // can say "12 lines" instead of nothing at all.
  const lines = countLines(outcome.text);
  if (lines > 0) {
    metrics.lines = lines;
    return { metrics, summary: plural(lines, "line") };
  }
  return { metrics, summary: outcome.text.length > 0 ? undefined : "empty" };
}

/**
 * Build the payload for a result marker: status, the tool it belongs to,
 * typed metrics, a printable `summary`, and a capped text preview.
 *
 * Key order is stable and additive — a consumer reads the keys it knows.
 */
export function buildResultPayload(
  outcome: ToolOutcome,
): Record<string, unknown> {
  const { metrics, summary } = describeOutcome(outcome);
  const payload: Record<string, unknown> = {
    status: outcome.isError ? "error" : "ok",
  };
  if (outcome.tool) payload.tool = outcome.tool;
  if (summary) payload.summary = summary;
  Object.assign(payload, metrics);
  payload.preview = outcome.text.slice(0, RESULT_PREVIEW_LIMIT);
  payload.length = outcome.text.length;
  if (outcome.text.length > RESULT_PREVIEW_LIMIT) payload.truncated = true;
  return payload;
}
