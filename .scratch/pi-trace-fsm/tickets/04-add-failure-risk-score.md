# 04 — Add a labeled failure-risk score
**Source:** `.scratch/pi-trace-fsm/spec.md` Scope Cuts, plus the approved follow-up monitor plan
**Blocked by:** 01 — Capture FSM risk features; 02 — Evaluate labeled traces offline

## Outcome
Train a small class-weighted failure predictor from FSM features and expose its score passively in status and prompt hints.

## Acceptance Criteria
- [x] Training excludes unknown traces and refuses insufficient or one-class data. This must fail at the current base because no training or prediction model exists.
- [x] A separable labeled fixture produces deterministic score ordering and evaluator metrics. This must fail at the current base because no feature-based outcome scorer exists.
- [x] Runtime output includes score availability and the strongest contributing features. This must fail at the current base because `/fsm-status` reports only labels, counts, and heuristic metrics.
- [x] The score is recomputed from the project’s labeled store and never changes tool behavior. This must fail at the current base because no score exists and the runtime has no model-training path.
- [x] No external ML service or dependency is required unless later evidence justifies one. This is a boundary condition for the implementation, not an existing capability.
- [x] `npm test`, `npm run typecheck`, and `npm run smoke` remain green.

## Public Test Seam
Pure `trainFailureModel()` and `predictFailure()` functions plus `/fsm-status` integration.

## Scope Boundary
Include a small deterministic supervised model, labeled-store training, score explanation, and passive Pi presentation. The current spec’s supervised-model no-go is superseded only for this ticket. Do not block tools, terminate runs, add embeddings, contact an external service, or reproduce the paper’s full gradient-boosting benchmark pipeline.
