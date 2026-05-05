import { AUTHORING_DEFAULTS } from "./authoring-defaults.js";
import { AuthoringCompileError } from "./authoring-errors.js";
import type {
	AuthoringCollection,
	AuthoringCompileOptions,
	AuthoringDefaults,
	AuthoringDrainStep,
	AuthoringNamedStep,
	AuthoringOutputSpec,
	AuthoringPipelineItem,
	AuthoringProfile,
	AuthoringStepBody,
	AuthoringUses,
	AuthoringWorkflow,
} from "./authoring-types.js";
import { normalizeSealedSpec } from "./sealed-policy.js";
import type {
	CompiledFromMetadata,
	OutputSpec,
	SealedStepSpec,
	ValidatorSpec,
	WorkflowDefinition,
	WorkflowStateConfig,
	WorkflowStep,
} from "./types.js";

type ResolvedAuthoringDefaults = {
	mode: "sealed";
	context: "adaptive" | "none";
	output_mode: "artifacts";
	retry: "safe" | "none";
	materialize: "always" | "on_demand" | "never";
	batch_size: number;
	lease_seconds: number;
	visibility_timeout_s: number;
	sealed: Partial<SealedStepSpec>;
	layout: {
		data: string;
		report: string;
		spool: string;
	};
};

type ResolvedCollection = {
	name: string;
	itemKey: string;
	queues: Set<string>;
};

type ResolvedProfile = {
	name: string;
	uses?: AuthoringUses;
	tools?: string[];
	context?: "adaptive" | "none";
	retry?: "safe" | "none";
	output?: "artifacts";
	model?: string | "none";
	script?: string | string[];
};

type ResolvedRetry = {
	retry: number;
	retry_delay: number;
	retry_on?: string[];
};

type ResolvedResource = {
	name: string;
	type: "json" | "text" | "file";
	source: string;
	cache: boolean;
	validate?: string;
};

type ResolvedQueueRef = {
	collection: string;
	queue: string;
	executionQueueId: string;
	workerGroupId: string;
	itemKey: string;
};

type AuthoringCompileContext = {
	workflowDir?: string;
	strict: boolean;
	workflowSlug: string;
	defaults: ResolvedAuthoringDefaults;
	collections: Map<string, ResolvedCollection>;
	profiles: Map<string, ResolvedProfile>;
	resources: Map<string, ResolvedResource>;
	usedStepIds: Set<string>;
	generatedStepIds: Set<string>;
};

type CompiledNamedStepResult = {
	mainStep: WorkflowStep;
	helpers: WorkflowStep[];
};

const USES_TOOLS: Record<AuthoringUses, string[]> = {
	browser: ["browser-harness", "write_output", "read_output"],
	model: ["write_output", "read_output"],
	transform: [],
	plugin: [],
	drain: [],
};

export function compileAuthoringWorkflow(
	input: AuthoringWorkflow,
	options: AuthoringCompileOptions = {},
): WorkflowDefinition {
	validateAuthoringWorkflow(input, options);

	const ctx = createAuthoringCompileContext(input, options);
	resolveCollections(input, ctx);
	resolveProfiles(input, ctx);
	resolveResources(input, ctx);
	validatePipelineReferences(input, ctx);

	const steps: WorkflowStep[] = [];
	steps.push(...compileResourceSteps(input, ctx));

	for (let i = 0; i < input.pipeline.length; i += 1) {
		const item = input.pipeline[i];
		if (isDrainStep(item)) {
			steps.push(compileDrainPipelineItem(item, i, ctx));
			continue;
		}

		const { mainStep, helpers } = compileNamedPipelineStep(item, i, ctx, false);
		steps.push(mainStep, ...helpers);
	}

	validateCompiledStepIds(steps, ctx);
	const generatedState = compileCollectionsState(ctx);

	const workflow: WorkflowDefinition = {
		name: input.name,
		version: input.version ?? "1.0",
		description: input.description ?? "",
		config: compileConfig(input),
		validators: (input.validators ?? {}) as Record<string, ValidatorSpec>,
		state: mergeWorkflowState(input.state, generatedState),
		required_skills: Array.isArray(input.required_skills)
			? input.required_skills
			: [],
		steps,
		concurrency:
			typeof input.concurrency === "number"
				? Math.max(1, input.concurrency)
				: 3,
		__compiled_from: {
			schema: "authoring",
		} as CompiledFromMetadata,
	};

	return workflow;
}

function mergeWorkflowState(
	explicit: WorkflowStateConfig | undefined,
	generated: WorkflowStateConfig,
): WorkflowStateConfig | undefined {
	if (!explicit) return generated;

	return {
		...explicit,
		collections: {
			...(explicit.collections ?? {}),
			...(generated.collections ?? {}),
		},
		queues: {
			...(explicit.queues ?? {}),
			...(generated.queues ?? {}),
		},
		worker_groups: {
			...(explicit.worker_groups ?? {}),
			...(generated.worker_groups ?? {}),
		},
	};
}

function validateAuthoringWorkflow(
	input: AuthoringWorkflow,
	options: AuthoringCompileOptions,
): void {
	if (!input || typeof input !== "object") {
		throw new AuthoringCompileError("workflow must be an object");
	}

	if (!input.name || typeof input.name !== "string") {
		throw new AuthoringCompileError('missing required field "name"');
	}

	if (!Array.isArray(input.pipeline)) {
		throw new AuthoringCompileError(
			'missing required field "pipeline" (array)',
		);
	}

	if (input.pipeline.length === 0) {
		throw new AuthoringCompileError("pipeline must be a non-empty array");
	}

	if (options.strict !== false) {
		for (let i = 0; i < input.pipeline.length; i += 1) {
			const item = input.pipeline[i];
			if (isDrainStep(item)) continue;
			const [stepId, body] = extractNamedStep(item, `/pipeline/${i}`);
			if (!body.outputs || Array.isArray(body.outputs)) continue;
			for (const [outputId, validatorId] of Object.entries(body.outputs)) {
				if (!validatorId || typeof validatorId !== "string") {
					throw new AuthoringCompileError(
						`output "${outputId}" must define a validator in strict mode`,
						`/pipeline/${i}/${stepId}/outputs/${outputId}`,
					);
				}
			}
		}
	}
}

