import { describe, expect, it } from "vitest";
import { address, getAddressDecoder, getBase64Decoder, type Address } from "@solana/kit";
import {
  CallStatus,
  CoreError,
  DEFAULT_PARAMS,
  Direction,
  Outcome,
  Side,
  bytes32,
} from "@agent-call-markets/core";
import {
  ACCOUNT_DISCRIMINATOR,
  addressToBytes32,
  callToState,
  configToParams,
  decodeCall,
  decodeConfig,
  decodePosition,
  sideFromByte,
  sideToByte,
  type CallAccount,
  type PositionAccount,
} from "../../src/codec/accounts.ts";
import { discriminator } from "../../src/codec/discriminator.ts";
import { parseEvents } from "../../src/codec/events.ts";
import { encodeIxData } from "../../src/codec/instructions.ts";
import { structCodec, type StructInput } from "../../src/codec/layout.ts";
import { ACCOUNTS, EVENTS } from "../../src/codec/program.ts";
import { checkOutcome } from "../../src/outcome.ts";

// Synthetic 32-byte identities (not real keys).
const AGENT: Address = getAddressDecoder().decode(new Uint8Array(32).fill(0xa1));
const OWNER: Address = getAddressDecoder().decode(new Uint8Array(32).fill(0xb2));
const ZERO32 = new Uint8Array(32);
const FEED = bytes32("f1".repeat(32));

function withDisc(kind: keyof typeof ACCOUNTS, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  out.set(ACCOUNT_DISCRIMINATOR[kind], 0);
  out.set(body, 8);
  return out;
}

const baseCall: StructInput<typeof ACCOUNTS.Call> = {
  bump: 254,
  status: 1,
  agent: AGENT,
  commitment: new Uint8Array(32).fill(7),
  seal_slot: 10n,
  seal_ts: 1_800_000_000n,
  expiry_ts: 1_800_003_600n,
  reveal_deadline_ts: 1_800_000_900n,
  feed_id: ZERO32,
  direction: 0,
  level_mantissa: 0n,
  level_expo: 0,
  salt: ZERO32,
  reveal_slot: 0n,
  reveal_ts: 0n,
  market_open: false,
  market_opened_ts: 0n,
  pool_yes: 0n,
  pool_no: 0n,
  outcome: 0,
  accepted_update: address("11111111111111111111111111111111"),
  obs_price: 0n,
  obs_conf: 0n,
  obs_expo: 0,
  obs_publish_time: 0n,
  obs_prev_publish_time: 0n,
  settled_ts: 0n,
  settler: address("11111111111111111111111111111111"),
};

const encodeCall = (c: StructInput<typeof ACCOUNTS.Call>): Uint8Array =>
  withDisc("Call", Uint8Array.from(structCodec(ACCOUNTS.Call).encode(c)));

const revealedFields = {
  status: 2,
  feed_id: FEED,
  direction: Direction.Above,
  level_mantissa: 100_000_000n,
  level_expo: -6,
  salt: new Uint8Array(32).fill(0x5a),
  reveal_slot: 11n,
  reveal_ts: 1_800_000_001n,
};

