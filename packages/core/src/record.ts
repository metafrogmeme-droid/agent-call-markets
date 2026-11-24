import { bytesEqual, type Bytes32 } from "./bytes.ts";
import type { Ratio } from "./parimutuel.ts";
import { recordStatus, RecordStatus, type CallState } from "./state.ts";

/**
 * An agent's public record, computed only from call states (chain data) and the current time.
 * Raw counts and the hit rate with its sample size; nothing else (no PnL, no ranking).
 */
export interface AgentRecord {
  readonly sealed: number;
  readonly revealed: number;
  /** Not yet decided: awaiting reveal (before the deadline) or awaiting settlement. */
  readonly pending: number;
  readonly hits: number;
  /** Settled misses plus calls not revealed by their deadline. */
  readonly misses: number;
  /** The part of `misses` that comes from calls never revealed in time. */
  readonly unrevealedMisses: number;
  /** Voided calls (no valid settlement in time). Never counted as hits or misses (Q10). */
  readonly voids: number;
  /** Calls where the agent's own key holds a position in its own market. Shown, not penalised. */
  readonly selfTradedCalls: number;
  /** hits / (hits + misses); null when nothing has been decided yet. */
  readonly hitRate: Ratio | null;
  /** hits + misses. */
  readonly sampleSize: number;
}

export function computeAgentRecord(
  agent: Bytes32,
  states: readonly CallState[],
  now: bigint,
): AgentRecord {
  let sealed = 0;
  let revealed = 0;
  let pending = 0;
  let hits = 0;
  let settledMisses = 0;
  let unrevealedMisses = 0;
  let voids = 0;
  let selfTradedCalls = 0;

  for (const s of states) {
    if (!bytesEqual(s.agent, agent)) continue;
    sealed++;
    if (s.call !== null) revealed++;
    if (s.market?.positions.some((p) => bytesEqual(p.owner, agent)) === true) selfTradedCalls++;
    switch (recordStatus(s, now)) {
      case RecordStatus.PendingReveal:
      case RecordStatus.PendingOutcome:
        pending++;
        break;
      case RecordStatus.UnrevealedMiss:
        unrevealedMisses++;
        break;
      case RecordStatus.Hit:
        hits++;
        break;
      case RecordStatus.Miss:
        settledMisses++;
        break;
      case RecordStatus.Void:
        voids++;
        break;
    }
  }

  const misses = settledMisses + unrevealedMisses;
  const sampleSize = hits + misses;
  return {
    sealed,
    revealed,
    pending,
    hits,
    misses,
    unrevealedMisses,
    voids,
    selfTradedCalls,
    hitRate: sampleSize === 0 ? null : { num: BigInt(hits), den: BigInt(sampleSize) },
    sampleSize,
  };
}

/**
 * Display string with the sample size and void count always next to the rate.
 * The percentage is rounded down to one decimal so it is never overstated.
 * e.g. "60.0% hit rate (3 of 5 decided; 1 void)".
 */
export function formatHitRate(record: AgentRecord): string {
  const voids = `${record.voids} void${record.voids === 1 ? "" : "s"}`;
  if (record.hitRate === null) return `no decided calls yet (0 decided; ${voids})`;
  const tenths = (record.hitRate.num * 1000n) / record.hitRate.den;
  const pct = `${tenths / 10n}.${tenths % 10n}%`;
  return `${pct} hit rate (${record.hits} of ${record.sampleSize} decided; ${voids})`;
}
