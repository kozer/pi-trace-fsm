import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	START_STATE,
	TRACE_OUTCOMES,
	buildModel,
	calibrateMonitor,
	evaluateLabeledTraces,
	formatFsmContext,
	predictFailure,
	extractHistoricalTraces,
	extractMessageSteps,
	extractTraceFeatures,
	failureRate,
	inspectPrefix,
	inspectTrace,
	predictNext,
	trainFailureModel,
	type FailureModel,
	type FailurePredictionResult,
	type FsmModel,
	type MessageStep,
	type MonitorCalibration,
	type TraceOutcome,
	type TraceRecord,
} from "./fsm.ts";
import { randomUUID } from "node:crypto";
import { projectStorePath, TraceStore } from "./store.ts";

const MIN_TRACES_FOR_NOVELTY_WARNING = 5;
const MAX_NEXT_ACTIVITIES = 15;
const PROMPT_SECTION = "pi-trace-fsm";

const isOutcome = (value: string): value is TraceOutcome =>
	(TRACE_OUTCOMES as readonly string[]).includes(value);

const currentState = (trace: TraceRecord | undefined): string =>
	trace?.activities.at(-1) ?? START_STATE;

const formatThreshold = (value: number): string => Number.isFinite(value) ? value.toFixed(2) : "disabled";

const formatFailureContributions = (prediction: FailurePredictionResult): string => {
	if (!prediction.available || prediction.contributions.length === 0) return "none";
	return prediction.contributions
		.slice(0, 3)
		.map((item) => `${item.feature} (${item.contribution >= 0 ? "+" : ""}${item.contribution.toFixed(2)})`)
		.join(", ");
};

const formatPredictions = (model: FsmModel, state: string): string => {
	const predictions = predictNext(model, state, MAX_NEXT_ACTIVITIES);
	if (predictions.length === 0) return "none observed";
	return predictions
		.map((prediction) => `${prediction.activity} (${Math.round(prediction.probability * 100)}%)`)
		.join(", ");
};

type LiveTrace = {
	trace: TraceRecord;
	toolErrors: number;
	pendingToolSteps: Map<string, number>;
	warnedEdges: Set<string>;
	monitorWarned: boolean;
	errorWarned: boolean;
};

function newLiveTrace(ctx: ExtensionContext, entryId?: string): LiveTrace {
	const stableId = entryId ?? randomUUID();
	return {
		trace: {
			id: `${ctx.sessionManager.getSessionId()}:${stableId}`,
			activities: [],
			outcome: "unknown",
			startedAt: new Date().toISOString(),
		},
		toolErrors: 0,
		pendingToolSteps: new Map(),
		warnedEdges: new Set(),
		monitorWarned: false,
		errorWarned: false,
	};
}

function appendSteps(live: LiveTrace, steps: readonly MessageStep[], timestamp = new Date().toISOString()): void {
	if (!live.trace.steps) live.trace.steps = [];
	for (const step of steps) {
		if (step.activity.length === 0) continue;
		live.trace.activities.push(step.activity);
		live.trace.steps.push({
			activity: step.activity,
			timestamp: step.timestamp ?? timestamp,
			...(step.messageLength !== undefined ? { messageLength: step.messageLength } : {}),
		});
		if (step.toolCallId) live.pendingToolSteps.set(step.toolCallId, live.trace.steps.length - 1);
	}
}

function appendActivity(live: LiveTrace, activity: string, toolCallId?: string): void {
	appendSteps(live, [{ activity, toolCallId }]);
}

async function rebuildFromSessions(
	cwd: string,
): Promise<{ traces: TraceRecord[]; sessionCount: number; skippedSessions: number }> {
	const sessions = await SessionManager.list(cwd);
	const traces: TraceRecord[] = [];
	let skippedSessions = 0;

	for (const session of sessions) {
		try {
			const manager = SessionManager.open(session.path);
			traces.push(...extractHistoricalTraces(manager.getBranch(), session.id));
		} catch {
			// One corrupt or concurrently changing session must not abort the rebuild.
			skippedSessions += 1;
		}
	}
	return { traces, sessionCount: sessions.length, skippedSessions };
}