function createAuthoringCompileContext(
	input: AuthoringWorkflow,
	options: AuthoringCompileOptions,
): AuthoringCompileContext {
	return {
		workflowDir: options.workflowDir,
		strict: options.strict !== false,
		workflowSlug: slugify(input.name),
		defaults: resolveDefaults(input.defaults),
		collections: new Map(),
		profiles: new Map(),
		resources: new Map(),
		usedStepIds: new Set(),
		generatedStepIds: new Set(),
	};
}

function resolveDefaults(
	defaults?: AuthoringDefaults,
): ResolvedAuthoringDefaults {
	return {
		mode: defaults?.mode ?? AUTHORING_DEFAULTS.mode,
		context: defaults?.context ?? AUTHORING_DEFAULTS.context,
		output_mode: defaults?.output_mode ?? AUTHORING_DEFAULTS.output_mode,
		retry: defaults?.retry ?? AUTHORING_DEFAULTS.retry,
		materialize: defaults?.materialize ?? AUTHORING_DEFAULTS.materialize,
		batch_size: defaults?.batch_size ?? AUTHORING_DEFAULTS.batch_size,
		lease_seconds: defaults?.lease_seconds ?? AUTHORING_DEFAULTS.lease_seconds,
		visibility_timeout_s:
			defaults?.visibility_timeout_s ?? AUTHORING_DEFAULTS.visibility_timeout_s,
		sealed: {
			...AUTHORING_DEFAULTS.sealed,
			...(defaults?.sealed ?? {}),
		},
		layout: {
			data: defaults?.layout?.data ?? AUTHORING_DEFAULTS.layout.data,
			report: defaults?.layout?.report ?? AUTHORING_DEFAULTS.layout.report,
			spool: defaults?.layout?.spool ?? AUTHORING_DEFAULTS.layout.spool,
		},
	};
}

function resolveCollections(
	input: AuthoringWorkflow,
	ctx: AuthoringCompileContext,
) {
	const collections = input.collections ?? {};
	for (const [name, spec] of Object.entries(collections)) {
		validateCollection(name, spec);
		const queues = normalizeQueueNames(spec);
		ctx.collections.set(name, {
			name,
			itemKey: spec.key,
			queues: new Set(queues),
		});
	}
}

function resolveProfiles(
	input: AuthoringWorkflow,
	ctx: AuthoringCompileContext,
) {
	const profiles = input.profiles ?? {};

	for (const [name, profile] of Object.entries(profiles)) {
		ctx.profiles.set(name, { name, ...profile });
	}

	detectProfileCycles(profiles);
}

function resolveResources(
	input: AuthoringWorkflow,
	ctx: AuthoringCompileContext,
) {
	const resources = input.resources ?? {};
	for (const [name, resource] of Object.entries(resources)) {
		ctx.resources.set(name, {
			name,
			type: resource.type,
			source: resource.source,
			cache: resource.cache !== false,
			validate: resource.validate,
		});
	}
}

function validatePipelineReferences(
	input: AuthoringWorkflow,
	ctx: AuthoringCompileContext,
): void {
	const declaredStepIds = new Set<string>();

	for (let i = 0; i < input.pipeline.length; i += 1) {
		const item = input.pipeline[i];

		if (isDrainStep(item)) {
			resolveQueueRef(item.drain, ctx, `/pipeline/${i}/drain`);
			const [drainStepId, drainBody] = extractNamedStep(
				item.do,
				`/pipeline/${i}/drain/do`,
			);
			validateStepBody(
				drainBody,
				ctx,
				`/pipeline/${i}/drain/do/${drainStepId}`,
				true,
			);
			continue;
		}

		const [stepId, body] = extractNamedStep(item, `/pipeline/${i}`);
		if (declaredStepIds.has(stepId)) {
			throw new AuthoringCompileError(
				`duplicate user step id "${stepId}"`,
				`/pipeline/${i}/${stepId}`,
			);
		}
		declaredStepIds.add(stepId);
		validateStepBody(body, ctx, `/pipeline/${i}/${stepId}`, false);
	}
}

function compileCollectionsState(
	ctx: AuthoringCompileContext,
): WorkflowStateConfig {
	const collections: NonNullable<WorkflowStateConfig["collections"]> = {};
	const queues: NonNullable<WorkflowStateConfig["queues"]> = {};
	const worker_groups: NonNullable<WorkflowStateConfig["worker_groups"]> = {};

	for (const [name, spec] of ctx.collections.entries()) {
		const queueNames = [...spec.queues];
		if (queueNames.length === 0) continue;
		const defaultQueueRef = resolveQueueRef(`${name}.${queueNames[0]}`, ctx);

		collections[name] = {
			entity: singularize(name),
			item_key: spec.itemKey,
			default_queue: defaultQueueRef.executionQueueId,
			views: {
				document: true,
				metadata_hash: true,
				seen_index: true,
				pending_queue: true,
				event_stream: true,
			},
		};

		for (const queue of queueNames) {
			const ref = resolveQueueRef(`${name}.${queue}`, ctx);
			queues[ref.executionQueueId] = {
				collection: name,
				batch_size: ctx.defaults.batch_size,
				visibility_timeout_s: ctx.defaults.visibility_timeout_s,
			};
			worker_groups[ref.workerGroupId] = {
				queue: ref.executionQueueId,
				batch_size: ctx.defaults.batch_size,
				lease_seconds: ctx.defaults.lease_seconds,
			};
		}
	}

	return {
		backend: "auto",
		collections,
		queues,
		worker_groups,
	};
}

function compileConfig(input: AuthoringWorkflow): Record<string, unknown> {
	return {
		...(input.vars ?? {}),
		...(input.config ?? {}),
	};
}

