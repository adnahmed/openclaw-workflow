import type { OutputSpec } from "./types.js";

export type SealedTaskDigestEvidence = {
	reason: string;
	snippet: string;
};

export type SealedTaskDigest = {
	version: 1;
	producer: "llm" | "deterministic" | "fallback";
	summary: string;
	evidence: SealedTaskDigestEvidence[];
	next_action: string;
	empty_output_risk: "low" | "medium" | "high";
	warnings?: string[];
};

export type SealedTaskDigestModel = {
	generateJson(args: {
		model?: string;
		system: string;
		user: string;
		timeoutMs: number;
	}): Promise<unknown>;
};

export type BuildSealedTaskDigestArgs = {
	value: unknown;
	taskText: string;
	outputs: OutputSpec[];
	toolName?: string;
	control?: unknown;
	modelClient?: SealedTaskDigestModel;
	model?: string;
	mode?: "llm" | "deterministic" | "hybrid" | "off";
	maxInputChars?: number;
	maxOutputBytes?: number;
	timeoutMs?: number;
	/** When true, LLM errors propagate instead of falling back. */
	strict?: boolean;
};

function stringifyForDigest(value: unknown): string {
	if (typeof value === "string") return value;

	try {
		return JSON.stringify(value);
	} catch {
		return String(value ?? "");
	}
}

function clipMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;

	const head = Math.floor(maxChars * 0.65);
	const tail = maxChars - head;

	return `${text.slice(0, head)}\n\n...[sealed digest input clipped ${text.length - maxChars} chars]...\n\n${text.slice(-tail)}`;
}

function outputSummary(outputs: OutputSpec[]): unknown {
	return outputs.map((output) => {
		if (typeof output === "string") {
			return {
				id: output,
				validate: undefined,
				path: output,
			};
		}

		return {
			id: output.id,
			validate: output.validate,
			path: output.path,
		};
	});
}

function clampDigest(
	digest: SealedTaskDigest,
	maxBytes: number,
): SealedTaskDigest {
	let current = digest;

	while (
		current.evidence.length > 0 &&
		Buffer.byteLength(JSON.stringify(current), "utf8") > maxBytes
	) {
		current = {
			...current,
			evidence: current.evidence.slice(0, -1),
			warnings: [
				...(current.warnings || []),
				"Digest evidence trimmed to fit byte budget.",
			],
		};
	}

	if (Buffer.byteLength(JSON.stringify(current), "utf8") <= maxBytes) {
		return current;
	}

	return {
		version: 1,
		producer: current.producer,
		summary: current.summary.slice(0, 500),
		evidence: [],
		next_action: current.next_action.slice(0, 500),
		empty_output_risk: current.empty_output_risk,
		warnings: ["Digest trimmed heavily to fit byte budget."],
	};
}

function normalizeDigest(
	value: unknown,
	producer: SealedTaskDigest["producer"],
): SealedTaskDigest {
	const obj =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};

	const evidence = Array.isArray(obj.evidence)
		? obj.evidence
				.map((item) => {
					const row =
						item && typeof item === "object"
							? (item as Record<string, unknown>)
							: {};
					return {
						reason: String(row.reason || "").slice(0, 300),
						snippet: String(row.snippet || "").slice(0, 1000),
					};
				})
				.filter((item) => item.reason && item.snippet)
				.slice(0, 12)
		: [];

	const risk =
		obj.empty_output_risk === "low" ||
		obj.empty_output_risk === "medium" ||
		obj.empty_output_risk === "high"
			? obj.empty_output_risk
			: evidence.length > 0
				? "high"
				: "medium";

	return {
		version: 1,
		producer,
		summary: String(obj.summary || "No digest summary produced.").slice(
			0,
			1000,
		),
		evidence,
		next_action: String(
			obj.next_action ||
				"Use the sealed observation readers if more evidence is needed.",
		).slice(0, 1000),
		empty_output_risk: risk,
		warnings: Array.isArray(obj.warnings)
			? obj.warnings.map((w) => String(w).slice(0, 300)).slice(0, 5)
			: undefined,
	};
}

