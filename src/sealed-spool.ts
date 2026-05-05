import type {
	OutputSpec,
	ValidationDecision,
	WorkflowArtifactStore,
} from "./types.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });

function decodeUtf8(value: Uint8Array): string {
	return UTF8_DECODER.decode(value);
}

export type ObservationControl = {
	ok: boolean;
	status?: "ok" | "failed" | "blocked";
	error?: string;
	warnings?: string[];
	elapsed_ms?: number;
	url?: string;
	title?: string;
	page_loaded?: boolean;
	visible_text_bytes?: number;
	visible_item_count?: number;
	scroll?: {
		scroll_y?: number;
		viewport_height?: number;
		document_height?: number;
		near_bottom?: boolean;
	};
	batch_items?: number;
	total_items?: number;
	new_items_since_last_call?: number;
	duplicate_items?: number;
	exhausted?: boolean;
	extra?: Record<string, unknown>;
};

export type BoundedPreview = {
	kind: "bounded_preview";
	max_bytes: number;
	full_bytes: number;
	truncated: boolean;
	summary?: unknown;
};

export type SealedResultEnvelope = {
	ok: boolean;
	status: "ok" | "failed" | "blocked";
	result_ref?: string;
	observation_ref?: string;
	tool_call_id?: string;
	tool_name?: string;
	bytes?: number;
	kind?: "json_array" | "json_object" | "text" | "binary" | "unknown";
	items?: number;
	control: ObservationControl;
	preview?: BoundedPreview | unknown;
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

function truncateUtf8(input: string, maxBytes: number): string {
	const buf = Buffer.from(input, "utf8");

	if (buf.length <= maxBytes) {
		return input;
	}

	return `${decodeUtf8(buf.subarray(0, maxBytes))}\n…[truncated: ${buf.length} bytes > ${maxBytes} bytes]`;
}

function jsonSize(value: unknown): number {
	return Buffer.byteLength(asText(value), "utf8");
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function firstString(
	obj: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string" && value.trim()) {
			return value.length > 512 ? `${value.slice(0, 512)}…` : value;
		}
	}
	return undefined;
}

function firstBoolean(
	obj: Record<string, unknown>,
	keys: string[],
): boolean | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function firstNumber(
	obj: Record<string, unknown>,
	keys: string[],
): number | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function firstArrayLength(
	obj: Record<string, unknown>,
	keys: string[],
): number | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (Array.isArray(value)) return value.length;
	}
	return undefined;
}

function deriveScroll(
	obj: Record<string, unknown>,
): ObservationControl["scroll"] | undefined {
	const scroll_y = firstNumber(obj, ["scroll_y", "scrollY", "scrollTop", "y"]);
	const viewport_height = firstNumber(obj, [
		"viewport_height",
		"viewportHeight",
		"innerHeight",
		"clientHeight",
	]);
	const document_height = firstNumber(obj, [
		"document_height",
		"documentHeight",
		"scrollHeight",
		"bodyScrollHeight",
	]);

	const explicitNearBottom = firstBoolean(obj, [
		"near_bottom",
		"nearBottom",
		"atBottom",
	]);
	const near_bottom =
		explicitNearBottom ??
		(typeof scroll_y === "number" &&
		typeof viewport_height === "number" &&
		typeof document_height === "number"
			? scroll_y + viewport_height >= document_height - 8
			: undefined);

	if (
		scroll_y === undefined &&
		viewport_height === undefined &&
		document_height === undefined &&
		near_bottom === undefined
	) {
		return undefined;
	}

	return { scroll_y, viewport_height, document_height, near_bottom };
}