function compileResourceSteps(
	input: AuthoringWorkflow,
	ctx: AuthoringCompileContext,
): WorkflowStep[] {
	const out: WorkflowStep[] = [];

	for (const [name, resource] of Object.entries(input.resources ?? {})) {
		if (resource.type !== "json") {
			throw new AuthoringCompileError(
				`resources.${name}.type "${resource.type}" is not supported yet (only json)`,
				`/resources/${name}/type`,
			);
		}

		if (resource.cache === false) {
			continue;
		}

		const stepId = `cache_resource_${name}`;
		trackGeneratedId(stepId, ctx, `/resources/${name}`);

		const outputId = `resource_${name}`;
		out.push({
			id: stepId,
			name: `Cache resource ${name}`,
			kind: "plugin",
			uses: "workflow.cache_json_document",
			with: {
				source_path: resource.source,
				json_key: `cache:{run_id}:resource:${name}`,
				hash_key: `cache:{run_id}:resource:${name}:hash`,
				output_id: outputId,
			},
			task: null,
			depends_on: [],
			outputs: [
				{
					id: outputId,
					...(resource.validate ? { validate: resource.validate } : {}),
				},
			],
			timeout: 300,
			retry: 0,
			retry_delay: 30,
			optional: false,
			__compiled_from: {
				schema: "authoring",
				source_pointer: `/resources/${name}`,
				generated: true,
				generated_reason: `resource_cache:${name}`,
			},
		});
	}

	return out;
}

function compileNamedPipelineStep(
	item: AuthoringNamedStep,
	index: number,
	ctx: AuthoringCompileContext,
	inDrain: boolean,
): CompiledNamedStepResult {
	const pointerBase = inDrain
		? `/pipeline/${index}/drain/do`
		: `/pipeline/${index}`;
	const [stepId, body] = extractNamedStep(item, pointerBase);
	const pointer = `${pointerBase}/${stepId}`;

	const profile = body.profile
		? resolveProfile(body.profile, ctx, pointer)
		: undefined;
	const resolvedUses = (body.uses ?? profile?.uses) as
		| AuthoringUses
		| undefined;

	if (!resolvedUses) {
		throw new AuthoringCompileError(
			"missing uses (or profile with uses)",
			`${pointer}/uses`,
		);
	}

	if (
		!["browser", "model", "transform", "plugin", "drain"].includes(resolvedUses)
	) {
		throw new AuthoringCompileError(
			`unknown uses value "${String(resolvedUses)}"`,
			`${pointer}/uses`,
		);
	}

	const reads = normalizeStringArray(body.reads);
	const writes = normalizeStringArray(body.writes);
	const readDeps = resolveReadDependencies(reads, ctx, pointer);
	const baseDependsOn = [...new Set([...(body.depends_on ?? []), ...readDeps])];

	const writeRefs = writes.map((ref, writeIndex) =>
		resolveQueueRef(ref, ctx, `${pointer}/writes/${writeIndex}`),
	);

	const writeOutputs = writeRefs.map((ref, writeIndex) =>
		finalizeOutputSpec(
			{ id: queueRefOutputId(ref), validate: `${ref.collection}_array` },
			ctx,
			`${pointer}/writes/${writeIndex}`,
		),
	);

	const explicitOutputs = compileExplicitOutputs(
		body.outputs,
		ctx,
		`${pointer}/outputs`,
	);

	const normalizedOutputs = [...explicitOutputs, ...writeOutputs];

	const retry = resolveRetry(body, profile, ctx);

	const compiledFrom: CompiledFromMetadata = {
		schema: "authoring",
		source_step: stepId,
		source_pointer: pointer,
	};

	let mainStep: WorkflowStep;

	if (resolvedUses === "plugin") {
		mainStep = compilePluginAuthoringStep({
			stepId,
			body,
			dependsOn: baseDependsOn,
			normalizedOutputs,
			retry,
			compiledFrom,
			pointer,
		});
	} else if (resolvedUses === "drain") {
		mainStep = compileDrainAuthoringStep({
			stepId,
			body,
			dependsOn: baseDependsOn,
			retry,
			ctx,
			compiledFrom,
			pointer,
		});
	} else if (resolvedUses === "transform") {
		mainStep = compileTransformStep({
			stepId,
			body,
			profile,
			dependsOn: baseDependsOn,
			normalizedOutputs,
			retry,
			compiledFrom,
			pointer,
		});
	} else if (
		(resolvedUses === "browser" || resolvedUses === "model") &&
		body.for_each
	) {
		mainStep = compileSealedForEachStep({
			stepId,
			body,
			resolvedUses,
			profile,
			reads,
			writes,
			dependsOn: baseDependsOn,
			normalizedOutputs,
			retry,
			ctx,
			compiledFrom,
			pointer,
		});
	} else if (resolvedUses === "browser" || resolvedUses === "model") {
		mainStep = compileSealedWorkerStep({
			stepId,
			body,
			resolvedUses,
			profile,
			reads,
			writes,
			dependsOn: baseDependsOn,
			normalizedOutputs,
			retry,
			ctx,
			compiledFrom,
			inDrain,
			drainQueueRef: null,
		});
	} else {
		throw new AuthoringCompileError(
			`unknown uses value "${resolvedUses}"`,
			`${pointer}/uses`,
		);
	}

	const helpers: WorkflowStep[] = [];
	if (resolvedUses !== "plugin" && resolvedUses !== "drain" && !body.for_each) {
		for (const ref of writeRefs) {
			helpers.push(
				compilePublishHelperStep({
					sourceStepId: stepId,
					sourcePointer: pointer,
					ref,
					inDrain,
				}),
			);
		}
	}

	if (!inDrain) {
		trackUserId(mainStep.id, ctx, pointer);
		for (const helper of helpers) {
			trackGeneratedId(helper.id, ctx, pointer);
		}
	}

	return {
		mainStep,
		helpers,
	};
}

function compilePluginAuthoringStep(args: {
	stepId: string;
	body: AuthoringStepBody;
	dependsOn: string[];
	normalizedOutputs: OutputSpec[];
	retry: ResolvedRetry;
	compiledFrom: CompiledFromMetadata;
	pointer: string;
}): WorkflowStep {
	const op = args.body.operation ?? args.body.with?.operation;

	if (!op || typeof op !== "string") {
		throw new AuthoringCompileError(
			"uses: plugin requires operation",
			`${args.pointer}/operation`,
		);
	}

	const withArgs = { ...(args.body.with ?? {}) };
	delete (withArgs as Record<string, unknown>).operation;

	return {
		id: args.stepId,
		name: args.body.name ?? args.stepId,
		kind: "plugin",
		uses: op,
		with: withArgs,
		task: null,
		depends_on: args.dependsOn,
		outputs: args.normalizedOutputs,
		timeout: args.body.timeout ?? 300,
		retry: args.retry.retry,
		retry_delay: args.body.retry_delay ?? args.retry.retry_delay,
		retry_on: args.body.retry_on ?? args.retry.retry_on,
		retry_except: args.body.retry_except,
		optional: args.body.optional ?? false,
		always_run: args.body.always_run,
		on_block: args.body.on_block,
		complete_when: args.body.complete_when ?? "outputs",
		state_publish: args.body.state_publish,
		state_consume: args.body.state_consume,
		state_complete: args.body.state_complete,
		state_reclaim: args.body.state_reclaim,
		state_query: args.body.state_query,
		state_partition: args.body.state_partition,
		state_patch_outputs: args.body.state_patch_outputs,
		state_report: args.body.state_report,
		output_contract_version: args.body.output_contract_version,
		reuse_outputs: args.body.reuse_outputs,
		__compiled_from: args.compiledFrom,
	};
}

