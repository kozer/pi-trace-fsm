import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	START_STATE,
	buildModel,
	calibrateMonitor,
	extractHistoricalTraces,
	extractMessageActivities,
	evaluateLabeledTraces,
	evaluatePredictions,
	extractTraceFeatures,
	inspectPrefix,
	inspectTrace,
	predictFailure,
	splitLabeledTraces,
	predictNext,
	trainFailureModel,
	replayTrace,
	type TraceRecord,
} from "../fsm.ts";
import { TraceStore } from "../store.ts";

test("extracts only stable activity symbols from Pi messages", () => {
	assert.deepEqual(
		extractMessageActivities({
			role: "user",
			content: "Inspect the project",
		}),
		["user:text"],
	);

	assert.deepEqual(
		extractMessageActivities({
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect it." },
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "toolCall", name: "read", arguments: { path: "src" } },
			],
		}),
		["assistant:text", "tool:read"],
	);

	assert.deepEqual(
		extractMessageActivities({ role: "toolResult", toolName: "read", isError: true }),
		[],
	);
});

test("splits historical entries at user messages and ignores tool results", () => {
	const traces = extractHistoricalTraces(
		[
			{ type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "one" } },
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "",
				message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", name: "read" }] },
			},
			{
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: "",
				message: { role: "toolResult", toolName: "read", isError: false },
			},
			{ type: "message", id: "u2", parentId: "r1", timestamp: "", message: { role: "user", content: "two" } },
			{ type: "message", id: "a2", parentId: "u2", timestamp: "", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
		],
		"session-1",
	);

	assert.deepEqual(traces, [
		{
			id: "session-1:u1",
			activities: ["user:text", "assistant:text", "tool:read"],
			outcome: "unknown",
			steps: [
				{ activity: "user:text", messageLength: 3 },
				{ activity: "assistant:text", messageLength: 2 },
				{ activity: "tool:read" },
			],
		},
		{
			id: "session-1:u2",
			activities: ["user:text", "assistant:text"],
			outcome: "unknown",
			steps: [
				{ activity: "user:text", messageLength: 3 },
				{ activity: "assistant:text", messageLength: 4 },
			],
		},
	]);
});

test("extracts deterministic privacy-preserving FSM risk features", () => {
	const traces: TraceRecord[] = [
		{
			id: "success",
			activities: ["user:text", "tool:read", "tool:bash"],
			outcome: "success",
		},
	];
	const trace: TraceRecord = {
		id: "failure",
		activities: ["user:text", "tool:read", "tool:read", "tool:bash"],
		outcome: "failure",
		steps: [
			{ activity: "user:text", timestamp: "2026-01-01T00:00:00.000Z", messageLength: 5 },
			{ activity: "tool:read", timestamp: "2026-01-01T00:00:01.000Z", isError: true },
			{ activity: "tool:read", timestamp: "2026-01-01T00:00:02.000Z" },
			{ activity: "tool:bash", timestamp: "2026-01-01T00:00:03.000Z" },
		],
	};
	const features = extractTraceFeatures(trace, buildModel(traces, { minTransitionCount: 1 }));

	assert.equal(features.activityCount, 4);
	assert.equal(features.uniqueStateCount, 3);
	assert.equal(features.cycleRate, 0.25);
	assert.equal(features.errorCount, 1);
	assert.equal(features.elapsedMs, 3000);
	assert.equal(features.stateFeatures["tool:read"]?.errorRate, 0.5);
	assert.ok(features.traceCrossEntropy > 0);
	assert.ok(features.maxSurprise >= features.traceCrossEntropy / features.activityCount);
	assert.equal(JSON.stringify(features).includes("secret"), false);
});

test("captures historical timing and tool errors without storing result content", () => {
	const traces = extractHistoricalTraces(
		[
			{
				type: "message",
				id: "u1",
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "secret prompt" },
			},
			{
				type: "message",
				id: "a1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "secret" } }] },
			},
			{
				type: "message",
				id: "r1",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: { role: "toolResult", toolCallId: "call-1", isError: true, content: [{ type: "text", text: "secret output" }] },
			},
		],
		"session-1",
	);

	assert.deepEqual(traces[0], {
		id: "session-1:u1",
		activities: ["user:text", "tool:read"],
		outcome: "unknown",
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:00:03.000Z",
		steps: [
			{ activity: "user:text", timestamp: "2026-01-01T00:00:00.000Z", messageLength: 13 },
			{ activity: "tool:read", timestamp: "2026-01-01T00:00:01.000Z", isError: true },
		],
	});
	assert.equal(JSON.stringify(traces).includes("secret"), false);
});

