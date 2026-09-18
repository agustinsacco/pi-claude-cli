import { describe, it, expect } from "vitest";
import {
  buildCallPayload,
  buildResultPayload,
  RESULT_PREVIEW_LIMIT,
} from "../src/tool-markers";

/**
 * Marker payloads (src/tool-markers.ts).
 *
 * Two invariants dominate this file, because breaking either is what the
 * module exists to prevent:
 *
 * 1. **Every payload parses.** Consumers `JSON.parse` these. The old builder
 *    cut `JSON.stringify(input)` at 120 characters, so most markers did not
 *    parse and Phosphor needed a fragment scanner with its own escape decoder.
 * 2. **The identifying value survives.** A blind cut takes the END off, which
 *    for an absolute path is the filename — the only part a row shows.
 *
 * The `tool_use_result` shapes asserted below were captured from a live
 * `claude -p --output-format stream-json --verbose` run on 2026-09-09
 * (claude 2.1.x), not invented.
 */
describe("buildCallPayload", () => {
  const parse = (json: string) => JSON.parse(json) as Record<string, unknown>;

  it("returns nothing for a call with no arguments", () => {
    expect(buildCallPayload("Bash", {})).toBe("");
    expect(buildCallPayload("Bash", undefined)).toBe("");
  });

  it("keeps the tail of a long path, so the filename survives", () => {
    // Long enough to be clipped: a worktree path spends its whole first
    // hundred characters on directories, which is how `Read cl…` happened.
    const path =
      "/Users/agustinsacco/src/agustinsacco/Phosphor/.phosphor/worktrees/" +
      "improve-in-pi-claude-cli-the-tool/packages/renderer/source/" +
      "features/chat/transcript/items/activity/external/rendering/" +
      "transcriptRows.ts";
    expect(path.length).toBeGreaterThan(200);
    const payload = parse(buildCallPayload("Read", { file_path: path }));
    // The whole point: a row can name the file. The front of the path is
    // directories, and it is what gets dropped.
    expect(String(payload.file_path).endsWith("transcriptRows.ts")).toBe(true);
    expect(String(payload.file_path).startsWith("…")).toBe(true);
  });

  it("keeps a short path whole", () => {
    expect(parse(buildCallPayload("Read", { file_path: "/a/b.txt" }))).toEqual({
      file_path: "/a/b.txt",
    });
  });

  it("parses even when the command is far longer than the budget", () => {
    const command = `ssh -o BatchMode=yes stark@stark '${"echo hi; ".repeat(200)}'`;
    const json = buildCallPayload("Bash", { command });
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.length).toBeLessThanOrEqual(720);
    expect(String(parse(json).command)).toMatch(/^ssh -o BatchMode=yes/);
    expect(String(parse(json).command)).toMatch(/…$/);
  });

  it("keeps a command's description beside it", () => {
    expect(
      parse(
        buildCallPayload("Bash", {
          command: "npm test",
          description: "Run unit tests",
          run_in_background: false,
        }),
      ),
    ).toEqual({
      command: "npm test",
      description: "Run unit tests",
      run_in_background: false,
    });
  });

  /**
   * A front-end picks the OPERATIVE line out of a multi-line command and
   * counts the rest as "+N more". Flatten the newlines here and it puts the
   * `cd`/`export` preamble on the row instead of the work. The marker stays
   * one line either way: JSON.stringify escapes them.
   */
  it("keeps the newlines of a multi-line command", () => {
    const json = buildCallPayload("Bash", {
      command: "set -e\ncd /tmp\nls -la\n",
    });
    expect(json.includes("\n")).toBe(false);
    expect(parse(json).command).toBe("set -e\ncd /tmp\nls -la");
  });

  it("measures a written file instead of dumping its contents", () => {
    const payload = parse(
      buildCallPayload("Write", {
        file_path: "/repo/poem.txt",
        content: "one\ntwo\nthree\n",
      }),
    );
    expect(payload).toEqual({
      file_path: "/repo/poem.txt",
      lines: 3,
      bytes: 14,
    });
    // `content` used to eat the entire budget before `file_path` was reached
    // on tools that send it first.
    expect(payload.content).toBeUndefined();
  });

  it("measures both sides of an edit instead of quoting them", () => {
    const payload = parse(
      buildCallPayload("Edit", {
        file_path: "/repo/a.ts",
        old_string: "a\nb",
        new_string: "a\nb\nc",
        replace_all: true,
      }),
    );
    expect(payload).toEqual({
      file_path: "/repo/a.ts",
      replace_all: true,
      new_lines: 3,
      old_lines: 2,
    });
  });

  it("counts a MultiEdit's edits", () => {
    expect(
      parse(
        buildCallPayload("MultiEdit", {
          file_path: "/repo/a.ts",
          edits: [{}, {}, {}],
        }),
      ),
    ).toEqual({ file_path: "/repo/a.ts", edits: 3 });
  });

  it("summarises a todo update by its shape and its live item", () => {
    expect(
      parse(
        buildCallPayload("TodoWrite", {
          todos: [
            { content: "Read the bridge", status: "completed" },
            { content: "Write the builder", status: "completed" },
            {
              content: "Wire the marker",
              activeForm: "Wiring the marker",
              status: "in_progress",
            },
            { content: "Update the docs", status: "pending" },
          ],
        }),
      ),
    ).toEqual({ todos: 4, done: 2, active: "Wiring the marker" });
  });

  it("keeps a search's pattern ahead of its options", () => {
    const payload = parse(
      buildCallPayload("Grep", {
        pattern: "parseExternalToolMarker",
        path: "src",
        output_mode: "content",
        "-n": true,
        head_limit: 20,
      }),
    );
    expect(Object.keys(payload)).toEqual([
      "pattern",
      "path",
      "output_mode",
      "-n",
      "head_limit",
    ]);
  });

  it("passes an unknown tool's scalar arguments through, arrays as counts", () => {
    expect(
      parse(
        buildCallPayload("mcp__linear__save_issue", {
          title: "Fix the marker",
          labels: ["bug", "ui"],
          estimate: 3,
          draft: false,
          nested: { ignored: true },
        }),
      ),
    ).toEqual({
      title: "Fix the marker",
      labels: 2,
      estimate: 3,
      draft: false,
    });
  });

  it("drops trailing fields rather than cutting the JSON", () => {
    const json = buildCallPayload("mcp__x__y", {
      first: "a".repeat(180),
      second: "b".repeat(180),
      third: "c".repeat(180),
      fourth: "d".repeat(180),
      fifth: "e".repeat(180),
    });
    const payload = parse(json);
    expect(json.length).toBeLessThanOrEqual(700);
    // Priority order: the leading fields identify the call.
    expect(Object.keys(payload)[0]).toBe("first");
    expect(Object.keys(payload).length).toBeLessThan(5);
  });

  it("shortens the first field when it alone exceeds the budget", () => {
    const json = buildCallPayload("WebSearch", { query: "q".repeat(5000) });
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.length).toBeLessThanOrEqual(700);
    expect(String(parse(json).query)).toMatch(/…$/);
  });

  it("drops empty strings, nulls and objects", () => {
    expect(buildCallPayload("mcp__x__y", { a: "", b: null, c: { d: 1 } })).toBe(
      "",
    );
  });
});

