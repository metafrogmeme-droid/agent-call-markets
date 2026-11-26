import { describe, expect, it } from "vitest";
import { Direction, RecordStatus } from "@agent-call-markets/core";
import { directionLabel, formatFixed, formatUtc, statusLabel } from "../src/format.ts";
import { escapeHtml } from "../src/html.ts";

describe("escaping", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;",
    );
    expect(escapeHtml("plain-text_123")).toBe("plain-text_123");
  });
});

describe("formatting", () => {
  it("prints fixed-point numbers exactly", () => {
    expect(formatFixed({ mantissa: 18525n, expo: -2 })).toBe("185.25");
    expect(formatFixed({ mantissa: 90000n, expo: 0 })).toBe("90000");
    expect(formatFixed({ mantissa: 1n, expo: -6 })).toBe("0.000001");
    expect(formatFixed({ mantissa: 100_000_000n, expo: -6 })).toBe("100.000000");
    expect(formatFixed({ mantissa: 12n, expo: 3 })).toBe("12000");
    expect(formatFixed({ mantissa: -12345n, expo: -2 })).toBe("-123.45");
    expect(formatFixed({ mantissa: -5n, expo: -3 })).toBe("-0.005");
  });

  it("prints times in UTC", () => {
    expect(formatUtc(1_800_000_000n)).toBe("2027-01-15 08:00:00 UTC");
    expect(formatUtc(0n)).toBe("1970-01-01 00:00:00 UTC");
  });

  it("labels every record status and direction without performance language", () => {
    for (const s of Object.values(RecordStatus)) {
      expect(statusLabel(s).length).toBeGreaterThan(0);
    }
    expect(statusLabel(RecordStatus.UnrevealedMiss)).toMatch(/counts as a miss/);
    expect(statusLabel(RecordStatus.Void)).toMatch(/not counted/);
    expect(directionLabel(Direction.Above)).toBe("above");
    expect(directionLabel(Direction.Below)).toBe("below");
  });
});
