export const START_STATE = "<start>";
export const TRACE_OUTCOMES = ["success", "failure", "unknown"] as const;
export type TraceOutcome = (typeof TRACE_OUTCOMES)[number];
export type Activity = string;

export type TraceStep = {
	activity: Activity;
	timestamp?: string;
	messageLength?: number;
	isError?: boolean;
};

export type TraceRecord = {
	id: string;
	activities: Activity[];
	outcome: TraceOutcome;
	startedAt?: string;
	endedAt?: string;
	steps?: TraceStep[];
};

export type SessionEntryLike = {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	message?: unknown;
};

type RecordLike = Record<string, unknown>;

type Transition = {
	count: number;
	probability: number;
};

export type StateOutcomeCounts = {
	success: number;
	failure: number;
	unknown: number;
};

export type StateStats = StateOutcomeCounts & {
	visits: number;
	traces: number;
};

export type Continuation = {
	activities: Activity[];
	count: number;
};

export type FsmModel = {
	version: 2;
	traces: number;
	alphabet: Activity[];
	states: string[];
	transitions: Record<string, Record<string, Transition>>;
	continuations: Record<string, Continuation[]>;
	stateStats: Record<string, StateStats>;
	minTransitionCount: number;
	smoothingAlpha: number;
	continuationDepth: number;
};

export type NextActivity = {
	activity: Activity;
	count: number;
	probability: number;
};

export type ReplayReport = {
	consumed: number;
	novel: number;
	fitness: number;
};

export type TraceInspection = {
	activityCount: number;
	uniqueActivityCount: number;
	cycleRate: number;
};

export type BuildModelOptions = {
	/** Drop a transition seen fewer than this many times when alternatives exist. */
	minTransitionCount?: number;
	/** Additive smoothing parameter from the paper's next-step estimator. */
	smoothingAlpha?: number;
	/** Maximum number of activities in an observed continuation path. */
	maxContinuationDepth?: number;
	/** Number of continuation paths retained for each state. */
	maxContinuations?: number;
};

export const DEFAULT_SMOOTHING_ALPHA = 0.1;
export const DEFAULT_CONTINUATION_DEPTH = 5;
export const DEFAULT_CONTINUATION_LIMIT = 15;

function asRecord(value: unknown): RecordLike | undefined {
	return value && typeof value === "object" ? (value as RecordLike) : undefined;
}

function hasText(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		const block = asRecord(part);
		return block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
	});
}

function toolActivity(name: unknown): Activity | undefined {
	if (typeof name !== "string" || name.trim().length === 0) return undefined;
	return `tool:${name.trim()}`;
}

function textLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((total, part) => {
		const block = asRecord(part);
		return total + (block?.type === "text" && typeof block.text === "string" ? block.text.length : 0);
	}, 0);
}

function validTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
	return value;
}

export type MessageStep = TraceStep & { toolCallId?: string };

export function extractMessageSteps(message: unknown): MessageStep[] {
	const value = asRecord(message);
	if (!value || typeof value.role !== "string") return [];
	const timestamp = validTimestamp(value.timestamp);

	if (value.role === "user") {
		if (!hasText(value.content)) return [];
		const messageLength = textLength(value.content);
		return [{ activity: "user:text", ...(timestamp ? { timestamp } : {}), ...(messageLength ? { messageLength } : {}) }];
	}

	if (value.role !== "assistant") return [];
	if (typeof value.content === "string") {
		return value.content.trim().length > 0
			? [{ activity: "assistant:text", ...(timestamp ? { timestamp } : {}), messageLength: value.content.length }]
			: [];
	}
	if (!Array.isArray(value.content)) return [];

	const steps: MessageStep[] = [];
	let textRecorded = false;
	const messageLength = textLength(value.content);
	for (const part of value.content) {
		const block = asRecord(part);
		if (!block) continue;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
			if (!textRecorded) {
				steps.push({
					activity: "assistant:text",
					...(timestamp ? { timestamp } : {}),
					...(messageLength ? { messageLength } : {}),
				});
				textRecorded = true;
			}
			continue;
		}
		if (block.type === "toolCall") {
			const activity = toolActivity(block.name);
			if (activity) {
				const toolCallId = typeof block.id === "string" ? block.id : undefined;
				steps.push({ activity, ...(timestamp ? { timestamp } : {}), ...(toolCallId ? { toolCallId } : {}) });
			}
		}
	}
	return steps;
}

/**
 * Convert a persisted Pi message into stable activity symbols.
 * Tool results, thinking blocks, arguments, and message text are intentionally
 * not retained beyond their coarse activity category.
 */
export function extractMessageActivities(message: unknown): Activity[] {
	return extractMessageSteps(message).map((step) => step.activity);
}

function resultDetails(message: unknown): { toolCallId?: string; isError: boolean } | undefined {
	const value = asRecord(message);
	if (!value || value.role !== "toolResult") return undefined;
	return {
		toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
		isError: value.isError === true,
	};
}