describe("buildResultPayload", () => {
  it("reports a full read by its line count", () => {
    expect(
      buildResultPayload({
        tool: "Read",
        isError: false,
        text: "1\talpha\n2\tbeta\n",
        detail: {
          type: "text",
          file: {
            filePath: "/tmp/notes.txt",
            numLines: 4,
            startLine: 1,
            totalLines: 4,
          },
        },
      }),
    ).toEqual({
      status: "ok",
      tool: "Read",
      summary: "4 lines",
      path: "/tmp/notes.txt",
      lines: 4,
      totalLines: 4,
      preview: "1\talpha\n2\tbeta\n",
      length: 15,
    });
  });

  it("reports a windowed read as the window it read", () => {
    const payload = buildResultPayload({
      tool: "Read",
      isError: false,
      text: "…",
      detail: {
        type: "text",
        file: {
          filePath: "/repo/big.ts",
          numLines: 100,
          startLine: 201,
          totalLines: 900,
        },
      },
    });
    expect(payload.summary).toBe("lines 201-300 of 900");
  });

  it("reports a command by its output volume", () => {
    expect(
      buildResultPayload({
        tool: "Bash",
        isError: false,
        text: "hi\nthere",
        detail: {
          stdout: "hi\nthere",
          stderr: "",
          interrupted: false,
          isImage: false,
        },
      }),
    ).toMatchObject({
      status: "ok",
      tool: "Bash",
      summary: "2 lines out",
      lines: 2,
      bytes: 8,
    });
  });

  it("says so when a command printed nothing", () => {
    expect(
      buildResultPayload({
        tool: "Bash",
        isError: false,
        text: "",
        detail: { stdout: "", stderr: "", interrupted: false },
      }),
    ).toMatchObject({ summary: "no output", lines: 0 });
  });

  it("counts stderr separately and flags an interruption", () => {
    expect(
      buildResultPayload({
        tool: "Bash",
        isError: false,
        text: "out",
        detail: {
          stdout: "out",
          stderr: "warn one\nwarn two",
          interrupted: true,
        },
      }),
    ).toMatchObject({
      summary: "1 line out · 2 on stderr · interrupted",
      stderrLines: 2,
      interrupted: true,
    });
  });

  /**
   * A failed Bash reports its `tool_use_result` as a bare STRING, and that
   * string is the only place the exit code appears — the CLI does not publish
   * it as a field anywhere.
   */
  it("pulls the exit code and message out of a failed command", () => {
    expect(
      buildResultPayload({
        tool: "Bash",
        isError: true,
        text: "Exit code 1\nls: /definitely-not-here: No such file or directory",
        detail:
          "Error: Exit code 1\nls: /definitely-not-here: No such file or directory",
      }),
    ).toMatchObject({
      status: "error",
      exitCode: 1,
      error: "ls: /definitely-not-here: No such file or directory",
      summary: "exit 1 · ls: /definitely-not-here: No such file or directory",
    });
  });

  it("falls back to the first line when a failure has no exit code", () => {
    expect(
      buildResultPayload({
        tool: "WebSearch",
        isError: true,
        text: "Claude requested permissions to use WebSearch, but you haven't granted it yet.",
      }),
    ).toMatchObject({
      status: "error",
      summary:
        "Claude requested permissions to use WebSearch, but you haven't granted it yet.",
    });
  });

  it("reports a grep by its matches and files", () => {
    expect(
      buildResultPayload({
        tool: "Grep",
        isError: false,
        text: "2:beta",
        detail: {
          mode: "content",
          numFiles: 0,
          filenames: [],
          content: "2:beta",
          numLines: 1,
          totalLines: 1,
        },
      }),
    ).toMatchObject({ summary: "1 match", files: 0, matches: 1 });
  });

  it("reports a glob by its file count", () => {
    expect(
      buildResultPayload({
        tool: "Glob",
        isError: false,
        text: "a.txt\nb.txt",
        detail: {
          filenames: ["a.txt", "b.txt", "c.txt", "d.txt"],
          durationMs: 5,
          numFiles: 4,
          truncated: false,
          totalMatches: 4,
        },
      }),
    ).toMatchObject({ summary: "4 files", files: 4, durationMs: 5 });
  });

  it("keeps a truncated file list out of the preview's `truncated` key", () => {
    const payload = buildResultPayload({
      tool: "Glob",
      isError: false,
      text: "a.txt",
      detail: { filenames: ["a.txt"], numFiles: 1, truncated: true },
    });
    expect(payload.filesTruncated).toBe(true);
    expect(payload.truncated).toBeUndefined();
  });

  it("reports an edit as a diff stat against its file", () => {
    expect(
      buildResultPayload({
        tool: "Edit",
        isError: false,
        text: "The file /tmp/poem.txt has been updated successfully.",
        detail: {
          filePath: "/tmp/poem.txt",
          replaceAll: false,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 3,
              newStart: 1,
              newLines: 3,
              lines: [
                "-The wind whispers soft",
                "+The wind roars soft",
                " Stars dance in the night",
              ],
            },
          ],
        },
      }),
    ).toMatchObject({
      summary: "+1 -1 in poem.txt",
      added: 1,
      removed: 1,
      path: "/tmp/poem.txt",
    });
  });

  it("reports a created file by name and size", () => {
    expect(
      buildResultPayload({
        tool: "Write",
        isError: false,
        text: "File created successfully at: /tmp/poem.txt",
        detail: {
          type: "create",
          filePath: "/tmp/poem.txt",
          content: "one\ntwo\nthree\n",
          structuredPatch: [],
        },
      }),
    ).toMatchObject({
      summary: "created poem.txt · 3 lines",
      lines: 3,
      bytes: 14,
    });
  });

  it("counts the text when the CLI publishes no structure", () => {
    expect(
      buildResultPayload({
        tool: "ToolSearch",
        isError: false,
        text: "one\ntwo\nthree",
      }),
    ).toMatchObject({ summary: "3 lines", lines: 3 });
  });

  it("caps the preview and still reports the full length", () => {
    const payload = buildResultPayload({
      tool: "Bash",
      isError: false,
      text: "x".repeat(RESULT_PREVIEW_LIMIT + 500),
      detail: { stdout: "x".repeat(RESULT_PREVIEW_LIMIT + 500), stderr: "" },
    });
    expect(String(payload.preview)).toHaveLength(RESULT_PREVIEW_LIMIT);
    expect(payload.length).toBe(RESULT_PREVIEW_LIMIT + 500);
    expect(payload.truncated).toBe(true);
  });

  /** A marker is written inside a turn: garbage in must not throw. */
  it("survives a detail shape it has never seen", () => {
    for (const detail of [null, 42, [1, 2], { file: 7 }, { stdout: 5 }]) {
      expect(() =>
        buildResultPayload({
          tool: "Weird",
          isError: false,
          text: "x",
          detail,
        }),
      ).not.toThrow();
    }
  });

  it("omits the tool when the bridge could not name it", () => {
    const payload = buildResultPayload({ isError: false, text: "x" });
    expect(payload.tool).toBeUndefined();
    expect(payload.status).toBe("ok");
  });
});
