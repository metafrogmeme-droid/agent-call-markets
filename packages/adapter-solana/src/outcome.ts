import {
  CallStatus,
  decideOutcome,
  type CallState,
  type ProtocolParams,
} from "@agent-call-markets/core";

/** Whether the on-chain outcome matches the core rule re-applied to the stored observation. */
export type OutcomeCheck = "match" | "mismatch" | "n/a";

/**
 * Re-applies the core settlement rule to a settled call's stored observation and compares it with
 * the outcome the program recorded (docs/PLAN.md §1.3). "n/a" until the call is settled.
 */
export function checkOutcome(state: CallState, params: ProtocolParams): OutcomeCheck {
  if (state.status !== CallStatus.Settled || state.call === null || state.observation === null) {
    return "n/a";
  }
  const derived = decideOutcome(state.call, state.observation, params);
  return derived.ok && derived.value === state.outcome ? "match" : "mismatch";
}