/** Extract one trace for each user message from an active session branch. */
export function extractHistoricalTraces(entries: SessionEntryLike[], sessionId: string): TraceRecord[] {
	const traces: TraceRecord[] = [];
	let current: TraceRecord | undefined;
	let pendingToolSteps = new Map<string, number>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const result = resultDetails(entry.message);
		if (result) {
			if (current && result.isError) {
				const stepIndex = result.toolCallId ? pendingToolSteps.get(result.toolCallId) : undefined;
				if (stepIndex !== undefined && current.steps?.[stepIndex]) current.steps[stepIndex].isError = true;
			}
			if (current) {
				const timestamp = validTimestamp(entry.timestamp);
				if (timestamp) current.endedAt = timestamp;
			}
			continue;
		}

		const steps = extractMessageSteps({ ...asRecord(entry.message), timestamp: entry.timestamp });
		if (steps.length === 0) continue;

		if (steps[0]?.activity === "user:text") {
			if (current) traces.push(current);
			current = {
				id: `${sessionId}:${entry.id}`,
				activities: [],
				outcome: "unknown",
				steps: [],
			};
			pendingToolSteps = new Map();
		}
		if (!current) continue;
		const timestamp = validTimestamp(entry.timestamp);
		if (timestamp && !current.startedAt) current.startedAt = timestamp;
		if (timestamp) current.endedAt = timestamp;
		for (const step of steps) {
			current.activities.push(step.activity);
			current.steps?.push({
				activity: step.activity,
				...(step.timestamp ? { timestamp: step.timestamp } : {}),
				...(step.messageLength ? { messageLength: step.messageLength } : {}),
			});
			if (step.toolCallId) pendingToolSteps.set(step.toolCallId, current.steps!.length - 1);
		}
	}
	if (current) traces.push(current);
	return traces;
}

function increment(map: Map<string, Map<string, number>>, from: string, to: string): void {
	let successors = map.get(from);
	if (!successors) {
		successors = new Map();
		map.set(from, successors);
	}
	successors.set(to, (successors.get(to) ?? 0) + 1);
}

function emptyStateStats(): StateStats {
	return { visits: 0, traces: 0, success: 0, failure: 0, unknown: 0 };
}

function outcomeCounts(target: StateStats, outcome: TraceOutcome): void {
	target[outcome] += 1;
}

function filteredTransitions(
	raw: Map<string, Map<string, number>>,
	minTransitionCount: number,
): Map<string, Map<string, number>> {
	const filtered = new Map<string, Map<string, number>>();
	for (const [from, successors] of raw) {
		const keepOnlySuccessors = successors.size === 1;
		const kept = new Map<string, number>();
		for (const [to, count] of successors) {
			if (keepOnlySuccessors || count >= minTransitionCount) kept.set(to, count);
		}
		if (kept.size > 0) filtered.set(from, kept);
	}
	return filtered;
}

function continuationKey(activities: readonly Activity[]): string {
	return JSON.stringify(activities);
}

function buildContinuations(
	traces: readonly TraceRecord[],
	transitions: Map<string, Map<string, number>>,
	maxDepth: number,
	limit: number,
): Record<string, Continuation[]> {
	const counts = new Map<string, Map<string, Continuation>>();
	for (const trace of traces) {
		const activities = trace.activities.filter((activity) => typeof activity === "string" && activity.length > 0);
		for (let start = -1; start < activities.length; start += 1) {
			const sourceState = start === -1 ? START_STATE : activities[start];
			if (!sourceState) continue;
			let state = sourceState;
			const path: Activity[] = [];
			const stateCounts = counts.get(sourceState) ?? new Map<string, Continuation>();
			counts.set(sourceState, stateCounts);
			for (let depth = 1; depth <= maxDepth; depth += 1) {
				const activity = activities[start + depth];
				if (!activity || !transitions.get(state)?.has(activity)) break;
				path.push(activity);
				state = activity;
				if (path.length < 2) continue;
				const key = continuationKey(path);
				const continuation = stateCounts.get(key) ?? { activities: [...path], count: 0 };
				continuation.count += 1;
				stateCounts.set(key, continuation);
			}
		}
	}

	const result: Record<string, Continuation[]> = {};
	for (const [state, stateCounts] of counts) {
		result[state] = Array.from(stateCounts.values())
			.sort(
				(left, right) =>
					right.count - left.count ||
					left.activities.length - right.activities.length ||
					continuationKey(left.activities).localeCompare(continuationKey(right.activities)),
			)
			.slice(0, limit)
			.map((continuation) => ({ activities: [...continuation.activities], count: continuation.count }));
	}
	return result;
}

/** Build the deterministic directly-follows FSM described by the paper. */
export function buildModel(traces: readonly TraceRecord[], options: BuildModelOptions = {}): FsmModel {
	const minTransitionCount = Math.max(1, Math.floor(options.minTransitionCount ?? 2));
	const smoothingAlpha = typeof options.smoothingAlpha === "number" && Number.isFinite(options.smoothingAlpha)
		? Math.max(0, options.smoothingAlpha)
		: DEFAULT_SMOOTHING_ALPHA;
	const continuationDepth = Math.max(2, Math.floor(options.maxContinuationDepth ?? DEFAULT_CONTINUATION_DEPTH));
	const continuationLimit = Math.max(1, Math.floor(options.maxContinuations ?? DEFAULT_CONTINUATION_LIMIT));
	const rawTransitions = new Map<string, Map<string, number>>();
	const stateStats = new Map<string, StateStats>();
	const alphabet = new Set<Activity>();

	for (const trace of traces) {
		const activities = trace.activities.filter((activity) => typeof activity === "string" && activity.length > 0);
		const seenStates = new Set<Activity>();
		let from = START_STATE;
		for (const activity of activities) {
			alphabet.add(activity);
			increment(rawTransitions, from, activity);
			from = activity;

			const stats = stateStats.get(activity) ?? emptyStateStats();
			stats.visits += 1;
			if (!seenStates.has(activity)) {
				stats.traces += 1;
				outcomeCounts(stats, TRACE_OUTCOMES.includes(trace.outcome) ? trace.outcome : "unknown");
				seenStates.add(activity);
			}
			stateStats.set(activity, stats);
		}
	}

	const keptTransitions = filteredTransitions(rawTransitions, minTransitionCount);
	const transitions: Record<string, Record<string, Transition>> = {};
	for (const [from, successors] of keptTransitions) {
		const total = Array.from(successors.values()).reduce((sum, count) => sum + count, 0);
		transitions[from] = {};
		for (const [to, count] of successors) {
			transitions[from][to] = { count, probability: count / total };
		}
	}

	const sortedAlphabet = Array.from(alphabet).sort();
	const serializedStats: Record<string, StateStats> = {};
	for (const activity of sortedAlphabet) serializedStats[activity] = stateStats.get(activity) ?? emptyStateStats();

	return {
		version: 2,
		traces: traces.length,
		alphabet: sortedAlphabet,
		states: [START_STATE, ...sortedAlphabet],
		transitions,
		continuations: buildContinuations(traces, keptTransitions, continuationDepth, continuationLimit),
		stateStats: serializedStats,
		minTransitionCount,
		smoothingAlpha,
		continuationDepth,
	};
}

