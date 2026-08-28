# Architecture: pi-trace-fsm

## Decision

Use a standalone Pi package with flat functional modules:

- `index.ts` is the Pi adapter: lifecycle hooks, commands, and UI notices.
- `fsm.ts` is pure: activity extraction, directly-follows model construction,
  replay, prediction, feature extraction, evaluation, calibration, and risk
  scoring.
- `store.ts` is the persistence adapter: compact metadata-bearing JSONL records
  keyed by canonical project path.

Dependency direction:

```text
Pi events ──> index.ts ──> fsm.ts
                     └──> store.ts ──> node:fs
```

## Boundaries

The store never persists conversation text, tool arguments, tool-call
identifiers, or model output; it stores only activity symbols and compact
length, timestamp, and error metadata. Novelty, calibrated risk, and cycle
notices are advisory. Tool calls are never blocked by this package.

Historical sessions are scanned only by `/fsm-rebuild`; startup loads the
already-built project store and records current settled traces.
