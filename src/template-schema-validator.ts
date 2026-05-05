type JsonSchemaLite = {
	type?: "string" | "number" | "boolean" | "object" | "array";
	required?: string[];
	properties?: Record<string, JsonSchemaLite>;
	additionalProperties?: boolean;
};

type WorkflowStepLike = {
	id: string;
	kind?: unknown;
	task?: unknown;
	sealed?: unknown;
	outputs?: unknown;
	skip_if_empty?: unknown;
	for_each?: unknown;
	drain?: unknown;
	item_schema?: JsonSchemaLite | null;
	steps?: WorkflowStepLike[];
};

type WorkflowLike = {
	name: string;
	config?: Record<string, unknown>;
	steps: WorkflowStepLike[];
};

type TokenHit = {
	token: string;
	path: string;
	location: string;
};

const TOKEN_RE =
	/(?<!\\)\{(date|datetime|run_id|config(?:\.[A-Za-z_]\w*)+|item(?:\.[A-Za-z_]\w*)*)\}/g;

export class WorkflowTemplateValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowTemplateValidationError";
	}
}

export function validateWorkflowTemplates(workflow: WorkflowLike): void {
	for (const step of workflow.steps) {
		validateStepTemplates(step, {
			workflowName: workflow.name,
			loopStepId: null,
			itemSchema: null,
			config: workflow.config ?? {},
		});
	}
}

function validateStepTemplates(
	step: WorkflowStepLike,
	ctx: {
		workflowName: string;
		loopStepId: string | null;
		itemSchema: JsonSchemaLite | null;
		config: Record<string, unknown>;
	},
): void {
	validateStepShape(step, ctx);

	const isLoopController = !!step.for_each;
	const activeLoopCtx = isLoopController
		? {
				...ctx,
				loopStepId: step.id,
				itemSchema: step.item_schema ?? null,
			}
		: ctx;

	const fieldsToCheck: Array<[string, unknown]> = [
		["task", step.task],
		["outputs", step.outputs],
		["skip_if_empty", step.skip_if_empty],
		["for_each", step.for_each],
	];

	for (const [field, value] of fieldsToCheck) {
		for (const hit of findTemplateTokens(value, `${step.id}.${field}`)) {
			validateToken(hit, activeLoopCtx);
		}
	}

	for (const inner of step.steps ?? []) {
		validateStepTemplates(inner, activeLoopCtx);
	}
}

function validateStepShape(
	step: WorkflowStepLike,
	ctx: {
		workflowName: string;
		loopStepId: string | null;
	},
): void {
	const where = ctx.loopStepId
		? `loop "${ctx.loopStepId}"`
		: `workflow "${ctx.workflowName}"`;

	const validKinds = new Set([
		"subagent",
		"loop_subagent",
		"plugin",
		"state_drain",
		"sealed",
	]);
	if (step.kind !== undefined) {
		if (typeof step.kind !== "string" || !validKinds.has(step.kind)) {
			throw new WorkflowTemplateValidationError(
				`${step.id}.kind: invalid kind "${String(step.kind)}". Expected one of: subagent, loop_subagent, plugin, state_drain, sealed.`,
			);
		}
	}

	validateSealedStep(step, where);

	if (step.drain === undefined) return;

	if (
		!step.drain ||
		typeof step.drain !== "object" ||
		Array.isArray(step.drain)
	) {
		throw new WorkflowTemplateValidationError(
			`${step.id}.drain: must be an object in ${where}`,
		);
	}

	const drain = step.drain as Record<string, unknown>;
	const allowed = new Set([
		"worker_group",
		"max_empty_claims",
		"max_iterations",
	]);
	for (const key of Object.keys(drain)) {
		if (!allowed.has(key)) {
			throw new WorkflowTemplateValidationError(
				`${step.id}.drain.${key}: unknown property in ${where}`,
			);
		}
	}

	if (
		typeof drain.worker_group !== "string" ||
		drain.worker_group.trim().length === 0
	) {
		throw new WorkflowTemplateValidationError(
			`${step.id}.drain.worker_group: required non-empty string in ${where}`,
		);
	}

	if (
		drain.max_empty_claims !== undefined &&
		(!Number.isInteger(drain.max_empty_claims) ||
			(drain.max_empty_claims as number) < 1)
	) {
		throw new WorkflowTemplateValidationError(
			`${step.id}.drain.max_empty_claims: must be integer >= 1 in ${where}`,
		);
	}

	if (
		drain.max_iterations !== undefined &&
		drain.max_iterations !== null &&
		(!Number.isInteger(drain.max_iterations) ||
			(drain.max_iterations as number) < 1)
	) {
		throw new WorkflowTemplateValidationError(
			`${step.id}.drain.max_iterations: must be integer >= 1 or null in ${where}`,
		);
	}
}

function validateSealedStep(step: WorkflowStepLike, where: string): void {
	if (step.kind !== "sealed") return;

	if (
		!step.sealed ||
		typeof step.sealed !== "object" ||
		Array.isArray(step.sealed)
	) {
		throw new WorkflowTemplateValidationError(
			`${step.id}.sealed: required object in ${where}`,
		);
	}

	const sealed = step.sealed as Record<string, unknown>;
	const mode =
		typeof sealed.mode === "string" && sealed.mode.length > 0
			? sealed.mode
			: "tool_worker";
	const allowedModes = new Set([
		"command",
		"tool_worker",
		"skill_worker",
		"adapter",
	]);

	if (!allowedModes.has(mode)) {
		throw new WorkflowTemplateValidationError(
			`${step.id}.sealed.mode: expected command, tool_worker, skill_worker, or adapter`,
		);
	}

	if (mode === "command" && !sealed.command) {
		throw new WorkflowTemplateValidationError(
			`${step.id}.sealed.command: required when sealed.mode=command`,
		);
	}
}