function smoothedProbability(model: FsmModel, state: string, activity: Activity): number | undefined {
	const successors = model.transitions[state];
	if (!successors || model.alphabet.length === 0) return undefined;
	const alpha = Math.max(0, model.smoothingAlpha ?? 0);
	const observedTotal = Object.values(successors).reduce((total, transition) => total + transition.count, 0);
	const count = successors[activity]?.count ?? 0;
	if (alpha === 0 && count === 0) return 0;
	return (count + alpha) / (observedTotal + alpha * model.alphabet.length);
}

/** Return additive-smoothed next-step probabilities from an FSM state. */
export function predictNext(model: FsmModel, state: string, limit = 3): NextActivity[] {
	const successors = model.transitions[state];
	if (!successors || limit <= 0) return [];
	const alpha = Math.max(0, model.smoothingAlpha ?? 0);
	return model.alphabet
		.map((activity) => ({
			activity,
			count: successors[activity]?.count ?? 0,
			probability: smoothedProbability(model, state, activity) ?? 0,
		}))
		.filter((prediction) => alpha > 0 || prediction.count > 0)
		.sort((left, right) => right.probability - left.probability || right.count - left.count || left.activity.localeCompare(right.activity))
		.slice(0, Math.floor(limit));
}

/** Return observed multi-step continuations ranked by corpus frequency. */
export function continuationsFrom(model: FsmModel, state: string, limit = DEFAULT_CONTINUATION_LIMIT): Continuation[] {
	if (limit <= 0) return [];
	return (model.continuations[state] ?? [])
		.slice(0, Math.floor(limit))
		.map((continuation) => ({ activities: [...continuation.activities], count: continuation.count }));
}

export type FsmContextOptions = {
	nextActivityLimit?: number;
	continuationLimit?: number;
};

/** Render the paper's minimal next-action context without exposing the full graph. */
export function formatFsmContext(model: FsmModel, state: string, options: FsmContextOptions = {}): string {
	const nextActivityLimit = Math.floor(options.nextActivityLimit ?? model.alphabet.length);
	const predictions = predictNext(model, state, nextActivityLimit);
	const continuations = continuationsFrom(model, state, options.continuationLimit ?? DEFAULT_CONTINUATION_LIMIT);
	if (predictions.length === 0 && continuations.length === 0) return "";

	const lines = [
		"After the most recent action",
		`\"${state}\", past traces`,
		"show these next actions:",
		...predictions.map((prediction) => `- ${prediction.activity}: ${(prediction.probability * 100).toFixed(1)}%`),
	];
	if (continuations.length > 0) {
		lines.push(
			"Common multi-step continuations:",
			...continuations.map((continuation) => `- ${continuation.activities.join(" → ")} (${continuation.count}x)`),
		);
	}
	return lines.join("\n");
}

/** Replay a partial or complete activity sequence against the filtered FSM. */
export function replayTrace(model: FsmModel, activities: readonly Activity[]): ReplayReport {
	let state = START_STATE;
	let consumed = 0;
	for (const activity of activities) {
		if (model.transitions[state]?.[activity]) consumed += 1;
		state = activity;
	}
	const total = activities.length;
	return { consumed, novel: total - consumed, fitness: total === 0 ? 1 : consumed / total };
}

/** Measure repeated activity as a transparent, label-free cycle heuristic. */
export function inspectTrace(trace: Pick<TraceRecord, "activities">): TraceInspection {
	const activityCount = trace.activities.length;
	const uniqueActivityCount = new Set(trace.activities).size;
	return {
		activityCount,
		uniqueActivityCount,
		cycleRate: activityCount === 0 ? 0 : (activityCount - uniqueActivityCount) / activityCount,
	};
}

export type StateFeatures = {
	visits: number;
	visitFrequency: number;
	meanMessageLength: number;
	maxMessageLength: number;
	errorRate: number;
	meanInterVisitMs: number;
	temporalEntropy: number;
};