test("evaluates labeled traces with reproducible holdouts and prefix metrics", () => {
	const traces: TraceRecord[] = [
		{ id: "success-1", activities: ["user:text", "tool:read"], outcome: "success" },
		{ id: "success-2", activities: ["user:text", "tool:bash"], outcome: "success" },
		{ id: "failure-1", activities: ["user:text", "tool:read", "tool:read"], outcome: "failure" },
		{ id: "failure-2", activities: ["user:text", "tool:bash", "tool:bash"], outcome: "failure" },
		{ id: "unknown", activities: ["user:text"], outcome: "unknown" },
	];
	const firstSplit = splitLabeledTraces(traces, { seed: 7 });
	const secondSplit = splitLabeledTraces(traces, { seed: 7 });

	assert.equal(firstSplit.ok, true);
	assert.deepEqual(firstSplit, secondSplit);
	if (!firstSplit.ok) return;
	assert.equal(firstSplit.training.length, 2);
	assert.equal(firstSplit.holdout.length, 2);
	const trainingIds = new Set(firstSplit.training.map((trace) => trace.id));
	assert.equal(firstSplit.holdout.some((trace) => trainingIds.has(trace.id)), false);
	assert.deepEqual(new Set(firstSplit.training.map((trace) => trace.outcome)), new Set(["success", "failure"]));
	assert.deepEqual(new Set(firstSplit.holdout.map((trace) => trace.outcome)), new Set(["success", "failure"]));

	const report = evaluateLabeledTraces(traces, { seed: 7, prefixFractions: [0.5, 1] });
	assert.equal(report.ok, true);
	if (!report.ok) return;
	assert.equal(report.prefixes.length, 2);
	assert.ok(report.prefixes.every((prefix) => prefix.replayFitness >= 0 && prefix.replayFitness <= 1));

	const predictions = evaluatePredictions([
		{ outcome: "success", score: 0.1 },
		{ outcome: "failure", score: 0.9 },
	]);
	assert.equal(predictions.ok, true);
	if (predictions.ok) {
		assert.equal(predictions.metrics.auroc, 1);
		assert.equal(predictions.metrics.f1, 1);
	}
	assert.deepEqual(evaluateLabeledTraces([{ id: "only", activities: ["user:text"], outcome: "success" }]), {
		ok: false,
		reason: "one-class",
	});
});

test("calibrates a passive monitor from labels and explains triggered prefixes", () => {
	const traces: TraceRecord[] = [
		{ id: "success-1", activities: ["user:text", "tool:read", "tool:bash"], outcome: "success" },
		{ id: "success-2", activities: ["user:text", "tool:read", "tool:bash"], outcome: "success" },
		{ id: "failure-1", activities: ["user:text", "tool:read", "tool:read", "tool:read"], outcome: "failure" },
		{ id: "failure-2", activities: ["user:text", "tool:read", "tool:read", "tool:read"], outcome: "failure" },
	];
	const calibration = calibrateMonitor(traces, { seed: 3, minActivities: 3, minUniqueStates: 2 });
	assert.equal(calibration.ok, true);
	if (!calibration.ok) return;
	assert.equal(calibration.trainingCount, 2);
	assert.equal(calibration.holdoutCount, 2);
	assert.ok(calibration.holdoutMetrics.auroc >= 0);

	const model = buildModel(traces);
	const triggered = inspectPrefix(model, traces[2], calibration.config);
	assert.equal(triggered.triggered, true);
	assert.equal(triggered.state, "tool:read");
	assert.ok(triggered.rule === "cycle-rate" || triggered.rule === "surprise");
	assert.ok(triggered.value !== undefined);
	assert.ok(triggered.threshold !== undefined);

	const healthy = inspectPrefix(model, traces[0], calibration.config);
	assert.equal(healthy.triggered, false);
});

