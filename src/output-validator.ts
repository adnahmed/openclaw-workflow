import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { run } from "@bufbuild/cel";
import Ajv from "ajv";
import type {
	OutputSpec,
	OutputValidationResult,
	ValidationDecision,
	ValidatorSpec,
} from "./types.js";

type AjvCtor = new (
	...args: unknown[]
) => {
	compile: (schema: unknown) => {
		(data: unknown): boolean;
		errors?: Array<{ instancePath?: string; message?: string }>;
	};
};

const ajv = new (Ajv as unknown as AjvCtor)();

type ValidateOutputValueArgs = {
	value: unknown;
	validatorId?: string;
	validator?: ValidatorSpec;
	validators?: Record<string, ValidatorSpec>;
	workflowDir?: string;
	path?: string;
	bytes?: number;
	exists?: boolean;
};

export function resolveOutputSpec(spec: OutputSpec) {
	return typeof spec === "string" ? { path: spec } : spec;
}

/**
 * Validates a single output based on its specification and the workflow's validator definitions.
 *
 * @param {OutputSpec} spec - The output specification for this specific output
 * @param {string} baseDir - Base directory for resolving relative paths
 * @param {Record<string, ValidatorSpec>} validators - Map of validator IDs to their specifications
 * @param {string} [workflowDir] - Optional workflow directory for reference
 * @returns {Promise<OutputValidationResult>}
 */
function resolveUnknownPolicy(policy) {
	if (policy === undefined || policy === null) {
		return "fail";
	}

	if (policy === "fail" || policy === "blocked" || policy === "pass") {
		return policy;
	}

	throw new Error(
		`Invalid unknown_policy "${String(policy)}". ` +
			`Expected one of: fail, blocked, pass.`,
	);
}

async function loadSchema(schema, workflowDir) {
	if (!schema) return null;
	if (typeof schema === "object") return schema;
	const trimmed = schema.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return JSON.parse(trimmed);
	}
	const schemaPath = isAbsolute(trimmed)
		? trimmed
		: resolve(workflowDir || process.cwd(), trimmed);
	return JSON.parse(await readFile(schemaPath, "utf8"));
}

function failureKindForDecision(
	decision: ValidationDecision,
): OutputValidationResult["failure_kind"] {
	if (decision === "fail") return "fail_when";
	return undefined;
}

export async function validateOutputValue(
	args: ValidateOutputValueArgs,
): Promise<OutputValidationResult> {
	const {
		value,
		validatorId,
		validators = {},
		workflowDir = "",
		path = "",
		bytes,
		exists = true,
	} = args;

	const result: OutputValidationResult = {
		path,
		exists,
		bytes,
		validator: validatorId,
		decision: "unknown",
		errors: [],
		doc: value,
	};

	if (!validatorId) {
		result.decision = "pass";
		return result;
	}

	const validator = args.validator ?? validators[validatorId];
	if (!validator) {
		result.decision = "fail";
		result.errors.push(`Unknown output validator: ${validatorId}`);
		result.failure_kind = "other";
		return result;
	}

	if (
		validator.min_bytes &&
		typeof bytes === "number" &&
		bytes < validator.min_bytes
	) {
		result.decision = "fail";
		result.errors.push(
			`File size ${bytes} is less than minimum ${validator.min_bytes}`,
		);
		result.failure_kind = "other";
		return result;
	}

	if (validator.schema) {
		try {
			const schema = await loadSchema(validator.schema, workflowDir);
			const validateSchema = ajv.compile(schema);
			const valid = validateSchema(value);
			if (!valid) {
				result.decision = "fail";
				result.errors.push(
					...(validateSchema.errors?.map(
						(e) => `${e.instancePath} ${e.message}`,
					) || ["Schema validation failed"]),
				);
				result.failure_kind = "schema";
				return result;
			}
		} catch (e) {
			result.decision = "fail";
			result.errors.push(
				`Schema load/validation error: ${e instanceof Error ? e.message : String(e)}`,
			);
			result.failure_kind = "schema";
			return result;
		}
	}

	const celContext = {
		doc: value,
		path,
		bytes,
		exists,
	};

	const rules = [
		{ rule: validator.fail_when, decision: "fail" as const },
		{ rule: validator.block_when, decision: "blocked" as const },
		{ rule: validator.retry_when, decision: "retry" as const },
		{ rule: validator.pass_when, decision: "pass" as const },
	];

	for (const { rule, decision } of rules) {
		if (!rule) continue;
		try {
			const isMatch = await evaluateCel(rule, celContext);
			if (isMatch) {
				result.decision = decision;
				result.failure_kind = failureKindForDecision(decision);
				return result;
			}
		} catch (e) {
			result.errors.push(
				`CEL evaluation error in ${decision}_when: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	result.decision = resolveUnknownPolicy(validator.unknown_policy);
	return result;
}

export async function validateOutputFile(
	spec,
	baseDir,
	validators = {},
	workflowDir = "",
): Promise<OutputValidationResult> {
	const outputSpec = resolveOutputSpec(spec);
	const { path: rawPath, validate: validatorId } = outputSpec;
	const absPath = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
	const result: OutputValidationResult = {
		path: absPath,
		exists: false,
		decision: "unknown",
		errors: [],
		validator: validatorId,
	};

	try {
		const fileStat = await stat(absPath);
		result.exists = true;
		result.modified_at_ms = fileStat.mtimeMs;
	} catch {
		if (outputSpec.optional) {
			result.decision = "pass";
			return result;
		}
		result.decision = "fail";
		result.errors.push("File does not exist");
		result.failure_kind = "missing_file";
		return result;
	}

	let content: Buffer;
	try {
		content = await readFile(absPath);
	} catch (e) {
		result.decision = "fail";
		result.errors.push(
			`Unexpected error during validation: ${e instanceof Error ? e.message : String(e)}`,
		);
		result.failure_kind = "other";
		return result;
	}

	result.bytes = content.length;

	if (validatorId && !validators[validatorId]) {
		result.decision = "fail";
		result.errors.push(`Unknown output validator: ${validatorId}`);
		result.failure_kind = "other";
		return result;
	}

	const validator = validatorId ? validators[validatorId] : undefined;

	let value: unknown;
	if (validator?.type === "json") {
		try {
			value = JSON.parse(content.toString());
		} catch (e) {
			result.decision = "fail";
			result.errors.push(
				`Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
			);
			result.failure_kind = "parse";
			return result;
		}
	} else {
		value = content.toString();
	}

	const validated = await validateOutputValue({
		value,
		validatorId,
		validator,
		validators,
		workflowDir,
		path: absPath,
		bytes: result.bytes,
		exists: true,
	});

	return {
		...validated,
		path: absPath,
		exists: true,
		bytes: result.bytes,
		modified_at_ms: result.modified_at_ms,
		validator: validatorId,
	};
}

export async function validateOutput(
	spec,
	baseDir,
	validators = {},
	workflowDir = "",
): Promise<OutputValidationResult> {
	return validateOutputFile(spec, baseDir, validators, workflowDir);
}

/**
 * Evaluates a CEL expression against a given context.
 *
 * @param {string} expression - The CEL expression to evaluate
 * @param {Record<string, any>} context - The context data
 * @returns {Promise<boolean>}
 */
async function evaluateCel(expression, context) {
	try {
		const result = run(expression, context);
		return !!result;
	} catch (e) {
		throw e;
	}
}