function compileTransformStep(args: {
	stepId: string;
	body: AuthoringStepBody;
	profile?: ResolvedProfile;
	dependsOn: string[];
	normalizedOutputs: OutputSpec[];
	retry: ResolvedRetry;
	compiledFrom: CompiledFromMetadata;
	pointer: string;
}): WorkflowStep {
	const script = args.body.script ?? args.profile?.script;
	if (!script) {
		throw new AuthoringCompileError(
			"required when uses: transform",
			`${args.pointer}/script`,
		);
	}

	if (!Array.isArray(script)) {
		throw new AuthoringCompileError(
			"transform script must be an argv array in first implementation",
			`${args.pointer}/script`,
		);
	}

	return {
		id: args.stepId,
		name: args.body.name ?? args.stepId,
		kind: "sealed",
		task: null,
		depends_on: args.dependsOn,
		outputs: args.normalizedOutputs,
		timeout: args.body.timeout ?? 300,
		retry: args.retry.retry,
		retry_delay: args.body.retry_delay ?? args.retry.retry_delay,
		retry_on: args.body.retry_on ?? args.retry.retry_on,
		retry_except: args.body.retry_except,
		optional: args.body.optional ?? false,
		always_run: args.body.always_run,
		on_block: args.body.on_block,
		complete_when: args.body.complete_when ?? "outputs",
		output_contract_version: args.body.output_contract_version,
		reuse_outputs: args.body.reuse_outputs,
		sealed: normalizeSealedSpec({
			...args.body.sealed,
			mode: "command",
			no_model: true,
			command: {
				argv: script.map(String),
			},
		}),
		__compiled_from: args.compiledFrom,
	};
}

function compileSealedWorkerStep(args: {
	stepId: string;
	body: AuthoringStepBody;
	resolvedUses: "browser" | "model";
	profile?: ResolvedProfile;
	reads: string[];
	writes: string[];
	dependsOn: string[];
	normalizedOutputs: OutputSpec[];
	retry: ResolvedRetry;
	ctx: AuthoringCompileContext;
	compiledFrom: CompiledFromMetadata;
	inDrain?: boolean;
	drainQueueRef?: string | null;
}): WorkflowStep {
	if (!args.normalizedOutputs.length) {
		throw new AuthoringCompileError(
			`sealed ${args.resolvedUses} step requires declared outputs`,
		);
	}

	const tools = args.profile?.tools?.length
		? args.profile.tools
		: USES_TOOLS[args.resolvedUses];

	const context =
		(args.profile?.context ?? args.ctx.defaults.context) === "none"
			? { enabled: false }
			: { enabled: true, strategy: "adaptive" as const };

	return {
		id: args.stepId,
		name: args.body.name ?? args.stepId,
		kind: "sealed",
		task: buildWorkerTask({
			stepId: args.stepId,
			userTask: args.body.task,
			reads: args.reads,
			writes: args.writes,
			inDrain: args.inDrain ?? false,
			drainQueueRef: args.drainQueueRef ?? null,
		}),
		depends_on: args.dependsOn,
		outputs: args.normalizedOutputs,
		timeout: args.body.timeout ?? 300,
		retry: args.retry.retry,
		retry_delay: args.body.retry_delay ?? args.retry.retry_delay,
		retry_on: args.body.retry_on ?? args.retry.retry_on,
		retry_except: args.body.retry_except,
		optional: args.body.optional ?? false,
		always_run: args.body.always_run,
		on_block: args.body.on_block,
		model:
			args.body.model ??
			(args.profile?.model && args.profile.model !== "none"
				? args.profile.model
				: undefined),
		complete_when: args.body.complete_when ?? "outputs",
		output_contract_version: args.body.output_contract_version,
		reuse_outputs: args.body.reuse_outputs,
		sealed: normalizeSealedSpec({
			...args.ctx.defaults.sealed,
			...args.body.sealed,
			mode: "tool_worker",
			tools: { allow: tools },
			result_visibility: {
				mode: "auto",
				...(args.ctx.defaults.sealed?.result_visibility ?? {}),
				...(args.body.sealed?.result_visibility ?? {}),
			},
			context_firewall: {
				...context,
				...(args.ctx.defaults.sealed?.context_firewall ?? {}),
				...(args.body.sealed?.context_firewall ?? {}),
			},
		}),
		__compiled_from: args.compiledFrom,
	};
}

function compileSealedForEachStep(args: {
	stepId: string;
	body: AuthoringStepBody;
	resolvedUses: "browser" | "model";
	profile?: ResolvedProfile;
	reads: string[];
	writes: string[];
	dependsOn: string[];
	normalizedOutputs: OutputSpec[];
	retry: ResolvedRetry;
	ctx: AuthoringCompileContext;
	compiledFrom: CompiledFromMetadata;
	pointer: string;
}): WorkflowStep {
	if (!args.body.for_each) {
		throw new AuthoringCompileError(
			"for_each step requires for_each path",
			`${args.pointer}/for_each`,
		);
	}

	const childId = `${args.stepId}_item`;

	const child = compileSealedWorkerStep({
		...args,
		stepId: childId,
		dependsOn: [],
		compiledFrom: {
			...args.compiledFrom,
			generated: true,
			generated_reason: `sealed_loop_worker:${args.stepId}`,
		},
	});

	return {
		id: args.stepId,
		name: args.body.name ?? args.stepId,
		kind: "loop_subagent",
		task: null,
		depends_on: args.dependsOn,
		for_each: args.body.for_each,
		parser: args.body.parser ?? "auto",
		item_schema: args.body.item_schema,
		skip_if_empty: args.body.skip_if_empty,
		concurrency: args.body.concurrency,
		outputs: [],
		timeout: args.body.timeout ?? 300,
		retry: args.retry.retry,
		retry_delay: args.body.retry_delay ?? args.retry.retry_delay,
		retry_on: args.body.retry_on ?? args.retry.retry_on,
		retry_except: args.body.retry_except,
		optional: args.body.optional ?? false,
		complete_when: args.body.complete_when ?? "session_then_outputs",
		steps: [child],
		__compiled_from: args.compiledFrom,
	};
}

