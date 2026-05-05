import type {
	ClaimContextInputSpec,
	WorkflowArtifactStore,
	WorkflowStep,
} from "./types.js";

type JsonObject = Record<string, unknown>;

export type InjectedContextResolution = {
	context: Record<string, unknown>;
	logs: string[];
};

function asObject(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

function normalizeClaimSpec(step: WorkflowStep): ClaimContextInputSpec | null {
	if (step.input?.claim) return step.input.claim;

	const legacy = step.input_context;
	if (legacy?.from_claim) {
		return {
			from: legacy.from_claim,
			inject_as: legacy.inject_as,
			max_items: legacy.max_items,
			max_bytes: legacy.max_bytes,
			include_fields: legacy.include_fields,
			expose_artifact_path: legacy.expose_artifact_path,
			require_lease: legacy.require_lease,
		};
	}

	return null;
}

function projectItem(
	item: JsonObject,
	includeFields: string[] | undefined,
): JsonObject {
	if (!includeFields || includeFields.length === 0) return item;

	const out: JsonObject = {};
	for (const field of includeFields) {
		if (Object.hasOwn(item, field)) {
			out[field] = item[field];
		}
	}

	if (Object.hasOwn(item, "lease") && !Object.hasOwn(out, "lease")) {
		out.lease = item.lease;
	}

	if (Object.hasOwn(item, "item_key") && !Object.hasOwn(out, "item_key")) {
		out.item_key = item.item_key;
	}

	return out;
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function findProducerStepId(args: {
	artifactStore: WorkflowArtifactStore;
	runId: string;
	step: WorkflowStep;
	spec: ClaimContextInputSpec;
}): Promise<string> {
	if (args.spec.from_step) return args.spec.from_step;

	const deps = args.step.depends_on ?? [];
	const matches: string[] = [];

	for (const depId of deps) {
		const artifact = await args.artifactStore.readArtifact(
			args.runId,
			depId,
			args.spec.from,
		);
		if (artifact) matches.push(depId);
	}

	if (matches.length === 1) return matches[0];

	if (matches.length === 0) {
		throw new Error(
			`input.claim.from="${args.spec.from}" was not produced by any immediate dependency of step "${args.step.id}". ` +
				`Add depends_on for the claim step, or set input.claim.from_step explicitly.`,
		);
	}

	throw new Error(
		`input.claim.from="${args.spec.from}" is ambiguous for step "${args.step.id}". ` +
			`Matching dependencies: ${matches.join(", ")}. Set input.claim.from_step.`,
	);
}

export async function resolveInjectedContextForStep(args: {
	artifactStore: WorkflowArtifactStore | null | undefined;
	runId: string;
	step: WorkflowStep;
}): Promise<InjectedContextResolution> {
	const spec = normalizeClaimSpec(args.step);
	if (!spec) return { context: {}, logs: [] };

	if (!args.artifactStore) {
		throw new Error(
			`step "${args.step.id}" declares input.claim but no artifactStore is available`,
		);
	}

	if (!spec.from) {
		throw new Error(`step "${args.step.id}" input.claim.from is required`);
	}

	const producerStepId = await findProducerStepId({
		artifactStore: args.artifactStore,
		runId: args.runId,
		step: args.step,
		spec,
	});

	const artifact = await args.artifactStore.readArtifact(
		args.runId,
		producerStepId,
		spec.from,
	);

	if (!artifact) {
		throw new Error(`claim artifact not found: ${producerStepId}.${spec.from}`);
	}

	const data = asObject(artifact.data);
	const rawItems = Array.isArray(data.items)
		? data.items.filter(
				(item): item is JsonObject =>
					item != null && typeof item === "object" && !Array.isArray(item),
			)
		: [];

	const maxItems =
		typeof spec.max_items === "number" && spec.max_items >= 0
			? spec.max_items
			: rawItems.length;

	const requireLease = spec.require_lease !== false;
	const includeFields = spec.include_fields;

	const items = rawItems.slice(0, maxItems).map((item, index) => {
		const projected = projectItem(item, includeFields);

		if (
			requireLease &&
			(!projected.lease ||
				typeof projected.lease !== "object" ||
				Array.isArray(projected.lease))
		) {
			throw new Error(
				`claim item ${index} for step "${args.step.id}" is missing required lease`,
			);
		}

		return projected;
	});

	const injectAs = spec.inject_as || "claim";

	const claim = {
		status: data.status ?? "ok",
		backend: data.backend ?? null,
		mode: data.mode ?? null,
		generated_at: data.generated_at ?? null,
		valid_count: items.length,
		claimed_count: items.length,
		items,
		rejected_items: [],
		workflow_result: data.workflow_result ?? {
			ok: true,
			retryable: false,
			blocked: false,
			failed: false,
		},
		source: {
			output_id: spec.from,
			producer_step_id: producerStepId,
			artifact_path:
				spec.expose_artifact_path === true
					? (artifact.materialized_path ?? null)
					: null,
		},
	};

	const maxBytes =
		typeof spec.max_bytes === "number" && spec.max_bytes > 0
			? spec.max_bytes
			: 32768;

	const size = byteLength(claim);
	if (size > maxBytes) {
		throw new Error(
			`injected claim context for step "${args.step.id}" is ${size} bytes, exceeding max_bytes=${maxBytes}`,
		);
	}

	return {
		context: {
			[injectAs]: claim,
		},
		logs: [
			`injected claim context "${injectAs}" from ${producerStepId}.${spec.from}`,
			`items=${items.length} bytes=${size} expose_artifact_path=${spec.expose_artifact_path === true}`,
		],
	};
}
