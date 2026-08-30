import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_AUTOCOMPACT_TOKENS,
  parseAutocompactTokens,
  resolveAutocompact,
} from "../src/autocompact";

describe("parseAutocompactTokens", () => {
  it("parses plain token counts", () => {
    expect(parseAutocompactTokens("200000")).toBe(200_000);
    expect(parseAutocompactTokens("1000000")).toBe(1_000_000);
  });

  it("parses k and M suffixes, case-insensitively", () => {
    expect(parseAutocompactTokens("200k")).toBe(200_000);
    expect(parseAutocompactTokens("500K")).toBe(500_000);
    expect(parseAutocompactTokens("1m")).toBe(1_000_000);
    expect(parseAutocompactTokens("0.5M")).toBe(500_000);
  });

  it("reads bare numbers under 100k as thousands (CLI shorthand)", () => {
    expect(parseAutocompactTokens("200")).toBe(200_000);
    expect(parseAutocompactTokens("150")).toBe(150_000);
  });

  it("returns undefined for junk", () => {
    expect(parseAutocompactTokens("")).toBeUndefined();
    expect(parseAutocompactTokens("lots")).toBeUndefined();
    expect(parseAutocompactTokens("40%")).toBeUndefined();
    expect(parseAutocompactTokens("-200k")).toBeUndefined();
  });
});

describe("resolveAutocompact", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to 200k when unset", () => {
    expect(resolveAutocompact({})).toBe(String(DEFAULT_AUTOCOMPACT_TOKENS));
    expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: "" })).toBe(
      String(DEFAULT_AUTOCOMPACT_TOKENS),
    );
  });

  it("normalizes valid values to a plain token count", () => {
    expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: "400k" })).toBe(
      "400000",
    );
    expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: "1M" })).toBe(
      "1000000",
    );
    expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: "300" })).toBe(
      "300000",
    );
    expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: " 250000 " })).toBe(
      "250000",
    );
  });

  it("passes 'auto' through for the CLI's own default behaviour", () => {
    expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: "auto" })).toBe(
      "auto",
    );
    expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: "AUTO" })).toBe(
      "auto",
    );
  });

  it("omits the flag entirely for off values", () => {
    for (const off of ["off", "0", "none", "disable", "disabled", "false"]) {
      expect(
        resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: off }),
      ).toBeUndefined();
    }
  });

  it("falls back to the default, with a warning, on invalid or out-of-range values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The CLI would refuse to start on these; the provider must never let a
    // typo kill every spawn.
    for (const bad of ["50k", "2M", "banana", "40%", "-1"]) {
      expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: bad })).toBe(
        String(DEFAULT_AUTOCOMPACT_TOKENS),
      );
    }
    expect(warn).toHaveBeenCalled();
  });

  it("accepts the documented CLI bounds", () => {
    expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: "100k" })).toBe(
      "100000",
    );
    expect(resolveAutocompact({ PI_CLAUDE_CLI_AUTOCOMPACT: "1000000" })).toBe(
      "1000000",
    );
  });
});
