import { describe, expect, it } from "vitest";
import { bytes32, CoreError, type OracleObservation } from "@agent-call-markets/core";
import {
  decodePriceUpdateV2,
  encodePriceUpdateV2,
  observationOf,
  PRICE_UPDATE_V2_LEN,
} from "../../src/pyth.ts";

const OBS: OracleObservation = {
  feedId: bytes32("f1".repeat(32)),
  price: 101_000_000n,
  conf: 12_345n,
  expo: -6,
  publishTime: 1_800_003_600n,
  prevPublishTime: 1_800_003_599n,
};

describe("PriceUpdateV2", () => {
  it("is allocated at LEN = 134 bytes like the receiver's accounts", () => {
    expect(PRICE_UPDATE_V2_LEN).toBe(134);
    expect(encodePriceUpdateV2(OBS)).toHaveLength(134);
  });

  it("round-trips a fully verified update into the core observation", () => {
    const u = decodePriceUpdateV2(encodePriceUpdateV2(OBS, { postedSlot: 42n }));
    expect(u.verificationLevel).toEqual({ kind: "full" });
    expect(u.postedSlot).toBe(42n);
    expect(u.emaPrice).toBe(OBS.price);
    expect(u.emaConf).toBe(OBS.conf);
    expect(observationOf(u)).toEqual(OBS);
  });

  it("round-trips a partially verified update", () => {
    const u = decodePriceUpdateV2(
      encodePriceUpdateV2(
        { ...OBS, price: -5n },
        { verificationLevel: { kind: "partial", numSignatures: 7 } },
      ),
    );
    expect(u.verificationLevel).toEqual({ kind: "partial", numSignatures: 7 });
    expect(u.price).toBe(-5n);
    expect(u.publishTime).toBe(OBS.publishTime);
  });

  it("rejects other accounts", () => {
    const good = encodePriceUpdateV2(OBS);
    const badDisc = Uint8Array.from(good);
    badDisc[0] = (badDisc[0] ?? 0) ^ 0xff;
    expect(() => decodePriceUpdateV2(badDisc)).toThrow(CoreError);
    expect(() => decodePriceUpdateV2(good.slice(0, 60))).toThrow(CoreError);
    expect(() => decodePriceUpdateV2(good.slice(0, 20))).toThrow(CoreError);
    const badTag = Uint8Array.from(good);
    badTag[40] = 9;
    expect(() => decodePriceUpdateV2(badTag)).toThrow(CoreError);
  });
});
