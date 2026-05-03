import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { run } from "@bufbuild/cel";
import { writeJsonAtomic } from "./json-io.js";
import { checkOutputs, checkStepContract } from "./output-checker.js";
import type {
	CompletionReason,
	OutputCheckResult,
	OutputSpec,
	ReuseOutputsSpec,
	RunState,
	ValidationDecision,
	ValidatorSpec,
	WorkflowDefinition,
	WorkflowStep,
	WorkflowStateStore,
} from "./types.js";
import {
	assertSafeOutputPath,
	outputIdOf,
	outputPathOf,
} from "./variable-substitution.js";
import { getLocalISOString, updateStepState } from "./workflow-state.js";

type CacheManifest = {
	step_id: string;
	outputs: string[];
	producer_run_id?: string;
	produced_at?: string;
	decision?: ValidationDecision;
	reason?: string;
	signature: {
		value: string;
		step_id: string;
		workflow_version: string;
		output_contract_version: number;
		step_task_hash: string;
		output_contract_hash: string;
		validator_hash: string;
		schema_hash: string;
		selected_config_hash: string;
		input_signature: string;
		includes: string[];
	};
};

function hashOf(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value: any): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}

	const keys = Object.keys(value).sort();
	return `{${keys
		.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
		.join(",")}}`;
}

function outputPathList(
	outputs: OutputSpec[] | string[] | undefined,
): string[] {
	if (!outputs) return [];
	return outputs.map((o: any) => outputIdOf(o));
}

function legacyOutputPathList(outputs: OutputSpec[] | string[] | undefined): string[] {
	if (!outputs) return [];
	return outputs
		.map((o: any) => {
			if (typeof o === "string") return o;
			return typeof o?.path === "string" ? o.path : "";
		})
		.filter((v) => typeof v === "string" && v.trim().length > 0);
}

function cacheManifestFilePath(
	baseDir: string,
	stepId: string,
	outputs: string[],
): string {
	const sanitized = stepId.replace(/[^a-zA-Z0-9_-]+/g, "_");
	const fingerprint = createHash("sha256")
		.update(outputs.slice().sort().join("|"))
		.digest("hex")
		.slice(0, 12);
	return join(
		baseDir,
		".openclaw-workflow-cache",
		`${sanitized}-${fingerprint}.json`,
	);
}

async function readSchemaForValidator(
	validator: ValidatorSpec,
	workflowDir = "",
): Promise<{ schema_hash: string; schema_repr: unknown }> {
	if (!validator?.schema)
		return { schema_hash: hashOf(null), schema_repr: null };

	if (typeof validator.schema === "object") {
		return {
			schema_hash: hashOf(validator.schema),
			schema_repr: validator.schema,
		};
	}

	const schemaRef = validator.schema.trim();
	if (schemaRef.startsWith("{") || schemaRef.startsWith("[")) {
		const parsed = JSON.parse(schemaRef);
		return { schema_hash: hashOf(parsed), schema_repr: parsed };
	}

	const schemaPath = isAbsolute(schemaRef)
		? schemaRef
		: resolve(workflowDir || process.cwd(), schemaRef);

	const raw = await readFile(schemaPath, "utf8");
	const parsed = JSON.parse(raw);
	return {
		schema_hash: hashOf(parsed),
		schema_repr: { path: schemaPath, content_hash: hashOf(parsed) },
	};
}

async function buildInputSignature(args: {
	state?: RunState;
	step: WorkflowStep;
	baseDir: string;
}): Promise<string> {
	const { state, step, baseDir } = args;
	const files: Array<{
		path: string;
		exists: boolean;
		size?: number;
		mtimeMs?: number;
	}> = [];

	for (const depId of step.depends_on || []) {
		const depStep = state?.steps?.[depId];
		const declared = depStep?.declared_outputs || [];

		for (const out of declared as any[]) {
			const p = outputPathOf(out);
			if (!p) continue;
			const abs = isAbsolute(p) ? p : resolve(baseDir, p);
			try {
				const st = await stat(abs);
				files.push({
					path: abs,
					exists: true,
					size: st.size,
					mtimeMs: st.mtimeMs,
				});
			} catch {
				files.push({ path: abs, exists: false });
			}
		}
	}

	return hashOf(files.sort((a, b) => a.path.localeCompare(b.path)));
}

