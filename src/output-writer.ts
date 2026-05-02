import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { validateOutput, validateOutputValue } from "./output-validator.js";
import type {
	OutputSpec,
	OutputWriteProvenance,
	RunState,
	StepState,
	ValidationDecision,
	WorkflowDefinition,
} from "./types.js";
import { assertSafeOutputPath, outputPathOf } from "./variable-substitution.js";
import { getLocalISOString } from "./workflow-state.js";

function workflowDirOf(workflow: WorkflowDefinition, fallback: string): string {
	const maybe = workflow as unknown as { __dir?: string };
	return maybe.__dir || fallback || "";
}

function normalizePath(baseDir: string, rawPath: string): string {
	assertSafeOutputPath(rawPath);
	return isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
}

function findDeclaredOutput(step: StepState, path: string): OutputSpec | null {
	const declared = step.declared_outputs || [];
	for (const out of declared) {
		if (outputPathOf(out) === path) return out;
	}
	return null;
}

function validatorIdOf(out: OutputSpec): string | undefined {
	return typeof out === "string" ? undefined : out.validate;
}

function serializeForValidator(value: unknown, validatorType?: string): string {
	if (validatorType === "json") {
		return `${JSON.stringify(value, null, 2)}\n`;
	}
	return typeof value === "string" ? value : String(value ?? "");
}

function sha256(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function isCommittableDecision(decision: ValidationDecision): boolean {
	return decision === "pass" || decision === "blocked" || decision === "retry";
}

export async function writeDeclaredOutput(args: {
	workflow: WorkflowDefinition;
	state: RunState;
	stepId: string;
	path: string;
	data?: unknown;
	text?: string;
	baseDir: string;
	workflowsDir: string;
	attempt?: number;
	session_key?: string;
	subagent_run_id?: string;
	handoff_token?: string;
}) {
	const stepState = args.state.steps?.[args.stepId] as StepState | undefined;
	if (!stepState) throw new Error(`Step "${args.stepId}" does not exist.`);
	if (args.state.status !== "running") throw new Error(`Run is not active.`);
	if (stepState.status !== "running") {
		throw new Error(`Step "${args.stepId}" is not running.`);
	}

	const declared = findDeclaredOutput(stepState, args.path);
	if (!declared) {
		throw new Error(
			`Path is not a declared output for step "${args.stepId}": ${args.path}`,
		);
	}

	const validatorId = validatorIdOf(declared);
	const validator = validatorId
		? args.workflow.validators?.[validatorId]
		: undefined;
	if (validatorId && !validator) {
		throw new Error(`Unknown output validator: ${validatorId}`);
	}

	const absPath = normalizePath(args.baseDir, args.path);
	const value =
		validator?.type === "json" ? args.data : (args.text ?? args.data);

	if (
		validator?.type === "json" &&
		(typeof args.data === "undefined" || typeof args.text !== "undefined")
	) {
		throw new Error("For json validators, provide 'data' and omit 'text'.");
	}

	if (validator?.type === "text" && typeof args.text === "undefined") {
		throw new Error("For text validators, provide 'text'.");
	}

	const serialized = serializeForValidator(value, validator?.type);
	const bytes = Buffer.byteLength(serialized);

	const preflight = await validateOutputValue({
		value,
		validatorId,
		validator,
		validators: args.workflow.validators || {},
		workflowDir: workflowDirOf(args.workflow, args.workflowsDir),
		path: absPath,
		bytes,
		exists: true,
	});

	if (!isCommittableDecision(preflight.decision)) {
		return {
			ok: false,
			committed: false,
			decision: preflight.decision,
			validation: preflight,
			message: "Output was not committed because validation failed.",
		};
	}

	await mkdir(dirname(absPath), { recursive: true });

	const tmpPath = resolve(
		dirname(absPath),
		`.${basename(absPath)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`,
	);

	try {
		await writeFile(tmpPath, serialized, "utf8");

		const stagedSpec =
			typeof declared === "string" ? tmpPath : { ...declared, path: tmpPath };

		const stagedValidation = await validateOutput(
			stagedSpec,
			args.baseDir,
			args.workflow.validators || {},
			workflowDirOf(args.workflow, args.workflowsDir),
		);

		if (!isCommittableDecision(stagedValidation.decision)) {
			return {
				ok: false,
				committed: false,
				decision: stagedValidation.decision,
				validation: stagedValidation,
				message:
					"Staged output was not committed because file validation failed.",
			};
		}

		await rename(tmpPath, absPath);

		const finalContent = await readFile(absPath, "utf8");
		const provenance: OutputWriteProvenance = {
			path: args.path,
			abs_path: absPath,
			validator: validatorId,
			decision: stagedValidation.decision,
			failure_kind: stagedValidation.failure_kind,
			run_id: args.state.run_id,
			step_id: args.stepId,
			attempt: args.attempt ?? stepState.attempts,
			session_key: args.session_key ?? stepState.session_key,
			subagent_run_id: args.subagent_run_id ?? stepState.subagent_run_id,
			handoff_token: args.handoff_token ?? stepState.handoff_token,
			bytes: Buffer.byteLength(finalContent),
			sha256: sha256(finalContent),
			committed_at: getLocalISOString(),
		};

		return {
			ok: true,
			committed: true,
			decision: stagedValidation.decision,
			validation: stagedValidation,
			provenance,
		};
	} finally {
		await rm(tmpPath, { force: true }).catch(() => undefined);
	}
}
