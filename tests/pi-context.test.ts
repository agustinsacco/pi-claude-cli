import { describe, expect, it } from "vitest";
import { piContext } from "../src/pi-context";

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
  });

  it("supports legacy Context and an explicitly empty tool set", () => {
    expect(
      piContext({ systemPrompt: "hello", messages: [], tools: [] }),
    ).toEqual({ systemPrompt: "hello", messages: [], tools: [] });
  });
});
