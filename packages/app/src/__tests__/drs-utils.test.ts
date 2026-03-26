import { describe, expect, it } from "vitest";

import { getDrsVerdict, getDrsVerdictLabel, isDrsCommentary } from "../drs-utils";

describe("drs utils", () => {
  it("detects DRS commentary regardless of casing", () => {
    expect(isDrsCommentary("appeal... DRS review... OVERTURNED!")).toBe(true);
    expect(isDrsCommentary("appeal... drs review... umpire's call")).toBe(true);
    expect(isDrsCommentary("regular dot ball")).toBe(false);
  });

  it("classifies the three supported DRS outcomes", () => {
    expect(getDrsVerdict("DRS review... OVERTURNED! That's OUT! LBW!")).toBe("overturned");
    expect(getDrsVerdict("DRS review... UMPIRE'S CALL — clipping leg stump.")).toBe("umpires-call");
    expect(getDrsVerdict("DRS review... clearly missing off stump. Team lose their review.")).toBe("review-lost");
  });

  it("returns stable labels for UI badges", () => {
    expect(getDrsVerdictLabel("overturned")).toBe("CALL OVERTURNED");
    expect(getDrsVerdictLabel("overturned", "DRS review... OVERTURNED! That's OUT! LBW!")).toBe("DRS OUT");
    expect(getDrsVerdictLabel("overturned", "DRS review... OVERTURNED! Fair delivery. Call withdrawn.")).toBe("CALL OVERTURNED");
    expect(getDrsVerdictLabel("umpires-call")).toBe("UMPIRE'S CALL");
    expect(getDrsVerdictLabel("review-lost")).toBe("REVIEW LOST");
  });
});