export type TraceFeatures = {
	activityCount: number;
	uniqueStateCount: number;
	traceLen: number;
	logLength: number;
	transitionDiversity: number;
	maxConsecutiveRatio: number;
	recurrenceRate: number;
	cycleRate: number;
	errorCount: number;
	errorRate: number;
	messageLength: number;
	elapsedMs: number;
	temporalEntropy: number;
	replayFitness: number;
	traceCrossEntropy: number;
	maxSurprise: number;
	halfToHalfDrift: number;
	minimumTransitionProbability: number;
	stateFeatures: Record<Activity, StateFeatures>;
};

const NOVEL_TRANSITION_SURPRISE_BITS = 16;
const TIME_BUCKETS_MS = [1_000, 5_000, 30_000, 120_000];

function entropy(values: readonly string[]): number {
	if (values.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return Array.from(counts.values()).reduce((total, count) => {
		const probability = count / values.length;
		return total - probability * Math.log2(probability);
	}, 0);
}

function timeBucket(milliseconds: number): string {
	const index = TIME_BUCKETS_MS.findIndex((limit) => milliseconds < limit);
	return index === -1 ? `>${TIME_BUCKETS_MS.at(-1)}` : `<${TIME_BUCKETS_MS[index]}`;
}

function timestampMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function traceSteps(trace: TraceRecord): TraceStep[] {
	if (trace.steps?.length === trace.activities.length) return trace.steps.map((step) => ({ ...step }));
	return trace.activities.map((activity) => ({ activity }));
}

function maxConsecutiveCount(activities: readonly Activity[]): number {
	if (activities.length === 0) return 0;
	let longest = 1;
	let current = 1;
	for (let index = 1; index < activities.length; index += 1) {
		current = activities[index] === activities[index - 1] ? current + 1 : 1;
		longest = Math.max(longest, current);
	}
	return longest;
}

function maxConsecutiveRatio(activities: readonly Activity[]): number {
	return activities.length === 0 ? 0 : maxConsecutiveCount(activities) / activities.length;
}

function mean(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function transitionSurprises(model: FsmModel | undefined, activities: readonly Activity[]): number[] {
	if (!model || model.traces === 0) return activities.map(() => 0);
	let state = START_STATE;
	const surprises: number[] = [];
	for (const activity of activities) {
		const probability = smoothedProbability(model, state, activity);
		surprises.push(probability && probability > 0 ? -Math.log2(probability) : NOVEL_TRANSITION_SURPRISE_BITS);
		state = activity;
	}
	return surprises;
}

/** Extract compact structural and FSM-scored features without retaining content. */
export function extractTraceFeatures(trace: TraceRecord, model?: FsmModel): TraceFeatures {
	const steps = traceSteps(trace);
	const activities = steps.map((step) => step.activity);
	const activityCount = activities.length;
	const uniqueStates = new Set(activities);
	const transitionCount = Math.max(0, activityCount - 1);
	const transitions = new Set<string>();
	for (let index = 1; index < activityCount; index += 1) {
		transitions.add(`${activities[index - 1]}\u0000${activities[index]}`);
	}

	const timestamps = steps
		.map((step) => timestampMs(step.timestamp))
		.filter((value): value is number => value !== undefined);
	const gaps: number[] = [];
	for (let index = 1; index < timestamps.length; index += 1) {
		gaps.push(Math.max(0, timestamps[index] - timestamps[index - 1]));
	}
	const sortedTimestamps = [...timestamps].sort((left, right) => left - right);
	const perState = new Map<Activity, { lengths: number[]; errors: number; times: number[] }>();
	let errorCount = 0;
	let messageLength = 0;
	for (const step of steps) {
		const state = perState.get(step.activity) ?? { lengths: [], errors: 0, times: [] };
		if (typeof step.messageLength === "number" && Number.isFinite(step.messageLength) && step.messageLength >= 0) {
			state.lengths.push(step.messageLength);
			messageLength += step.messageLength;
		}
		if (step.isError === true) {
			state.errors += 1;
			errorCount += 1;
		}
		const timestamp = timestampMs(step.timestamp);
		if (timestamp !== undefined) state.times.push(timestamp);
		perState.set(step.activity, state);
	}

	const stateFeatures: Record<Activity, StateFeatures> = {};
	for (const state of Array.from(uniqueStates).sort()) {
		const values = perState.get(state) ?? { lengths: [], errors: 0, times: [] };
		const visits = activities.filter((activity) => activity === state).length;
		const stateGaps: number[] = [];
		for (let index = 1; index < values.times.length; index += 1) {
			stateGaps.push(Math.max(0, values.times[index] - values.times[index - 1]));
		}
		stateFeatures[state] = {
			visits,
			visitFrequency: activityCount === 0 ? 0 : visits / activityCount,
			meanMessageLength: mean(values.lengths),
			maxMessageLength: values.lengths.length === 0 ? 0 : Math.max(...values.lengths),
			errorRate: visits === 0 ? 0 : values.errors / visits,
			meanInterVisitMs: mean(stateGaps),
			temporalEntropy: entropy(stateGaps.map(timeBucket)),
		};
	}

	const inspection = inspectTrace({ activities });
	const replay = model && model.traces > 0 ? replayTrace(model, activities) : { consumed: 0, novel: 0, fitness: 0 };
	const surprises = transitionSurprises(model, activities);
	const firstHalf = surprises.slice(0, Math.ceil(surprises.length / 2));
	const secondHalf = surprises.slice(Math.ceil(surprises.length / 2));
	const probabilities: number[] = [];
	if (model && model.traces > 0) {
		let state = START_STATE;
		for (const activity of activities) {
			probabilities.push(smoothedProbability(model, state, activity) ?? 0);
			state = activity;
		}
	}

	return {
		activityCount,
		uniqueStateCount: uniqueStates.size,
		traceLen: activityCount,
		logLength: Math.log2(1 + activityCount),
		transitionDiversity: transitionCount === 0 ? 0 : transitions.size / transitionCount,
		maxConsecutiveRatio: maxConsecutiveRatio(activities),
		recurrenceRate: inspection.cycleRate,
		cycleRate: inspection.cycleRate,
		errorCount,
		errorRate: activityCount === 0 ? 0 : errorCount / activityCount,
		messageLength,
		elapsedMs: sortedTimestamps.length < 2 ? 0 : sortedTimestamps.at(-1)! - sortedTimestamps[0]!,
		temporalEntropy: entropy(gaps.map(timeBucket)),
		replayFitness: replay.fitness,
		traceCrossEntropy: mean(surprises),
		maxSurprise: surprises.length === 0 ? 0 : Math.max(...surprises),
		halfToHalfDrift: mean(secondHalf) - mean(firstHalf),
		minimumTransitionProbability: probabilities.length === 0 ? 0 : Math.min(...probabilities),
		stateFeatures,
	};
}

export type EvaluationFailure = "insufficient-labeled-data" | "one-class";

export type LabeledSplit =
	| { ok: true; training: TraceRecord[]; holdout: TraceRecord[] }
	| { ok: false; reason: EvaluationFailure };

export type SplitOptions = {
	seed?: number;
	holdoutFraction?: number;
};

function shuffled<T>(values: readonly T[], seed: number): T[] {
	const result = [...values];
	let state = (seed >>> 0) || 0x9e3779b9;
	for (let index = result.length - 1; index > 0; index -= 1) {
		state = (Math.imul(1664525, state) + 1013904223) >>> 0;
		const swapIndex = state % (index + 1);
		[result[index], result[swapIndex]] = [result[swapIndex], result[index]];
	}
	return result;
}

function labelSeed(seed: number, label: "success" | "failure"): number {
	return seed + (label === "success" ? 17 : 31);
}

/** Split labeled traces without allowing unknown outcomes into evaluation data. */
export function splitLabeledTraces(
	traces: readonly TraceRecord[],
	options: SplitOptions = {},
): LabeledSplit {
	const labeled = traces.filter((trace) => trace.outcome !== "unknown");
	const labels = new Set(labeled.map((trace) => trace.outcome));
	if (labeled.length === 0) return { ok: false, reason: "insufficient-labeled-data" };
	if (labels.size < 2) return { ok: false, reason: "one-class" };

	const byOutcome = {
		success: labeled.filter((trace) => trace.outcome === "success").sort((left, right) => left.id.localeCompare(right.id)),
		failure: labeled.filter((trace) => trace.outcome === "failure").sort((left, right) => left.id.localeCompare(right.id)),
	};
	if (byOutcome.success.length < 2 || byOutcome.failure.length < 2) {
		return { ok: false, reason: "insufficient-labeled-data" };
	}

	const fraction = Math.min(0.99, Math.max(0.01, options.holdoutFraction ?? 0.2));
	const seed = options.seed ?? 0;
	const training: TraceRecord[] = [];
	const holdout: TraceRecord[] = [];
	for (const label of ["success", "failure"] as const) {
		const values = shuffled(byOutcome[label], labelSeed(seed, label));
		const holdoutCount = Math.max(1, Math.min(values.length - 1, Math.round(values.length * fraction)));
		holdout.push(...values.slice(0, holdoutCount));
		training.push(...values.slice(holdoutCount));
	}
	training.sort((left, right) => left.id.localeCompare(right.id));
	holdout.sort((left, right) => left.id.localeCompare(right.id));
	return { ok: true, training, holdout };
}

/** Return a trace prefix while preserving compact step metadata when present. */
export function prefixTrace(trace: TraceRecord, fraction: number): TraceRecord {
	const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 1));
	const count = Math.ceil(trace.activities.length * clamped);
	return {
		...trace,
		activities: trace.activities.slice(0, count),
		...(trace.steps ? { steps: trace.steps.slice(0, count).map((step) => ({ ...step })) } : {}),
	};
}