function buildDeterministicFallback(
	args: BuildSealedTaskDigestArgs,
): SealedTaskDigest {
	const text = stringifyForDigest(args.value);
	const task = args.taskText || "";
	const outputText = JSON.stringify(outputSummary(args.outputs || []));

	const terms = [
		...new Set(
			[...task.matchAll(/[A-Za-z0-9_./?=&:-]{4,}/g)]
				.map((m) => m[0])
				.concat(
					[...outputText.matchAll(/[A-Za-z0-9_./?=&:-]{4,}/g)].map((m) => m[0]),
				)
				.slice(0, 60),
		),
	];

	const lower = text.toLowerCase();
	const evidence: SealedTaskDigestEvidence[] = [];

	for (const term of terms) {
		const idx = lower.indexOf(term.toLowerCase());
		if (idx < 0) continue;

		evidence.push({
			reason: `Matched task/output term "${term}".`,
			snippet: text
				.slice(
					Math.max(0, idx - 300),
					Math.min(text.length, idx + term.length + 300),
				)
				.replace(/\s+/g, " "),
		});

		if (evidence.length >= 8) break;
	}

	return {
		version: 1,
		producer: "fallback",
		summary:
			evidence.length > 0
				? "Deterministic fallback found task/output terms in the sealed payload."
				: "Deterministic fallback found no task/output terms in the sealed payload.",
		evidence,
		next_action:
			evidence.length > 0
				? "Use the evidence snippets to produce the declared workflow output. Do not commit sealed metadata."
				: "Probe the page/tool once more before concluding the declared output is empty.",
		empty_output_risk: evidence.length > 0 ? "high" : "medium",
	};
}

async function buildLlmDigest(
	args: BuildSealedTaskDigestArgs,
): Promise<SealedTaskDigest> {
	if (!args.modelClient) {
		throw new Error(
			"sealed task digest LLM requested but no modelClient was provided",
		);
	}

	const maxInputChars = args.maxInputChars ?? 100_000;
	const payload = clipMiddle(stringifyForDigest(args.value), maxInputChars);

	const system = `
You are a sealed workflow observation compressor.

You are NOT the workflow agent.
You must NOT produce the final workflow output.
You must NOT invent facts.
You must only summarize evidence visible in the provided payload.
Return JSON only.

Your job:
- Read the step task, declared outputs, tool control data, and sealed payload.
- Identify evidence in the payload that helps the worker complete the step.
- Give a short next action.
- Warn when committing an empty output would be risky.

Rules:
- Do not copy huge payloads.
- Evidence snippets must be short and must come from the payload.
- Do not include sealed metadata in the workflow output.
- Do not add fields outside the schema.
`.trim();

	const user = JSON.stringify(
		{
			step_task: args.taskText || "",
			declared_outputs: outputSummary(args.outputs || []),
			tool_name: args.toolName || null,
			control: args.control || null,
			required_json_schema: {
				version: 1,
				producer: "llm",
				summary: "short string",
				evidence: [
					{
						reason: "short string",
						snippet: "short verbatim-ish payload snippet",
					},
				],
				next_action: "short instruction for worker",
				empty_output_risk: "low | medium | high",
				warnings: ["optional short warning"],
			},
			payload,
		},
		null,
		2,
	);

	const raw = await args.modelClient.generateJson({
		model: args.model,
		system,
		user,
		timeoutMs: args.timeoutMs ?? 20_000,
	});

	return normalizeDigest(raw, "llm");
}

export async function buildSealedTaskDigest(
	args: BuildSealedTaskDigestArgs,
): Promise<SealedTaskDigest | undefined> {
	const mode = args.mode ?? "hybrid";

	if (mode === "off") return undefined;

	const maxOutputBytes = args.maxOutputBytes ?? 12_000;

	if (mode === "deterministic") {
		return clampDigest(buildDeterministicFallback(args), maxOutputBytes);
	}

	if (mode === "llm") {
		if (args.strict) {
			return clampDigest(await buildLlmDigest(args), maxOutputBytes);
		}

		try {
			return clampDigest(await buildLlmDigest(args), maxOutputBytes);
		} catch (err) {
			const fallback = buildDeterministicFallback(args);
			return clampDigest(
				{
					...fallback,
					producer: "fallback",
					warnings: [
						...(fallback.warnings || []),
						`LLM digest failed; deterministic fallback used: ${
							err instanceof Error ? err.message : String(err)
						}`,
					],
				},
				maxOutputBytes,
			);
		}
	}

	try {
		return clampDigest(await buildLlmDigest(args), maxOutputBytes);
	} catch (err) {
		const fallback = buildDeterministicFallback(args);
		return clampDigest(
			{
				...fallback,
				producer: "fallback",
				warnings: [
					...(fallback.warnings || []),
					`LLM digest failed; deterministic fallback used: ${err instanceof Error ? err.message : String(err)}`,
				],
			},
			maxOutputBytes,
		);
	}
}
