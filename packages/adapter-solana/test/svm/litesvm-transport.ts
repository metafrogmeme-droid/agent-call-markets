// In-process transport over LiteSVM for tests. Not exported from the package and never shipped:
// it has no network at all, and the cluster guard treats it as localnet.
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { Endpoint } from "../../src/guard.ts";
import {
  TxFailedError,
  type AccountInfo,
  type MemcmpFilter,
  type SentTx,
  type SolanaTransport,
} from "../../src/transport.ts";
import type { TxFailure } from "../../src/codec/errors.ts";

/** A stand-in genesis hash; not a public cluster's, so the guard accepts it as localnet. */
export const LITESVM_GENESIS = "LiteSVM1nProcess1111111111111111111111111111";

function matches(data: ArrayLike<number>, f: MemcmpFilter): boolean {
  if (data.length < f.offset + f.bytes.length) return false;
  for (let i = 0; i < f.bytes.length; i++) if (data[f.offset + i] !== f.bytes[i]) return false;
  return true;
}

function failureOf(res: FailedTransactionMetadata): TxFailure {
  const err: unknown = res.err();
  const logs = res.meta().logs();
  const detail = `${res.toString()} | ${logs.slice(-4).join(" | ")}`;
  if (typeof err === "object" && err !== null && "index" in err && "err" in err) {
    const e = err as { index: number; err: () => unknown };
    const inner = e.err();
    const code =
      typeof inner === "object" && inner !== null && "code" in inner ? Number(inner.code) : null;
    return { instructionIndex: e.index, customCode: code, detail };
  }
  return { instructionIndex: null, customCode: null, detail };
}

export class LiteSvmTransport implements SolanaTransport {
  readonly endpoint: Endpoint = { kind: "in-process", name: "litesvm" };
  readonly svm: LiteSVM;
  /** Tests may change this to simulate an endpoint that turns into another cluster. */
  genesisHash = LITESVM_GENESIS;
  sends = 0;

  constructor(svm: LiteSVM) {
    this.svm = svm;
  }

  getGenesisHash(): Promise<string> {
    return Promise.resolve(this.genesisHash);
  }

  getAccount(addr: Address): Promise<AccountInfo | null> {
    const a = this.svm.getAccount(addr);
    if (!a.exists) return Promise.resolve(null);
    return Promise.resolve({
      address: addr,
      owner: a.programAddress,
      lamports: a.lamports,
      data: Uint8Array.from(a.data),
    });
  }

  getProgramAccounts(
    program: Address,
    dataSize: number,
    filters: readonly MemcmpFilter[],
  ): Promise<AccountInfo[]> {
    return Promise.resolve(
      this.svm
        .getProgramAccounts(program)
        .filter((a) => a.data.length === dataSize && filters.every((f) => matches(a.data, f)))
        .map((a) => ({
          address: a.address,
          owner: a.programAddress,
          lamports: a.lamports,
          data: Uint8Array.from(a.data),
        })),
    );
  }

  async send(instructions: readonly Instruction[], feePayer: TransactionSigner): Promise<SentTx> {
    this.sends++;
    // A fresh blockhash per send, so retrying an identical transaction is not "already processed".
    this.svm.expireBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const res = this.svm.sendTransaction(tx);
    if (res instanceof FailedTransactionMetadata) throw new TxFailedError(failureOf(res));
    return { signature: getBase58Decoder().decode(res.signature()), logs: res.logs() };
  }

  getUnixTimestamp(): Promise<bigint> {
    return Promise.resolve(this.svm.getClock().unixTimestamp);
  }

  requestAirdrop(to: Address, lamportAmount: bigint): Promise<string> {
    const res = this.svm.airdrop(to, lamports(lamportAmount));
    if (res === null || res instanceof FailedTransactionMetadata) {
      return Promise.reject(new Error("airdrop failed"));
    }
    return Promise.resolve(getBase58Decoder().decode(res.signature()));
  }

  rentExempt(space: number): Promise<bigint> {
    return Promise.resolve(this.svm.minimumBalanceForRentExemption(BigInt(space)));
  }
}