test("trains a deterministic labeled failure-risk model", () => {
	const traces: TraceRecord[] = [
		{ id: "success-1", activities: ["user:text", "tool:read", "tool:bash"], outcome: "success" },
		{ id: "success-2", activities: ["user:text", "tool:read", "tool:bash"], outcome: "success" },
		{ id: "failure-1", activities: ["user:text", "tool:read", "tool:read", "tool:read"], outcome: "failure" },
		{ id: "failure-2", activities: ["user:text", "tool:read", "tool:read", "tool:read"], outcome: "failure" },
		{ id: "unknown", activities: ["user:text"], outcome: "unknown" },
	];
	const trained = trainFailureModel(traces);
	assert.equal(trained.ok, true);
	if (!trained.ok) return;
	assert.equal(trained.trainingCount, 4);
	const success = predictFailure(trained.model, traces[0]);
	const failure = predictFailure(trained.model, traces[2]);
	assert.equal(success.available, true);
	assert.equal(failure.available, true);
	if (success.available && failure.available) {
		assert.ok(failure.score > success.score);
		assert.ok(failure.contributions.length > 0);
	}
	const modelMetrics = evaluatePredictions(
		traces
			.filter((trace) => trace.outcome !== "unknown")
			.map((trace) => {
				const prediction = predictFailure(trained.model, trace);
				assert.equal(prediction.available, true);
				return { outcome: trace.outcome as "success" | "failure", score: prediction.available ? prediction.score : 0 };
			}),
	);
	assert.equal(modelMetrics.ok, true);
	if (modelMetrics.ok) assert.ok(modelMetrics.metrics.auroc >= 0.5);
	assert.deepEqual(
		trainFailureModel([{ id: "only", activities: ["user:text"], outcome: "success" }]),
		{ ok: false, reason: "one-class" },
	);
});

test("filters one-off transitions unless they are the only continuation", () => {
	const traces: TraceRecord[] = [
		{ id: "1", activities: ["user:text", "tool:read", "tool:bash"], outcome: "unknown" },
		{ id: "2", activities: ["user:text", "tool:read", "tool:bash"], outcome: "unknown" },
		{ id: "3", activities: ["user:text", "tool:grep", "tool:bash"], outcome: "unknown" },
	];
	const model = buildModel(traces);

	assert.equal(model.transitions["user:text"]?.["tool:read"]?.count, 2);
	assert.equal(model.transitions["user:text"]?.["tool:grep"], undefined);
	assert.equal(model.transitions["tool:grep"]?.["tool:bash"]?.count, 1);
});

test("replays traces and ranks the filtered next action", () => {
	const model = buildModel([
		{ id: "1", activities: ["user:text", "tool:read", "tool:bash"], outcome: "unknown" },
		{ id: "2", activities: ["user:text", "tool:read", "tool:bash"], outcome: "unknown" },
	]);

	assert.deepEqual(predictNext(model, "user:text", 3), [
		{ activity: "tool:read", count: 2, probability: 1 },
	]);
	assert.deepEqual(replayTrace(model, ["user:text", "tool:read", "tool:bash"]), {
		consumed: 3,
		novel: 0,
		fitness: 1,
	});
	assert.equal(replayTrace(model, ["user:text", "tool:write"]).novel, 1);
	assert.equal(model.transitions[START_STATE]?.["user:text"]?.count, 2);
});

test("inspects repeated activity without requiring labels", () => {
	const report = inspectTrace({
		activities: ["user:text", "tool:read", "tool:read", "tool:bash"],
	});

	assert.equal(report.activityCount, 4);
	assert.equal(report.uniqueActivityCount, 3);
	assert.equal(report.cycleRate, 0.25);
});

test("persists traces, labels, and malformed-line counts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-trace-fsm-"));
	const file = join(directory, "traces.jsonl");
	try {
		await writeFile(file, "not-json\n{\"kind\":\"unknown\"}\n", "utf8");
		const store = new TraceStore(file);
		await store.load();
		assert.equal(store.invalidRecordCount, 2);

		await store.append({
			id: "trace-1",
			activities: ["user:text"],
			outcome: "unknown",
			steps: [{ activity: "user:text", timestamp: "2026-01-01T00:00:00.000Z", messageLength: 6 }],
		});
		await assert.rejects(
			store.append({
				id: "invalid",
				activities: ["user:text"],
				outcome: "unknown",
				steps: [{ activity: "user:text", messageLength: -1 }],
			}),
		);
		assert.equal(await store.label("trace-1", "success"), true);

		const reloaded = new TraceStore(file);
		await reloaded.load();
		assert.deepEqual(reloaded.getTraces(), [
			{
				id: "trace-1",
				activities: ["user:text"],
				outcome: "success",
				steps: [{ activity: "user:text", timestamp: "2026-01-01T00:00:00.000Z", messageLength: 6 }],
			},
		]);
		assert.match(await readFile(file, "utf8"), /trace-1/);
		assert.doesNotMatch(await readFile(file, "utf8"), /secret|arguments|toolOutput/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
