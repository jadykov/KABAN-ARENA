import { describe, expect, it } from "vitest";
import { chargeToPower01 } from "./protocol";
import { advanceEffectiveChargeMs } from "./chargeBoost";

describe("next-shot fast charge", () => {
  it("reaches full shot power in half a second, then retains the same maximum", () => {
    expect(chargeToPower01(advanceEffectiveChargeMs(0, 500, 10000) / 1000)).toBe(1);
    expect(chargeToPower01(advanceEffectiveChargeMs(0, 500, 0) / 1000)).toBe(0.75);
    expect(advanceEffectiveChargeMs(1000, 500, 10000)).toBe(1000);
  });

  it("uses the boosted rate only during the active part of a hold", () => {
    const boosted = advanceEffectiveChargeMs(0, 200, 10000);
    const expired = advanceEffectiveChargeMs(boosted, 200, 0);
    expect(expired).toBe(600);
    expect(chargeToPower01(expired / 1000)).toBe(0.8);
    expect(advanceEffectiveChargeMs(0, 200, 50)).toBe(250);
  });
});