export type PrefixEvaluation = {
	fraction: number;
	replayFitness: number;
	nextStepCrossEntropy: number;
	nextStepAccuracy: number;
	novelTransitionRate: number;
};

export type TraceEvaluation =
	| {
			ok: true;
			trainingCount: number;
			holdoutCount: number;
			prefixes: PrefixEvaluation[];
		}
	| { ok: false; reason: EvaluationFailure };

export type TraceEvaluationOptions = SplitOptions & {
	prefixFractions?: readonly number[];
};

export type NextStepScore = {
	correct: number;
	total: number;
	accuracy: number;
	crossEntropy: number;
};

/** Score each activity against the smoothed distribution from its preceding state. */
export function scoreNextSteps(model: FsmModel, activities: readonly Activity[]): NextStepScore {
	let state = START_STATE;
	let correct = 0;
	let total = 0;
	let surpriseTotal = 0;
	for (const activity of activities) {
		const probability = smoothedProbability(model, state, activity) ?? 0;
		if (predictNext(model, state, 1)[0]?.activity === activity) correct += 1;
		if (probability > 0) surpriseTotal += -Math.log2(probability);
		else surpriseTotal += NOVEL_TRANSITION_SURPRISE_BITS;
		total += 1;
		state = activity;
	}
	return {
		correct,
		total,
		accuracy: total === 0 ? 0 : correct / total,
		crossEntropy: total === 0 ? 0 : surpriseTotal / total,
	};
}

