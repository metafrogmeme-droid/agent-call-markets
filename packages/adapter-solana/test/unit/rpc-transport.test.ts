// RpcTransport against a scripted JSON-RPC server on 127.0.0.1 (no real cluster, no network).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateKeyPairSigner,
  getAddressDecoder,
  getBase58Decoder,
  getBase64Decoder,
  getI64Codec,
} from "@solana/kit";
import { CoreError, ErrorCode } from "@agent-call-markets/core";
import { RpcTransport, TxFailedError } from "../../src/transport.ts";

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown[];
}
type Handler = (req: RpcRequest) => { result?: unknown; error?: unknown };

const OWNER = getAddressDecoder().decode(new Uint8Array(32).fill(7));
const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(3));
let handler: Handler = () => ({ result: null });
const seen: RpcRequest[] = [];
let url = "";
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    const rpc = JSON.parse(body) as RpcRequest;
    seen.push(rpc);
    const out = handler(rpc);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...out }));
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const account = (data: Uint8Array) => ({
  data: [getBase64Decoder().decode(data), "base64"],
  executable: false,
  lamports: 5,
  owner: OWNER,
  rentEpoch: 0,
  space: data.length,
});

/** Default responses for the send/confirm path; `over` replaces individual methods. */
function sendPath(over: Record<string, Handler> = {}): Handler {
  return (req) => {
    const h = over[req.method];
    if (h) return h(req);
    switch (req.method) {
      case "getGenesisHash":
        return { result: "GenesisHash1111111111111111111111111111111111" };
      case "getLatestBlockhash":
        return {
          result: {
            context: { slot: 1 },
            value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 },
          },
        };
      case "sendTransaction":
        return { result: "sig" };
      case "getSignatureStatuses":
        return {
          result: {
            context: { slot: 2 },
            value: [
              {
                slot: 2,
                confirmations: 0,
                err: null,
                confirmationStatus: "confirmed",
                status: { Ok: null },
              },
            ],
          },
        };
      case "getTransaction":
        return {
          result: {
            slot: 2,
            meta: { err: null, logMessages: ["Program log: ok"] },
            transaction: {},
          },
        };
      case "getBlockHeight":
        return { result: 50 };
      default:
        return { error: { code: -32601, message: `unexpected ${req.method}` } };
    }
  };
}

describe("RpcTransport", () => {
  it("reads the genesis hash, accounts and program accounts", async () => {
    const t = new RpcTransport(url);
    expect(t.endpoint).toEqual({ kind: "rpc", url });
    handler = sendPath();
    expect(await t.getGenesisHash()).toBe("GenesisHash1111111111111111111111111111111111");

    handler = () => ({ result: { context: { slot: 1 }, value: null } });
    expect(await t.getAccount(OWNER)).toBeNull();
    handler = () => ({ result: { context: { slot: 1 }, value: account(Uint8Array.of(1, 2, 3)) } });
    expect(await t.getAccount(OWNER)).toEqual({
      address: OWNER,
      owner: OWNER,
      lamports: 5n,
      data: Uint8Array.of(1, 2, 3),
    });

    seen.length = 0;
    handler = () => ({ result: [{ pubkey: OWNER, account: account(Uint8Array.of(9)) }] });
    const got = await t.getProgramAccounts(OWNER, 1, [{ offset: 10, bytes: Uint8Array.of(1, 2) }]);
    expect(got).toEqual([{ address: OWNER, owner: OWNER, lamports: 5n, data: Uint8Array.of(9) }]);
    const cfg = seen[0]?.params[1] as { filters: unknown[] };
    expect(cfg.filters).toEqual([
      { dataSize: 1 },
      {
        memcmp: {
          offset: 10,
          bytes: getBase58Decoder().decode(Uint8Array.of(1, 2)),
          encoding: "base58",
        },
      },
    ]);
  });

  it("sends, confirms and returns the transaction logs", async () => {
    const t = new RpcTransport(url, { pollMs: 1 });
    const payer = await generateKeyPairSigner();
    handler = sendPath();
    const sent = await t.send([], payer);
    expect(sent.logs).toEqual(["Program log: ok"]);
    expect(sent.signature.length).toBeGreaterThan(40);
  });

  it("turns a preflight failure into the failing instruction and custom code", async () => {
    const t = new RpcTransport(url, { pollMs: 1 });
    const payer = await generateKeyPairSigner();
    handler = sendPath({
      sendTransaction: () => ({
        error: {
          code: -32002,
          message: "Transaction simulation failed: custom program error: 0x177e",
          data: {
            err: { InstructionError: [1, { Custom: 6014 }] },
            logs: ["Program log: AnchorError"],
            accounts: null,
            unitsConsumed: 1000,
          },
        },
      }),
    });
    await expect(t.send([], payer)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof TxFailedError &&
        e.failure.instructionIndex === 1 &&
        e.failure.customCode === 6014,
    );
    handler = sendPath({
      sendTransaction: () => ({ error: { code: -32005, message: "node is unhealthy" } }),
    });
    await expect(t.send([], payer)).rejects.toSatisfy(
      (e: unknown) => e instanceof TxFailedError && e.failure.customCode === null,
    );
  });

  it("reports an on-chain failure from the signature status", async () => {
    const t = new RpcTransport(url, { pollMs: 1 });
    const payer = await generateKeyPairSigner();
    handler = sendPath({
      getSignatureStatuses: () => ({
        result: {
          context: { slot: 2 },
          value: [
            {
              slot: 2,
              confirmations: 0,
              err: { InstructionError: [0, { Custom: 6021 }] },
              confirmationStatus: "confirmed",
              status: { Err: {} },
            },
          ],
        },
      }),
    });
    await expect(t.send([], payer)).rejects.toSatisfy(
      (e: unknown) => e instanceof TxFailedError && e.failure.customCode === 6021,
    );
  });

  it("gives up once the blockhash has expired unconfirmed", async () => {
    const t = new RpcTransport(url, { pollMs: 1 });
    const payer = await generateKeyPairSigner();
    let polls = 0;
    handler = sendPath({
      getSignatureStatuses: () => {
        polls++;
        return { result: { context: { slot: 2 }, value: [null] } };
      },
      getBlockHeight: () => ({ result: polls < 2 ? 50 : 101 }),
    });
    await expect(t.send([], payer)).rejects.toSatisfy(
      (e: unknown) => e instanceof CoreError && e.code === ErrorCode.ChainError,
    );
    expect(polls).toBe(2);
  });

  it("reads the clock, rent and the faucet", async () => {
    const t = new RpcTransport(url, { pollMs: 1 });
    const clock = new Uint8Array(40);
    clock.set(getI64Codec().encode(1_800_000_123n), 32);
    handler = () => ({ result: { context: { slot: 1 }, value: account(clock) } });
    expect(await t.getUnixTimestamp()).toBe(1_800_000_123n);
    handler = () => ({ result: { context: { slot: 1 }, value: null } });
    await expect(t.getUnixTimestamp()).rejects.toSatisfy(
      (e: unknown) => e instanceof CoreError && e.code === ErrorCode.ChainError,
    );
    handler = () => ({ result: 890_880 });
    expect(await t.rentExempt(0)).toBe(890_880n);
    handler = sendPath({ requestAirdrop: () => ({ result: "AirdropSig" }) });
    expect(await t.requestAirdrop(OWNER, 1n)).toBe("AirdropSig");
  });
});