function clampControl(control: ObservationControl): ObservationControl {
	const extra =
		control.extra && typeof control.extra === "object"
			? Object.fromEntries(
					Object.entries(control.extra)
						.slice(0, 20)
						.map(([key, value]) => {
							if (typeof value === "string") {
								return [
									key,
									value.length > 256 ? `${value.slice(0, 256)}…` : value,
								];
							}
							if (
								value === null ||
								typeof value === "boolean" ||
								typeof value === "number"
							) {
								return [key, value];
							}
							if (Array.isArray(value)) {
								return [key, { kind: "array", items: value.length }];
							}
							if (typeof value === "object") {
								return [
									key,
									{
										kind: "object",
										keys: Object.keys(value as object).slice(0, 20),
									},
								];
							}
							return [key, String(value)];
						}),
				)
			: undefined;

	return {
		...control,
		error:
			typeof control.error === "string" && control.error.length > 512
				? `${control.error.slice(0, 512)}…`
				: control.error,
		warnings: Array.isArray(control.warnings)
			? control.warnings.slice(0, 10).map((w) => String(w).slice(0, 256))
			: undefined,
		extra,
	};
}

export function deriveObservationControl(args: {
	value: unknown;
	status: SealedResultEnvelope["status"];
	control?: Partial<ObservationControl>;
	elapsedMs?: number;
}): ObservationControl {
	const value = args.value;
	const obj = asRecord(value);
	const supplied = args.control ?? {};

	const ok =
		typeof supplied.ok === "boolean" ? supplied.ok : args.status === "ok";

	const base: ObservationControl = {
		ok,
		status: supplied.status ?? args.status,
		error:
			supplied.error ??
			(obj
				? firstString(obj, ["error", "error_message", "message", "reason"])
				: undefined),
		warnings: supplied.warnings,
		elapsed_ms: supplied.elapsed_ms ?? args.elapsedMs,
		url:
			supplied.url ??
			(obj
				? firstString(obj, ["url", "current_url", "href", "location"])
				: undefined),
		title:
			supplied.title ??
			(obj ? firstString(obj, ["title", "page_title"]) : undefined),
		page_loaded:
			supplied.page_loaded ??
			(obj
				? firstBoolean(obj, ["page_loaded", "loaded", "dom_complete", "ready"])
				: undefined),
		visible_text_bytes:
			supplied.visible_text_bytes ??
			(obj
				? (() => {
						const text = firstString(obj, [
							"visible_text",
							"text",
							"body_text",
							"content",
						]);
						return text ? Buffer.byteLength(text, "utf8") : undefined;
					})()
				: typeof value === "string"
					? Buffer.byteLength(value, "utf8")
					: undefined),
		visible_item_count:
			supplied.visible_item_count ??
			(Array.isArray(value)
				? value.length
				: obj
					? firstArrayLength(obj, [
							"items",
							"results",
							"rows",
							"elements",
							"links",
							"cards",
						])
					: undefined),
		scroll: supplied.scroll ?? (obj ? deriveScroll(obj) : undefined),
		batch_items:
			supplied.batch_items ??
			(Array.isArray(value)
				? value.length
				: obj
					? firstArrayLength(obj, ["batch", "items", "results", "rows"])
					: undefined),
		total_items:
			supplied.total_items ??
			(obj
				? firstNumber(obj, ["total_items", "total", "totalCount", "count"])
				: undefined),
		new_items_since_last_call: supplied.new_items_since_last_call,
		duplicate_items: supplied.duplicate_items,
		exhausted: supplied.exhausted,
		extra: supplied.extra,
	};

	return clampControl(base);
}

