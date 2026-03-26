import { describe, expect, it } from "vitest";

import { buildInProgressMatchStorageKey, buildMatchStorageKey } from "../match-db";

describe("match-db key scoping", () => {
  it("scopes completed match storage keys by slot", () => {
    expect(buildMatchStorageKey("slot-a", 1, 2)).toBe("slot-a:1-2");
    expect(buildMatchStorageKey("slot-b", 1, 2)).toBe("slot-b:1-2");
    expect(buildMatchStorageKey("slot-a", 1, 2)).not.toBe(buildMatchStorageKey("slot-b", 1, 2));
  });

  it("scopes in-progress match keys by slot", () => {
    expect(buildInProgressMatchStorageKey("slot-a", 1, 2)).toBe("slot-a:1-2");
    expect(buildInProgressMatchStorageKey(null, 1, 2)).toBe("default:1-2");
  });
});
