# Passive Pi Trace FSM

## Problem

Pi sessions contain repeated tool-use workflows, but that structure is not
currently summarized or surfaced. The paper *Automata from Agent Traces* gives a
small directly-follows FSM that can describe next actions and flag novel or
repetitive paths without an ML dependency.

## Observed Current Behavior

- Pi persists session entries as JSONL trees under `~/.pi/agent/sessions`.
- Public extension hooks expose message, tool, agent-settled, and shutdown
  lifecycles.
- The requested package is a new standalone directory under
  `/mnt/BACKUP/programming-free-time/my-projects`.
- Pi has no reliable built-in success/failure label for completed coding tasks.

## Desired Behavior

A standalone Pi package named `pi-trace-fsm` shall collect activity-only traces
per project and implement the paper's complete passive runtime surface: a
deterministic last-activity FSM, additive-smoothed next-step probabilities,
top-15 multi-step continuations, replay and held-out evaluation, structural
failure features, and calibrated runtime monitoring. It shall inject the
minimal FSM context into the next model prompt and emit explainable passive
warnings for novel transitions, cycles, and surprising prefixes. It shall
never block a tool call, terminate a run, or claim paper benchmark results
without local evaluation evidence.

## Domain Language

- **Activity:** `user:text`, `assistant:text`, or `tool:<name>`.
- **Trace:** activities from one user prompt until `agent_settled`.
- **FSM:** directly-following counts keyed by the previous activity, with
  one-off transitions removed unless they are the source state's only outgoing
  continuation.
- **Outcome:** `success`, `failure`, or `unknown`; new traces default to
  `unknown` and can be manually labeled.
- **Novel transition:** a proposed edge absent from the filtered FSM.
- **Smoothed next-step probability:** the paper's additive-smoothed estimate
  `P(a|q) = (C(q,a) + α) / Σa'(C(q,a') + α|A|)` over the training alphabet.
- **Continuation:** a deterministic multi-activity path beginning after an FSM
  state, ranked by observed path count and rendered in the minimal context
  format used by the paper.
- **Cycle rate:** repeated activity occurrences divided by activity count; this
  is an explicit local heuristic, not a paper benchmark operating point.

## Repository Structure

This is a standalone package using a flat functional-composition layout:

```text
pi-trace-fsm/
  index.ts
  fsm.ts
  store.ts
  tests/fsm.test.ts
  scripts/smoke.ts
```

`index.ts` depends on `fsm.ts` and `store.ts`; `fsm.ts` has no Pi runtime
dependency; `store.ts` uses Node standard-library filesystem APIs.

## Architecture and Placement

The package is placed at:

`/mnt/BACKUP/programming-free-time/my-projects/pi-trace-fsm`

It follows the existing Pi package convention used by the local `pi-dap`
extension: `package.json` declares `pi.extensions`, TypeScript is loaded by Pi,
and Pi core is a peer dependency. Runtime behavior is passive and warning-only.

Historical rebuilding is explicit through `/fsm-rebuild`; normal startup loads
the compact project store and learns new settled traces without rescanning every
session file.

## Public Test Seam

Pure functions in `fsm.ts` are the primary seam: model construction,
smoothed prediction, continuation extraction, replay, feature scoring,
calibration, and deterministic evaluation. The extension factory and commands
are covered by typecheck and a separate smoke script; no TUI harness is
needed.

## Acceptance Criteria

1. Historical Pi-shaped message entries become activity-only traces while
   ignoring tool-result content and extension custom entries.
2. `buildModel()` has at most one successor per `(state, activity)` pair and
   applies the paper's exact rare-transition rule.
3. `predictNext()` implements additive smoothing over the model alphabet and
   returns deterministic probability-ranked successors; `continuationsFrom()`
   returns deterministic top-15 multi-step paths with observed counts.
4. `replayTrace()` and the evaluator report consumed/novel transitions,
   smoothed next-step cross-entropy, replay fitness, and prefix checkpoints on
   a disjoint deterministic holdout split.
5. `TraceStore` persists only compact trace records, tolerates malformed lines,
   supports labels, and replaces a rebuilt snapshot atomically.
6. The extension registers `/fsm-status`, `/fsm-next`, `/fsm-evaluate`,
   `/fsm-mark`, and `/fsm-rebuild`, and renders the paper's minimal FSM context
   with probabilities plus top-15 continuations.
7. Structural feature extraction and the passive monitor remain available for
   live prefixes; cycle, surprise, and five-step stuck-state warnings name the
   rule, observed value, threshold, and FSM state.
8. The extension collects current activities through public Pi hooks and never
   blocks `tool_call` or terminates a run.
9. Focused tests, typecheck, and the smoke script pass.

## Risks and Unknowns

- A single per-project FSM may mix unrelated task types and produce weak
  predictions; task clustering is deliberately deferred.
- Success/failure labels are sparse until the user marks traces manually.
- Historical session scans can be expensive in very large session directories;
  they are explicit rather than part of startup.
- The monitor is a novelty/repetition signal, not proof that an agent failed.

## No-Gos

- No automatic tool blocking or process termination.
- No conversation text or tool arguments in the trace store.
- No XState/automata dependency.
- No embeddings or external service.
- No modification of pi-observational-memory or pi-fff.

## Scope Cuts

This target is the complete passive runtime implementation, not a reproduction
of the paper's external benchmark tables. It omits external dataset loaders,
RPNI/EDSM/Alergia/k-Tails/process-mining baselines, and paper-scale neural or
gradient-boosted benchmark training. Higher-order PPM remains optional
research work because the paper's winning LLM context uses first-order
probabilities plus observed continuations. The runtime stays warning-only:
the paper's automatic early-stop action is deliberately not enabled in Pi.

## Evidence

- Pi extension API and session format documentation under
  `/home/wild/.vite-plus/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/docs/`.
- Existing local Pi package convention at
  `/home/wild/dotfiles/dcli/modules/ai/pi/agent/extensions/pi-dap/`.
- Paper text at `/tmp/arxiv-2608.23670.txt`.
- Local trace probe: 17 dotfiles sessions, 260 traces, 4,838 activity events,
  28 action symbols, and 0.9696 holdout replay fitness.