export async function computeStepContractSignature(args: {
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	baseDir: string;
	workflowsDir?: string;
	state?: RunState;
	outputsOverride?: string[];
}): Promise<CacheManifest["signature"]> {
	const { workflow, step, state, baseDir, workflowsDir, outputsOverride } =
		args;
	const include = step.reuse_outputs?.freshness?.include || [
		"output_contract_version",
		"step_task",
		"validators",
		"schemas",
		"selected_config",
		"input_signature",
	];

	const outputs =
		outputsOverride && outputsOverride.length > 0
			? outputsOverride
			: outputPathList(step.outputs);

	const outputContractVersion = step.output_contract_version ?? 1;
	const workflowVersion = workflow.version || "1.0";

	const validatorIds = new Set<string>();
	for (const out of (step.outputs || []) as any[]) {
		if (typeof out === "object" && out.validate) validatorIds.add(out.validate);
	}

	const validatorBundle: Record<string, unknown> = {};
	const schemaHashes: string[] = [];

	for (const validatorId of [...validatorIds].sort()) {
		const validator = (workflow.validators || {})[validatorId];
		if (!validator) continue;
		const schema = await readSchemaForValidator(
			validator,
			(workflow as any).__dir || workflowsDir || "",
		);
		schemaHashes.push(schema.schema_hash);
		validatorBundle[validatorId] = {
			...validator,
			schema: schema.schema_repr,
		};
	}

	const inputSignature = await buildInputSignature({ state, step, baseDir });

	const signatureData = {
		step_id: step.id,
		workflow_version: include.includes("step_task") ? workflowVersion : "n/a",
		output_contract_version: include.includes("output_contract_version")
			? outputContractVersion
			: 0,
		step_task_hash: include.includes("step_task")
			? hashOf(step.task || "")
			: hashOf("ignored"),
		output_contract_hash: hashOf(outputs.sort()),
		validator_hash: include.includes("validators")
			? hashOf(validatorBundle)
			: hashOf("ignored"),
		schema_hash: include.includes("schemas")
			? hashOf(schemaHashes.sort())
			: hashOf("ignored"),
		selected_config_hash: include.includes("selected_config")
			? hashOf(workflow.config || {})
			: hashOf("ignored"),
		input_signature: include.includes("input_signature")
			? inputSignature
			: hashOf("ignored"),
		includes: include.slice().sort(),
	};

	return {
		...signatureData,
		value: hashOf(signatureData),
	};
}

export async function readStepCacheManifest(args: {
	baseDir: string;
	stepId: string;
	outputs: string[];
}): Promise<CacheManifest | null> {
	const path = cacheManifestFilePath(args.baseDir, args.stepId, args.outputs);
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as CacheManifest;
	} catch {
		return null;
	}
}

export async function writeStepCacheManifest(args: {
	baseDir: string;
	stepId: string;
	outputs: string[];
	producerRunId: string;
	reason?: string;
	decision: ValidationDecision;
	signature: CacheManifest["signature"];
}): Promise<void> {
	const path = cacheManifestFilePath(args.baseDir, args.stepId, args.outputs);
	await mkdir(dirname(path), { recursive: true });

	const manifest: CacheManifest = {
		step_id: args.stepId,
		outputs: args.outputs,
		producer_run_id: args.producerRunId,
		produced_at: getLocalISOString(),
		decision: args.decision,
		reason: args.reason,
		signature: args.signature,
	};

	await writeJsonAtomic(path, manifest);
}