function makeBoundedPreview(
	value: unknown,
	maxPreviewBytes: number,
	fullBytes = Buffer.byteLength(asText(value), "utf8"),
): BoundedPreview {
	if (fullBytes <= maxPreviewBytes) {
		return {
			kind: "bounded_preview",
			max_bytes: maxPreviewBytes,
			full_bytes: fullBytes,
			truncated: false,
			summary: value,
		};
	}

	if (Array.isArray(value)) {
		return {
			kind: "bounded_preview",
			max_bytes: maxPreviewBytes,
			full_bytes: fullBytes,
			truncated: true,
			summary: {
				kind: "json_array_preview",
				items: value.length,
				preview_items: value.slice(0, 3).map((item) => {
					const itemBytes = jsonSize(item);
					if (itemBytes <= 512) return item;
					if (item && typeof item === "object") {
						return {
							kind: "json_object_preview",
							keys: Object.keys(item as Record<string, unknown>).slice(0, 20),
							full_bytes: itemBytes,
							truncated_for_context: true,
						};
					}
					return truncateUtf8(asText(item), 512);
				}),
			},
		};
	}

	if (value && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		return {
			kind: "bounded_preview",
			max_bytes: maxPreviewBytes,
			full_bytes: fullBytes,
			truncated: true,
			summary: {
				kind: "json_object_preview",
				keys: keys.slice(0, 40),
				key_count: keys.length,
			},
		};
	}

	return {
		kind: "bounded_preview",
		max_bytes: maxPreviewBytes,
		full_bytes: fullBytes,
		truncated: true,
		summary: truncateUtf8(asText(value), maxPreviewBytes),
	};
}

export async function spoolValue(args: {
	artifactStore: WorkflowArtifactStore;
	runId: string;
	stepId: string;
	outputId: string;
	value: unknown;
	declaredOutput?: OutputSpec;
	maxPreviewBytes?: number;
	toolCallId?: string;
	toolName?: string;
	control?: Partial<ObservationControl>;
	elapsedMs?: number;
}): Promise<SealedResultEnvelope> {
	const raw = asText(args.value);
	const bytes = Buffer.byteLength(raw, "utf8");
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
	const status = decisionToStatus(committed.decision);
	const ref = `${args.runId}:${args.stepId}:${args.outputId}`;
	const control = deriveObservationControl({
		value: args.value,
		status,
		control: args.control,
		elapsedMs: args.elapsedMs,
	});

	return {
		ok: status === "ok",
		status,
		result_ref: ref,
		observation_ref: ref,
		tool_call_id: args.toolCallId,
		tool_name: args.toolName,
		bytes,
		kind,
		items: Array.isArray(args.value) ? args.value.length : undefined,
		control,
		preview: makeBoundedPreview(args.value, maxPreview, bytes),
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
	mode?: "head" | "tail" | "page";
	page?: number;
	maxBytes?: number;
}): Promise<unknown> {
	const artifact = await args.artifactStore.readArtifact(
		args.runId,
		args.stepId,
		args.outputId,
	);
	if (!artifact) return null;

	const text = asText(artifact.data);
	const buf = Buffer.from(text, "utf8");
	const maxBytes = Math.min(Math.max(args.maxBytes ?? 4096, 1), 32768);
	const mode = args.mode ?? "head";

	if (mode === "tail") {
		const start = Math.max(0, buf.length - maxBytes);
		return {
			mode,
			text: decodeUtf8(buf.subarray(start)),
			total_bytes: buf.length,
			start_byte: start,
			end_byte: buf.length,
			truncated: start > 0,
		};
	}

	if (mode === "page") {
		const page = Math.max(1, args.page ?? 1);
		const start = (page - 1) * maxBytes;
		const end = Math.min(buf.length, start + maxBytes);
		return {
			mode,
			page,
			text: decodeUtf8(buf.subarray(start, end)),
			total_bytes: buf.length,
			start_byte: start,
			end_byte: end,
			has_next_page: end < buf.length,
		};
	}

	const end = Math.min(buf.length, maxBytes);
	return {
		mode: "head",
		text: decodeUtf8(buf.subarray(0, end)),
		total_bytes: buf.length,
		start_byte: 0,
		end_byte: end,
		truncated: end < buf.length,
	};
}

function parseSimplePath(path: string): Array<string | number> {
	const normalized = path.replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1");

	if (!normalized) return [];

	return normalized.split(".").map((part) => {
		const n = Number(part);
		return Number.isInteger(n) && String(n) === part ? n : part;
	});
}

