import { strict as assert } from "node:assert";
import {
	buildModel,
	evaluateLabeledTraces,
	extractMessageActivities,
	formatFsmContext,
	predictNext,
	replayTrace,
	type TraceRecord,
} from "../fsm.ts";
import extension from "../index.ts";

assert.equal(typeof extension, "function");
assert.deepEqual(extractMessageActivities({ role: "user", content: "inspect" }), ["user:text"]);

const traces: TraceRecord[] = [
	{ id: "smoke-success-1", activities: ["user:text", "tool:read", "tool:bash", "tool:read"], outcome: "success" },
	{ id: "smoke-success-2", activities: ["user:text", "tool:read", "tool:bash", "tool:read"], outcome: "success" },
	{ id: "smoke-failure-1", activities: ["user:text", "tool:read", "tool:read", "tool:read"], outcome: "failure" },
	{ id: "smoke-failure-2", activities: ["user:text", "tool:read", "tool:read", "tool:read"], outcome: "failure" },
];
const model = buildModel(traces, { minTransitionCount: 1 });
const next = predictNext(model, "user:text", 1);
assert.equal(next[0]?.activity, "tool:read");
assert.equal(replayTrace(model, traces[0].activities).fitness, 1);
const context = formatFsmContext(model, "tool:read");
assert.match(context, /Common multi-step continuations/);
assert.match(context, /tool:read/);
const evaluation = evaluateLabeledTraces(traces, { seed: 7 });
assert.equal(evaluation.ok, true);

console.log(`pi-trace-fsm smoke: ${model.traces} traces, ${model.alphabet.length} activities, next=${next[0]?.activity}, context=paper-minimal, evaluation=${evaluation.ok}`);
