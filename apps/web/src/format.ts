import { Direction, RecordStatus, type FixedPoint } from "@agent-call-markets/core";

/** Exact decimal rendering of mantissa * 10^expo (no floats). */
export function formatFixed({ mantissa, expo }: FixedPoint): string {
  const negative = mantissa < 0n;
  const abs = negative ? -mantissa : mantissa;
  let out: string;
  if (expo >= 0) {
    out = (abs * 10n ** BigInt(expo)).toString();
  } else {
    const places = -expo;
    const digits = abs.toString().padStart(places + 1, "0");
    out = `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
  }
  return negative ? `-${out}` : out;
}

/** Unix seconds -> "YYYY-MM-DD HH:MM:SS UTC". */
export function formatUtc(ts: bigint): string {
  return `${new Date(Number(ts) * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const STATUS: Readonly<Record<RecordStatus, string>> = {
  [RecordStatus.PendingReveal]: "Sealed, awaiting reveal",
  [RecordStatus.UnrevealedMiss]: "Not revealed in time (counts as a miss)",
  [RecordStatus.PendingOutcome]: "Revealed, awaiting settlement",
  [RecordStatus.Hit]: "Hit",
  [RecordStatus.Miss]: "Miss",
  [RecordStatus.Void]: "Void (refunded; not counted)",
};

export function statusLabel(status: RecordStatus): string {
  return STATUS[status];
}

export function directionLabel(direction: Direction): "above" | "below" {
  return direction === Direction.Above ? "above" : "below";
}
