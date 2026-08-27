import { describe, it, expect, vi, afterEach } from "vitest";
import { mapThinkingEffort } from "../src/thinking-config";
import type { ThinkingBudgets } from "@earendil-works/pi-ai";

describe("mapThinkingEffort", () => {
  describe("undefined reasoning", () => {
    it("returns undefined when reasoning is undefined", () => {
      expect(
        mapThinkingEffort(undefined, "claude-sonnet-4-5", undefined),
      ).toBeUndefined();
    });

    it("returns undefined regardless of model", () => {
      expect(
        mapThinkingEffort(undefined, "claude-opus-4-6-20260301", undefined),
      ).toBeUndefined();
    });
  });

  describe("standard (non-Opus) model mapping", () => {
    const model = "claude-sonnet-4-5";

    it("maps minimal to low", () => {
      expect(mapThinkingEffort("minimal", model, undefined)).toBe("low");
    });

    it("maps low to low", () => {
      expect(mapThinkingEffort("low", model, undefined)).toBe("low");
    });

    it("maps medium to medium", () => {
      expect(mapThinkingEffort("medium", model, undefined)).toBe("medium");
    });

    it("maps high to high", () => {
      expect(mapThinkingEffort("high", model, undefined)).toBe("high");
    });

    it("maps xhigh to xhigh (full ladder pass-through)", () => {
      expect(mapThinkingEffort("xhigh", model, undefined)).toBe("xhigh");
    });

    it("maps max to max (full ladder pass-through)", () => {
      expect(mapThinkingEffort("max", model, undefined)).toBe("max");
    });
  });

  describe("Fable model mapping (standard, full ladder)", () => {
    const model = "claude-fable-5";

    it("maps high to high", () => {
      expect(mapThinkingEffort("high", model, undefined)).toBe("high");
    });

    it("maps xhigh to xhigh", () => {
      expect(mapThinkingEffort("xhigh", model, undefined)).toBe("xhigh");
    });

    it("maps max to max", () => {
      expect(mapThinkingEffort("max", model, undefined)).toBe("max");
    });
  });

  describe("Opus model mapping (1:1, same as every other model)", () => {
    const model = "claude-opus-4-6-20260301";

    it("maps minimal to low", () => {
      expect(mapThinkingEffort("minimal", model, undefined)).toBe("low");
    });

    it("maps low to low", () => {
      expect(mapThinkingEffort("low", model, undefined)).toBe("low");
    });

    it("maps medium to medium, not high", () => {
      expect(mapThinkingEffort("medium", model, undefined)).toBe("medium");
    });

    it("maps high to high, not max", () => {
      expect(mapThinkingEffort("high", model, undefined)).toBe("high");
    });

    it("maps xhigh to xhigh, not max", () => {
      expect(mapThinkingEffort("xhigh", model, undefined)).toBe("xhigh");
    });

    it("maps max to max", () => {
      expect(mapThinkingEffort("max", model, undefined)).toBe("max");
    });
  });

  describe("no level is ever escalated above what the host asked for", () => {
    const RANK = ["low", "medium", "high", "xhigh", "max"];
    const LEVELS = [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] as const;
    const MODELS = [
      "claude-opus-5",
      "claude-opus-4-6-20260301",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-haiku-4-5-20251001",
      undefined,
    ];

    // Regression guard for #22: an opus shift made `high` unrequestable and
    // handed skills their widest sub-agent fan-out tier unasked.
    it.each(MODELS)("never maps above the requested rung on %s", (model) => {
      for (const level of LEVELS) {
        const got = mapThinkingEffort(level, model, undefined)!;
        const asked = RANK.indexOf(level === "minimal" ? "low" : level);
        expect(RANK.indexOf(got)).toBeLessThanOrEqual(asked);
      }
    });

    it("maps every rung the CLI has identically for opus and sonnet", () => {
      for (const level of LEVELS) {
        expect(mapThinkingEffort(level, "claude-opus-5", undefined)).toBe(
          mapThinkingEffort(level, "claude-sonnet-5", undefined),
        );
      }
    });
  });

  describe("thinkingBudgets warning", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("logs console.warn when thinkingBudgets is provided with entries", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const budgets: ThinkingBudgets = { high: 50000 };

      mapThinkingEffort("high", "claude-sonnet-4-5", budgets);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("thinkingBudgets are not supported"),
      );
    });

    it("does not warn when thinkingBudgets is undefined", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mapThinkingEffort("high", "claude-sonnet-4-5", undefined);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn when thinkingBudgets is empty object", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mapThinkingEffort("high", "claude-sonnet-4-5", {} as ThinkingBudgets);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("still returns correct effort level when budgets trigger warning", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const budgets: ThinkingBudgets = { high: 50000 };

      const result = mapThinkingEffort(
        "high",
        "claude-opus-4-6-20260301",
        budgets,
      );
      expect(result).toBe("high");
    });
  });

  describe("no modelId defaults to non-Opus behavior", () => {
    it("uses standard mapping when modelId is undefined", () => {
      expect(mapThinkingEffort("medium", undefined, undefined)).toBe("medium");
    });

    it("maps xhigh to xhigh when modelId is undefined", () => {
      expect(mapThinkingEffort("xhigh", undefined, undefined)).toBe("xhigh");
    });
  });
});