/** Evaluate held-out replay and surprise metrics at deterministic prefix checkpoints. */
export function evaluateLabeledTraces(
	traces: readonly TraceRecord[],
	options: TraceEvaluationOptions = {},
): TraceEvaluation {
	const split = splitLabeledTraces(traces, options);
	if (!split.ok) return split;
	const model = buildModel(split.training);
	const fractions = (options.prefixFractions?.length ? options.prefixFractions : [1])
		.map((fraction) => Math.min(1, Math.max(0, fraction)))
		.filter((fraction, index, values) => Number.isFinite(fraction) && values.indexOf(fraction) === index);
	const prefixes: PrefixEvaluation[] = [];
	for (const fraction of fractions) {
		const values = split.holdout.map((trace) => {
			const prefix = prefixTrace(trace, fraction);
			const score = scoreNextSteps(model, prefix.activities);
			const replay = replayTrace(model, prefix.activities);
			return {
				fitness: replay.fitness,
				crossEntropy: score.crossEntropy,
				nextStepAccuracy: score.accuracy,
				nextStepCount: score.total,
				correct: score.correct,
				novel: replay.novel,
				activityCount: prefix.activities.length,
			};
		});
		const activityCount = values.reduce((total, value) => total + value.activityCount, 0);
		const nextStepCount = values.reduce((total, value) => total + value.nextStepCount, 0);
		prefixes.push({
			fraction,
			replayFitness: mean(values.map((value) => value.fitness)),
			nextStepCrossEntropy:
				nextStepCount === 0
					? 0
					: values.reduce((total, value) => total + value.crossEntropy * value.nextStepCount, 0) / nextStepCount,
			nextStepAccuracy: nextStepCount === 0 ? 0 : values.reduce((total, value) => total + value.correct, 0) / nextStepCount,
			novelTransitionRate: activityCount === 0 ? 0 : values.reduce((total, value) => total + value.novel, 0) / activityCount,
		});
	}
	return {
		ok: true,
		trainingCount: split.training.length,
		holdoutCount: split.holdout.length,
		prefixes,
	};
}

export type FailurePrediction = {
	traceId?: string;
	outcome: "success" | "failure";
	score: number;
};

export type PredictionMetrics = {
	threshold: number;
	auroc: number;
	accuracy: number;
	precision: number;
	recall: number;
	f1: number;
	tp: number;
	tn: number;
	fp: number;
	fn: number;
};

export type PredictionEvaluation =
	| { ok: true; metrics: PredictionMetrics }
	| { ok: false; reason: EvaluationFailure };

/** Calculate pairwise AUROC with ties receiving half credit. */
export function rocAuc(predictions: readonly FailurePrediction[]): number | undefined {
	const successes = predictions.filter((prediction) => prediction.outcome === "success");
	const failures = predictions.filter((prediction) => prediction.outcome === "failure");
	if (successes.length === 0 || failures.length === 0) return undefined;
	let rankScore = 0;
	for (const failure of failures) {
		for (const success of successes) {
			if (failure.score > success.score) rankScore += 1;
			else if (failure.score === success.score) rankScore += 0.5;
		}
	}
	return rankScore / (failures.length * successes.length);
}

/** Evaluate failure-risk scores without fitting a model or contacting a service. */
export function evaluatePredictions(
	predictions: readonly FailurePrediction[],
	threshold = 0.5,
): PredictionEvaluation {
	const valid = predictions.filter((prediction) => Number.isFinite(prediction.score));
	const labels = new Set(valid.map((prediction) => prediction.outcome));
	if (valid.length === 0) return { ok: false, reason: "insufficient-labeled-data" };
	if (labels.size < 2) return { ok: false, reason: "one-class" };

	let tp = 0;
	let tn = 0;
	let fp = 0;
	let fn = 0;
	for (const prediction of valid) {
		const predictedFailure = prediction.score >= threshold;
		if (predictedFailure && prediction.outcome === "failure") tp += 1;
		else if (!predictedFailure && prediction.outcome === "success") tn += 1;
		else if (predictedFailure) fp += 1;
		else fn += 1;
	}
	const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
	const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
	return {
		ok: true,
		metrics: {
			threshold,
			auroc: rocAuc(valid) ?? 0,
			accuracy: (tp + tn) / valid.length,
			precision,
			recall,
			f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
			tp,
			tn,
			fp,
			fn,
		},
	};
}

export type MonitorConfig = {
	minActivities: number;
	minUniqueStates: number;
	cycleRateThreshold: number;
	surpriseThreshold: number;
	stuckRunLength: number;
};

export type MonitorInspection = {
	triggered: boolean;
	state: string;
	rule?: "cycle-rate" | "surprise" | "stuck";
	value?: number;
	threshold?: number;
	features: TraceFeatures;
};

export type MonitorCalibrationOptions = SplitOptions & {
	minActivities?: number;
	minUniqueStates?: number;
	stuckRunLength?: number;
};

export type MonitorCalibration =
	| {
			ok: true;
			config: MonitorConfig;
			trainingCount: number;
			holdoutCount: number;
			holdoutMetrics: PredictionMetrics;
		}
	| { ok: false; reason: EvaluationFailure };

