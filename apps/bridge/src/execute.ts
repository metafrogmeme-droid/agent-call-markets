import {
  bytes32,
  bytesEqual,
  bytesToHex,
  commitmentOf,
  CoreError,
  ErrorCode,
  randomSalt,
  SEAL_VERSION_V1,
  type Bytes32,
  type CallRef,
  type CallV1,
  type ChainAdapter,
  type RandomSource,
} from "@agent-call-markets/core";
import { SkipReason, type Skip } from "./journal.ts";
import type { Ledger, LedgerRecord, SaltRecord, SaltStore } from "./ledger.ts";
import type { BridgePlan, SealIntent } from "./plan.ts";

export interface ExecuteOptions {
  /** Any ChainAdapter whose signer is `agentKey`. M5 tests use the core's MemoryAdapter only. */
  readonly adapter: ChainAdapter;
  /** The agent the adapter seals as. Intents for other agents are skipped, never sealed. */
  readonly agentKey: Bytes32;
  readonly ledger: Ledger;
  readonly salts: SaltStore;
  /** The chain's clock (unix seconds), for freshness on resume and ledger timestamps. */
  readonly now: () => bigint | Promise<bigint>;
  /** CSPRNG for salts (defaults to globalThis.crypto). */
  readonly random?: RandomSource;
}

export interface SealedEntry {
  readonly line: number;
  readonly entryId: string;
  readonly commitment: string;
  readonly callRef: CallRef;
  /** Resumed from a pending ledger record (found on chain, or re-sent with the stored salt). */
  readonly recovered: boolean;
}

export interface RejectedEntry {
  readonly line: number;
  readonly entryId: string;
  readonly code: ErrorCode | null;
  readonly detail: string;
}

export interface ExecuteReport {
  readonly chainId: string;
  readonly sealed: readonly SealedEntry[];
  readonly rejected: readonly RejectedEntry[];
  readonly skipped: readonly Skip[];
}

/**
 * Codes with which a chain rejects a seal on its rules. These are final: the entry is recorded as
 * rejected and never retried. Anything else (read-only adapter, transport or cluster errors, ...)
 * stops the run and leaves the entry pending, so the next run can recover it.
 */
const REJECTIONS: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.ExpiryTooSoon,
  ErrorCode.ExpiryTooFar,
  ErrorCode.ZeroCommitment,
  ErrorCode.ZeroAgent,
]);

function callFromSalt(rec: SaltRecord): CallV1 {
  return {
    version: SEAL_VERSION_V1,
    agent: bytes32(rec.agent),
    feedId: bytes32(rec.feedId),
    direction: rec.direction,
    level: { mantissa: BigInt(rec.levelMantissa), expo: rec.levelExpo },
    expiryTs: BigInt(rec.expiryTs),
  };
}

/**
 * Seals a plan's intents, one attempt per entry. For each new entry: draw a salt, store it, record
 * the entry as pending, then send. A pending entry (an earlier run stopped mid-way) is looked up
 * on chain first; if it isn't there it is re-sent with the same stored salt, but only while the
 * entry is still fresh, so nothing is sealed late with hindsight.
 */