function compileDrainAuthoringStep(args: {
	stepId: string;
	body: AuthoringStepBody;
	dependsOn: string[];
	retry: ResolvedRetry;
	ctx: AuthoringCompileContext;
	compiledFrom: CompiledFromMetadata;
	pointer: string;
}): WorkflowStep {
	const workerGroup = args.body.worker_group;

	if (!workerGroup) {
		throw new AuthoringCompileError(
			"uses: drain requires worker_group",
			`${args.pointer}/worker_group`,
		);
	}

	if (!args.body.worker) {
		throw new AuthoringCompileError(
			"uses: drain requires worker",
			`${args.pointer}/worker`,
		);
	}

	const workerBody = args.body.worker;
	const workerId = workerBody.id ?? "worker";

	const claimStep: WorkflowStep = {
		id: "claim",
		name: args.body.claim?.name ?? "claim",
		kind: "plugin",
		uses: "workflow.state_claim",
		task: null,
		depends_on: args.body.claim?.depends_on ?? [],
		state_consume: args.body.claim?.state_consume ?? {
			worker_group: workerGroup,
			output: "claim_manifest",
		},
		outputs: compileExplicitOutputs(
			args.body.claim?.outputs ?? [{ id: "claim_manifest" }],
			args.ctx,
			`${args.pointer}/claim/outputs`,
		),
		timeout: args.body.claim?.timeout ?? 300,
		retry:
			typeof args.body.claim?.retry === "number" ? args.body.claim.retry : 0,
		retry_delay: args.body.claim?.retry_delay ?? 30,
		complete_when: args.body.claim?.complete_when ?? "outputs",
		optional: false,
		__compiled_from: {
			...args.compiledFrom,
			generated: true,
			generated_reason: `state_claim:${workerGroup}`,
		},
	};

	const workerUses = workerBody.uses ?? "model";
	if (workerUses !== "model" && workerUses !== "browser") {
		throw new AuthoringCompileError(
			"drain worker must use model or browser",
			`${args.pointer}/worker/uses`,
		);
	}

	const workerStep = compileSealedWorkerStep({
		stepId: workerId,
		body: workerBody,
		resolvedUses: workerUses,
		profile: workerBody.profile
			? resolveProfile(workerBody.profile, args.ctx, `${args.pointer}/worker`)
			: undefined,
		reads: normalizeStringArray(workerBody.reads),
		writes: normalizeStringArray(workerBody.writes),
		dependsOn: workerBody.depends_on ?? ["claim"],
		normalizedOutputs: compileExplicitOutputs(
			workerBody.outputs,
			args.ctx,
			`${args.pointer}/worker/outputs`,
		),
		retry: resolveRetry(workerBody, undefined, args.ctx),
		ctx: args.ctx,
		inDrain: true,
		drainQueueRef: workerGroup,
		compiledFrom: {
			...args.compiledFrom,
			source_step: workerId,
			generated: true,
			generated_reason: `state_drain_worker:${args.stepId}`,
		},
	});
	const primaryWorkerOutput = workerStep.outputs?.[0];
	const primaryWorkerOutputId =
		typeof primaryWorkerOutput === "string"
			? primaryWorkerOutput
			: primaryWorkerOutput?.id;
	if (!primaryWorkerOutputId) {
		throw new AuthoringCompileError(
			"drain worker must declare at least one output",
			`${args.pointer}/worker/outputs`,
		);
	}

	const completeStep: WorkflowStep = {
		id: "complete",
		name: args.body.complete?.name ?? "complete",
		kind: "plugin",
		uses: "workflow.state_complete",
		task: null,
		depends_on: args.body.complete?.depends_on ?? [workerId],
		state_complete: args.body.complete?.state_complete ?? {
			from_step: workerId,
			output: primaryWorkerOutputId,
			worker_group: workerGroup,
			summary_output: "state_complete_summary",
		},
		outputs: compileExplicitOutputs(
			args.body.complete?.outputs ?? [{ id: "state_complete_summary" }],
			args.ctx,
			`${args.pointer}/complete/outputs`,
		),
		timeout: args.body.complete?.timeout ?? 300,
		retry:
			typeof args.body.complete?.retry === "number"
				? args.body.complete.retry
				: 0,
		retry_delay: args.body.complete?.retry_delay ?? 30,
		complete_when: args.body.complete?.complete_when ?? "outputs",
		optional: false,
		__compiled_from: {
			...args.compiledFrom,
			generated: true,
			generated_reason: `state_complete:${workerGroup}`,
		},
	};

	return {
		id: args.stepId,
		name: args.body.name ?? args.stepId,
		kind: "state_drain",
		task: null,
		depends_on: args.dependsOn,
		outputs: [],
		timeout: args.body.timeout ?? 300,
		retry: args.retry.retry,
		retry_delay: args.body.retry_delay ?? args.retry.retry_delay,
		optional: args.body.optional ?? false,
		drain: {
			worker_group: workerGroup,
			max_empty_claims: args.body.max_empty_claims ?? 1,
			max_iterations: args.body.max_iterations ?? null,
		},
		steps: [claimStep, workerStep, completeStep],
		__compiled_from: args.compiledFrom,
	};
}

