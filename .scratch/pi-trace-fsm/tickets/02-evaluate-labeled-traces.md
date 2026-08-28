# 02 — Evaluate labeled traces offline
**Source:** `.scratch/pi-trace-fsm/spec.md` Scope Cuts, plus the approved follow-up monitor plan
**Blocked by:** 01 — Capture FSM risk features

## Outcome
Add a deterministic offline evaluator using the labels already created by `/fsm-mark`.

## Acceptance Criteria
- [x] Unknown or one-class datasets produce an explicit insufficient-labeled-data result instead of fabricated metrics. This must fail at the current base because no evaluator exists.
- [x] A seeded, disjoint, stratified training/holdout split is reproducible. This must fail at the current base because no split or evaluation seam exists.
- [x] The evaluator reports replay fitness, next-step cross-entropy, AUROC, precision, recall, and F1 for supplied predictions. This must fail at the current base because none of these evaluation functions exist.
- [x] Prefix checkpoints such as 25%, 50%, 75%, and 100% completion are supported. This must fail at the current base because scoring only accepts a complete supplied activity sequence.
- [x] A runnable command evaluates a local project store without contacting an external service. This must fail at the current base because the only runnable script is a model smoke check.
- [x] `npm test`, `npm run typecheck`, and `npm run smoke` remain green.

## Public Test Seam
Pure seeded split and metric functions plus an evaluator CLI that consumes the existing project JSONL store.

## Scope Boundary
Include labeled-data validation, deterministic splitting, prefix evaluation, and metrics needed by the monitor and future predictor. Do not train a failure model, calibrate runtime thresholds, reproduce external paper datasets, or add an external ML dependency.
