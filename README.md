# pi-trace-fsm

A passive Pi extension that learns directly-following activity patterns from
agent traces. It is a small, dependency-free implementation of the core FSM
construction described in [*Automata from Agent Traces: Failure and Next-Step
Prediction*](https://arxiv.org/abs/2608.23670).

## Install

Try it for one run:

```sh
pi -e /mnt/BACKUP/programming-free-time/my-projects/pi-trace-fsm/index.ts
```

Install the local package for normal Pi discovery:

```sh
pi install /mnt/BACKUP/programming-free-time/my-projects/pi-trace-fsm
```

Restart Pi after installation. This project does not modify your Pi settings
automatically.

## Commands

- `/fsm-rebuild` — scan historical sessions for the current project and rebuild
  the trace store.
- `/fsm-status` — show model size, current state, next activities, labels, and
  current-trace metrics.
- `/fsm-next [state]` — show probability-ranked next activities. Without a
  state, uses the current state.
- `/fsm-evaluate` — evaluate labeled traces with deterministic holdout and
  prefix metrics.
- `/fsm-mark success|failure|unknown` — label the latest completed trace.

The extension starts warning-only. It never blocks a tool call or terminates a
run.

## Model

Activities are deliberately coarse:

- `user:text`
- `assistant:text`
- `tool:<name>`

Tool results, arguments, thinking blocks, extension custom entries, and message
content are not stored. Historical extraction follows the active branch of each
Pi session and starts a trace at each user message. A live trace ends at
`agent_settled`.

The model has one state per observed activity plus `<start>`. It counts each
`(state, next activity)` pair and drops a transition seen once when its source
state has another observed continuation. A source state's only continuation is
retained even when seen once. The filtered transitions remain deterministic.

Next-step probabilities use the paper's additive estimator over the full
training alphabet:

```text
P(a|q) = (C(q,a) + alpha) / (sum(C(q,a')) + alpha * |A|)
```

The default `alpha` is `0.1` and is configurable through `buildModel()`. The
model also counts observed continuation paths up to depth five and keeps the
top 15 per state. The paper does not prescribe a continuation-depth value, so
five is an explicit bounded default exposed by `buildModel()`. `/fsm-next` and
the prompt context render probabilities plus those continuations in the paper's
minimal format. The runtime context starts after the first stored trace; novelty
warnings still wait for five traces.

`/fsm-evaluate` builds its model only from the deterministic stratified
training split, replays the disjoint holdout at 25%, 50%, 75%, and 100% prefix
checkpoints, and reports fitness, smoothed cross-entropy, top-1 next-step
accuracy, and novel-transition rate. After at least two success and two failure
labels, it calibrates passive cycle/surprise warnings, activates the paper's
five-step stuck-state rule, and exposes a feature-based failure-risk score in
`/fsm-status` and the next prompt. These signals never block or terminate a
run.

Cycle rate is `(activity count - unique activity count) / activity count`; it is
a transparent local feature, not a failure diagnosis.

## Storage

Traces are stored outside the project at:

```text
~/.pi/agent/pi-trace-fsm/<project-hash>.jsonl
```

Each record contains activity names, a trace id, outcome label, timestamps, and
compact message-length/error metadata. Conversation text, tool arguments, tool
output, and tool-call identifiers are never persisted by this extension. Rebuild
uses Pi's public `SessionManager` API and atomically replaces the project's
snapshot while preserving explicit labels.

## Development

```sh
npm install
npm test
npm run typecheck
npm run smoke
```

The extension uses Pi as a peer dependency at runtime and Node's standard
library for persistence and its small dependency-free logistic risk model. No
automata package, embeddings, or external service is required.