function compileDrainPipelineItem(
	item: AuthoringDrainStep,
	index: number,
	ctx: AuthoringCompileContext,
): WorkflowStep {
	const sourcePointer = `/pipeline/${index}/drain`;
	const queueRef = resolveQueueRef(item.drain, ctx, `${sourcePointer}`);
	const controllerId = `drain_${queueRef.collection}_${queueRef.queue}`;

	trackGeneratedId(controllerId, ctx, sourcePointer);

	const [workerStepId, workerBody] = extractNamedStep(
		item.do,
		`${sourcePointer}/do`,
	);
	const workerPointer = `${sourcePointer}/do/${workerStepId}`;

	const workerCompiled = compileNamedPipelineStep(item.do, index, ctx, true);
	const workerStep = {
		...workerCompiled.mainStep,
		depends_on: ["claim", ...workerCompiled.mainStep.depends_on],
		task: buildWorkerTask({
			stepId: workerStepId,
			userTask: workerBody.task,
			reads: normalizeStringArray(workerBody.reads),
			writes: normalizeStringArray(workerBody.writes),
			inDrain: true,
			drainQueueRef: item.drain,
		}),
	};

	const claimStep: WorkflowStep = {
		id: "claim",
		name: `Claim ${item.drain}`,
		kind: "plugin",
		uses: "workflow.state_claim",
		task: null,
		depends_on: [],
		state_consume: {
			worker_group: queueRef.workerGroupId,
			batch_size: item.batch ?? workerBody.batch ?? ctx.defaults.batch_size,
			output: "claim_manifest",
		},
		outputs: [{ id: "claim_manifest" }],
		timeout: 300,
		retry: 0,
		retry_delay: 30,
		optional: false,
		__compiled_from: {
			schema: "authoring",
			source_step: workerStepId,
			source_pointer: workerPointer,
			generated: true,
			generated_reason: `state_claim:${item.drain}`,
		},
	};

	const nestedPublishHelpers = workerCompiled.helpers.map((helper) => ({
		...helper,
		depends_on: [workerStep.id],
	}));

	for (const helper of nestedPublishHelpers) {
		helper.id = helper.id.replace(/^__/, "");
		helper.name = helper.name.replace(/^Publish /, "Publish ");
	}

	const completeDependsOn =
		nestedPublishHelpers.length > 0
			? nestedPublishHelpers.map((s) => s.id)
			: [workerStep.id];
	const firstWriteOutput =
		normalizeStringArray(workerBody.writes).length > 0
			? queueRefOutputId(
					resolveQueueRef(normalizeStringArray(workerBody.writes)[0], ctx),
				)
			: "claim_manifest";

	const completeSummary = `complete_${queueRef.collection}_${queueRef.queue}_summary`;
	const completeStep: WorkflowStep = {
		id: "complete",
		name: "complete",
		kind: "plugin",
		uses: "workflow.state_complete",
		task: null,
		depends_on: completeDependsOn,
		state_complete: {
			from_step: workerStep.id,
			output: firstWriteOutput,
			worker_group: queueRef.workerGroupId,
			collection: queueRef.collection,
			item_key: queueRef.itemKey,
			summary_output: completeSummary,
		},
		outputs: [{ id: completeSummary }],
		timeout: 300,
		retry: 0,
		retry_delay: 30,
		optional: false,
		__compiled_from: {
			schema: "authoring",
			source_step: workerStepId,
			source_pointer: workerPointer,
			generated: true,
			generated_reason: `state_complete:${item.drain}`,
		},
	};

	const nestedSteps = [
		claimStep,
		workerStep,
		...nestedPublishHelpers,
		completeStep,
	];
	validateNestedStepIds(nestedSteps, sourcePointer);

	return {
		id: controllerId,
		name: `Drain ${item.drain}`,
		kind: "state_drain",
		task: null,
		depends_on: [],
		outputs: [],
		timeout: 300,
		retry: 0,
		retry_delay: 30,
		optional: false,
		drain: {
			worker_group: queueRef.workerGroupId,
			max_empty_claims: 1,
			max_iterations: null,
		},
		steps: nestedSteps,
		__compiled_from: {
			schema: "authoring",
			source_step: workerStepId,
			source_pointer: sourcePointer,
			generated: true,
			generated_reason: `state_drain:${item.drain}`,
		},
	};
}

function compilePublishHelperStep(args: {
	sourceStepId: string;
	sourcePointer: string;
	ref: ResolvedQueueRef;
	inDrain: boolean;
}): WorkflowStep {
	const { sourceStepId, sourcePointer, ref, inDrain } = args;
	const outputId = queueRefOutputId(ref);
	const helperId = inDrain
		? `publish_${ref.collection}_${ref.queue}`
		: `__publish_${ref.collection}_${ref.queue}_from_${sourceStepId}`;
	const summaryOutput = inDrain
		? `${helperId}_summary`
		: `__publish_${ref.collection}_${ref.queue}_from_${sourceStepId}_summary`;

	return {
		id: helperId,
		name: `Publish ${ref.collection}.${ref.queue} from ${sourceStepId}`,
		kind: "plugin",
		uses: "workflow.state_publish",
		task: null,
		depends_on: [sourceStepId],
		state_publish: {
			from_step: sourceStepId,
			output: outputId,
			collection: ref.collection,
			queue: ref.executionQueueId,
			item_key: ref.itemKey,
			summary_output: summaryOutput,
		},
		outputs: [{ id: summaryOutput }],
		timeout: 300,
		retry: 0,
		retry_delay: 30,
		optional: false,
		__compiled_from: {
			schema: "authoring",
			source_step: sourceStepId,
			source_pointer: sourcePointer,
			generated: true,
			generated_reason: `state_publish:${ref.collection}.${ref.queue}`,
		},
	};
}

function resolveQueueRef(
	ref: string,
	ctx: AuthoringCompileContext,
	sourcePointer?: string,
): ResolvedQueueRef {
	const [collection, queue] = ref.split(".");

	if (!collection || !queue) {
		throw new AuthoringCompileError(
			`expected collection.queue reference, got "${ref}"`,
			sourcePointer,
		);
	}

	const spec = ctx.collections.get(collection);
	if (!spec) {
		throw new AuthoringCompileError(
			`unknown collection "${collection}"`,
			sourcePointer,
		);
	}

	if (!spec.queues.has(queue)) {
		throw new AuthoringCompileError(
			`unknown queue "${ref}". Declare it under collections.${collection}.queues.`,
			sourcePointer,
		);
	}

	return {
		collection,
		queue,
		executionQueueId: `${collection}_${queue}`,
		workerGroupId: `${collection}_${queue}_workers`,
		itemKey: spec.itemKey,
	};
}

