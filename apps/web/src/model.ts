import {
  bytesEqual,
  bytesToHex,
  CallStatus,
  computeAgentRecord,
  decideOutcome,
  formatHitRate,
  recordStatus,
  type AgentRecord,
  type CallState,
  type ErrorCode,
  type Outcome,
  type ProtocolParams,
  type RecordStatus,
} from "@agent-call-markets/core";
import { directionLabel, formatFixed, statusLabel } from "./format.ts";
import type { RecordData } from "./source.ts";

export type OutcomeCheck = "match" | "mismatch" | "n/a";

export interface CallRow {
  readonly id: string;
  readonly status: RecordStatus;
  readonly statusLabel: string;
  readonly commitment: string;
  readonly sealTs: bigint;
  readonly expiryTs: bigint;
  readonly revealDeadlineTs: bigint;
  /** Null until revealed: before that, only the commitment and the expiry are public. */
  readonly revealed: {
    readonly feedId: string;
    readonly direction: "above" | "below";
    readonly level: string;
    /** Public after reveal, so anyone can recompute the commitment. */
    readonly salt: string;
  } | null;
  /** The outcome stored on chain. */
  readonly outcome: Outcome | null;
  /** The core rule re-applied to the stored observation (an ErrorCode if it rejects it). */
  readonly coreOutcome: Outcome | ErrorCode | null;
  readonly outcomeCheck: OutcomeCheck;
  /** The agent's own key holds a position in this call's market. */
  readonly selfTraded: boolean;
  readonly observation: {
    readonly price: string;
    readonly conf: string;
    readonly publishTime: bigint;
  } | null;
  readonly settledTs: bigint | null;
}

export interface AgentView {
  readonly label: string;
  /** The agent's public id, hex (also the page's file name). */
  readonly id: string;
  readonly record: AgentRecord;
  /** The core's display string: the hit rate always next to its sample size and voids. */
  readonly summary: string;
  readonly calls: readonly CallRow[];
  /** Calls whose on-chain outcome differs from the core rule. */
  readonly mismatches: number;
}

export interface SiteModel {
  readonly source: string;
  readonly synthetic: boolean;
  readonly takenAt: bigint;
  readonly params: ProtocolParams;
  /** Sorted by label. Never ranked by hit rate. */
  readonly agents: readonly AgentView[];
}

function row(
  id: string,
  s: CallState,
  agentId: Uint8Array,
  takenAt: bigint,
  params: ProtocolParams,
): CallRow {
  let coreOutcome: Outcome | ErrorCode | null = null;
  let outcomeCheck: OutcomeCheck = "n/a";
  if (s.status === CallStatus.Settled && s.call !== null && s.observation !== null) {
    const derived = decideOutcome(s.call, s.observation, params);
    coreOutcome = derived.ok ? derived.value : derived.error.code;
    outcomeCheck = derived.ok && derived.value === s.outcome ? "match" : "mismatch";
  }
  const status = recordStatus(s, takenAt);
  return {
    id,
    status,
    statusLabel: statusLabel(status),
    commitment: bytesToHex(s.commitment),
    sealTs: s.sealTs,
    expiryTs: s.expiryTs,
    revealDeadlineTs: s.revealDeadlineTs,
    revealed:
      s.call === null
        ? null
        : {
            feedId: bytesToHex(s.call.feedId),
            direction: directionLabel(s.call.direction),
            level: formatFixed(s.call.level),
            salt: s.salt === null ? "" : bytesToHex(s.salt),
          },
    outcome: s.outcome,
    coreOutcome,
    outcomeCheck,
    selfTraded: s.market?.positions.some((p) => bytesEqual(p.owner, agentId)) === true,
    observation:
      s.observation === null
        ? null
        : {
            price: formatFixed({ mantissa: s.observation.price, expo: s.observation.expo }),
            conf: formatFixed({ mantissa: s.observation.conf, expo: s.observation.expo }),
            publishTime: s.observation.publishTime,
          },
    settledTs: s.settledTs,
  };
}

/** Builds the page model from chain data: records by the core, outcomes re-checked by the core. */
export function buildModel(data: RecordData): SiteModel {
  const agents = [...data.agents]
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .map((agent): AgentView => {
      const mine = data.calls
        .filter((c) => bytesEqual(c.state.agent, agent.id))
        .sort((a, b) =>
          a.state.sealTs === b.state.sealTs
            ? a.id.localeCompare(b.id)
            : a.state.sealTs < b.state.sealTs
              ? -1
              : 1,
        );
      const record = computeAgentRecord(
        agent.id,
        mine.map((c) => c.state),
        data.takenAt,
      );
      const calls = mine.map((c) => row(c.id, c.state, agent.id, data.takenAt, data.params));
      return {
        label: agent.label,
        id: bytesToHex(agent.id),
        record,
        summary: formatHitRate(record),
        calls,
        mismatches: calls.filter((c) => c.outcomeCheck === "mismatch").length,
      };
    });
  return {
    source: data.source,
    synthetic: data.synthetic,
    takenAt: data.takenAt,
    params: data.params,
    agents,
  };
}