export default function piTraceFsm(pi: ExtensionAPI) {
	let store: TraceStore | undefined;
	let model: FsmModel = buildModel([]);
	let monitor: MonitorCalibration = { ok: false, reason: "insufficient-labeled-data" };
	let failureModel: FailureModel | undefined;
	let failureModelReason = "insufficient-labeled-data";
	let live: LiveTrace | undefined;

	const refreshModel = () => {
		const traces = store?.getTraces() ?? [];
		model = buildModel(traces);
		monitor = calibrateMonitor(traces);
		const trained = trainFailureModel(traces);
		failureModel = trained.ok ? trained.model : undefined;
		failureModelReason = trained.ok ? "available" : trained.reason;
	};

	const finishTrace = async () => {
		if (!live || !store || live.trace.activities.length === 0) {
			live = undefined;
			return;
		}
		const completed = live.trace;
		live = undefined;
		completed.endedAt = new Date().toISOString();
		await store.append(completed);
		refreshModel();
	};

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	};

	pi.on("session_start", async (_event, ctx) => {
		const path = await projectStorePath(getAgentDir(), ctx.cwd);
		store = new TraceStore(path);
		await store.load();
		live = undefined;
		refreshModel();
	});

	pi.on("agent_settled", async () => {
		await finishTrace();
	});

	pi.on("session_shutdown", async () => {
		await finishTrace();
		store = undefined;
		model = buildModel([]);
		monitor = { ok: false, reason: "insufficient-labeled-data" };
		failureModel = undefined;
		failureModelReason = "insufficient-labeled-data";
	});

	pi.on("message_end", async (event, ctx) => {
		const steps = extractMessageSteps(event.message);
		if (steps[0]?.activity === "user:text") {
			if (live?.trace.activities.length) await finishTrace();
			live = newLiveTrace(ctx, ctx.sessionManager.getLeafId() ?? undefined);
			appendSteps(live, steps);
			return;
		}

		if (live) appendSteps(live, steps.filter((step) => step.activity === "assistant:text"));
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!live) return;
		const activity = `tool:${event.toolName.trim()}`;
		const state = currentState(live.trace);
		const edge = `${state} -> ${activity}`;
		const known = model.transitions[state]?.[activity];

		if (
			model.traces >= MIN_TRACES_FOR_NOVELTY_WARNING &&
			!known &&
			!live.warnedEdges.has(edge)
		) {
			live.warnedEdges.add(edge);
			notify(ctx, `Trace FSM: novel transition ${edge}`, "warning");
		}

		appendActivity(live, activity, event.toolCallId);
		if (monitor.ok && !live.monitorWarned) {
			const inspection = inspectPrefix(model, live.trace, monitor.config);
			if (inspection.triggered && inspection.rule && inspection.value !== undefined && inspection.threshold !== undefined) {
				live.monitorWarned = true;
				notify(
					ctx,
					`Trace FSM: ${inspection.rule} ${inspection.value.toFixed(2)} >= ${inspection.threshold.toFixed(2)} at ${inspection.state}`,
					"warning",
				);
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!live) return;
		if (event.isError) {
			live.toolErrors += 1;
			const stepIndex = live.pendingToolSteps.get(event.toolCallId);
			if (stepIndex !== undefined && live.trace.steps?.[stepIndex]) live.trace.steps[stepIndex].isError = true;
		}
		if (live.toolErrors >= 2 && !live.errorWarned) {
			live.errorWarned = true;
			notify(ctx, `Trace FSM: ${live.toolErrors} tool errors in the current trace`, "warning");
		}
	});

	// A named section rather than a returned systemPrompt: a returned prompt is sent verbatim and
	// drops the sections that handlers running later add, such as pi's mcp_servers.
	pi.on("before_agent_start", async (event) => {
		const sections = event.systemPromptOptions.sections;
		const state = live?.trace.activities.at(-1) ?? "user:text";
		const context = model.traces > 0 ? formatFsmContext(model, state) : "";
		const risk = live && failureModel ? predictFailure(failureModel, live.trace) : undefined;
		if (!context && (!risk || !risk.available)) {
			delete sections[PROMPT_SECTION];
			return;
		}
		const hintLines = ["Weak local workflow signals; they are advisory and must not override the user's request."];
		if (context) hintLines.push(context);
		if (risk?.available) {
			hintLines.push(
				`Passive failure-risk score: ${(risk.score * 100).toFixed(0)}%`,
				`Strongest signals: ${formatFailureContributions(risk)}`,
			);
		}
		// pi wraps the section in <pi-trace-fsm> tags.
		sections[PROMPT_SECTION] = hintLines.join("\n");
	});

	pi.registerCommand("fsm-status", {
		description: "Show the current project's trace FSM status",
		handler: async (_args, ctx) => {
			if (!store) {
				notify(ctx, "Trace FSM is not initialized yet", "warning");
				return;
			}
			const traces = store.getTraces();
			const labeled = traces.filter((trace) => trace.outcome !== "unknown").length;
			const state = currentState(live?.trace);
			const inspection = live ? inspectTrace(live.trace) : undefined;
			const features = live ? extractTraceFeatures(live.trace, model) : undefined;
			const failureRisk = live && failureModel ? predictFailure(failureModel, live.trace) : undefined;
			const stateFailureRate = failureRate(model.stateStats[state]);
			const lines = [
				`Trace FSM: ${traces.length} stored traces, ${model.alphabet.length} activities, ${Object.values(model.transitions).reduce((sum, next) => sum + Object.keys(next).length, 0)} transitions`,
				`Store: ${store.filePath}`,
				`Labels: ${labeled}/${traces.length}`,
				`Current state: ${state}`,
				`Next: ${formatPredictions(model, state)}`,
			];
			const context = model.traces > 0 ? formatFsmContext(model, state) : "";
			if (context) lines.push(context);
			if (inspection && features) {
				lines.push(
					`Current trace: ${inspection.activityCount} activities, cycle rate ${inspection.cycleRate.toFixed(2)}, ${features.elapsedMs}ms elapsed, ${features.errorCount} tool errors`,
				);
				lines.push(
					`FSM features: fitness ${features.replayFitness.toFixed(2)}, cross-entropy ${features.traceCrossEntropy.toFixed(2)}, max surprise ${features.maxSurprise.toFixed(2)}`,
				);
			}
			if (stateFailureRate !== undefined) {
				lines.push(`Labeled failure rate at state: ${(stateFailureRate * 100).toFixed(0)}%`);
			}
			if (monitor.ok) {
				lines.push(
					`Monitor: cycle >= ${formatThreshold(monitor.config.cycleRateThreshold)}, surprise >= ${formatThreshold(monitor.config.surpriseThreshold)}, stuck >= ${monitor.config.stuckRunLength}, holdout AUROC ${monitor.holdoutMetrics.auroc.toFixed(2)}`,
				);
			} else {
				lines.push(`Monitor: unavailable (${monitor.reason})`);
			}
			if (failureRisk?.available) {
				lines.push(`Failure risk: ${(failureRisk.score * 100).toFixed(0)}%, signals ${formatFailureContributions(failureRisk)}`);
			} else {
				lines.push(`Failure risk: unavailable (${live ? failureModelReason : "no-active-trace"})`);
			}
			if (store.invalidRecordCount > 0) {
				lines.push(`Ignored malformed store records: ${store.invalidRecordCount}`);
			}
			notify(ctx, lines.join("\n"));
		},
	});

	pi.registerCommand("fsm-evaluate", {
		description: "Evaluate labeled trace replay and surprise metrics",
		handler: async (_args, ctx) => {
			if (!store) {
				notify(ctx, "Trace FSM is not initialized yet", "warning");
				return;
			}
			const report = evaluateLabeledTraces(store.getTraces(), {
				prefixFractions: [0.25, 0.5, 0.75, 1],
			});
			if (!report.ok) {
				notify(ctx, `Trace FSM evaluation unavailable: ${report.reason}`, "warning");
				return;
			}
			const lines = [
				`Evaluation: ${report.trainingCount} training traces, ${report.holdoutCount} holdout traces`,
				...report.prefixes.map(
					(prefix) =>
						`${Math.round(prefix.fraction * 100)}%: fitness ${prefix.replayFitness.toFixed(3)}, cross-entropy ${prefix.nextStepCrossEntropy.toFixed(3)}, top-1 ${(prefix.nextStepAccuracy * 100).toFixed(1)}%, novel ${(prefix.novelTransitionRate * 100).toFixed(1)}%`,
				),
			];
			notify(ctx, lines.join("\n"));
		},
	});

	pi.registerCommand("fsm-next", {
		description: "Show paper-style next-action context for the current or named FSM state",
		handler: async (args, ctx) => {
			const state = args.trim() || currentState(live?.trace);
			notify(ctx, formatFsmContext(model, state) || `${state}: none observed`);
		},
	});

	pi.registerCommand("fsm-mark", {
		description: "Label the latest trace: success, failure, or unknown",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			await finishTrace();
			const outcome = args.trim();
			if (!isOutcome(outcome)) {
				notify(ctx, "Usage: /fsm-mark success|failure|unknown", "warning");
				return;
			}
			const latest = store?.latestTrace();
			if (!store || !latest) {
				notify(ctx, "No completed trace to label", "warning");
				return;
			}
			await store.label(latest.id, outcome);
			refreshModel();
			notify(ctx, `Marked ${latest.id} as ${outcome}`);
		},
	});

	pi.registerCommand("fsm-rebuild", {
		description: "Rebuild the project's FSM from historical Pi session branches",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (!store) {
				notify(ctx, "Trace FSM is not initialized yet", "warning");
				return;
			}
			const existingLabels = new Map(
				store.getTraces().map((trace) => [trace.id, trace.outcome] as const),
			);
			const result = await rebuildFromSessions(ctx.cwd);
			const traces = result.traces.map((trace) => {
				const previousOutcome = existingLabels.get(trace.id);
				return previousOutcome && previousOutcome !== "unknown"
					? { ...trace, outcome: previousOutcome }
					: trace;
			});
			await store.replace(traces);
			refreshModel();
			notify(
				ctx,
				`Rebuilt ${traces.length} traces from ${result.sessionCount} sessions${result.skippedSessions ? `; skipped ${result.skippedSessions}` : ""}`,
			);
		},
	});
}