function validateCollection(name: string, spec: AuthoringCollection): void {
	if (!spec || typeof spec !== "object") {
		throw new AuthoringCompileError(`collection "${name}" must be an object`);
	}

	if (!spec.key || typeof spec.key !== "string") {
		throw new AuthoringCompileError(
			`collection "${name}" is missing key`,
			`/collections/${name}/key`,
		);
	}

	const hasQueue = typeof spec.queue === "string" && spec.queue.length > 0;
	const hasQueues = Array.isArray(spec.queues) && spec.queues.length > 0;
	if (!hasQueue && !hasQueues) {
		throw new AuthoringCompileError(
			`collection "${name}" must define queue or queues`,
			`/collections/${name}`,
		);
	}
}

function validateStepBody(
	body: AuthoringStepBody,
	ctx: AuthoringCompileContext,
	pointer: string,
	inDrain: boolean,
): void {
	if (body.profile && !ctx.profiles.has(body.profile)) {
		throw new AuthoringCompileError(
			`unknown profile "${body.profile}"`,
			`${pointer}/profile`,
		);
	}

	if (
		body.uses &&
		!["browser", "model", "transform", "plugin", "drain"].includes(body.uses)
	) {
		throw new AuthoringCompileError(
			`unknown uses value "${body.uses}"`,
			`${pointer}/uses`,
		);
	}

	if (
		body.uses === "transform" &&
		!body.script &&
		!resolveProfileScript(body, ctx)
	) {
		throw new AuthoringCompileError(
			"required when uses: transform.",
			`${pointer}/script`,
		);
	}

	if (body.uses === "plugin") {
		if (
			typeof body.operation !== "string" &&
			(!body.with || typeof body.with.operation !== "string")
		) {
			throw new AuthoringCompileError(
				"uses: plugin requires operation",
				`${pointer}/operation`,
			);
		}
	}

	const writes = normalizeStringArray(body.writes);
	writes.forEach((writeTarget, index) => {
		resolveQueueRef(writeTarget, ctx, `${pointer}/writes/${index}`);
	});

	const reads = normalizeStringArray(body.reads);
	reads.forEach((readTarget, index) => {
		if (isCollectionQueueRef(readTarget)) {
			resolveQueueRef(readTarget, ctx, `${pointer}/reads/${index}`);
			return;
		}

		if (ctx.resources.has(readTarget)) return;

		if (ctx.strict && !isLikelyOutputId(readTarget)) {
			throw new AuthoringCompileError(
				`resource read "${readTarget}" is undeclared`,
				`${pointer}/reads/${index}`,
			);
		}
	});

	if (inDrain && body.depends_on && body.depends_on.length > 0) {
		throw new AuthoringCompileError(
			"drain worker step should not declare depends_on manually",
			`${pointer}/depends_on`,
		);
	}
}

function resolveReadDependencies(
	reads: string[],
	ctx: AuthoringCompileContext,
	pointer: string,
): string[] {
	const deps: string[] = [];
	for (let i = 0; i < reads.length; i += 1) {
		const read = reads[i];
		if (ctx.resources.has(read)) {
			deps.push(`cache_resource_${read}`);
			continue;
		}

		if (isCollectionQueueRef(read)) {
			resolveQueueRef(read, ctx, `${pointer}/reads/${i}`);
		}
	}
	return deps;
}

function resolveRetry(
	body: AuthoringStepBody,
	profile: ResolvedProfile | undefined,
	ctx: AuthoringCompileContext,
): ResolvedRetry {
	if (typeof body.retry === "number") {
		return {
			retry: Math.max(0, body.retry),
			retry_delay: 30,
			retry_on: ["missing_file", "parse", "timeout"],
		};
	}

	const retryMode =
		typeof body.retry === "string"
			? body.retry
			: body.with && typeof body.with.retry === "string"
				? (body.with.retry as "safe" | "none")
				: (profile?.retry ?? ctx.defaults.retry);

	if (retryMode === "none") {
		return { retry: 0, retry_delay: 30 };
	}

	return {
		retry: 2,
		retry_delay: 30,
		retry_on: ["missing_file", "parse", "timeout"],
	};
}

function compileExplicitOutputs(
	raw: AuthoringStepBody["outputs"],
	ctx: AuthoringCompileContext,
	pointer: string,
): OutputSpec[] {
	if (!raw) return [];

	if (Array.isArray(raw)) {
		return raw.map((item, index) => {
			if (typeof item === "string") {
				return finalizeOutputSpec({ id: item }, ctx, `${pointer}/${index}`);
			}

			if (!item || typeof item !== "object") {
				throw new AuthoringCompileError(
					"output must be a string or object",
					`${pointer}/${index}`,
				);
			}

			if (!("id" in item) && !("path" in item)) {
				throw new AuthoringCompileError(
					"output object must define id or path",
					`${pointer}/${index}`,
				);
			}

			return finalizeOutputSpec(item, ctx, `${pointer}/${index}`);
		});
	}

	return Object.entries(raw).map(([id, validate]) =>
		finalizeOutputSpec({ id, validate }, ctx, `${pointer}/${id}`),
	);
}

function finalizeOutputSpec(
	output: Exclude<AuthoringOutputSpec, string>,
	ctx: AuthoringCompileContext,
	pointer: string,
): OutputSpec {
	const id = output.id ?? output.path;
	if (!id) {
		throw new AuthoringCompileError("output missing id", pointer);
	}

	const path = output.path ?? buildOutputPath(id, output.validate, ctx);

	return {
		id,
		path,
		validate: output.validate,
		optional: output.optional === true,
		materialize: {
			path: output.materialize?.path ?? path,
			mode: output.materialize?.mode ?? ctx.defaults.materialize,
		},
	};
}

function buildOutputPath(
	outputId: string,
	validatorId: string | undefined,
	ctx: AuthoringCompileContext,
): string {
	const reportLike = isReportLikeOutput(outputId, validatorId);
	const template = reportLike
		? ctx.defaults.layout.report
		: ctx.defaults.layout.data;
	return template
		.replaceAll("{workflow_slug}", ctx.workflowSlug)
		.replaceAll("{output_id}", outputId)
		.replaceAll("{date}", "{date}");
}

