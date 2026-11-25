# Bridge fixtures (synthetic)

Everything in this folder is **fake**. The journal uses the provisional `acm-journal-fixture/v0`
format defined in `apps/bridge/src/journal.ts`; it is **not** the AudaceFi journal format, which is
still unknown (open question Q8). Agent labels (`FAKE-AGENT-*`) map to synthetic 32-byte ids
(`a1…`, `b2…`), and asset labels (`FAKE-*/USD`) map to synthetic feed ids (`f1…`, `f2…`) that are
not real Pyth feed ids. Tests fix "now" at `2026-12-01T12:00:00Z`.