export async function evaluateCacheFreshness(args: {
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	state?: RunState;
	baseDir: string;
	workflowsDir?: string;
	outputsOverride?: string[];
}): Promise<{
	ok: boolean;
	reason?: string;
	current_signature: string;
	previous_signature?: string;
	producer_run_id?: string;
	validator_hash?: string;
}> {
	const outputs =
		args.outputsOverride && args.outputsOverride.length > 0
			? args.outputsOverride
			: outputPathList(args.step.outputs);

	const current = await computeStepContractSignature(args);
	let manifest = await readStepCacheManifest({
		baseDir: args.baseDir,
		stepId: args.step.id,
		outputs,
	});

	if (!manifest) {
		const legacyOutputs = legacyOutputPathList(args.step.outputs);
		if (
			legacyOutputs.length > 0 &&
			legacyOutputs.join("|") !== outputs.join("|")
		) {
			manifest = await readStepCacheManifest({
				baseDir: args.baseDir,
				stepId: args.step.id,
				outputs: legacyOutputs,
			});
		}
	}

	const requireSignature = args.step.reuse_outputs?.require_signature !== false;
	const legacyPolicy =
		args.step.reuse_outputs?.legacy_unsigned_cache || "stale";

	if (!manifest) {
		if (requireSignature && legacyPolicy === "stale") {
			return {
				ok: false,
				reason: "unsigned_cache_stale",
				current_signature: current.value,
			};
		}

		return {
			ok: true,
			reason: "unsigned_cache_allowed",
			current_signature: current.value,
		};
	}

	if (manifest.signature?.value !== current.value) {
		return {
			ok: false,
			reason: "stale_contract",
			current_signature: current.value,
			previous_signature: manifest.signature?.value,
			producer_run_id: manifest.producer_run_id,
			validator_hash: current.validator_hash,
		};
	}

	return {
		ok: true,
		reason: "signature_match",
		current_signature: current.value,
		previous_signature: manifest.signature?.value,
		producer_run_id: manifest.producer_run_id,
		validator_hash: current.validator_hash,
	};
}

export async function validateStepContract(args: {
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	baseDir: string;
	workflowsDir?: string;
	outputsOverride?: string[];
	runId?: string;
	stepId?: string;
	artifactStore?: any;
	filesystemFallback?: boolean;
}): Promise<OutputCheckResult> {
	const { workflow, step, baseDir, workflowsDir, outputsOverride } = args;

	const outputs =
		outputsOverride && outputsOverride.length > 0
			? outputsOverride
			: step.outputs || [];

	for (const output of outputs) {
		const p = outputPathOf(output);
		if (p) {
			assertSafeOutputPath(p);
		}
	}

	if (args.runId && args.stepId && args.artifactStore) {
		return checkStepContract({
			outputs,
			validators: workflow.validators || {},
			artifactStore: args.artifactStore,
			runId: args.runId,
			stepId: args.stepId,
			baseDir,
			workflowDir: (workflow as any).__dir || workflowsDir || "",
			filesystemFallback: args.filesystemFallback !== false,
		});
	}

	return checkOutputs(outputs, baseDir, workflow.validators || {}, (workflow as any).__dir || workflowsDir || "");
}

export function statusFromContractDecision(outputCheck: OutputCheckResult): {
	status: "ok" | "failed" | "blocked";
	retryable: boolean;
	error: string | null;
} {
	switch (outputCheck.decision) {
		case "pass":
			return { status: "ok", retryable: false, error: null };
		case "blocked":
			return {
				status: "blocked",
				retryable: false,
				error: "Output validator blocked step",
			};
		case "retry":
			return {
				status: "failed",
				retryable: true,
				error: "Output validator requested retry",
			};
		case "fail":
		case "unknown":
		default:
			return {
				status: "failed",
				retryable: false,
				error: `Output gate failed (${outputCheck.decision})`,
			};
	}
}

export function decisionAcceptedForReuse(
	reuseOutputs: ReuseOutputsSpec | undefined,
	decision: ValidationDecision,
): boolean {
	const accepted = reuseOutputs?.accept_decisions || ["pass"];
	return accepted.includes(decision);
}