export async function executePlan(plan: BridgePlan, opts: ExecuteOptions): Promise<ExecuteReport> {
  const chainId = opts.adapter.chainId;
  const sealed: SealedEntry[] = [];
  const rejected: RejectedEntry[] = [];
  const skipped: Skip[] = [];
  const agentHex = bytesToHex(opts.agentKey);
  const stamp = async () => (await opts.now()).toString();

  const record = async (
    intent: SealIntent,
    rec: Omit<LedgerRecord, "entryId" | "contentHash" | "agent" | "updatedTs">,
  ) => {
    opts.ledger.put({
      entryId: intent.entryId,
      contentHash: intent.contentHash,
      agent: agentHex,
      updatedTs: await stamp(),
      ...rec,
    });
  };

  const send = async (
    intent: SealIntent,
    call: CallV1,
    commitment: Bytes32,
    recovered: boolean,
  ) => {
    const commitmentHex = bytesToHex(commitment);
    let ref: CallRef;
    try {
      ref = (await opts.adapter.sealCall({ commitment, expiryTs: call.expiryTs })).value;
    } catch (e) {
      if (e instanceof CoreError && REJECTIONS.has(e.code)) {
        await record(intent, {
          status: "rejected",
          commitment: commitmentHex,
          code: e.code,
          detail: e.message,
        });
        rejected.push({
          line: intent.line,
          entryId: intent.entryId,
          code: e.code,
          detail: e.message,
        });
        return;
      }
      throw e;
    }
    await record(intent, { status: "sealed", commitment: commitmentHex, callRef: ref });
    sealed.push({
      line: intent.line,
      entryId: intent.entryId,
      commitment: commitmentHex,
      callRef: ref,
      recovered,
    });
  };

  for (const intent of plan.intents) {
    if (!bytesEqual(intent.call.agent, opts.agentKey)) {
      skipped.push({
        line: intent.line,
        entryId: intent.entryId,
        reason: SkipReason.NotThisAgent,
        detail: "the adapter seals for another agent",
      });
      continue;
    }
    const prior = opts.ledger.get(intent.entryId);

    if (!intent.resume) {
      if (prior !== undefined) {
        // The ledger changed since planning (e.g. another run); never seal twice.
        skipped.push({
          line: intent.line,
          entryId: intent.entryId,
          reason:
            prior.contentHash === intent.contentHash
              ? SkipReason.AlreadyProcessed
              : SkipReason.LedgerConflict,
          detail: `ledger status ${prior.status}`,
        });
        continue;
      }
      const salt = randomSalt(opts.random);
      const commitment = commitmentOf(intent.call, salt);
      const commitmentHex = bytesToHex(commitment);
      opts.salts.put({
        version: 1,
        entryId: intent.entryId,
        chainId,
        agent: agentHex,
        feedId: bytesToHex(intent.call.feedId),
        direction: intent.call.direction,
        levelMantissa: intent.call.level.mantissa.toString(),
        levelExpo: intent.call.level.expo,
        expiryTs: intent.call.expiryTs.toString(),
        salt: bytesToHex(salt),
        commitment: commitmentHex,
      });
      await record(intent, { status: "pending", commitment: commitmentHex });
      await send(intent, intent.call, commitment, false);
      continue;
    }

    // Resume a pending entry.
    if (
      prior?.status !== "pending" ||
      prior.contentHash !== intent.contentHash ||
      prior.commitment === undefined
    ) {
      skipped.push({
        line: intent.line,
        entryId: intent.entryId,
        reason: SkipReason.LedgerConflict,
        detail: "no matching pending record to resume",
      });
      continue;
    }
    const pendingCommitment = prior.commitment;
    const onChain = (await opts.adapter.listCalls(opts.agentKey)).find(
      (r) => bytesToHex(r.state.commitment) === pendingCommitment,
    );
    if (onChain !== undefined) {
      await record(intent, {
        status: "sealed",
        commitment: pendingCommitment,
        callRef: onChain.ref,
      });
      sealed.push({
        line: intent.line,
        entryId: intent.entryId,
        commitment: pendingCommitment,
        callRef: onChain.ref,
        recovered: true,
      });
      continue;
    }
    const saltRec = opts.salts.get(pendingCommitment);
    const now = await opts.now();
    const stale = now - intent.createdAt > plan.maxEntryAgeSecs;
    if (saltRec === undefined || stale) {
      const detail =
        saltRec === undefined
          ? "pending seal not found on chain and its salt is missing; not re-sent"
          : `stale: pending seal not found on chain and the entry is older than ${plan.maxEntryAgeSecs}s; not re-sent`;
      await record(intent, { status: "rejected", commitment: pendingCommitment, detail });
      rejected.push({ line: intent.line, entryId: intent.entryId, code: null, detail });
      continue;
    }
    const call = callFromSalt(saltRec);
    const commitment = commitmentOf(call, bytes32(saltRec.salt));
    if (bytesToHex(commitment) !== pendingCommitment) {
      throw new CoreError(
        ErrorCode.CommitmentMismatch,
        `stored salt for ${intent.entryId} does not match its commitment`,
      );
    }
    await send(intent, call, commitment, true);
  }

  return { chainId, sealed, rejected, skipped };
}