describe("Call account → core CallState", () => {
  it("maps a sealed call with nothing revealed", () => {
    const s = callToState(decodeCall(encodeCall(baseCall)), []);
    expect(s).toMatchObject({
      status: CallStatus.Sealed,
      call: null,
      salt: null,
      revealTs: null,
      market: null,
      outcome: null,
      observation: null,
      settledTs: null,
      sealTs: 1_800_000_000n,
      revealDeadlineTs: 1_800_000_900n,
    });
    expect(s.agent).toEqual(addressToBytes32(AGENT));
  });

  it("maps a revealed call with an open market and positions", () => {
    const acct = decodeCall(
      encodeCall({
        ...baseCall,
        ...revealedFields,
        market_open: true,
        market_opened_ts: 5n,
        pool_yes: 3n,
        pool_no: 4n,
      }),
    );
    const pos: PositionAccount = decodePosition(
      withDisc(
        "Position",
        Uint8Array.from(
          structCodec(ACCOUNTS.Position).encode({
            bump: 1,
            call: AGENT,
            owner: OWNER,
            side: 2,
            amount: 4n,
            redeemed: false,
          }),
        ),
      ),
    );
    const s = callToState(acct, [pos]);
    expect(s.status).toBe(CallStatus.Revealed);
    expect(s.call).toMatchObject({
      direction: Direction.Above,
      level: { mantissa: 100_000_000n, expo: -6 },
    });
    expect(s.market).toMatchObject({ openedTs: 5n, pool: { yes: 3n, no: 4n } });
    expect(s.market?.positions[0]).toMatchObject({ side: Side.No, amount: 4n, redeemed: false });
  });

  it("maps a settled call's outcome and observation; the core rule re-derives it", () => {
    const settled: CallAccount = decodeCall(
      encodeCall({
        ...baseCall,
        ...revealedFields,
        status: 3,
        outcome: 1,
        obs_price: 101_000_000n,
        obs_conf: 0n,
        obs_expo: -6,
        obs_publish_time: 1_800_003_600n,
        obs_prev_publish_time: 1_800_003_599n,
        settled_ts: 1_800_003_601n,
      }),
    );
    const s = callToState(settled, []);
    expect(s.outcome).toBe(Outcome.Hit);
    expect(s.observation).toMatchObject({ price: 101_000_000n, publishTime: 1_800_003_600n });
    expect(s.settledTs).toBe(1_800_003_601n);
    const params = { ...DEFAULT_PARAMS, allowedFeedIds: [FEED] };
    expect(checkOutcome(s, params)).toBe("match");
    expect(checkOutcome({ ...s, outcome: Outcome.Miss }, params)).toBe("mismatch");
    expect(checkOutcome(callToState(decodeCall(encodeCall(baseCall)), []), params)).toBe("n/a");
    const miss = callToState({ ...settled, outcome: 2 }, []);
    expect(miss.outcome).toBe(Outcome.Miss);
  });

  it("maps a void call", () => {
    const s = callToState(
      decodeCall(encodeCall({ ...baseCall, ...revealedFields, status: 4, settled_ts: 9n })),
      [],
    );
    expect(s).toMatchObject({
      status: CallStatus.Void,
      outcome: null,
      observation: null,
      settledTs: 9n,
    });
  });

  it("rejects corrupt or foreign data", () => {
    expect(() => decodeCall(new Uint8Array(333))).toThrow(CoreError);
    expect(() => decodeCall(encodeCall(baseCall).slice(0, 100))).toThrow(CoreError);
    const bad = (patch: Partial<StructInput<typeof ACCOUNTS.Call>>) => () =>
      callToState(decodeCall(encodeCall({ ...baseCall, ...revealedFields, ...patch })), []);
    expect(bad({ status: 9 })).toThrow(CoreError);
    expect(bad({ direction: 3 })).toThrow(CoreError);
    expect(bad({ status: 3, outcome: 0 })).toThrow(CoreError);
    expect(() => sideFromByte(0)).toThrow(CoreError);
    expect(sideToByte(Side.Yes)).toBe(1);
    expect(sideToByte(Side.No)).toBe(2);
  });
});

describe("Config account → core ProtocolParams", () => {
  it("keeps only the configured feeds", () => {
    const feeds = [FEED, bytes32("f2".repeat(32)), ...Array.from({ length: 6 }, () => ZERO32)];
    const data = withDisc(
      "Config",
      Uint8Array.from(
        structCodec(ACCOUNTS.Config).encode({
          bump: 1,
          reveal_window_secs: 900n,
          min_lead_secs: 3600n,
          max_horizon_secs: 2_592_000n,
          trade_cutoff_secs: 600n,
          settle_window_secs: 10n,
          max_conf_bps: 50,
          void_after_secs: 259_200n,
          min_level_expo: -18,
          max_level_expo: 0,
          feed_count: 2,
          allowed_feed_ids: feeds,
          collateral_mint: OWNER,
          collateral_decimals: 6,
        }),
      ),
    );
    const config = decodeConfig(data);
    expect(config.collateral_mint).toBe(OWNER);
    expect(configToParams(config)).toEqual({
      ...DEFAULT_PARAMS,
      allowedFeedIds: [FEED, bytes32("f2".repeat(32))],
    });
  });
});

describe("instruction data and events", () => {
  it("prefixes instruction data with the Anchor discriminator", () => {
    const data = encodeIxData("openPosition", { side: 2 });
    expect([...data]).toEqual([...discriminator("global", "open_position"), 2]);
    const seal = encodeIxData("sealCall", {
      commitment: new Uint8Array(32).fill(1),
      expiry_ts: -1n,
    });
    expect(seal).toHaveLength(8 + 32 + 8);
    expect([...seal.slice(40)]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
  });

  it("parses Anchor events from logs and skips everything else", () => {
    const body = Uint8Array.from(
      structCodec(EVENTS.Redeemed).encode({ call: AGENT, owner: OWNER, side: 1, payout: 77n }),
    );
    const disc = discriminator("event", "Redeemed");
    const bytes = new Uint8Array(disc.length + body.length);
    bytes.set(disc);
    bytes.set(body, disc.length);
    const b64 = getBase64Decoder().decode(bytes);
    const other = getBase64Decoder().decode(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9));
    const logs = [
      "Program log: Instruction: Redeem",
      `Program data: ${other}`,
      "Program data: !!!not-base64!!!",
      `Program data: ${b64}`,
    ];
    const events = parseEvents(logs, "Redeemed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ call: AGENT, owner: OWNER, side: 1, payout: 77n });
    expect(parseEvents(logs, "Bought")).toEqual([]);
  });
});
