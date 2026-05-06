export type SealedMiddlewareCapabilities = {
	toolResultInterception: true;
	transcriptFirewall: true;
	artifactSink: true;
	recordObservationBeforeModel: true;
	source: "agentToolResultMiddleware";
	registeredAt: string;
};

const READY_KEY = Symbol.for("openclaw-workflow.sealedMiddlewareCapabilities");

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