export function evaluateReuseCondition(args: {
	reuseOutputs?: ReuseOutputsSpec;
	context: Record<string, unknown>;
}): { allowed: boolean; error?: string } {
	const whenExpr = args.reuseOutputs?.when;
	if (!args.reuseOutputs?.enabled) return { allowed: false };
	if (!whenExpr || String(whenExpr).trim().length === 0)
		return { allowed: true };

	try {
		const value = run(whenExpr, args.context as any);
		return { allowed: Boolean(value) };
	} catch (err) {
		return {
			allowed: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export function buildStepHandoffToken(args: {
	runId: string;
	stepId: string;
	attempts: number;
}): string {
	return `${args.runId}:${args.stepId}:attempt:${args.attempts}`;
}

export function handoffMatchesCurrentAttempt(args: {
	stepState: any;
	attempt?: number;
	session_key?: string;
	subagent_run_id?: string;
	handoff_token?: string;
}): { ok: boolean; reason?: string } {
	const { stepState, attempt, session_key, subagent_run_id, handoff_token } =
		args;

	if (typeof attempt === "number" && attempt !== (stepState?.attempts || 0)) {
		return { ok: false, reason: "stale_attempt" };
	}

	if (
		session_key &&
		stepState?.session_key &&
		session_key !== stepState.session_key
	) {
		return { ok: false, reason: "session_key_mismatch" };
	}

	if (
		subagent_run_id &&
		stepState?.subagent_run_id &&
		subagent_run_id !== stepState.subagent_run_id
	) {
		return { ok: false, reason: "subagent_run_id_mismatch" };
	}

	if (
		handoff_token &&
		stepState?.handoff_token &&
		handoff_token !== stepState.handoff_token
	) {
		return { ok: false, reason: "handoff_token_mismatch" };
	}

	return { ok: true };
}

export async function adoptStepContract(args: {
	state: RunState;
	stateStore?: WorkflowStateStore;
	runsDir?: string;
	stepId: string;
	outputCheck: OutputCheckResult;
	reason: CompletionReason | string;
	message?: string;
	metadata?: Record<string, unknown>;
	counters?: Record<string, number>;
}): Promise<RunState> {
	const {
		state,
		runsDir,
		stepId,
		outputCheck,
		reason,
		message,
		metadata,
		counters,
	} = args;

	const mapped = statusFromContractDecision(outputCheck);
	const now = getLocalISOString();

	const patch = {
		status: mapped.status,
		completed_at: now,
		output_check: outputCheck,
		error: mapped.error,
		handoff: {
			...(state.steps?.[stepId]?.handoff || {}),
			completed_at: now,
			reason,
			message: message || null,
			metadata: metadata || undefined,
		},
		counters: counters || state.steps?.[stepId]?.counters || null,
		last_update_at: now,
		last_message: message || state.steps?.[stepId]?.last_message || null,
	};

	if (args.stateStore) {
		return args.stateStore.updateStep(state.run_id, stepId, patch);
	}

	if (!args.runsDir) {
		throw new Error("adoptStepContract requires either stateStore or runsDir");
	}

	return updateStepState(state, stepId, patch, args.runsDir);
}

export async function markCacheProbe(args: {
	state: RunState;
	stateStore?: WorkflowStateStore;
	runsDir?: string;
	stepId: string;
	hit: boolean;
	adopted: boolean;
	decision?: ValidationDecision;
	reason?: string;
	producer_run_id?: string;
	contract_signature?: string;
	previous_contract_signature?: string;
	current_contract_signature?: string;
	validator_hash?: string;
}): Promise<RunState> {
	const now = getLocalISOString();
	const patch = {
		cache: {
			checked_at: now,
			hit: args.hit,
			adopted: args.adopted,
			decision: args.decision,
			reason: args.reason,
			producer_run_id: args.producer_run_id,
			contract_signature: args.contract_signature,
			previous_contract_signature: args.previous_contract_signature,
			current_contract_signature: args.current_contract_signature,
			validator_hash: args.validator_hash,
		},
		last_update_at: now,
		last_message: args.reason || (args.hit ? "cache_hit" : "cache_miss"),
	};

	if (args.stateStore) {
		return args.stateStore.updateStep(args.state.run_id, args.stepId, patch);
	}

	if (!args.runsDir) {
		throw new Error("markCacheProbe requires either stateStore or runsDir");
	}

	return updateStepState(args.state, args.stepId, patch, args.runsDir);
}