function selectThreshold(predictions: readonly FailurePrediction[]): number {
	const scores = predictions.map((prediction) => prediction.score).filter((score) => Number.isFinite(score));
	const auc = rocAuc(predictions);
	if (scores.length === 0 || auc === undefined || auc <= 0.5) return Number.POSITIVE_INFINITY;
	const maximum = Math.max(...scores);
	const candidates = Array.from(new Set([...scores, maximum + Number.EPSILON])).sort((left, right) => right - left);
	let bestThreshold = candidates[0];
	let bestMetrics: PredictionMetrics | undefined;
	for (const threshold of candidates) {
		const evaluation = evaluatePredictions(predictions, threshold);
		if (!evaluation.ok) continue;
		const metrics = evaluation.metrics;
		if (
			!bestMetrics ||
			metrics.f1 > bestMetrics.f1 ||
			(metrics.f1 === bestMetrics.f1 && metrics.precision > bestMetrics.precision) ||
			(metrics.f1 === bestMetrics.f1 && metrics.precision === bestMetrics.precision && threshold > bestThreshold)
		) {
			bestThreshold = threshold;
			bestMetrics = metrics;
		}
	}
	return bestThreshold;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
}

/** Calibrate warning thresholds from the training side of a labeled split. */
export function calibrateMonitor(
	traces: readonly TraceRecord[],
	options: MonitorCalibrationOptions = {},
): MonitorCalibration {
	const split = splitLabeledTraces(traces, options);
	if (!split.ok) return split;
	const model = buildModel(split.training);
	const trainingFeatures = split.training.map((trace) => ({ trace, features: extractTraceFeatures(trace, model) }));
	const defaultMinActivities = Math.max(1, Math.ceil(mean(trainingFeatures.map(({ features }) => features.activityCount)) * 0.1));
	const defaultMinUniqueStates = Math.max(1, Math.floor(median(trainingFeatures.map(({ features }) => features.uniqueStateCount)) * 0.5));
	const config: MonitorConfig = {
		minActivities: Math.max(1, Math.floor(options.minActivities ?? defaultMinActivities)),
		minUniqueStates: Math.max(1, Math.floor(options.minUniqueStates ?? defaultMinUniqueStates)),
		stuckRunLength: Math.max(2, Math.floor(options.stuckRunLength ?? 5)),
		cycleRateThreshold: selectThreshold(
			trainingFeatures.map(({ trace, features }) => ({ outcome: trace.outcome as "success" | "failure", score: features.cycleRate })),
		),
		surpriseThreshold: selectThreshold(
			trainingFeatures.map(({ trace, features }) => ({ outcome: trace.outcome as "success" | "failure", score: features.traceCrossEntropy })),
		),
	};
	const holdoutPredictions = split.holdout.map((trace) => {
		const inspection = inspectPrefix(model, trace, config);
		return {
			outcome: trace.outcome as "success" | "failure",
			score: inspection.triggered ? 1 : 0,
		};
	});
	const holdoutEvaluation = evaluatePredictions(holdoutPredictions);
	if (!holdoutEvaluation.ok) return holdoutEvaluation;
	return {
		ok: true,
		config,
		trainingCount: split.training.length,
		holdoutCount: split.holdout.length,
		holdoutMetrics: holdoutEvaluation.metrics,
	};
}

/** Inspect a trace prefix using calibrated, warning-only monitor rules. */
export function inspectPrefix(
	model: FsmModel,
	trace: TraceRecord,
	config: MonitorConfig,
): MonitorInspection {
	const features = extractTraceFeatures(trace, model);
	const state = trace.activities.at(-1) ?? START_STATE;
	const longestRun = maxConsecutiveCount(trace.activities);
	if (features.activityCount >= config.minActivities && longestRun >= config.stuckRunLength) {
		return {
			triggered: true,
			state,
			rule: "stuck",
			value: longestRun,
			threshold: config.stuckRunLength,
			features,
		};
	}
	if (features.activityCount < config.minActivities || features.uniqueStateCount < config.minUniqueStates) {
		return { triggered: false, state, features };
	}
	if (features.cycleRate >= config.cycleRateThreshold) {
		return {
			triggered: true,
			state,
			rule: "cycle-rate",
			value: features.cycleRate,
			threshold: config.cycleRateThreshold,
			features,
		};
	}
	if (features.traceCrossEntropy >= config.surpriseThreshold) {
		return {
			triggered: true,
			state,
			rule: "surprise",
			value: features.traceCrossEntropy,
			threshold: config.surpriseThreshold,
			features,
		};
	}
	return { triggered: false, state, features };
}

const GLOBAL_FAILURE_FEATURES = [
	"activityCount",
	"uniqueStateCount",
	"transitionDiversity",
	"maxConsecutiveRatio",
	"recurrenceRate",
	"errorRate",
	"messageLength",
	"elapsedMs",
	"temporalEntropy",
	"replayFitness",
	"traceCrossEntropy",
	"maxSurprise",
	"halfToHalfDrift",
	"minimumTransitionProbability",
] as const;

const STATE_FAILURE_FEATURES = [
	"visits",
	"visitFrequency",
	"meanMessageLength",
	"maxMessageLength",
	"errorRate",
	"meanInterVisitMs",
	"temporalEntropy",
] as const;

