import type {
	OutputSpec,
	ValidationDecision,
	WorkflowArtifactStore,
} from "./types.js";

export type SealedResultEnvelope = {
	status: "ok" | "failed" | "blocked";
	result_ref?: string;
	bytes?: number;
	kind?: "json_array" | "json_object" | "text" | "binary" | "unknown";
	items?: number;
	preview?: unknown;
	truncated_for_context?: boolean;
	available_reads?: {
		head?: boolean;
		tail?: boolean;
		json_path?: boolean;
		page?: boolean;
		search?: boolean;
	};
};

function asText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	try {
		return JSON.stringify(value);
	} catch {
		return String(value ?? "");
	}
}

function kindOfValue(value: unknown): SealedResultEnvelope["kind"] {
	if (typeof value === "string") return "text";
	if (Buffer.isBuffer(value)) return "binary";
	if (Array.isArray(value)) return "json_array";
	if (value && typeof value === "object") return "json_object";
	if (value === undefined || value === null) return "unknown";
	return "text";
}

function decisionToStatus(
	decision?: ValidationDecision,
): SealedResultEnvelope["status"] {
	if (decision === "blocked") return "blocked";
	if (decision === "fail") return "failed";
	return "ok";
}

export async function spoolValue(args: {
	artifactStore: WorkflowArtifactStore;
	runId: string;
	stepId: string;
	outputId: string;
	value: unknown;
	declaredOutput?: OutputSpec;
	maxPreviewBytes?: number;
}): Promise<SealedResultEnvelope> {
	const raw = asText(args.value);
	const bytes = Buffer.byteLength(raw);
	const maxPreview = Math.max(64, args.maxPreviewBytes ?? 1024);
	const kind = kindOfValue(args.value);
	const declaredOutput = args.declaredOutput ?? { id: args.outputId };

	const committed = await args.artifactStore.commitArtifact({
		runId: args.runId,
		stepId: args.stepId,
		outputId: args.outputId,
		declaredOutput,
		data: args.value,
		text: typeof args.value === "string" ? args.value : undefined,
	});

	return {
		status: decisionToStatus(committed.decision),
		result_ref: `${args.runId}:${args.stepId}:${args.outputId}`,
		bytes,
		kind,
		items: Array.isArray(args.value) ? args.value.length : undefined,
		preview:
			typeof args.value === "string"
				? raw.slice(0, maxPreview)
				: kind === "json_object" || kind === "json_array"
					? args.value
					: raw.slice(0, maxPreview),
		truncated_for_context: bytes > maxPreview,
		available_reads: {
			head: true,
			tail: true,
			json_path: kind === "json_object" || kind === "json_array",
			page: true,
			search: true,
		},
	};
}

export async function spoolStream(args: {
	artifactStore: WorkflowArtifactStore;
	runId: string;
	stepId: string;
	outputId: string;
	text: string;
	maxPreviewBytes?: number;
}): Promise<SealedResultEnvelope> {
	return spoolValue({
		artifactStore: args.artifactStore,
		runId: args.runId,
		stepId: args.stepId,
		outputId: args.outputId,
		value: args.text,
		declaredOutput: { id: args.outputId },
		maxPreviewBytes: args.maxPreviewBytes,
	});
}

export async function readResultSlice(args: {
	artifactStore: WorkflowArtifactStore;
	runId: string;
	stepId: string;
	outputId: string;
	headBytes?: number;
	tailBytes?: number;
}): Promise<unknown> {
	const artifact = await args.artifactStore.readArtifact(
		args.runId,
		args.stepId,
		args.outputId,
	);
	if (!artifact) return null;

	const text = asText(artifact.data);
	const headBytes = Math.max(0, args.headBytes ?? 0);
	const tailBytes = Math.max(0, args.tailBytes ?? 0);

	if (headBytes === 0 && tailBytes === 0) return artifact.data;

	return {
		head: headBytes > 0 ? text.slice(0, headBytes) : undefined,
		tail:
			tailBytes > 0
				? text.slice(Math.max(0, text.length - tailBytes))
				: undefined,
		total_bytes: Buffer.byteLength(text),
	};
}

export function summarizeJsonLike(value: unknown): SealedResultEnvelope {
	if (Array.isArray(value)) {
		return {
			status: "ok",
			kind: "json_array",
			items: value.length,
			preview: value.slice(0, 3),
			available_reads: {
				head: true,
				tail: true,
				json_path: true,
				page: true,
				search: true,
			},
		};
	}

	if (value && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		return {
			status: "ok",
			kind: "json_object",
			items: keys.length,
			preview: keys.slice(0, 20),
			available_reads: {
				head: true,
				tail: true,
				json_path: true,
				page: true,
				search: true,
			},
		};
	}

	return {
		status: "ok",
		kind: "unknown",
		preview: value,
	};
}

export function summarizeTextLike(text: string): SealedResultEnvelope {
	const bytes = Buffer.byteLength(text);
	return {
		status: "ok",
		kind: "text",
		bytes,
		preview: text.slice(0, 512),
		truncated_for_context: bytes > 512,
		available_reads: {
			head: true,
			tail: true,
			page: true,
			search: true,
		},
	};
}