function projectPath(value: unknown, parts: Array<string | number>): unknown {
	let current = value;

	for (const part of parts) {
		if (Array.isArray(current) && typeof part === "number") {
			current = current[part];
		} else if (
			current &&
			typeof current === "object" &&
			typeof part === "string"
		) {
			current = (current as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}

	return current;
}

export async function searchObservationText(args: {
	artifactStore: WorkflowArtifactStore;
	runId: string;
	stepId: string;
	outputId: string;
	query: string;
	maxMatches?: number;
	contextBytes?: number;
}): Promise<unknown> {
	const artifact = await args.artifactStore.readArtifact(
		args.runId,
		args.stepId,
		args.outputId,
	);

	if (!artifact) return null;

	const text = asText(artifact.data);
	const query = args.query.toLowerCase();
	const maxMatches = Math.min(Math.max(args.maxMatches ?? 10, 1), 50);
	const contextBytes = Math.min(Math.max(args.contextBytes ?? 256, 16), 2048);

	const matches: Array<{
		index: number;
		snippet: string;
	}> = [];

	let from = 0;
	const lower = text.toLowerCase();

	while (matches.length < maxMatches) {
		const index = lower.indexOf(query, from);
		if (index < 0) break;

		const start = Math.max(0, index - contextBytes);
		const end = Math.min(text.length, index + args.query.length + contextBytes);

		matches.push({
			index,
			snippet: truncateUtf8(text.slice(start, end), contextBytes * 2 + 256),
		});

		from = index + Math.max(1, query.length);
	}

	return {
		query: args.query,
		matches,
		match_count: matches.length,
		total_bytes: Buffer.byteLength(text, "utf8"),
		truncated: matches.length >= maxMatches,
	};
}

export async function readObservationJsonPath(args: {
	artifactStore: WorkflowArtifactStore;
	runId: string;
	stepId: string;
	outputId: string;
	path: string;
	maxItems?: number;
	maxBytes?: number;
}): Promise<unknown> {
	const artifact = await args.artifactStore.readArtifact(
		args.runId,
		args.stepId,
		args.outputId,
	);

	if (!artifact) return null;

	const projected = projectPath(artifact.data, parseSimplePath(args.path));
	const maxItems = Math.min(Math.max(args.maxItems ?? 50, 1), 200);

	let value = projected;
	if (Array.isArray(value)) {
		value = value.slice(0, maxItems);
	}

	const raw = asText(value);
	const maxBytes = Math.min(Math.max(args.maxBytes ?? 8192, 128), 32768);
	const rawBytes = Buffer.byteLength(raw, "utf8");
	const projectedBytes = Buffer.byteLength(asText(projected), "utf8");

	return {
		path: args.path,
		value:
			rawBytes > maxBytes
				? makeBoundedPreview(value, maxBytes, rawBytes)
				: value,
		total_bytes: projectedBytes,
		returned_bytes: Math.min(rawBytes, maxBytes),
		truncated: rawBytes > maxBytes,
	};
}

export function summarizeJsonLike(value: unknown): SealedResultEnvelope {
	if (Array.isArray(value)) {
		return {
			ok: true,
			status: "ok",
			kind: "json_array",
			items: value.length,
			control: deriveObservationControl({ value, status: "ok" }),
			preview: makeBoundedPreview(value, 1024),
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
			ok: true,
			status: "ok",
			kind: "json_object",
			items: keys.length,
			control: deriveObservationControl({ value, status: "ok" }),
			preview: makeBoundedPreview(value, 1024),
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
		ok: true,
		status: "ok",
		kind: "unknown",
		control: deriveObservationControl({ value, status: "ok" }),
		preview: makeBoundedPreview(value, 1024),
	};
}

export function summarizeTextLike(text: string): SealedResultEnvelope {
	const bytes = Buffer.byteLength(text);
	return {
		ok: true,
		status: "ok",
		kind: "text",
		bytes,
		control: deriveObservationControl({ value: text, status: "ok" }),
		preview: truncateUtf8(text, 512),
		truncated_for_context: bytes > 512,
		available_reads: {
			head: true,
			tail: true,
			page: true,
			search: true,
		},
	};
}
