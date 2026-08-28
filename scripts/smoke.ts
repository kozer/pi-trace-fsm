import { strict as assert } from "node:assert";
import {
	buildModel,
	extractMessageActivities,
	predictNext,
	replayTrace,
	type TraceRecord,
} from "../fsm.ts";
import extension from "../index.ts";

assert.equal(typeof extension, "function");
assert.deepEqual(extractMessageActivities({ role: "user", content: "inspect" }), ["user:text"]);

const traces: TraceRecord[] = [
	{ id: "smoke-1", activities: ["user:text", "tool:read", "tool:bash"], outcome: "success" },
	{ id: "smoke-2", activities: ["user:text", "tool:read", "tool:bash"], outcome: "unknown" },
];
const model = buildModel(traces);
const next = predictNext(model, "user:text", 1);
assert.equal(next[0]?.activity, "tool:read");
assert.equal(replayTrace(model, traces[0].activities).fitness, 1);

console.log(`pi-trace-fsm smoke: ${model.traces} traces, ${model.alphabet.length} activities, next=${next[0]?.activity}`);
