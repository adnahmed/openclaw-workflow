export type SealedMiddlewareCapabilities = {
	toolResultInterception: true;
	transcriptFirewall: true;
	artifactSink: true;
	recordObservationBeforeModel: true;
	source: "agentToolResultMiddleware";
	registeredAt: string;
};

export type MiddlewareCounters = {
	intercepted: number;
	sealed: number;
	no_active_run: number;
	passthrough: number;
	last_event: string | null;
	last_sealed: string | null;
	last_no_active_run: string | null;
};

const READY_KEY = Symbol.for("openclaw-workflow.sealedMiddlewareCapabilities");
const COUNTERS_KEY = Symbol.for("openclaw-workflow.middlewareCounters");

function getCounters(): MiddlewareCounters {
	if (!(globalThis as any)[COUNTERS_KEY]) {
		(globalThis as any)[COUNTERS_KEY] = {
			intercepted: 0,
			sealed: 0,
			no_active_run: 0,
			passthrough: 0,
			last_event: null,
			last_sealed: null,
			last_no_active_run: null,
		};
	}
	return (globalThis as any)[COUNTERS_KEY] as MiddlewareCounters;
}

export function incrementIntercepted(toolName: string): void {
	const c = getCounters();
	c.intercepted += 1;
	c.last_event = toolName;
}

export function incrementPassthrough(toolName: string): void {
	const c = getCounters();
	c.passthrough += 1;
}

export function incrementNoActiveRun(toolName: string): void {
	const c = getCounters();
	c.no_active_run += 1;
	c.last_no_active_run = toolName;
}

export function incrementSealed(toolName: string): void {
	const c = getCounters();
	c.sealed += 1;
	c.last_sealed = toolName;
}

export function getMiddlewareCounters(): MiddlewareCounters {
	return { ...getCounters() };
}

export function markSealedMiddlewareReady(): SealedMiddlewareCapabilities {
	const caps: SealedMiddlewareCapabilities = {
		toolResultInterception: true,
		transcriptFirewall: true,
		artifactSink: true,
		recordObservationBeforeModel: true,
		source: "agentToolResultMiddleware",
		registeredAt: new Date().toISOString(),
	};

	(globalThis as any)[READY_KEY] = caps;
	return caps;
}

export function getSealedMiddlewareCapabilities(): SealedMiddlewareCapabilities | null {
	const value = (globalThis as any)[READY_KEY];

	if (
		value &&
		typeof value === "object" &&
		value.recordObservationBeforeModel === true
	) {
		return value as SealedMiddlewareCapabilities;
	}

	return null;
}

export function isSealedMiddlewareReady(): boolean {
	return Boolean(getSealedMiddlewareCapabilities());
}