function findTemplateTokens(value: unknown, location: string): TokenHit[] {
	const hits: TokenHit[] = [];

	function visit(node: unknown, loc: string): void {
		if (typeof node === "string") {
			for (const match of node.matchAll(TOKEN_RE)) {
				hits.push({
					token: match[0],
					path: match[1],
					location: loc,
				});
			}
			return;
		}

		if (Array.isArray(node)) {
			node.forEach((child, index) => visit(child, `${loc}[${index}]`));
			return;
		}

		if (node && typeof node === "object") {
			for (const [key, child] of Object.entries(node)) {
				visit(child, `${loc}.${key}`);
			}
		}
	}

	visit(value, location);
	return hits;
}

function validateToken(
	hit: TokenHit,
	ctx: {
		workflowName: string;
		loopStepId: string | null;
		itemSchema: JsonSchemaLite | null;
		config: Record<string, unknown>;
	},
): void {
	if (hit.path === "date" || hit.path === "datetime" || hit.path === "run_id") {
		return;
	}

	if (hit.path.startsWith("config.")) {
		validateConfigPath(hit, ctx.config);
		return;
	}

	if (hit.path === "item" || hit.path.startsWith("item.")) {
		validateItemPath(hit, ctx);
		return;
	}
}

function validateConfigPath(
	hit: TokenHit,
	config: Record<string, unknown>,
): void {
	const parts = hit.path.split(".").slice(1);
	let current: unknown = config;

	for (const part of parts) {
		if (!current || typeof current !== "object" || !(part in current)) {
			throw new WorkflowTemplateValidationError(
				`${hit.location}: ${hit.token} references missing config path "${hit.path}"`,
			);
		}

		current = (current as Record<string, unknown>)[part];
	}

	if (!isScalar(current)) {
		throw new WorkflowTemplateValidationError(
			`${hit.location}: ${hit.token} resolves to a non-scalar config value`,
		);
	}
}

function validateItemPath(
	hit: TokenHit,
	ctx: {
		workflowName: string;
		loopStepId: string | null;
		itemSchema: JsonSchemaLite | null;
	},
): void {
	if (!ctx.loopStepId) {
		throw new WorkflowTemplateValidationError(
			`${hit.location}: ${hit.token} is only valid inside a for_each step`,
		);
	}

	const schema = ctx.itemSchema;
	if (!schema) {
		throw new WorkflowTemplateValidationError(
			`${hit.location}: ${hit.token} cannot be checked because loop "${ctx.loopStepId}" has no item_schema`,
		);
	}

	const parts = hit.path.split(".");

	if (schema.type === "string") {
		if (parts.length > 1) {
			throw new WorkflowTemplateValidationError(
				`${hit.location}: ${hit.token} is invalid because loop "${ctx.loopStepId}" declares item_schema.type: string. Use {item}, not {item.${parts.slice(1).join(".")}}.`,
			);
		}
		return;
	}

	if (schema.type === "object") {
		if (parts.length === 1) {
			throw new WorkflowTemplateValidationError(
				`${hit.location}: ${hit.token} is invalid because loop "${ctx.loopStepId}" declares object items. Use a scalar property such as {item.alert_key}.`,
			);
		}

		validateSchemaPropertyPath(hit, schema, parts.slice(1), ctx.loopStepId);
		return;
	}

	throw new WorkflowTemplateValidationError(
		`${hit.location}: ${hit.token} cannot be checked because loop "${ctx.loopStepId}" has unsupported item_schema.type: ${String(schema.type)}`,
	);
}

function validateSchemaPropertyPath(
	hit: TokenHit,
	schema: JsonSchemaLite,
	parts: string[],
	loopStepId: string,
): void {
	let current = schema;

	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		const propSchema = current.properties?.[part];

		if (!propSchema && current.additionalProperties !== true) {
			throw new WorkflowTemplateValidationError(
				`${hit.location}: ${hit.token} references unknown item property "${part}" for loop "${loopStepId}"`,
			);
		}

		if (!propSchema) {
			return;
		}

		const isLast = index === parts.length - 1;

		if (isLast) {
			if (!isScalarSchema(propSchema)) {
				throw new WorkflowTemplateValidationError(
					`${hit.location}: ${hit.token} references non-scalar item property "${parts.join(".")}"`,
				);
			}
			return;
		}

		if (propSchema.type !== "object") {
			throw new WorkflowTemplateValidationError(
				`${hit.location}: ${hit.token} descends through non-object item property "${parts
					.slice(0, index + 1)
					.join(".")}"`,
			);
		}

		current = propSchema;
	}
}

function isScalarSchema(schema: JsonSchemaLite): boolean {
	return (
		schema.type === "string" ||
		schema.type === "number" ||
		schema.type === "boolean"
	);
}

function isScalar(value: unknown): boolean {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}
