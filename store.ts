import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	TRACE_OUTCOMES,
	type TraceOutcome,
	type TraceRecord,
	type TraceStep,
} from "./fsm.ts";

const TRACE_KIND = "trace";
const LABEL_KIND = "label";

type TraceLine = {
	kind: typeof TRACE_KIND;
	trace: TraceRecord;
};

type LabelLine = {
	kind: typeof LABEL_KIND;
	traceId: string;
	outcome: TraceOutcome;
};

type StoredLine = TraceLine | LabelLine;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isOutcome(value: unknown): value is TraceOutcome {
	return typeof value === "string" && (TRACE_OUTCOMES as readonly string[]).includes(value);
}

function isTraceStep(value: unknown): value is TraceStep {
	if (!isRecord(value)) return false;
	return (
		typeof value.activity === "string" &&
		value.activity.length > 0 &&
		(value.timestamp === undefined || typeof value.timestamp === "string") &&
		(value.messageLength === undefined || (typeof value.messageLength === "number" && Number.isFinite(value.messageLength) && value.messageLength >= 0)) &&
		(value.isError === undefined || typeof value.isError === "boolean")
	);
}

function isTraceRecord(value: unknown): value is TraceRecord {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		Array.isArray(value.activities) &&
		value.activities.every((activity) => typeof activity === "string" && activity.length > 0) &&
		(value.steps === undefined || (Array.isArray(value.steps) && value.steps.length === value.activities.length && value.steps.every(isTraceStep))) &&
		isOutcome(value.outcome) &&
		(value.startedAt === undefined || typeof value.startedAt === "string") &&
		(value.endedAt === undefined || typeof value.endedAt === "string")
	);
}

function cloneTrace(trace: TraceRecord): TraceRecord {
	return {
		...trace,
		activities: [...trace.activities],
		...(trace.steps ? { steps: trace.steps.map((step) => ({ ...step })) } : {}),
	};
}

function parseLine(line: string): StoredLine | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || typeof value.kind !== "string") return undefined;
	if (value.kind === TRACE_KIND && isTraceRecord(value.trace)) {
		return { kind: TRACE_KIND, trace: value.trace };
	}
	if (value.kind === LABEL_KIND && typeof value.traceId === "string" && value.traceId.length > 0 && isOutcome(value.outcome)) {
		return { kind: LABEL_KIND, traceId: value.traceId, outcome: value.outcome };
	}
	return undefined;
}

/** Return the metadata-only store path for a canonical project directory. */
export async function projectStorePath(agentDir: string, cwd: string): Promise<string> {
	let canonicalCwd = resolve(cwd);
	try {
		canonicalCwd = await realpath(canonicalCwd);
	} catch {
		// The project may disappear between session discovery and persistence.
		// The resolved path remains a stable fallback for this process.
	}
	const projectKey = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 24);
	return join(agentDir, "pi-trace-fsm", `${projectKey}.jsonl`);
}

/** Small append-only trace store with atomic rebuild replacement. */
export class TraceStore {
	readonly filePath: string;
	private traces = new Map<string, TraceRecord>();
	private loaded = false;
	private _invalidRecordCount = 0;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	get invalidRecordCount(): number {
		return this._invalidRecordCount;
	}

	async load(): Promise<void> {
		this.traces.clear();
		this._invalidRecordCount = 0;
		try {
			const content = await readFile(this.filePath, "utf8");
			const labels = new Map<string, TraceOutcome>();
			for (const line of content.split("\n")) {
				if (!line.trim()) continue;
				const record = parseLine(line);
				if (!record) {
					this._invalidRecordCount += 1;
					continue;
				}
				if (record.kind === TRACE_KIND) this.traces.set(record.trace.id, record.trace);
				else labels.set(record.traceId, record.outcome);
			}
			for (const [traceId, outcome] of labels) {
				const trace = this.traces.get(traceId);
				if (trace) this.traces.set(traceId, { ...trace, outcome });
			}
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
		this.loaded = true;
	}

	getTraces(): TraceRecord[] {
		return Array.from(this.traces.values()).map(cloneTrace);
	}

	getTrace(traceId: string): TraceRecord | undefined {
		const trace = this.traces.get(traceId);
		return trace ? cloneTrace(trace) : undefined;
	}

	latestTrace(): TraceRecord | undefined {
		const traces = this.getTraces();
		return traces[traces.length - 1];
	}

	async append(trace: TraceRecord): Promise<boolean> {
		this.assertLoaded();
		if (!isTraceRecord(trace)) throw new Error("Invalid trace record");
		if (this.traces.has(trace.id)) return false;
		this.traces.set(trace.id, cloneTrace(trace));
		await this.enqueue(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			await appendFile(this.filePath, `${JSON.stringify({ kind: TRACE_KIND, trace })}\n`, "utf8");
		});
		return true;
	}

	async label(traceId: string, outcome: TraceOutcome): Promise<boolean> {
		this.assertLoaded();
		if (!this.traces.has(traceId) || !isOutcome(outcome)) return false;
		const trace = this.traces.get(traceId);
		if (!trace) return false;
		this.traces.set(traceId, { ...cloneTrace(trace), outcome });
		await this.enqueue(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			await appendFile(this.filePath, `${JSON.stringify({ kind: LABEL_KIND, traceId, outcome })}\n`, "utf8");
		});
		return true;
	}

	async replace(traces: readonly TraceRecord[]): Promise<void> {
		this.assertLoaded();
		const deduplicated = new Map<string, TraceRecord>();
		for (const trace of traces) {
			if (isTraceRecord(trace)) deduplicated.set(trace.id, cloneTrace(trace));
		}
		await this.enqueue(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
			const content = Array.from(deduplicated.values())
				.map((trace) => JSON.stringify({ kind: TRACE_KIND, trace }))
				.join("\n");
			await writeFile(temporaryPath, content.length > 0 ? `${content}\n` : "", "utf8");
			await rename(temporaryPath, this.filePath);
		});
		this.traces = deduplicated;
		this._invalidRecordCount = 0;
	}

	private assertLoaded(): void {
		if (!this.loaded) throw new Error("TraceStore.load() must be called before use");
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		this.writeQueue = this.writeQueue.then(operation, operation);
		return this.writeQueue;
	}
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
