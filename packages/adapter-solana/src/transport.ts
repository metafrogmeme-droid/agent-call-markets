import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  devnet,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getI64Codec,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type RpcDevnet,
  type Signature,
  type SolanaRpcApiDevnet,
  type TransactionSigner,
} from "@solana/kit";
import { CoreError, ErrorCode } from "@agent-call-markets/core";
import { failureFromRawError, failureFromSolanaError, type TxFailure } from "./codec/errors.ts";
import type { Endpoint } from "./guard.ts";

export interface AccountInfo {
  readonly address: Address;
  readonly owner: Address;
  readonly lamports: bigint;
  readonly data: Uint8Array;
}

export interface MemcmpFilter {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface SentTx {
  readonly signature: string;
  readonly logs: readonly string[];
}

/** Thrown by `SolanaTransport.send` when a transaction fails (preflight or on-chain). */
export class TxFailedError extends Error {
  readonly failure: TxFailure;

  constructor(failure: TxFailure) {
    super(`transaction failed: ${failure.detail}`);
    this.name = "TxFailedError";
    this.failure = failure;
  }
}

/**
 * The few chain operations the adapter needs. `RpcTransport` talks JSON-RPC; tests use an
 * in-process LiteSVM transport (test/svm, not shipped). Transports only move bytes: the cluster
 * guard and all program logic live elsewhere.
 */
export interface SolanaTransport {
  readonly endpoint: Endpoint;
  getGenesisHash(): Promise<string>;
  getAccount(address: Address): Promise<AccountInfo | null>;
  /** Accounts owned by `program` whose data has `dataSize` bytes and matches every filter. */
  getProgramAccounts(
    program: Address,
    dataSize: number,
    filters: readonly MemcmpFilter[],
  ): Promise<AccountInfo[]>;
  /** Signs with the signers attached to the instructions and the fee payer, sends, confirms. */
  send(instructions: readonly Instruction[], feePayer: TransactionSigner): Promise<SentTx>;
  /** The cluster clock's unix timestamp (Clock sysvar). */
  getUnixTimestamp(): Promise<bigint>;
  /** Devnet/localnet faucet. Not available on every endpoint. */
  requestAirdrop(to: Address, lamportAmount: bigint): Promise<string>;
  /** Minimum lamports for a rent-exempt account of `space` bytes. */
  rentExempt(space: number): Promise<bigint>;
}

const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");
/** Clock: slot u64 | epoch_start_timestamp i64 | epoch u64 | leader_schedule_epoch u64 | unix_timestamp i64 */
const CLOCK_UNIX_TS_OFFSET = 32;

export function unixTimestampFromClock(data: Uint8Array): bigint {
  return getI64Codec().decode(data, CLOCK_UNIX_TS_OFFSET);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON-RPC transport over @solana/kit. Confirms by polling signature statuses (no websockets). */
export class RpcTransport implements SolanaTransport {
  readonly endpoint: Endpoint;
  private readonly rpc: RpcDevnet<SolanaRpcApiDevnet>;
  private readonly pollMs: number;

  /**
   * `url` is typed as a test-cluster URL (devnet or localnet); the adapter's cluster guard checks
   * the genesis hash before any read or write, so a mainnet URL is refused there.
   */
  constructor(url: string, opts: { readonly pollMs?: number } = {}) {
    this.endpoint = { kind: "rpc", url };
    this.rpc = createSolanaRpc(devnet(url));
    this.pollMs = opts.pollMs ?? 500;
  }

  async getGenesisHash(): Promise<string> {
    return await this.rpc.getGenesisHash().send();
  }

  async getAccount(addr: Address): Promise<AccountInfo | null> {
    const { value } = await this.rpc
      .getAccountInfo(addr, { encoding: "base64", commitment: "confirmed" })
      .send();
    if (value === null) return null;
    return {
      address: addr,
      owner: value.owner,
      lamports: value.lamports,
      data: Uint8Array.from(getBase64Encoder().encode(value.data[0])),
    };
  }

  async getProgramAccounts(
    program: Address,
    dataSize: number,
    filters: readonly MemcmpFilter[],
  ): Promise<AccountInfo[]> {
    const b58 = getBase58Decoder();
    const res = await this.rpc
      .getProgramAccounts(program, {
        encoding: "base64",
        commitment: "confirmed",
        filters: [
          { dataSize: BigInt(dataSize) },
          ...filters.map((f) => ({
            memcmp: {
              offset: BigInt(f.offset),
              bytes: b58.decode(f.bytes) as Base58EncodedBytes,
              encoding: "base58" as const,
            },
          })),
        ],
      })
      .send();
    return res.map(({ pubkey, account }) => ({
      address: pubkey,
      owner: account.owner,
      lamports: account.lamports,
      data: Uint8Array.from(getBase64Encoder().encode(account.data[0])),
    }));
  }

  async send(instructions: readonly Instruction[], feePayer: TransactionSigner): Promise<SentTx> {
    const { value: blockhash } = await this.rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(tx);
    try {
      await this.rpc
        .sendTransaction(getBase64EncodedWireTransaction(tx), {
          encoding: "base64",
          preflightCommitment: "confirmed",
        })
        .send();
    } catch (e) {
      const failure = failureFromSolanaError(e);
      if (failure !== null) throw new TxFailedError(failure);
      throw e;
    }
    await this.confirm(signature, blockhash.lastValidBlockHeight);
    const got = await this.rpc
      .getTransaction(signature, {
        encoding: "json",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    return { signature, logs: got?.meta?.logMessages ?? [] };
  }

  private async confirm(signature: Signature, lastValidBlockHeight: bigint): Promise<void> {
    for (;;) {
      const { value } = await this.rpc.getSignatureStatuses([signature]).send();
      const status = value[0];
      if (status) {
        if (status.err !== null) throw new TxFailedError(failureFromRawError(status.err));
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          return;
        }
      }
      const height = await this.rpc.getBlockHeight({ commitment: "confirmed" }).send();
      if (height > lastValidBlockHeight) {
        throw new CoreError(ErrorCode.ChainError, `transaction ${signature} expired unconfirmed`);
      }
      await sleep(this.pollMs);
    }
  }

  async getUnixTimestamp(): Promise<bigint> {
    const clock = await this.getAccount(CLOCK_SYSVAR);
    if (clock === null) throw new CoreError(ErrorCode.ChainError, "clock sysvar missing");
    return unixTimestampFromClock(clock.data);
  }

  async rentExempt(space: number): Promise<bigint> {
    return await this.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  }

  async requestAirdrop(to: Address, lamportAmount: bigint): Promise<string> {
    const signature = await this.rpc
      .requestAirdrop(to, lamports(lamportAmount), { commitment: "confirmed" })
      .send();
    const { value: blockhash } = await this.rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    await this.confirm(signature, blockhash.lastValidBlockHeight);
    return signature;
  }
}
