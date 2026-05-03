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
	WorkflowArtifactStore,
	WorkflowDefinition,
} from "./types.js";
import {
	assertSafeOutputPath,
	outputIdOf,
	outputPathOf,
} from "./variable-substitution.js";
import { getLocalISOString } from "./workflow-state.js";

function workflowDirOf(workflow: WorkflowDefinition, fallback: string): string {
	const maybe = workflow as unknown as { __dir?: string };
	return maybe.__dir || fallback || "";
}

function normalizePath(baseDir: string, rawPath: string): string {
	assertSafeOutputPath(rawPath);
	return isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
}

function findDeclaredOutput(args: {
	step: StepState;
	path?: string;
	outputId?: string;
}): OutputSpec | null {
	const { step, path, outputId } = args;
	const declared = step.declared_outputs || [];
	for (const out of declared) {
		if (path && outputPathOf(out) === path) return out;
		if (outputId && outputIdOf(out) === outputId) return out;
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
	path?: string;
	output_id?: string;
	data?: unknown;
	text?: string;
	baseDir: string;
	workflowsDir: string;
	artifactStore?: WorkflowArtifactStore | null;
	materializeMode?: "never" | "on_demand" | "always";
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

	const declared = findDeclaredOutput({
		step: stepState,
		path: args.path,
		outputId: args.output_id,
	});
	if (!declared) {
		throw new Error(
			`Output is not declared for step "${args.stepId}": ${args.output_id || args.path}`,
		);
	}

	const declaredPath = outputPathOf(declared);
	const declaredOutputId = args.output_id || outputIdOf(declared);

	const validatorId = validatorIdOf(declared);
	const validator = validatorId
		? args.workflow.validators?.[validatorId]
		: undefined;
	if (validatorId && !validator) {
		throw new Error(`Unknown output validator: ${validatorId}`);
	}

	const absPath = declaredPath ? normalizePath(args.baseDir, declaredPath) : "";
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

	if (args.artifactStore) {
		const isLegacyPathOnly =
			typeof declared === "string" ||
			(typeof declared === "object" && declared !== null && !declared.id && !!declaredPath);

		const effectiveMaterializeMode = isLegacyPathOnly
			? "always"
			: (args.materializeMode || (declaredPath ? "always" : "on_demand"));

		const artifactCommit = await args.artifactStore.commitArtifact({
			runId: args.state.run_id,
			stepId: args.stepId,
			outputId: declaredOutputId,
			declaredOutput: declared,
			data: args.data,
			text: args.text,
			validatorId,
			validator,
			validators: args.workflow.validators || {},
			attempt: args.attempt ?? stepState.attempts,
			sessionKey: args.session_key ?? stepState.session_key,
			subagentRunId: args.subagent_run_id ?? stepState.subagent_run_id,
			handoffToken: args.handoff_token ?? stepState.handoff_token,
			workflowDir: workflowDirOf(args.workflow, args.workflowsDir),
			baseDir: args.baseDir,
			materialize: effectiveMaterializeMode,
		});

		if (!artifactCommit.ok || !artifactCommit.committed || !artifactCommit.artifact) {
			return {
				ok: false,
				committed: false,
				decision: artifactCommit.decision,
				validation: artifactCommit.validation,
				message:
					artifactCommit.message ||
					"Output was not committed because artifact validation failed.",
			};
		}

		const artifact = artifactCommit.artifact;
		const provenance: OutputWriteProvenance = {
			path: declaredPath || undefined,
			abs_path: absPath || undefined,
			output_id: artifact.output_id,
			artifact_key: `${artifact.run_id}:${artifact.step_id}:${artifact.output_id}`,
			materialized_path: artifact.materialized_path || null,
			storage_backend: artifact.storage_backend,
			validator: validatorId,
			decision: artifact.decision,
			run_id: args.state.run_id,
			step_id: args.stepId,
			attempt: artifact.attempt ?? stepState.attempts,
			session_key: artifact.session_key,
			subagent_run_id: artifact.subagent_run_id,
			handoff_token: artifact.handoff_token,
			bytes: artifact.bytes,
			sha256: artifact.sha256,
			committed_at: artifact.committed_at,
		};

		return {
			ok: true,
			committed: true,
			decision: artifact.decision,
			validation: artifactCommit.validation,
			provenance,
		};
	}

	if (!declaredPath) {
		throw new Error(
			`Declared output "${declaredOutputId}" has no path and no artifact store was configured.`,
		);
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
			path: declaredPath,
			abs_path: absPath,
			output_id: declaredOutputId,
			storage_backend: "filesystem",
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