function buildWorkerTask(args: {
	stepId: string;
	userTask?: string;
	reads: string[];
	writes: string[];
	inDrain: boolean;
	drainQueueRef: string | null;
}): string {
	const lines: string[] = [];
	if (args.inDrain) {
		lines.push(`Authoring drain worker: ${args.stepId}`);
		lines.push("");
		lines.push("Process only the claimed records from claim_manifest.");
		if (args.drainQueueRef) {
			lines.push(`Source queue: ${args.drainQueueRef}`);
		}
	} else {
		lines.push(`Authoring step: ${args.stepId}`);
	}

	if (args.userTask) {
		lines.push("");
		lines.push(args.userTask.trim());
	}

	if (args.reads.length > 0) {
		lines.push("");
		lines.push("Available reads:");
		for (const read of args.reads) {
			if (isCollectionQueueRef(read)) {
				lines.push(
					`- queue ${read} is available through state/artifact reads.`,
				);
			} else if (isLikelyOutputId(read)) {
				lines.push(`- output ${read} is available as an output_id.`);
			} else {
				lines.push(
					`- resource ${read} is available as output_id resource_${read}.`,
				);
			}
		}
	}

	if (args.writes.length > 0) {
		lines.push("");
		lines.push("Required write targets:");
		for (const write of args.writes) {
			lines.push(`- ${write}`);
		}
	}

	lines.push("");
	lines.push("Write outputs only.");
	lines.push("Do not print full records into the transcript.");
	lines.push("Return only a compact JSON status.");

	return lines.join("\n");
}

function extractNamedStep(
	item: AuthoringNamedStep,
	pointer: string,
): [string, AuthoringStepBody] {
	const entries = Object.entries(item ?? {});
	if (entries.length !== 1) {
		throw new AuthoringCompileError(
			"named pipeline item must contain exactly one step",
			pointer,
		);
	}

	const [stepId, body] = entries[0];
	if (!body || typeof body !== "object") {
		throw new AuthoringCompileError(
			"step body must be an object",
			`${pointer}/${stepId}`,
		);
	}
	return [stepId, body as AuthoringStepBody];
}

function isDrainStep(item: AuthoringPipelineItem): item is AuthoringDrainStep {
	return (
		!!item &&
		typeof item === "object" &&
		"drain" in item &&
		"do" in item &&
		typeof (item as AuthoringDrainStep).drain === "string"
	);
}

function normalizeQueueNames(spec: AuthoringCollection): string[] {
	const queues = new Set<string>();
	if (spec.queue) queues.add(spec.queue);
	for (const queueName of spec.queues ?? []) {
		queues.add(queueName);
	}
	return [...queues];
}

function normalizeStringArray(value?: string | string[]): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value;
	return [value];
}

function queueRefOutputId(ref: ResolvedQueueRef): string {
	return `${ref.collection}_${ref.queue}`;
}

function singularize(name: string): string {
	if (name.endsWith("s") && name.length > 1) {
		return name.slice(0, -1);
	}
	return name;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function resolveProfile(
	profileName: string,
	ctx: AuthoringCompileContext,
	pointer: string,
): ResolvedProfile {
	const profile = ctx.profiles.get(profileName);
	if (!profile) {
		throw new AuthoringCompileError(
			`unknown profile "${profileName}"`,
			`${pointer}/profile`,
		);
	}
	return profile;
}

function validateCompiledStepIds(
	steps: WorkflowStep[],
	ctx: AuthoringCompileContext,
): void {
	const seen = new Set<string>();
	for (const step of steps) {
		if (seen.has(step.id)) {
			throw new AuthoringCompileError(
				`duplicate generated step ID "${step.id}"`,
			);
		}
		seen.add(step.id);
	}

	for (const userId of ctx.usedStepIds) {
		if (ctx.generatedStepIds.has(userId)) {
			throw new AuthoringCompileError(
				`generated step id conflicts with user step id "${userId}"`,
			);
		}
	}
}

function validateNestedStepIds(steps: WorkflowStep[], pointer: string): void {
	const seen = new Set<string>();
	for (const step of steps) {
		if (seen.has(step.id)) {
			throw new AuthoringCompileError(
				`duplicate generated step ID "${step.id}"`,
				pointer,
			);
		}
		seen.add(step.id);
	}
}

function trackUserId(
	stepId: string,
	ctx: AuthoringCompileContext,
	pointer: string,
) {
	if (ctx.usedStepIds.has(stepId)) {
		throw new AuthoringCompileError(
			`duplicate user step id "${stepId}"`,
			pointer,
		);
	}
	ctx.usedStepIds.add(stepId);
}

function trackGeneratedId(
	stepId: string,
	ctx: AuthoringCompileContext,
	pointer: string,
) {
	if (ctx.generatedStepIds.has(stepId)) {
		throw new AuthoringCompileError(
			`duplicate generated step id "${stepId}"`,
			pointer,
		);
	}
	ctx.generatedStepIds.add(stepId);
}

function isCollectionQueueRef(value: string): boolean {
	return /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(value);
}

function isLikelyOutputId(value: string): boolean {
	return /^[a-zA-Z0-9_-]+$/.test(value) || value.startsWith("resource_");
}

function isReportLikeOutput(outputId: string, validatorId?: string): boolean {
	const v = (validatorId ?? "").toLowerCase();
	const id = outputId.toLowerCase();
	if (v.includes("markdown")) return true;
	if (v.includes("report") && id.includes("report")) return true;
	return false;
}

function detectProfileCycles(profiles: Record<string, AuthoringProfile>): void {
	const graph = new Map<string, string[]>();
	type ProfileWithParent = AuthoringProfile & { profile?: string };

	for (const [name, profile] of Object.entries(profiles)) {
		const maybeExtends = (profile as ProfileWithParent).profile;
		if (typeof maybeExtends === "string" && maybeExtends.length > 0) {
			graph.set(name, [maybeExtends]);
		} else {
			graph.set(name, []);
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();

	function dfs(node: string, stack: string[]) {
		if (visiting.has(node)) {
			throw new AuthoringCompileError(
				"profile cycle detected.",
				`/profiles/${stack[0]}`,
			);
		}
		if (visited.has(node)) return;

		visiting.add(node);
		for (const neighbor of graph.get(node) ?? []) {
			dfs(neighbor, [...stack, neighbor]);
		}
		visiting.delete(node);
		visited.add(node);
	}

	for (const name of graph.keys()) {
		dfs(name, [name]);
	}
}

function resolveProfileScript(
	body: AuthoringStepBody,
	ctx: AuthoringCompileContext,
): string | string[] | undefined {
	if (!body.profile) return undefined;
	return ctx.profiles.get(body.profile)?.script;
}
