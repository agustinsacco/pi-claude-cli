import { describe, it, expect } from "vitest";
import { buildRateLimitPayload, rateLimitIdentity } from "../src/rate-limit";

// Captured verbatim from claude 2.1.231 on a Team account that had gone past
// its usage-credit allowance. This exact shape is what the UI has to render.
const OVER_CREDITS = {
  status: "allowed_warning",
  resetsAt: 1788220800,
  rateLimitType: "overage",
  utilization: 1.01,
  isUsingOverage: false,
  surpassedThreshold: 1,
};

describe("buildRateLimitPayload", () => {
  it("forwards utilization and surpassedThreshold, which used to be dropped", () => {
    const payload = buildRateLimitPayload(OVER_CREDITS, 1_700_000_000);
    expect(payload.utilization).toBe(1.01);
    expect(payload.surpassedThreshold).toBe(1);
  });

  it("keeps the fields the UI already relied on", () => {
    const payload = buildRateLimitPayload(OVER_CREDITS, 1_700_000_000);
    expect(payload).toMatchObject({
      status: "allowed_warning",
      resetsAt: 1788220800,
      rateLimitType: "overage",
      observedAt: 1_700_000_000,
    });
  });

  it("normalises isUsingOverage to a real boolean", () => {
    // The CLI sends a boolean, but a truthy non-boolean must not leak through
    // as one — the UI branches on it to warn about paid usage.
    expect(buildRateLimitPayload({ isUsingOverage: true }).isUsingOverage).toBe(
      true,
    );
    expect(
      buildRateLimitPayload({ isUsingOverage: "yes" }).isUsingOverage,
    ).toBe(false);
    expect(buildRateLimitPayload({}).isUsingOverage).toBe(false);
  });

  it("returns null rather than a bogus number for missing metrics", () => {
    // surpassedThreshold is absent until a threshold is actually crossed, and
    // `undefined` must not render as 0% — that reads as "plenty of room left".
    const payload = buildRateLimitPayload({ rateLimitType: "five_hour" });
    expect(payload.utilization).toBeNull();
    expect(payload.surpassedThreshold).toBeNull();
  });

  it("rejects non-finite and non-numeric metrics", () => {
    for (const bad of [NaN, Infinity, "1.01", null, {}]) {
      expect(
        buildRateLimitPayload({ utilization: bad }).utilization,
      ).toBeNull();
    }
  });

  it("carries a utilization of 0 through, which is meaningfully different from unknown", () => {
    expect(buildRateLimitPayload({ utilization: 0 }).utilization).toBe(0);
  });
});

describe("rateLimitIdentity", () => {
  const at = (seconds: number) => buildRateLimitPayload(OVER_CREDITS, seconds);

  it("ignores observedAt, so a repeated event is not a change", () => {
    // The CLI re-sends this every turn with a fresh timestamp. Treating that
    // as a change would rewrite the host's status constantly.
    expect(rateLimitIdentity(at(1000))).toBe(rateLimitIdentity(at(2000)));
  });

  it("changes when utilization moves", () => {
    const before = rateLimitIdentity(at(1000));
    const after = rateLimitIdentity(
      buildRateLimitPayload({ ...OVER_CREDITS, utilization: 1.4 }, 1000),
    );
    expect(after).not.toBe(before);
  });

  it("changes when the window itself changes", () => {
    const fiveHour = rateLimitIdentity(
      buildRateLimitPayload({ ...OVER_CREDITS, rateLimitType: "five_hour" }),
    );
    expect(fiveHour).not.toBe(rateLimitIdentity(at(1000)));
  });
});
