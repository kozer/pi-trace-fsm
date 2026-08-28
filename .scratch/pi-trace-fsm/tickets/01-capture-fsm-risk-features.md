# 01 — Capture FSM risk features
**Source:** `.scratch/pi-trace-fsm/spec.md` Scope Cuts, plus the approved follow-up monitor plan
**Blocked by:** None

## Outcome
Add privacy-preserving per-prefix and per-state features while reusing the existing `fsm.ts` model and replay code.

## Acceptance Criteria
- [x] Synthetic timed Pi entries produce deterministic visit, message-length metadata, error, temporal, cycle, and recurrence features. This must fail at the current base because `TraceRecord` stores only activities, outcome, and timestamps, while live tool-error counts are not persisted.
- [x] Prefix scoring exposes replay fitness, transition surprise, cross-entropy, maximum surprise, half-to-half drift, and minimum transition probability. This must fail at the current base because only transition counts/probabilities and replay fitness exist.
- [x] Historical and live traces use the same feature schema, and JSONL contains no message text, tool arguments, or tool output. This must fail at the current base because historical extraction discards timing/results and storage has no feature schema.
- [x] `npm test`, `npm run typecheck`, and `npm run smoke` remain green.

## Public Test Seam
A public `TraceFeatures` type plus pure feature-extraction and prefix-scoring functions; `TraceStore` round-trip tests verify the persisted metadata boundary.

## Scope Boundary
Include feature derivation from public Pi-shaped entries and current live hooks, compact metadata persistence, and deterministic formulas documented at the pure seam. Reuse the existing FSM and replay implementation. Do not add a classifier, threshold calibration, external service, raw content storage, or benchmark dataset loader.
