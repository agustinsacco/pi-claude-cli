import { describe, expect, it } from "vitest";
import { historyHash, piContext, systemUpdate } from "../src/pi-context";

describe("pi 0.87 transcript normalization", () => {
  it("uses current prompt sections and tools, never historical declarations", () => {
    const read = {
      name: "read",
      description: "Read",
      parameters: { type: "object" },
    };
    const write = {
      name: "write",
      description: "Write",
      parameters: { type: "object" },
    };
    const user = { role: "user", content: "go" };
    const context = piContext({
      messages: [
        {
          role: "system",
          content: "base",
          sections: { rules: "old rules", remove: "old extra" },
          toolsAdded: [read, write],
        },
        user,
        {
          role: "system",
          content: "",
          sections: { rules: "new rules", remove: null },
          toolsRemoved: [{ name: "write" }],
        },
      ],
    });
    expect(context.systemPrompt).toContain("new rules");
    expect(context.systemPrompt).not.toContain("old");
    expect(context.tools.map((t: any) => t.name)).toEqual(["read"]);
    expect(context.messages).toEqual([user]);
    expect(context.system).toEqual({
      content: "base",
      sections: { rules: "new rules" },
    });
  });

  it("supports legacy Context and an explicitly empty tool set", () => {
    expect(
      piContext({ systemPrompt: "hello", messages: [], tools: [] }),
    ).toEqual({
      systemPrompt: "hello",
      messages: [],
      tools: [],
      system: { content: "hello", sections: {} },
    });
  });
});

describe("systemUpdate", () => {
  const seen = { content: "base", sections: { a: "A1", b: "B1" } };

  it("is empty when nothing changed", () => {
    expect(
      systemUpdate(seen, { ...seen, sections: { ...seen.sections } }),
    ).toBe("");
  });

  it("renders changed, added and removed sections and appended text as pi does", () => {
    const update = systemUpdate(seen, {
      content: "base\n\nmore rules",
      sections: { a: "A2", c: "C1" },
    });
    expect(update).toBe(
      "<system-reminder>\nmore rules\n\n" +
        'Updated system prompt section "a":\n\nA2\n\n' +
        'Updated system prompt section "c":\n\nC1\n\n' +
        'Removed system prompt section "b".\n</system-reminder>',
    );
  });

  it("cannot express a rewritten base prompt", () => {
    expect(systemUpdate(seen, { ...seen, content: "other" })).toBeUndefined();
  });
});

describe("historyHash", () => {
  it("ignores a failed or aborted reply, which pi never sends", () => {
    const user = { role: "user", content: "go" };
    const failed = (stopReason: string) => ({
      role: "assistant",
      stopReason,
      content: [{ type: "text", text: "partial" }],
    });
    expect(historyHash([user, failed("aborted")])).toBe(historyHash([user]));
    expect(historyHash([user, failed("error")])).toBe(historyHash([user]));
    expect(historyHash([user, failed("stop")])).not.toBe(historyHash([user]));
  });
});