function featureMap(features: TraceFeatures): Map<string, number> {
	const values = new Map<string, number>([
		["activityCount", features.activityCount],
		["uniqueStateCount", features.uniqueStateCount],
		["transitionDiversity", features.transitionDiversity],
		["maxConsecutiveRatio", features.maxConsecutiveRatio],
		["recurrenceRate", features.recurrenceRate],
		["errorRate", features.errorRate],
		["messageLength", features.messageLength],
		["elapsedMs", features.elapsedMs],
		["temporalEntropy", features.temporalEntropy],
		["replayFitness", features.replayFitness],
		["traceCrossEntropy", features.traceCrossEntropy],
		["maxSurprise", features.maxSurprise],
		["halfToHalfDrift", features.halfToHalfDrift],
		["minimumTransitionProbability", features.minimumTransitionProbability],
	]);
	for (const [state, stateFeatures] of Object.entries(features.stateFeatures)) {
		for (const name of STATE_FAILURE_FEATURES) values.set(`state:${state}:${name}`, stateFeatures[name]);
	}
	return values;
}

function sigmoid(value: number): number {
	if (value <= -40) return 0;
	if (value >= 40) return 1;
	return 1 / (1 + Math.exp(-value));
}

export type FailureModel = {
	version: 1;
	featureNames: string[];
	means: number[];
	scales: number[];
	weights: number[];
	bias: number;
	trainingCount: number;
	fsmModel: FsmModel;
};

export type FailureModelResult =
	| { ok: true; model: FailureModel; trainingCount: number }
	| { ok: false; reason: EvaluationFailure };

export type FailureContribution = {
	feature: string;
	value: number;
	weight: number;
	contribution: number;
};

export type FailurePredictionResult =
	| { available: true; score: number; contributions: FailureContribution[] }
	| { available: false; reason: EvaluationFailure };

function modelFeatureNames(model: FsmModel): string[] {
	return [
		...GLOBAL_FAILURE_FEATURES,
		...model.alphabet.flatMap((state) => STATE_FAILURE_FEATURES.map((name) => `state:${state}:${name}`)),
	];
}

/** Train a small dependency-free, class-weighted logistic failure model. */
export function trainFailureModel(traces: readonly TraceRecord[]): FailureModelResult {
	const labeled = traces.filter((trace) => trace.outcome !== "unknown");
	if (labeled.length === 0) return { ok: false, reason: "insufficient-labeled-data" };
	const successes = labeled.filter((trace) => trace.outcome === "success");
	const failures = labeled.filter((trace) => trace.outcome === "failure");
	if (successes.length === 0 || failures.length === 0) return { ok: false, reason: "one-class" };
	if (successes.length < 2 || failures.length < 2) return { ok: false, reason: "insufficient-labeled-data" };

	const fsmModel = buildModel(labeled);
	const featureNames = modelFeatureNames(fsmModel);
	const rows = labeled.map((trace) => {
		const values = featureMap(extractTraceFeatures(trace, fsmModel));
		return {
			values: featureNames.map((name) => values.get(name) ?? 0),
			target: trace.outcome === "failure" ? 1 : 0,
		};
	});
	const means = featureNames.map((_name, index) => mean(rows.map((row) => row.values[index])));
	const scales = featureNames.map((_name, index) => {
		const variance = mean(rows.map((row) => (row.values[index] - means[index]) ** 2));
		return variance > 0 ? Math.sqrt(variance) : 1;
	});
	const normalized = rows.map((row) => row.values.map((value, index) => (value - means[index]) / scales[index]));
	const weights = new Array(featureNames.length).fill(0) as number[];
	let bias = 0;
	const successWeight = labeled.length / (2 * successes.length);
	const failureWeight = labeled.length / (2 * failures.length);
	for (let iteration = 0; iteration < 300; iteration += 1) {
		const gradients = new Array(featureNames.length).fill(0) as number[];
		let biasGradient = 0;
		for (let rowIndex = 0; rowIndex < normalized.length; rowIndex += 1) {
			const row = normalized[rowIndex];
			const target = rows[rowIndex].target;
			const prediction = sigmoid(bias + row.reduce((total, value, index) => total + value * weights[index], 0));
			const error = (prediction - target) * (target === 1 ? failureWeight : successWeight);
			biasGradient += error;
			for (let index = 0; index < row.length; index += 1) gradients[index] += error * row[index];
		}
		for (let index = 0; index < weights.length; index += 1) {
			weights[index] -= 0.2 * (gradients[index] / normalized.length + 0.01 * weights[index]);
		}
		bias -= 0.2 * (biasGradient / normalized.length);
	}
	return {
		ok: true,
		trainingCount: labeled.length,
		model: { version: 1, featureNames, means, scales, weights, bias, trainingCount: labeled.length, fsmModel },
	};
}

/** Score a trace and return its strongest model contributions. */
export function predictFailure(model: FailureModel, trace: TraceRecord): FailurePredictionResult {
	const values = featureMap(extractTraceFeatures(trace, model.fsmModel));
	const contributions = model.featureNames.map((feature, index) => {
		const value = values.get(feature) ?? 0;
		const normalized = (value - model.means[index]) / (model.scales[index] || 1);
		return {
			feature,
			value,
			weight: model.weights[index],
			contribution: normalized * model.weights[index],
		};
	});
	const logit = model.bias + contributions.reduce((total, item) => total + item.contribution, 0);
	return {
		available: true,
		score: sigmoid(logit),
		contributions: contributions
			.filter((item) => item.contribution !== 0)
			.sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution) || left.feature.localeCompare(right.feature))
			.slice(0, 5),
	};
}

export function failureRate(stats: StateStats | undefined): number | undefined {
	if (!stats) return undefined;
	const labeled = stats.success + stats.failure;
	return labeled === 0 ? undefined : stats.failure / labeled;
}
