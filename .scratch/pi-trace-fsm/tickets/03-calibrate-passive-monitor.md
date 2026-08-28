# 03 — Calibrate the passive risk monitor
**Source:** `.scratch/pi-trace-fsm/spec.md` Desired Behavior and No-Gos, plus the approved follow-up monitor plan
**Blocked by:** 01 — Capture FSM risk features; 02 — Evaluate labeled traces offline

## Outcome
Replace hardcoded warning thresholds with thresholds calibrated from labeled training traces while preserving the warning-only boundary.

## Acceptance Criteria
- [x] Calibration uses training labels only and reports selected thresholds plus holdout metrics. This must fail at the current base because cycle warnings use hardcoded activity-count and cycle-rate thresholds.
- [x] Prefix inspection combines warm-up, unique-state/cycle behavior, and surprise/cross-entropy signals. This must fail at the current base because the runtime only checks one hardcoded cycle heuristic and does not calculate surprise.
- [x] A triggered warning names the rule, observed value, threshold, and current FSM state. This must fail at the current base because existing warnings only report a novel edge or a cycle-rate value.
- [x] Healthy and cyclic synthetic traces produce deterministic non-trigger and trigger results. This must fail at the current base because no pure calibrated monitor seam exists.
- [x] The extension remains warning-only: it never blocks a tool call or terminates a run. The existing no-go must remain covered by an integration test.
- [x] `npm test`, `npm run typecheck`, and `npm run smoke` remain green.

## Public Test Seam
Pure `calibrateMonitor()` and `inspectPrefix()` functions plus the existing Pi warning hook.

## Scope Boundary
Include training-only threshold calibration, prefix risk inspection, explainable warnings, and passive status reporting. Do not terminate sessions, block tools, modify other Pi extensions, or claim paper-level operating points without local holdout evidence.
