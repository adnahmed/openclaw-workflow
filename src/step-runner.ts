/**
 * @module step-runner
 * @description Manages the lifecycle of a single workflow step: spawning the
 * step as an isolated subagent session, polling for completion, and reporting
 * the outcome.
 *
 * ## Session API Abstraction
 * OpenClaw's internal `sessions_spawn` capability is not yet exposed in the
 * plugin `api` object (as of v1.0). This module uses a `SessionAdapter`
 * interface that can be implemented in different ways:
 *
 *   1. **ApiAdapter** (default): Uses `api.sessions.spawn()` and
 *      `api.sessions.getStatus()` if they exist on the api object.
 *      This is the target behavior once OpenClaw exposes this surface.
 *
 *   2. **CliAdapter**: Falls back to spawning `openclaw session` subprocesses
 *      via Node.js `child_process`. This works today with any OpenClaw
 *      installation that has the CLI in PATH.
 *
 *   3. **MockAdapter**: Used in tests — resolves/rejects immediately
 *      based on a pre-configured fixture. Allows the executor to be tested
 *      without any OpenClaw installation.
 *
 * ## PR Note
 * For full functionality, OpenClaw should expose on the `api` object:
 *   - `api.sessions.spawn(prompt, options)` → `{ sessionId, sessionKey }`
 *   - `api.sessions.getStatus(sessionId)` → `{ status: 'running'|'done'|'error', error? }`
 * Until then, the CLI fallback handles real deployments.
 *
 * Dependencies: node:child_process, node:timers/promises, ./output-checker.js
 *
 * @example
 * import { runStep } from './step-runner.js';
 * const result = await runStep(step, runId, api, { pollIntervalMs: 2000, baseDir: '/workspace' });
 * // result.status === 'ok' | 'failed'
 */

import { exec, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
	buildIsolatedStepBoundaryPreamble,
	filterSubagentMcpServers,
} from "./native-state-boundary.js";
import { checkOutputs, checkStepContract } from "./output-checker.js";
import { normalizeSealedSpec } from "./sealed-policy.js";
import { spoolValue } from "./sealed-spool.js";
import {
	type CancelResult,
	type MockAdapterOptions,
	type OutputCheckResult,
	type OutputSpec,
	type OutputValidationResult,
	type SessionAdapter,
	type SessionAdapterCapabilities,
	type SpawnOptions,
	type StepFailureKind,
	StepRunResult,
	type StepState,
	type ValidationDecision,
	type ValidatorSpec,
	type WorkflowArtifactStore,
	type WorkflowDefinition,
} from "./types.js";
import { getLocalISOString } from "./workflow-state.js";

const execAsync = promisify(exec);
let cachedOpenClawPath = null;

/**
 * Runs an OpenClaw CLI command with a structured argument array.
 * Avoids shell interpolation by spawning the CLI directly with an argv array.
 *
 * @param {string[]} args - Arguments for the openclaw command
 * @param {Object} options - Execution options (timeout)
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function runOpenClaw(args: string[], options: { timeout?: number } = {}) {
	const { timeout = 120000 } = options;

	if (!cachedOpenClawPath) {
		try {
			let wrapperPath = "";
			if (process.platform === "win32") {
				try {
					const { stdout } = await execAsync(
						'powershell -Command "(Get-Command openclaw).Source"',
					);
					wrapperPath = stdout.trim().split(/\r?\n/)[0];
				} catch {
					const { stdout } = await execAsync("where openclaw");
					wrapperPath = stdout.trim().split(/\r?\n/)[0];
				}
			} else {
				const { stdout } = await execAsync("which openclaw");
				wrapperPath = stdout.trim().split(/\r?\n/)[0];
			}

			if (!wrapperPath) throw new Error("Executable not found");

			const realPath = fs.realpathSync(wrapperPath);
			const searchPaths = [
				path.join(
					path.dirname(realPath),
					"node_modules",
					"openclaw",
					"openclaw.mjs",
				),
				path.join(
					path.dirname(realPath),
					"..",
					"node_modules",
					"openclaw",
					"openclaw.mjs",
				),
				path.join(
					path.dirname(realPath),
					"..",
					"lib",
					"node_modules",
					"openclaw",
					"openclaw.mjs",
				),
			];

			let mjsPath = "";
			for (const candidate of searchPaths) {
				if (fs.existsSync(candidate)) {
					mjsPath = candidate;
					break;
				}
			}

			if (!mjsPath) {
				throw new Error(
					`Could not locate openclaw.mjs relative to ${realPath}`,
				);
			}

			cachedOpenClawPath = mjsPath;
		} catch (err) {
			throw new Error(
				`Could not find openclaw executable in PATH: ${err.message}`,
			);
		}
	}

	return new Promise((resolve, reject) => {
		const child = spawn("node", [cachedOpenClawPath, ...args], {
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`OpenClaw CLI timed out after ${timeout}ms`));
		}, timeout);

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data) => {
			stdout += data;
		});
		child.stderr.on("data", (data) => {
			stderr += data;
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(
					new Error(
						`OpenClaw CLI failed (code ${code}): ${stderr || stdout || "Unknown error"}`,
					),
				);
			}
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(
				new Error(
					`Failed to start OpenClaw CLI. Ensure "openclaw" is in PATH: ${err.message}`,
				),
			);
		});
	});
}

export function emptyOutputCheck(): OutputCheckResult {
	return {
		passed: false,
		decision: "unknown",
		missing_files: [],
		checked_files: [],
		validations: [],
	};
}

function statusFromOutputDecision(outputCheck) {
	switch (outputCheck.decision) {
		case "pass":
			return {
				finalStatus: "ok",
				retryable: false,
				errorMsg: null,
			};
		case "retry":
			return {
				finalStatus: "failed",
				retryable: true,
				errorMsg: "Output validator requested retry",
			};
		case "blocked":
			return {
				finalStatus: "blocked",
				retryable: false,
				errorMsg: "Output validator blocked step",
			};
		case "fail":
		case "unknown":
		default:
			return {
				finalStatus: "failed",
				retryable: false,
				errorMsg: `Output gate failed (${outputCheck.decision}) — missing files: ${outputCheck.missing_files.join(", ")}`,
			};
	}
}

function outputFailureKinds(outputCheck: OutputCheckResult): string[] {
	return (
		outputCheck.validations
			?.map((v) => v.failure_kind)
			.filter((kind): kind is StepFailureKind => Boolean(kind)) ?? []
	);
}

function readResolvedValidatorSchema(
	validator: ValidatorSpec | undefined,
	workflowDir = "",
): unknown {
	if (!validator?.schema) return null;
	if (typeof validator.schema === "object") return validator.schema;

	const trimmed = validator.schema.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return JSON.parse(trimmed);
	}

	const schemaPath = path.isAbsolute(trimmed)
		? trimmed
		: path.resolve(workflowDir || process.cwd(), trimmed);
	return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

function schemaTypeLabel(schema: Record<string, unknown> | null): string {
	if (!schema || typeof schema !== "object") return "JSON value";
	if (schema.type === "array") return "JSON array";
	if (schema.type === "object") return "JSON object";
	if (typeof schema.type === "string") return `JSON ${schema.type}`;
	return "JSON value";
}

function propertyDescription(
	name: string,
	prop: Record<string, unknown> | undefined,
	required: boolean,
): string {
	const type = typeof prop?.type === "string" ? prop.type : "value";
	const pattern =
		typeof prop?.pattern === "string" ? `, pattern ${prop.pattern}` : "";
	return `- ${name}: ${type}${pattern}${required ? "" : " (optional)"}`;
}

function describeSchema(schema: unknown): string[] {
	if (!schema || typeof schema !== "object") {
		return ["Shape: any JSON value"];
	}

	const typed = schema as Record<string, unknown>;
	const type = typed.type;

	if (type === "array") {
		const lines = ["Type: JSON array"];
		const items = typed.items;
		if (items && typeof items === "object") {
			const itemSchema = items as Record<string, unknown>;
			if (itemSchema.type === "object") {
				lines.push("Each item must be an object with:");
				const required = new Set(
					Array.isArray(itemSchema.required)
						? (itemSchema.required as string[])
						: [],
				);
				const properties = (
					itemSchema.properties && typeof itemSchema.properties === "object"
						? itemSchema.properties
						: {}
				) as Record<string, Record<string, unknown>>;
				for (const [name, prop] of Object.entries(properties)) {
					lines.push(propertyDescription(name, prop, required.has(name)));
				}
			} else {
				lines.push(`Items: ${schemaTypeLabel(itemSchema)}`);
			}
		}
		return lines;
	}

	if (type === "object") {
		const lines = ["Type: JSON object"];
		const required = new Set(
			Array.isArray(typed.required) ? (typed.required as string[]) : [],
		);
		const properties = (
			typed.properties && typeof typed.properties === "object"
				? typed.properties
				: {}
		) as Record<string, Record<string, unknown>>;
		if (Object.keys(properties).length > 0) {
			lines.push("Fields:");
			for (const [name, prop] of Object.entries(properties)) {
				lines.push(propertyDescription(name, prop, required.has(name)));
			}
		}
		return lines;
	}

	return [`Type: ${schemaTypeLabel(typed)}`];
}

function sampleValueFromSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return "example";
	const typed = schema as Record<string, unknown>;
	if (typed.example !== undefined) return typed.example;
	if (Array.isArray(typed.enum) && typed.enum.length > 0) return typed.enum[0];

	if (typed.type === "string") {
		if (typeof typed.pattern === "string") {
			if (typed.pattern.includes("^alert_")) return "alert_123_example";
		}
		return "example";
	}
	if (typed.type === "number" || typed.type === "integer") return 1;
	if (typed.type === "boolean") return true;
	if (typed.type === "array") {
		return [sampleValueFromSchema(typed.items ?? { type: "string" })];
	}
	if (typed.type === "object") {
		const required = new Set(
			Array.isArray(typed.required) ? (typed.required as string[]) : [],
		);
		const properties = (
			typed.properties && typeof typed.properties === "object"
				? typed.properties
				: {}
		) as Record<string, unknown>;
		const obj: Record<string, unknown> = {};
		for (const [key, prop] of Object.entries(properties)) {
			if (required.has(key)) {
				obj[key] = sampleValueFromSchema(prop);
			}
		}
		return obj;
	}

	return "example";
}

function blockedExampleForValidator(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return null;
	const typed = schema as Record<string, unknown>;
	if (typed.type !== "object") return null;
	const properties = (
		typed.properties && typeof typed.properties === "object"
			? typed.properties
			: {}
	) as Record<string, unknown>;
	if (!properties.status || !properties.workflow_result) return null;

	return {
		status: "blocked",
		reason: "upstream_blocked",
		workflow_result: {
			ok: false,
			retryable: false,
			blocked: true,
			failed: false,
		},
	};
}

function renderJsonExample(label: string, value: unknown): string {
	return `${label}:\n${JSON.stringify(value, null, 2)}`;
}

function buildDeclaredOutputContractsPreamble(args: {
	step: { outputs?: OutputSpec[] };
	validators: Record<string, ValidatorSpec>;
	workflowDir?: string;
}): string {
	const outputs = Array.isArray(args.step.outputs) ? args.step.outputs : [];
	if (outputs.length === 0) {
		return "";
	}

	const blocks = outputs.map((output, index) => {
		const outputSpec =
			typeof output === "string" ? { path: output, id: output } : output;
		const validatorId = outputSpec.validate;
		const validator = validatorId ? args.validators?.[validatorId] : undefined;
		const schema = readResolvedValidatorSchema(
			validator,
			args.workflowDir || "",
		);
		const lines = [
			`Output contract ${index + 1}:`,
			`Output ID: ${outputSpec.id || outputSpec.path || `(auto:${index + 1})`}`,
			`Path: ${outputSpec.path || "(logical artifact only)"}`,
			`Validator: ${validatorId || "(none)"}`,
		];

		if (validator) {
			lines.push(...describeSchema(schema));
			lines.push("Semantic decision:");
			lines.push(`- pass_when: ${validator.pass_when || "(none)"}`);
			lines.push(`- retry_when: ${validator.retry_when || "(none)"}`);
			lines.push(`- block_when: ${validator.block_when || "(none)"}`);
			lines.push(`- fail_when: ${validator.fail_when || "(none)"}`);
			lines.push(`- unknown_policy: ${validator.unknown_policy || "fail"}`);

			const blockedExample = validator.block_when
				? blockedExampleForValidator(schema)
				: null;
			if (blockedExample) {
				lines.push(renderJsonExample("Blocked example", blockedExample));
			}

			if (
				schema &&
				typeof schema === "object" &&
				(schema as Record<string, unknown>).type === "array"
			) {
				const exampleItem = sampleValueFromSchema(
					(schema as Record<string, unknown>).items ?? { type: "string" },
				);
				lines.push(renderJsonExample("Valid item example", exampleItem));
			}
		}

		return lines.join("\n");
	});

	return `
IMPORTANT — Declared output handling is managed by the workflow plugin.

You must commit declared outputs with the write_output tool. Do not manually
write declared output files.

The plugin has resolved this step's output validators. Produce outputs matching
the concrete contracts below. write_output will validate them before committing.

${blocks.join("\n\n")}
`;
}

function usesOutputCompletion(step: {
	complete_when?: string;
	outputs?: unknown[];
}): boolean {
	return (
		Array.isArray(step.outputs) &&
		step.outputs.length > 0 &&
		(step.complete_when === "outputs" ||
			step.complete_when === "handoff_or_outputs" ||
			step.complete_when === "session_then_outputs")
	);
}

function sha256ForFile(filePath: string): string | null {
	try {
		const raw = fs.readFileSync(filePath);
		return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
	} catch {
		return null;
	}
}

function hasMatchingProvenanceForValidation(args: {
	stepState?: StepState | null;
	validation: OutputValidationResult;
	runId: string;
	stepId: string;
	attempt?: number;
	decision?: ValidationDecision;
}): boolean {
	const provenanceEntries = Object.values(args.stepState?.output_writes || {});
	if (provenanceEntries.length === 0 || !args.validation.exists) {
		return false;
	}

	const currentHash = sha256ForFile(args.validation.path);
	if (!currentHash) {
		return false;
	}

	return provenanceEntries.some((entry) => {
		if (entry.abs_path !== args.validation.path) return false;
		if (entry.run_id !== args.runId) return false;
		if (entry.step_id !== args.stepId) return false;
		if (typeof args.attempt === "number" && entry.attempt !== args.attempt)
			return false;
		if (entry.sha256 !== currentHash) return false;
		if (args.decision && entry.decision !== args.decision) return false;
		return true;
	});
}

function outputCheckHasCurrentAttemptProvenance(args: {
	stepState?: StepState | null;
	outputCheck: OutputCheckResult;
	runId: string;
	stepId: string;
	attempt?: number;
}): boolean {
	const validations = args.outputCheck.validations ?? [];
	if (validations.length === 0) {
		return false;
	}

	return validations.every((validation) =>
		hasMatchingProvenanceForValidation({
			stepState: args.stepState,
			validation,
			runId: args.runId,
			stepId: args.stepId,
			attempt: args.attempt,
			decision: validation.decision,
		}),
	);
}

/**
 * Returns true when every declared output exists and its mtime is >= the run/step
 * start time, meaning it was (re)produced during this workflow run regardless of
 * which attempt wrote it.  Used as a fallback acceptance path so the runner doesn't
 * retry a step whose previous attempt already produced valid, fresh output files.
 */
function outputWasProducedDuringThisRun(args: {
	outputCheck: OutputCheckResult;
	runStartedAtMs?: number;
	stepFirstStartedAtMs?: number;
}): boolean {
	const minTime = args.stepFirstStartedAtMs ?? args.runStartedAtMs;
	if (!minTime) return false;

	return (args.outputCheck.validations ?? []).every(
		(v) =>
			v.exists &&
			typeof v.modified_at_ms === "number" &&
			v.modified_at_ms >= minTime,
	);
}

/**
 * Preamble injected at the start of every step task prompt.
 *
 * Addresses a known OpenClaw behavior: the exec tool backgrounds commands that
 * run longer than ~10 seconds (default yieldMs), returning "Command still running"
 * without any output. Without this instruction, an agent that runs a 15-30s bash
 * script will see no output and incorrectly conclude the step failed.
 *
 * The preamble instructs the agent to detect this condition and poll via the
 * process tool before interpreting any result.
 *
 * @constant {string}
 */
const EXEC_POLL_PREAMBLE = `\
IMPORTANT — Autonomous Execution: You are running in a non-interactive, automated mode. 
Do NOT ask for user confirmation, "OK", "Go", or any other permission to proceed. 
Execute the task fully and autonomously.

IMPORTANT — exec tool behaviour: if any exec call returns "Command still running \
(session <name>...)", the command was backgrounded because it takes >10s. In that \
case you MUST call process(action="poll", sessionId="<name>", timeout=60000) to \
retrieve the full output before proceeding. Never interpret a backgrounded exec as \
a failure. Only report failure if the final exit code is non-zero or the output \
explicitly indicates an error.
`;

function buildInjectedContextPreamble(context: unknown): string {
	if (
		!context ||
		typeof context !== "object" ||
		Array.isArray(context) ||
		Object.keys(context as Record<string, unknown>).length === 0
	) {
		return "";
	}

	const json = JSON.stringify(context, null, 2);

	return `
IMPORTANT — Engine-injected workflow input:
The following JSON was injected by the workflow engine. It is the complete bounded input context for this step.

Do not read claim artifacts by path.
Do not inspect artifact directories.
Do not aggregate filesystem outputs.
Use only this injected input, declared config, declared tools, and visible page/tool state.

<workflow_input_json>
${json}
</workflow_input_json>

`;
}

function buildWriteOutputPreamble(args: {
	step: { outputs?: OutputSpec[] } | null | undefined;
	validators?: Record<string, ValidatorSpec>;
	workflowDir?: string;
	runId: string;
	stepId: string;
	attempts?: number;
	handoffToken?: string;
}): string {
	if (!Array.isArray(args.step?.outputs) || args.step.outputs.length === 0) {
		return "";
	}

	const contract = buildDeclaredOutputContractsPreamble({
		step: args.step,
		validators: args.validators || {},
		workflowDir: args.workflowDir,
	});

	const attemptLine =
		typeof args.attempts === "number" ? `- attempt: ${args.attempts}` : "";
	const tokenLine = args.handoffToken
		? `- handoff_token: "${args.handoffToken}"`
		: "";

	return `${contract}
IMPORTANT — Every write_output call MUST include:
- run_id: "${args.runId}"
- step_id: "${args.stepId}"
${attemptLine}
${tokenLine}

Example JSON output write:
{
  "run_id": "${args.runId}",
  "step_id": "${args.stepId}",
	"output_id": "<declared output id>",
  "data": <JSON value matching the validator>
}

Legacy migration option:
- You may use "path" instead of "output_id" for older workflows.

For text outputs, use "text" instead of "data".
Provide exactly one of "data" or "text".
`;
}

function signalingModeForStep(step: any): "auto" | "off" {
	if (step?.signaling === "auto" || step?.signaling === "off") {
		return step.signaling;
	}

	return step?.complete_when === "handoff" ||
		step?.complete_when === "handoff_or_outputs"
		? "auto"
		: "off";
}

function buildWorkflowSignalingPreamble(args: {
	step: any;
	runId: string;
	attempts?: number;
	handoffToken?: string;
}): string {
	const mode = signalingModeForStep(args.step);
	if (mode !== "auto") {
		return "";
	}

	const attemptLine =
		typeof args.attempts === "number"
			? `  - attempt: ${args.attempts}`
			: "  - attempt: <current attempt number when known>";

	const tokenLine = args.handoffToken
		? `  - handoff_token: "${args.handoffToken}"`
		: "  - handoff_token: <provided by runtime context when available>";

	return `
IMPORTANT — Workflow signaling protocol (auto-injected by plugin):
- This step should use workflow signaling tools directly; do not ask the workflow author to include signaling boilerplate in task text.
- At start and after major milestones, call workflow_step_update with:
  - run_id: "${args.runId}"
  - step_id: "${args.step.id}"
  - status: "progress"
  - message: concise progress summary
  - counters: useful numeric counters when available
- After declared outputs are written and validated locally, call workflow_step_complete with:
  - run_id: "${args.runId}"
  - step_id: "${args.step.id}"
  - reason: "generated"
${attemptLine}
${tokenLine}
- If completion is rejected due to missing/invalid outputs, repair outputs and retry workflow_step_complete before exiting.
`;
}

const REQUIRED_SEALED_RUNTIME_CAPABILITIES: SessionAdapterCapabilities = {
	toolResultInterception: true,
	transcriptFirewall: true,
	artifactSink: true,
	abortRun: false,
};

function requiresSealedRuntime(step, sealed = step?.sealed): boolean {
	return (
		step?.kind === "sealed" &&
		sealed?.mode === "tool_worker" &&
		sealed?.context_firewall?.enabled !== false
	);
}

function getRuntimeSealedCapabilities(
	api: any,
): Record<string, unknown> | null {
	const sealedCaps =
		api?.runtime?.subagent?.capabilities?.sealed ??
		api?.runtime?.subagent?.sealedCapabilities ??
		null;

	return sealedCaps && typeof sealedCaps === "object"
		? (sealedCaps as Record<string, unknown>)
		: null;
}

function assertRuntimeSealedCapabilities(
	api: any,
	step,
	sealed = step?.sealed,
) {
	if (!requiresSealedRuntime(step, sealed)) return;

	const sealedCaps = getRuntimeSealedCapabilities(api);

	if (!sealedCaps?.toolResultInterception) {
		throw new Error(
			`Cannot run sealed tool_worker "${step.id}": runtime does not explicitly advertise enforced tool-result interception.`,
		);
	}

	if (!sealedCaps?.transcriptFirewall) {
		throw new Error(
			`Cannot run sealed tool_worker "${step.id}": runtime does not explicitly advertise enforced transcript firewalling.`,
		);
	}

	if (!sealedCaps?.artifactSink) {
		throw new Error(
			`Cannot run sealed tool_worker "${step.id}": runtime does not explicitly advertise enforced artifact sink support.`,
		);
	}

	if (!sealedCaps?.recordObservationBeforeModel) {
		throw new Error(
			`Cannot run sealed tool_worker "${step.id}": runtime does not advertise recordObservationBeforeModel — register agentToolResultMiddleware for sealed observation spooling.`,
		);
	}
}

export type ActiveSealedRun = {
	artifactStore: WorkflowArtifactStore;
	runId: string;
	stepId: string;
	maxPreviewBytes: number;
};

/**
 * Registry of currently-running sealed tool_worker steps keyed by sessionKey
 * (which Pi reports back as the threadId in agentToolResultMiddleware events).
 */
export const activeSealedRuns = new Map<string, ActiveSealedRun>();

/**
 * Look up the active sealed run for an incoming middleware tool-result event.
 * Resolves by multiple keys: threadId, sessionKey, sessionId, runId.
 * Returns undefined for non-workflow / non-sealed tool calls.
 */
export function resolveActiveSealedRunForToolResult(
	event: { threadId?: string; toolCallId?: string; cwd?: string },
	ctx?: any,
): ActiveSealedRun | undefined {
	const keys = [
		event?.threadId && `threadId:${event.threadId}`,
		ctx?.sessionKey && `sessionKey:${ctx.sessionKey}`,
		ctx?.sessionId && `sessionId:${ctx.sessionId}`,
		ctx?.runId && `runId:${ctx.runId}`,
	].filter(Boolean);

	for (const key of keys) {
		const run = activeSealedRuns.get(key as string);
		if (run) return run;
	}

	return undefined;
}

function buildSealedArtifactSink(args: {
	sealed: any;
	artifactStore: any;
	runId: string;
	stepId: string;
}) {
	if (!args.sealed) return undefined;

	const maxPreviewBytes =
		typeof args.sealed?.tool_result_policy?.max_context_injection_bytes ===
		"number"
			? Math.max(64, args.sealed.tool_result_policy.max_context_injection_bytes)
			: 2048;

	if (!args.artifactStore) {
		throw new Error(
			`Cannot run sealed tool_worker "${args.stepId}": artifactStore is required for sealed observation spooling.`,
		);
	}

	return {
		runId: args.runId,
		stepId: args.stepId,
		spoolPrefix: `__sealed_spool/${args.stepId}`,
		async recordObservation(event: {
			tool_call_id: string;
			tool_name?: string;
			result: unknown;
			control?: Record<string, unknown>;
			elapsed_ms?: number;
		}) {
			const outputId = `observation_${event.tool_call_id}`;

			return spoolValue({
				artifactStore: args.artifactStore,
				runId: args.runId,
				stepId: args.stepId,
				outputId,
				value: event.result,
				toolCallId: event.tool_call_id,
				toolName: event.tool_name,
				control: event.control,
				elapsedMs: event.elapsed_ms,
				maxPreviewBytes,
			});
		},
	};
}

function missingAdapterCapabilities(
	adapter: SessionAdapter,
	required: Partial<SessionAdapterCapabilities>,
): string[] {
	const capabilities = adapter.capabilities || {
		toolResultInterception: false,
		transcriptFirewall: false,
		artifactSink: false,
		abortRun: false,
	};

	return Object.entries(required)
		.filter(([, enabled]) => enabled)
		.filter(([name]) => !capabilities[name as keyof SessionAdapterCapabilities])
		.map(([name]) => name);
}

function formatCapabilityName(name: string): string {
	switch (name) {
		case "toolResultInterception":
			return "tool-result interception";
		case "transcriptFirewall":
			return "transcript firewall";
		case "artifactSink":
			return "artifact sink";
		case "abortRun":
			return "abort-run support";
		default:
			return name;
	}
}

function assertAdapterCapabilities(
	adapter: SessionAdapter,
	required: Partial<SessionAdapterCapabilities>,
	errorContext: string,
) {
	const missing = missingAdapterCapabilities(adapter, required);
	if (missing.length === 0) return;

	throw new Error(
		`${errorContext}: selected adapter does not support ${missing
			.map(formatCapabilityName)
			.join(", ")}.`,
	);
}

function assertAdapterCanRunSealedToolWorker(
	adapter: SessionAdapter,
	step,
	sealed = step?.sealed,
) {
	if (!requiresSealedRuntime(step, sealed)) return;

	assertAdapterCapabilities(
		adapter,
		REQUIRED_SEALED_RUNTIME_CAPABILITIES,
		`Cannot run sealed tool_worker "${step.id}"`,
	);
}

export function workflowRequiresSealedRuntime(
	workflow: WorkflowDefinition,
): boolean {
	const visit = (steps = []) =>
		steps.some((step) => {
			if (requiresSealedRuntime(step, step.sealed)) return true;
			return Array.isArray(step.steps) && step.steps.length > 0
				? visit(step.steps)
				: false;
		});

	return visit(workflow.steps || []);
}

export function assertWorkflowSessionAdapter(
	api,
	requestedAdapter = "auto",
	workflow: WorkflowDefinition,
) {
	if (!workflowRequiresSealedRuntime(workflow)) return;

	const sealedCaps = getRuntimeSealedCapabilities(api);
	if (
		!sealedCaps?.toolResultInterception ||
		!sealedCaps?.transcriptFirewall ||
		!sealedCaps?.artifactSink
	) {
		throw new Error(
			"Cannot run workflow requiring sealed tool_worker enforcement: runtime does not explicitly advertise sealed interception/firewall/artifact capabilities.",
		);
	}

	selectAdapter(
		api,
		requestedAdapter,
		REQUIRED_SEALED_RUNTIME_CAPABILITIES,
		"Cannot run workflow requiring sealed tool_worker enforcement",
	);
}

/**
 * @typedef {Object} StepRunOptions
 * @property {number}  pollIntervalMs  - How often to poll for session completion (ms)
 * @property {string}  baseDir         - Base directory for resolving relative output paths
 * @property {string}  [defaultModel]  - Default LLM model to use if step doesn't specify one
 * @property {boolean} [cancelled]     - If true, step should not be started (cancel check)
 * @property {'none'|'announce'} [cronDeliveryMode] - Delivery mode for cron jobs
 * @property {string}   [cronDeliveryChannel] - Delivery channel for cron jobs
 * @property {string}   [cronDeliveryTo] - Delivery target for cron jobs
 * @property {number}   [cliTimeoutMs] - General CLI timeout (ms)
 * @property {number}   [cronAddTimeoutMs] - Timeout for cron add (ms)
 * @property {number}   [cronRunTimeoutMs] - Timeout for cron run (ms)
 * @property {number}   [cronPollTimeoutMs] - Timeout for cron poll (ms)
 * @property {Record<string, any>} [validators] - Workflow-level validators
 * @property {string}   [workflowDir] - Workflow directory for resolving output paths
 * @property {Function} [onSpawn] - Callback called immediately after subagent spawn
 * @property {string}   [sessionAdapter] - Explicit adapter to use (auto, runtime-subagent, etc.)
 * @property {number}   [cancelGraceMs] - Grace period to wait for cancellation to confirm (ms)
 * @property {number}   [attempts] - Current step attempt number (when available)
 * @property {string}   [handoffToken] - Current handoff token for this attempt (when available)
 */

/**
 * @typedef {import('./types.js').StepRunResult} StepRunResult
 */

async function waitForTerminalAfterCancel(
	adapter,
	sessionId,
	options,
	cancelGraceMs,
	pollIntervalMs,
) {
	const deadline = Date.now() + cancelGraceMs;
	const interval = Math.min(Math.max(pollIntervalMs || 5000, 1000), 5000);

	while (Date.now() < deadline) {
		await sleep(interval);

		try {
			const status = await adapter.getStatus(sessionId, options);
			if (status.status === "done" || status.status === "error") {
				return status;
			}
		} catch {
			// Keep waiting during grace.
		}
	}

	return null;
}

async function settleSessionAfterOutputPass(
	adapter,
	spawnResult,
	step,
	options,
	pollIntervalMs,
) {
	const cancelGraceMs = options.cancelGraceMs ?? 30000;

	const statusResult = await adapter.getStatus(spawnResult.sessionId, options);

	if (statusResult.status === "done" || statusResult.status === "error") {
		return {
			settled: true,
			statusResult,
			cancelResult: null,
			stopped: statusResult,
			error: null,
		};
	}

	if (typeof adapter.cancel !== "function") {
		return {
			settled: false,
			statusResult,
			cancelResult: null,
			stopped: null,
			error:
				`Output gate passed for step "${step.id}", but the session is still running ` +
				"and the selected adapter does not support cancellation. Refusing to mark " +
				"the step successful because that would orphan a live subagent.",
		};
	}

	const cancelResult = await adapter
		.cancel(spawnResult.sessionId, {
			...options,
			sessionKey: spawnResult.sessionKey,
			runId: spawnResult.sessionId,
			reason: `workflow_output_complete:${step.id}`,
			cancelGraceMs,
		})
		.catch((err) => ({
			requested: false,
			confirmed: false,
			error: err instanceof Error ? err.message : String(err),
		}));

	const stopped = await waitForTerminalAfterCancel(
		adapter,
		spawnResult.sessionId,
		options,
		cancelGraceMs,
		pollIntervalMs,
	);

	if (stopped) {
		return {
			settled: true,
			statusResult,
			cancelResult,
			stopped,
			error: null,
		};
	}

	return {
		settled: false,
		statusResult,
		cancelResult,
		stopped: null,
		error:
			`Output gate passed for step "${step.id}", but subagent stop after output completion was not confirmed. ` +
			`Cancel result: ${cancelResult?.error || cancelResult?.method || "unknown"}`,
	};
}

/**
 * Request cancellation of a step session using the appropriate adapter.
 *
 * @param {Object} api - OpenClaw plugin api object
 * @param {Object} options - Cancellation options
 * @returns {Promise<CancelResult>}
 */
export async function cancelStepSession(api, options): Promise<CancelResult> {
	const {
		sessionAdapter = "auto",
		sessionId,
		sessionKey,
		runId,
		reason,
		logger = console,
		cronRunTimeoutMs,
	} = options;

	const adapter = selectAdapter(api, sessionAdapter);

	if (!adapter.cancel) {
		return {
			requested: false,
			confirmed: false,
			error: `Adapter ${sessionAdapter} does not support cancel`,
		};
	}

	return adapter.cancel(sessionId, {
		sessionKey,
		runId: sessionId || runId,
		reason,
		timeoutMs: options.timeoutMs,
		cancelGraceMs: options.cancelGraceMs,
	});
}

/**
 * Run a single workflow step as an isolated subagent and wait for completion.
 *
 * Flow:
 *   1. Select the appropriate SessionAdapter based on what's available in `api`
 *   2. Spawn the step session with the substituted task prompt
 *   3. Poll until done or timeout
 *   4. Check output files (if any defined)
 *   5. Return result
 *
 * @param {import('./workflow-loader.js').WorkflowStep} step - The step to execute
 * @param {string}        runId    - Current workflow run ID (for logging)
 * @param {Object}        api      - OpenClaw plugin api object
 * @param {StepRunOptions} options - Execution options
 * @returns {Promise<StepRunResult>}
 *
 * @example
 * const result = await runStep(
 *   { id: 'tech-auditor', task: 'Run SEO audit...', timeout: 420 },
 *   'seo-pipeline-20260309T082000',
 *   api,
 *   { pollIntervalMs: 5000, baseDir: '/workspace' }
 * );
 */
export async function runStep(step, runId, api, options) {
	const {
		pollIntervalMs = 5000,
		baseDir = process.cwd(),
		defaultModel,
		cancelled,
		cronDeliveryMode = "none",
		cronDeliveryChannel,
		cronDeliveryTo,
		cliTimeoutMs,
		cronAddTimeoutMs,
		cronRunTimeoutMs,
		cronPollTimeoutMs,
		validators = {},
		workflowDir = "",
		artifactStore = null,
		filesystemFallback = true,
		attempts,
		handoffToken,
		runStartedAtMs,
		acceptPreviousAttemptOutputs = true,
		injectedContext = {},
		injectedContextLogs = [],
	} = options;

	const runOutputCheck = async () => {
		if (artifactStore && runId && step?.id) {
			return checkStepContract({
				outputs: step.outputs,
				validators,
				artifactStore,
				runId,
				stepId: step.id,
				baseDir,
				workflowDir,
				filesystemFallback,
			});
		}

		return checkOutputs(step.outputs, baseDir, validators, workflowDir);
	};

	if (cancelled) {
		return {
			status: "failed",
			session_key: null,
			output_check: emptyOutputCheck(),
			error: "Step was cancelled",
			logs: null,
			duration_ms: 0,
		};
	}

	const startTime = Date.now();
	let sessionKey = null;
	let sealedRunKey: string | null = null;

	try {
		const model = step.model || defaultModel || null;
		const sealed =
			(options as any).sealed ||
			(step.kind === "sealed" ? normalizeSealedSpec(step.sealed) : undefined);
		assertRuntimeSealedCapabilities(api, step, sealed);
		const adapter = selectAdapter(
			api,
			options.sessionAdapter || "auto",
			requiresSealedRuntime(step, sealed)
				? REQUIRED_SEALED_RUNTIME_CAPABILITIES
				: undefined,
			`Cannot run step "${step.id}"`,
		);

		const workflow = options.workflow;
		const combinedSkills = [
			...(workflow?.required_skills ?? []),
			...(step.required_skills ?? []),
		];
		const uniqueRequiredSkills = [...new Set(combinedSkills)];

		const uniqueRequiredMcpServers = filterSubagentMcpServers({
			workflow,
			step,
		});

		// Only OpenClaw skills are checked against the agent skill allowlist.
		// MCP server names such as MCP_DOCKER are validated/used by the MCP layer,
		// not by the OpenClaw skill registry.
		assertSkillsNotConfigBlocked(api.config, uniqueRequiredSkills);
		assertMcpServersConfigured(api.config, uniqueRequiredMcpServers);

		const skillContract = uniqueRequiredSkills.length
			? `\nRequired skills for this step: ${uniqueRequiredSkills.join(", ")}.\n\nUse these skills directly when relevant.\nDo not substitute host shell commands for these skills.\nIf a required skill is unavailable, write the declared blocked/retryable output artifact explaining which skill was unavailable.\n`
			: "";
		const mcpContract = uniqueRequiredMcpServers.length
			? `\nExternal tools required for this step are available.\n\nUse external tools only when the task explicitly requires them.\nIf a required external capability is unavailable, produce the declared blocked/retryable output artifact explaining what capability was unavailable.\n`
			: "";
		const isolatedStepBoundaryPreamble = buildIsolatedStepBoundaryPreamble({
			workflow,
			step,
		});
		const signalingPreamble = buildWorkflowSignalingPreamble({
			step,
			runId,
			attempts,
			handoffToken,
		});
		const injectedContextPreamble =
			buildInjectedContextPreamble(injectedContext);
		const writeOutputPreamble = buildWriteOutputPreamble({
			step,
			validators,
			workflowDir,
			runId,
			stepId: step.id,
			attempts,
			handoffToken,
		});
		const taskWithPreamble =
			EXEC_POLL_PREAMBLE +
			writeOutputPreamble +
			skillContract +
			mcpContract +
			isolatedStepBoundaryPreamble +
			signalingPreamble +
			injectedContextPreamble +
			step.task;

		assertAdapterCanRunSealedToolWorker(adapter, step, sealed);

		const spawnResult = await adapter.spawn(taskWithPreamble, {
			model,
			timeout: step.timeout,
			sessionTarget: "isolated",
			label: `wf:${runId}:${step.id}`,
			inputContext: injectedContext,
			sealed,
			resultPolicy: sealed?.tool_result_policy,
			transcriptPolicy: sealed?.context_firewall,
			artifactSink: buildSealedArtifactSink({
				sealed,
				artifactStore,
				runId,
				stepId: step.id,
			}),
			cronDeliveryMode,
			cronDeliveryChannel,
			cronDeliveryTo,
			cliTimeoutMs,
			cronAddTimeoutMs,
			cronRunTimeoutMs,
			cronPollTimeoutMs,
		});
		sessionKey = spawnResult.sessionKey;

		if (sealed && artifactStore) {
			const maxPreviewBytes =
				typeof sealed?.tool_result_policy?.max_context_injection_bytes ===
				"number"
					? Math.max(64, sealed.tool_result_policy.max_context_injection_bytes)
					: ((api.config as any)?.sealedMaxPreviewBytes ?? 2048);
			sealedRunKey = sessionKey;
			const activeRun = {
				artifactStore,
				runId,
				stepId: step.id,
				maxPreviewBytes,
			};
			activeSealedRuns.set(`sessionKey:${sessionKey}`, activeRun);
			if (spawnResult.sessionId) {
				activeSealedRuns.set(`sessionId:${spawnResult.sessionId}`, activeRun);
			}
			if (runId) {
				activeSealedRuns.set(`runId:${runId}`, activeRun);
			}
			if (runId && step.id) {
				activeSealedRuns.set(`runStep:${runId}:${step.id}`, activeRun);
			}
		}

		if (options.onSpawn) {
			try {
				await options.onSpawn({
					stepId: step.id,
					runId,
					sessionId: spawnResult.sessionId,
					sessionKey: spawnResult.sessionKey,
					sessionAdapter: options.sessionAdapter || "auto",
					spawnedAt: getLocalISOString(),
				});
			} catch (err) {
				const cancelErr = await adapter
					.cancel?.(spawnResult.sessionId, {
						sessionKey: spawnResult.sessionKey,
						runId: spawnResult.sessionId,
						reason: `workflow_spawn_metadata_persist_failed:${step.id}`,
					})
					.catch(() => ({ requested: false }));

				return {
					status: "failed",
					retryable: false,
					session_key: spawnResult.sessionKey,
					output_check: emptyOutputCheck(),
					error: `Spawned session but failed to persist cancellation metadata: ${
						err instanceof Error ? err.message : String(err)
					}`,
					logs: null,
					duration_ms: Date.now() - startTime,
				};
			}
		}

		const timeoutMs = step.timeout * 1000;
		const deadline = Date.now() + timeoutMs;
		let finalStatus = null;
		let retryable = false;
		let failureKind: string | null = null;
		let errorMsg = null;
		let logs = null;
		let cancelResult: CancelResult | null = null;
		let outputCheck: OutputCheckResult = {
			passed: false,
			decision: "unknown" as any,
			missing_files: [],
			checked_files: [],
			validations: [],
		};

		while (Date.now() < deadline) {
			await sleep(pollIntervalMs);
			const liveStepState =
				typeof options.getStepState === "function"
					? options.getStepState()
					: null;

			if (usesOutputCompletion(step)) {
				outputCheck = await runOutputCheck();

				if (outputCheck.passed) {
					const hasCurrentAttemptProvenance =
						outputCheckHasCurrentAttemptProvenance({
							stepState: liveStepState,
							outputCheck,
							runId,
							stepId: step.id,
							attempt: attempts,
						});

					const hasSameRunOutput =
						acceptPreviousAttemptOutputs &&
						outputWasProducedDuringThisRun({
							outputCheck,
							runStartedAtMs,
							stepFirstStartedAtMs: liveStepState?.first_started_at_ms,
						});

					if (hasCurrentAttemptProvenance || hasSameRunOutput) {
						const mapped = statusFromOutputDecision(outputCheck);
						finalStatus = mapped.finalStatus;
						retryable = mapped.retryable;
						errorMsg = mapped.errorMsg;
						break;
					}
				}

				if (
					outputCheck.decision === "blocked" ||
					outputCheck.decision === "retry"
				) {
					if (
						outputCheckHasCurrentAttemptProvenance({
							stepState: liveStepState,
							outputCheck,
							runId,
							stepId: step.id,
							attempt: attempts,
						})
					) {
						const mapped = statusFromOutputDecision(outputCheck);
						finalStatus = mapped.finalStatus;
						retryable = mapped.retryable;
						errorMsg = mapped.errorMsg;
						failureKind = outputFailureKinds(outputCheck)[0] ?? null;
						break;
					}
				}

				// Non-terminal while running: parse/schema/fail artifacts can be repaired,
				// and valid direct writes without current-attempt provenance must not short-circuit.
			}

			const statusResult = await adapter.getStatus(
				spawnResult.sessionId,
				options,
			);

			if (statusResult.status === "done") {
				logs = statusResult.logs;

				outputCheck = await runOutputCheck();

				const mapped = statusFromOutputDecision(outputCheck);

				if (mapped.finalStatus === "ok" || mapped.finalStatus === "blocked") {
					finalStatus = mapped.finalStatus;
					retryable = mapped.retryable;
					errorMsg = mapped.errorMsg;
					break;
				}

				finalStatus = mapped.finalStatus;
				retryable = mapped.retryable;
				errorMsg = mapped.errorMsg;
				break;
			}
			if (statusResult.status === "error") {
				outputCheck = await runOutputCheck();
				finalStatus = "failed";
				errorMsg = statusResult.error || "Step session exited with error";
				logs = statusResult.logs;
				break;
			}
		}

		if (finalStatus === "ok" || finalStatus === null) {
			outputCheck = await runOutputCheck();
		}

		if (finalStatus === null) {
			cancelResult = await (
				adapter.cancel?.(spawnResult.sessionId, {
					...options,
					sessionKey: spawnResult.sessionKey,
					runId: spawnResult.sessionId,
					reason: `workflow_step_timeout:${step.id}`,
					timeoutMs,
					cancelGraceMs: options.cancelGraceMs ?? 30000,
				}) ?? Promise.resolve(null)
			).catch(
				(err): CancelResult =>
					({
						requested: false,
						confirmed: false,
						error: err instanceof Error ? err.message : String(err),
					}) as CancelResult,
			);

			const stopped = await waitForTerminalAfterCancel(
				adapter,
				spawnResult.sessionId,
				options,
				options.cancelGraceMs ?? 30000,
				pollIntervalMs,
			);

			finalStatus = "failed";

			const stopConfirmed = Boolean(cancelResult?.confirmed || stopped);
			const stopRequested = Boolean(cancelResult?.requested);

			failureKind = stopConfirmed
				? "timeout_stop_confirmed"
				: "timeout_stop_unconfirmed";

			// Default retryable: timeout failures are retryable when the workflow step has attempts left.
			// The executor will still enforce step.retry and retry_except.
			retryable = true;

			errorMsg = stopConfirmed
				? `Step timed out after ${step.timeout}s; subagent stop after timeout was confirmed via ${cancelResult?.method || "unknown"}`
				: `Step timed out after ${step.timeout}s; subagent stop after timeout was not confirmed. Previous subagent may still be running. Stop result: ${stopRequested ? "requested" : "not_requested"}`;

			logs = stopped?.logs || null;
		} else if (finalStatus === "ok") {
			const mapped = statusFromOutputDecision(outputCheck);
			finalStatus = mapped.finalStatus;
			retryable = mapped.retryable;
			errorMsg = mapped.errorMsg;
		}

		return {
			status: finalStatus,
			retryable,
			failure_kind: failureKind,
			session_key: sessionKey,
			output_check: outputCheck,
			error: errorMsg,
			logs: logs,
			duration_ms: Date.now() - startTime,
			cancel_result: cancelResult,
		};
	} catch (err) {
		return {
			status: "failed",
			session_key: sessionKey,
			output_check: emptyOutputCheck(),
			error: err.message,
			logs: null,
			duration_ms: Date.now() - startTime,
		};
	} finally {
		if (sealedRunKey) activeSealedRuns.delete(sealedRunKey);
	}
}

/**
 * Sanitizes a string for use in a session key.
 * @param {any} value
 * @returns {string}
 */
function safeSessionKeyPart(value) {
	return String(value || "")
		.replace(/[^a-zA-Z0-9:_-]/g, "_")
		.slice(0, 120);
}

function configuredSkillVisibility(
	cfg: any,
	agentId = "main",
): string[] | null {
	const agent = cfg?.agents?.list?.find((a: any) => a.id === agentId);

	if (Array.isArray(agent?.skills)) {
		return agent.skills; // final set
	}

	if (Array.isArray(cfg?.agents?.defaults?.skills)) {
		return cfg.agents.defaults.skills; // inherited baseline
	}

	return null; // unrestricted by config
}

function assertSkillsNotConfigBlocked(
	cfg: any,
	required: string[],
	agentId = "main",
) {
	const visible = configuredSkillVisibility(cfg, agentId);

	if (visible === null) return; // unrestricted by config

	for (const skill of required) {
		if (!visible.includes(skill)) {
			throw new Error(
				`Required skill "${skill}" is blocked by configured agent skill allowlist.`,
			);
		}
	}
}

function assertMcpServersConfigured(cfg: any, requiredMcpServers: string[]) {
	if (!requiredMcpServers.length) return;

	const configuredServers = cfg?.mcp?.servers ?? {};
	const missing = requiredMcpServers.filter(
		(name) => !Object.hasOwn(configuredServers, name),
	);

	if (missing.length) {
		throw new Error(
			`Required MCP server(s) not configured under mcp.servers: ${missing.join(", ")}`,
		);
	}
}

/**
 * Splits a model reference (e.g., "openai/gpt-4") into provider and model.
 * @param {string} modelRef
 * @returns {{provider?: string, model?: string}}
 */
function splitModelRef(modelRef) {
	if (!modelRef || typeof modelRef !== "string") return {};

	const slash = modelRef.indexOf("/");
	if (slash <= 0) {
		return { model: modelRef };
	}

	return {
		provider: modelRef.slice(0, slash),
		model: modelRef.slice(slash + 1),
	};
}

/**
 * @class RuntimeSubagentAdapter
 * @description Uses the modern OpenClaw Runtime SDK (api.runtime.subagent) to
 * launch and manage isolated subagent runs.
 */
class RuntimeSubagentAdapter implements SessionAdapter {
	capabilities: SessionAdapterCapabilities;
	runtime: any;
	api: any;
	subagent: any;
	logger: any;
	sessionsByRunId: Map<string, { sessionKey: string }>;

	/**
	 * @param {Object} runtime - api.runtime object
	 * @param {Object} api - full api object
	 * @param {Object} [logger=console] - Plugin logger
	 */
	constructor(runtime, api, logger = console) {
		this.runtime = runtime;
		this.api = api;
		this.subagent = runtime.subagent;
		this.logger = logger;
		this.capabilities = {
			toolResultInterception: true,
			transcriptFirewall: true,
			artifactSink: true,
			abortRun: true,
		};
		this.sessionsByRunId = new Map();
	}

	/**
	 * @param {string} prompt - Task prompt
	 * @param {Object} options - Spawn options (model, timeout, label, etc.)
	 * @returns {Promise<{ sessionId: string, sessionKey: string }>}
	 */
	async spawn(prompt: string, options: SpawnOptions = {}) {
		const label = options.label || `workflow-${Date.now()}`;
		const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

		const sessionKey =
			options.sessionKey ||
			`agent:main:subagent:${safeSessionKeyPart(label)}:${unique}`;

		const modelFields = splitModelRef(options.model);

		const args = {
			sessionKey,
			message: prompt,
			deliver: false,
			...modelFields,
			timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
			sealed: options.sealed,
			resultPolicy: options.resultPolicy,
			transcriptPolicy: options.transcriptPolicy,
			artifactSink: options.artifactSink,
		};

		const result = await this.subagent.run(args);

		if (!result?.runId) {
			throw new Error(
				`RuntimeSubagentAdapter: subagent.run did not return runId: ${JSON.stringify(result)}`,
			);
		}

		this.sessionsByRunId.set(result.runId, { sessionKey });

		return {
			sessionId: result.runId,
			sessionKey,
		};
	}

	/**
	 * @param {string} runId - Run ID returned by spawn()
	 * @param {Object} [options] - Polling options
	 * @returns {Promise<{ status: string, error?: string, logs?: string }>}
	 */
	async getStatus(runId: string, options: any = {}) {
		try {
			const timeoutMs = Math.min(
				Math.max(options.pollIntervalMs || 1000, 250),
				5000,
			);

			const result = await this.subagent.waitForRun({
				runId,
				timeoutMs,
			});

			const status = result?.status || result?.state;

			if (
				status === "cancelled" ||
				status === "canceled" ||
				status === "aborted" ||
				status === "stopped"
			) {
				return {
					status: "error",
					error:
						result?.error || result?.message || "Subagent run was cancelled",
					logs: result?.logs || result?.summary || null,
				};
			}

			if (
				status === "ok" ||
				status === "done" ||
				status === "success" ||
				status === "completed"
			) {
				return {
					status: "done",
					logs: result?.logs || result?.summary || null,
				};
			}

			if (status === "error" || status === "failed") {
				return {
					status: "error",
					error: result?.error || result?.message || "Subagent run failed",
					logs: result?.logs || result?.summary || null,
				};
			}

			return {
				status: "running",
				logs: result?.logs || result?.summary || null,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			if (
				message.toLowerCase().includes("timeout") ||
				message.toLowerCase().includes("timed out")
			) {
				return { status: "running" };
			}

			return {
				status: "error",
				error: `Failed to wait for subagent run: ${message}`,
			};
		}
	}

	async cancel(runId: string, options: any = {}) {
		const record = this.sessionsByRunId.get(runId);
		const sessionKey = options.sessionKey || record?.sessionKey;
		const reason = options.reason || "workflow_step_cancelled";

		if (!sessionKey) {
			return {
				requested: false,
				confirmed: false,
				error: `Cannot cancel run ${runId}: missing sessionKey`,
			};
		}

		const attempts: { method: string; fn: () => Promise<any> }[] = [
			{
				method: "runtime.subagent.abortRun",
				fn: () =>
					this.runtime?.subagent?.abortRun?.({
						runId,
						sessionKey,
						reason,
					}),
			},
			{
				method: "runtime.subagent.cancel",
				fn: () =>
					this.runtime?.subagent?.cancel?.({
						runId,
						sessionKey,
						reason,
					}),
			},
			{
				method: "api.sessions.abort(object)",
				fn: () =>
					this.api?.sessions?.abort?.({
						runId,
						sessionKey,
						reason,
					}),
			},
			{
				method: "api.sessions.abort(sessionKey)",
				fn: () =>
					this.api?.sessions?.abort?.(sessionKey, {
						runId,
						reason,
					}),
			},
			{
				method: "gateway.sessions.abort",
				fn: () =>
					this.runtime?.gateway?.request?.("sessions.abort", {
						runId,
						sessionKey,
						reason,
					}),
			},
			{
				method: "gateway.chat.abort",
				fn: () =>
					this.runtime?.gateway?.request?.("chat.abort", {
						sessionKey,
						reason,
					}),
			},
			{
				method: "gateway.call.sessions.abort",
				fn: () =>
					this.runtime?.gateway?.call?.("sessions.abort", {
						runId,
						sessionKey,
						reason,
					}),
			},
			{
				method: "gateway.call.chat.abort",
				fn: () =>
					this.runtime?.gateway?.call?.("chat.abort", {
						sessionKey,
						reason,
					}),
			},
		];

		let lastError = null;

		for (const attempt of attempts) {
			if (typeof attempt.fn !== "function") continue;

			try {
				const result = await attempt.fn();
				if (result !== undefined || attempt.method.includes("abort")) {
					this.logger?.warn?.("[workflow] requested subagent cancellation", {
						runId,
						sessionKey,
						method: attempt.method,
						reason,
					});

					return {
						requested: true,
						confirmed: false,
						method: attempt.method,
					};
				}
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				this.logger?.warn?.("[workflow] subagent cancel attempt failed", {
					runId,
					sessionKey,
					method: attempt.method,
					error: lastError,
				});
			}
		}

		return {
			requested: false,
			confirmed: false,
			error:
				lastError ||
				"No documented abort-capable runtime/gateway method was available. Do not retry this step automatically.",
		};
	}
}

/**
 * Select the best available session adapter.
 * Prefers the modern Runtime SDK, falls back to legacy ApiAdapter, then CliAdapter.
 *
 * @param {Object} api - OpenClaw plugin api object
 * @returns {SessionAdapter}
 */
/**
 * Select the best available session adapter.
 *
 * @param {Object} api - OpenClaw plugin api object
 * @param {string} [requestedAdapter="auto"] - The adapter to use
 * @returns {SessionAdapter}
 */
function selectAdapter(
	api,
	requestedAdapter = "auto",
	requiredCapabilities?: Partial<SessionAdapterCapabilities>,
	errorContext = "Cannot select session adapter",
): SessionAdapter {
	const logger = api?.logger;

	const hasRuntimeSubagent =
		api?.runtime?.subagent &&
		typeof api.runtime.subagent.run === "function" &&
		typeof api.runtime.subagent.waitForRun === "function";

	const hasLegacyApi =
		api?.sessions &&
		typeof api.sessions.spawn === "function" &&
		typeof api.sessions.getStatus === "function";

	logger?.info?.("[workflow] selectAdapter capability check", {
		requestedAdapter,
		hasRuntimeSubagent,
		hasLegacyApi,
	});

	if (requestedAdapter !== "auto") {
		const allowed = new Set(["auto", "runtime-subagent", "legacy-api", "cli"]);
		if (!allowed.has(requestedAdapter)) {
			throw new Error(
				`Invalid sessionAdapter "${requestedAdapter}". Expected auto, runtime-subagent, legacy-api, or cli.`,
			);
		}
	}

	const candidates: Array<{
		name: string;
		available: boolean;
		create: () => SessionAdapter;
		unavailableMessage?: string;
	}> =
		requestedAdapter === "runtime-subagent"
			? [
					{
						name: "runtime-subagent",
						available: hasRuntimeSubagent,
						create: () => new RuntimeSubagentAdapter(api.runtime, api, logger),
						unavailableMessage:
							"sessionAdapter=runtime-subagent requested, but api.runtime.subagent.run/waitForRun is unavailable",
					},
				]
			: requestedAdapter === "legacy-api"
				? [
						{
							name: "legacy-api",
							available: hasLegacyApi,
							create: () => new ApiAdapter(api.sessions),
							unavailableMessage:
								"sessionAdapter=legacy-api requested, but api.sessions.spawn/getStatus is unavailable",
						},
					]
				: requestedAdapter === "cli"
					? [
							{
								name: "cli",
								available: true,
								create: () => new CliAdapter(),
							},
						]
					: [
							{
								name: "runtime-subagent",
								available: hasRuntimeSubagent,
								create: () =>
									new RuntimeSubagentAdapter(api.runtime, api, logger),
							},
							{
								name: "legacy-api",
								available: hasLegacyApi,
								create: () => new ApiAdapter(api.sessions),
							},
							{
								name: "cli",
								available: true,
								create: () => new CliAdapter(),
							},
						];

	const capabilityErrors: string[] = [];

	for (const candidate of candidates) {
		if (!candidate.available) {
			if (candidate.unavailableMessage) {
				throw new Error(candidate.unavailableMessage);
			}
			continue;
		}

		const adapter = candidate.create();
		const missing = requiredCapabilities
			? missingAdapterCapabilities(adapter, requiredCapabilities)
			: [];

		if (missing.length > 0) {
			capabilityErrors.push(
				`${candidate.name}: missing ${missing.map(formatCapabilityName).join(", ")}`,
			);
			continue;
		}

		if (candidate.name === "runtime-subagent") {
			logger?.info?.("[workflow] using RuntimeSubagentAdapter");
		} else if (candidate.name === "legacy-api") {
			logger?.info?.("[workflow] using legacy ApiAdapter");
		} else {
			logger?.warn?.(
				requestedAdapter === "cli"
					? "[workflow] using CliAdapter because sessionAdapter=cli"
					: "[workflow] using CliAdapter fallback; steps will run through cron",
			);
		}

		return adapter;
	}

	if (capabilityErrors.length > 0) {
		throw new Error(`${errorContext}: ${capabilityErrors.join("; ")}`);
	}

	throw new Error(
		`${errorContext}: no compatible session adapter is available.`,
	);
}

/**
 * @typedef {Object} CancelResult
 * @property {boolean} requested
 * @property {boolean} [confirmed]
 * @property {string} [method]
 * @property {string} [error]
 */

/**
 * @interface SessionAdapter
 * Common interface for all session adapters.
 *
 * @property {Function} spawn - spawn(prompt, options) → Promise<{ sessionId, sessionKey }>
 * @property {Function} getStatus - getStatus(sessionId, options) → Promise<{ status: 'running'|'done'|'error', error?, logs? }>
 * @property {Function} [cancel] - cancel(sessionId, options) → Promise<CancelResult>
 */

/**
 * @class ApiAdapter
 * @description Uses the OpenClaw native sessions API (api.sessions).
 * This is the preferred path when OpenClaw exposes it.
 *
 * Expected api.sessions interface:
 *   spawn(prompt, options) → Promise<{ sessionId, sessionKey }>
 *   getStatus(sessionId)   → Promise<{ status: 'running'|'done'|'error', error? }>
 */
class ApiAdapter implements SessionAdapter {
	capabilities: SessionAdapterCapabilities;
	sessions: any;

	/**
	 * @param {Object} sessions - api.sessions object from OpenClaw
	 */
	constructor(sessions) {
		this.sessions = sessions;
		this.capabilities = {
			toolResultInterception: true,
			transcriptFirewall: true,
			artifactSink: true,
			abortRun: typeof sessions?.abort === "function",
		};
	}

	/**
	 * @param {string} prompt  - Task prompt for the subagent
	 * @param {Object} options - Spawn options (model, timeout, label, etc.)
	 * @returns {Promise<{ sessionId: string, sessionKey: string }>}
	 */
	async spawn(prompt: string, options: any) {
		return await this.sessions.spawn(prompt, options);
	}

	/**
	 * @param {string} sessionId - Session ID returned by spawn()
	 * @returns {Promise<{ status: string, error?: string }>}
	 */
	async getStatus(sessionId: string, options: any) {
		const status = await this.sessions.getStatus(sessionId);
		return {
			status: status.status === "done" ? "done" : status.status,
			error: status.error,
			logs: status.logs,
		};
	}

	async cancel(sessionId: string, options: any = {}) {
		const sessionKey = options.sessionKey;

		if (typeof this.sessions.abort === "function") {
			await this.sessions.abort({
				sessionId,
				runId: options.runId || sessionId,
				sessionKey,
				reason: options.reason || "workflow_step_cancelled",
			});

			return {
				requested: true,
				confirmed: false,
				method: "api.sessions.abort",
			};
		}

		return {
			requested: false,
			confirmed: false,
			error: "api.sessions.abort unavailable",
		};
	}
}

/**
 * @class CliAdapter
 * @description Spawns subagent sessions via the OpenClaw CLI using one-shot
 * cron jobs. Works with any OpenClaw installation where `openclaw` is in PATH.
 *
 * ## Approach
 * Since `openclaw sessions spawn` is not exposed as a CLI command, this adapter
 * uses the cron subsystem as a session-spawning mechanism:
 *   1. `openclaw cron add --at 5s --session isolated --message "..."`
 *      creates a one-shot job and returns its job ID.
 *   2. `openclaw cron run <id>` triggers it immediately.
 *   3. `openclaw cron runs --id <id>` polls for the run result.
 *   4. `openclaw cron remove <id>` cleans up after completion.
 *
 * The spawn() call returns immediately with the cron job ID as the sessionId.
 * getStatus() polls the cron run history to detect completion.
 *
 * ## Exec yieldMs note
 * Step task prompts are wrapped with exec-poll instructions (see EXEC_POLL_PREAMBLE)
 * so the spawned agent correctly handles bash commands that take >10s (the default
 * exec yieldMs) by polling via the process tool rather than seeing empty output.
 */
function stripAnsi(input) {
	return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseCronRunsOutput(raw) {
	const text = stripAnsi(raw || "").trim();
	if (!text) return [];

	// 1. Try whole output as JSON.
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) return parsed;
		if (Array.isArray(parsed.entries)) return parsed.entries;
		return [parsed];
	} catch {}

	// 2. Try extracting the outer JSON object from noisy CLI output.
	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");

	if (firstBrace >= 0 && lastBrace > firstBrace) {
		const jsonSlice = text.slice(firstBrace, lastBrace + 1);
		try {
			const parsed = JSON.parse(jsonSlice);
			if (Array.isArray(parsed)) return parsed;
			if (Array.isArray(parsed.entries)) return parsed.entries;
			return [parsed];
		} catch {}
	}

	// 3. JSONL fallback.
	const entries = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;

		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed.entries)) entries.push(...parsed.entries);
			else entries.push(parsed);
		} catch {}
	}

	return entries;
}

export class CliAdapter implements SessionAdapter {
	capabilities: SessionAdapterCapabilities;
	executor: any;
	_jobs: Map<string, { status: string }> | null = null;

	/**
	 * @param {Function} [executor] - Optional function to execute OpenClaw commands.
	 * Defaults to the module-level `runOpenClaw`.
	 */
	constructor(executor = runOpenClaw) {
		this.executor = executor;
		this.capabilities = {
			toolResultInterception: false,
			transcriptFirewall: false,
			artifactSink: false,
			abortRun: true,
		};
	}

	/**
	 * @param {string} prompt  - Task prompt
	 * @param {Object} options - Options (model, timeout, label)
	 * @returns {Promise<{ sessionId: string, sessionKey: string }>}
	 */
	async spawn(prompt: string, options: any) {
		this._jobs = this._jobs || new Map();
		const {
			cliTimeoutMs = 120000,
			cronAddTimeoutMs = 120000,
			cronRunTimeoutMs = 60000,
		} = options;

		const args = [
			"cron",
			"add",
			"--at",
			"5s",
			"--session",
			"isolated",
			"--message",
			prompt,
			"--delete-after-run",
		];

		if (options.cronDeliveryMode === "announce") {
			args.push("--announce");
			args.push("--channel", options.cronDeliveryChannel || "discord");
			if (options.cronDeliveryTo) {
				args.push("--to", options.cronDeliveryTo);
			}
		} else {
			// Default to 'none'
			args.push("--no-deliver");
		}

		if (options.model) {
			args.push("--model", options.model);
		}
		if (options.label) {
			args.push("--name", options.label);
		}

		let jobId;
		try {
			const { stdout } = await this.executor(args, {
				timeout: cronAddTimeoutMs,
			});
			const parsed = JSON.parse(stdout.trim());
			jobId = parsed.id || parsed.job?.id;
			if (!jobId) throw new Error(`Unexpected cron add output: ${stdout}`);
		} catch (err) {
			throw new Error(`CliAdapter: cron add failed — ${err.message}`);
		}

		// Trigger the job immediately
		try {
			await this.executor(["cron", "run", jobId], {
				timeout: cronRunTimeoutMs,
			});
		} catch (err) {
			// Non-fatal — the job may already be queued to run in 5s
		}

		this._jobs.set(jobId, { status: "running" });
		return { sessionId: jobId, sessionKey: `cli-cron:${jobId}` };
	}

	/**
	 * Poll the cron run history to check if the one-shot job has completed.
	 *
	 * @param {string} sessionId - The cron job ID returned by spawn()
	 * @param {Object} [options] - Options including cronPollTimeoutMs
	 * @returns {Promise<{ status: string, error?: string }>}
	 */
	async getStatus(sessionId: string, options: any = {}) {
		const { cronPollTimeoutMs = 60000 } = options;
		const jobId = sessionId;
		try {
			const { stdout, stderr } = await this.executor(
				["cron", "runs", "--id", jobId, "--limit", "5"],
				{ timeout: cronPollTimeoutMs },
			);

			const entries = parseCronRunsOutput(`${stdout}\n${stderr}`);

			if (!entries.length) {
				return { status: "running" };
			}

			const matching = entries.filter((entry) => {
				return (
					entry.jobId === jobId || entry.id === jobId || entry.job_id === jobId
				);
			});

			const entry = matching.at(-1) || entries.at(-1);

			if (!entry) {
				return { status: "running" };
			}

			const logs =
				entry.logs || entry.stdout || entry.stderr || entry.summary || null;

			const isFinished =
				entry.action === "finished" ||
				["ok", "success", "error", "failed"].includes(entry.status);

			if (!isFinished) {
				return { status: "running", logs };
			}

			this.executor(["cron", "remove", jobId]).catch(() => {});

			if (entry.status === "ok" || entry.status === "success") {
				return { status: "done", logs };
			}

			return {
				status: "error",
				error:
					entry.error ||
					entry.summary ||
					`Cron run finished with status: ${entry.status}`,
				logs,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			if (message.includes("not found") || message.includes("404")) {
				return { status: "done" };
			}

			return {
				status: "error",
				error: `Failed to poll cron run status: ${message}`,
			};
		}
	}

	async cancel(sessionId: string, options: any = {}) {
		const jobId = sessionId;

		try {
			await this.executor(["cron", "remove", jobId], {
				timeout: options.cronRunTimeoutMs || 60000,
			});

			return {
				requested: true,
				confirmed: false,
				method: "cron.remove",
			};
		} catch (err) {
			return {
				requested: false,
				confirmed: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}

/**
 * @class MockAdapter
 * @description Adapter for testing — resolves or rejects based on configuration.
 * Simulates a short delay to mimic real session execution.
 *
 * @example
 * const adapter = new MockAdapter({ resolveIn: 100, shouldFail: false });
 * // Steps using this adapter will complete in 100ms
 */
export class MockAdapter implements SessionAdapter {
	capabilities: SessionAdapterCapabilities;
	resolveIn: number;
	shouldFail: boolean;
	failMessage: string;
	_sessions: Map<string, any>;
	_counter: number;

	/**
	 * @param {Object} options
	 * @param {number}  [options.resolveIn=100]    - Simulated duration in ms
	 * @param {boolean} [options.shouldFail=false] - Whether the session should fail
	 * @param {string}  [options.failMessage]      - Error message if shouldFail is true
	 */
	constructor(options: MockAdapterOptions = {}) {
		this.resolveIn = options.resolveIn ?? 100;
		this.shouldFail = options.shouldFail ?? false;
		this.failMessage = options.failMessage || "Mock step failure";
		this.capabilities = {
			toolResultInterception: true,
			transcriptFirewall: true,
			artifactSink: true,
			abortRun: false,
		};
		this._sessions = new Map();
		this._counter = 0;
	}

	async spawn(prompt: string, options: any) {
		const sessionId = `mock-session-${++this._counter}`;
		const sessionKey = `agent:mock:subagent:${sessionId}`;

		// Schedule completion after resolveIn ms
		const result: { status: string; error?: string } = {
			status: this.shouldFail ? "error" : "done",
		};
		if (this.shouldFail) result.error = this.failMessage;

		setTimeout(() => {
			this._sessions.set(sessionId, result);
		}, this.resolveIn);

		this._sessions.set(sessionId, { status: "running" });
		return { sessionId, sessionKey };
	}

	async getStatus(sessionId: string) {
		return this._sessions.get(sessionId) || { status: "running" };
	}
}

/**
 * Create a step runner function bound to a specific adapter.
 * This is the primary injection point for swapping adapters in tests.
 *
 * @param {Object} adapter - A SessionAdapter instance
 * @returns {Function} A runStep-compatible function using the provided adapter
 *
 * @example
 * const mockRunner = createStepRunner(new MockAdapter({ resolveIn: 50 }));
 * const result = await mockRunner(step, runId, api, options);
 */
export function createStepRunner(adapter) {
	return async function runStepWithAdapter(step, runId, _api, options) {
		const {
			pollIntervalMs = 5000,
			baseDir = process.cwd(),
			cancelled,
			validators = {},
			workflowDir = "",
		} = options;
		if (cancelled) {
			return {
				status: "failed",
				session_key: null,
				output_check: emptyOutputCheck(),
				error: "Step was cancelled",
				duration_ms: 0,
			};
		}
		const startTime = Date.now();
		let sessionKey = null;
		let failureKind: string | null = null;
		let sealedRunKey: string | null = null;

		try {
			const model = step.model || options.defaultModel || null;
			const sealed =
				(options as any).sealed ||
				(step.kind === "sealed" ? normalizeSealedSpec(step.sealed) : undefined);
			assertRuntimeSealedCapabilities(_api, step, sealed);
			assertAdapterCanRunSealedToolWorker(adapter, step, sealed);
			const signalingPreamble = buildWorkflowSignalingPreamble({
				step,
				runId,
				attempts: options.attempts,
				handoffToken: options.handoffToken,
			});
			const writeOutputPreamble = buildWriteOutputPreamble({
				step,
				validators,
				workflowDir,
				runId,
				stepId: step.id,
				attempts: options.attempts,
				handoffToken: options.handoffToken,
			});
			const taskWithPreamble =
				EXEC_POLL_PREAMBLE +
				writeOutputPreamble +
				signalingPreamble +
				step.task;
			const spawnResult = await adapter.spawn(taskWithPreamble, {
				model,
				timeout: step.timeout,
				sessionTarget: "isolated",
				label: `wf:${runId}:${step.id}`,
				sealed,
				resultPolicy: sealed?.tool_result_policy,
				transcriptPolicy: sealed?.context_firewall,
				artifactSink: buildSealedArtifactSink({
					sealed,
					artifactStore: options.artifactStore,
					runId,
					stepId: step.id,
				}),
			});
			sessionKey = spawnResult.sessionKey;

			if (sealed && options.artifactStore) {
				const maxPreviewBytes =
					typeof sealed?.tool_result_policy?.max_context_injection_bytes ===
					"number"
						? Math.max(
								64,
								sealed.tool_result_policy.max_context_injection_bytes,
							)
						: ((_api.config as any)?.sealedMaxPreviewBytes ?? 2048);
				sealedRunKey = sessionKey;
				const activeRun = {
					artifactStore: options.artifactStore,
					runId,
					stepId: step.id,
					maxPreviewBytes,
				};
				activeSealedRuns.set(`sessionKey:${sessionKey}`, activeRun);
				if (spawnResult.sessionId) {
					activeSealedRuns.set(`sessionId:${spawnResult.sessionId}`, activeRun);
				}
				if (runId) {
					activeSealedRuns.set(`runId:${runId}`, activeRun);
				}
				if (runId && step.id) {
					activeSealedRuns.set(`runStep:${runId}:${step.id}`, activeRun);
				}
			}

			const timeoutMs = step.timeout * 1000;
			const deadline = Date.now() + timeoutMs;
			let finalStatus = null;
			let retryable = false;
			let errorMsg = null;
			let logs = null;
			let outputCheck: OutputCheckResult = {
				passed: false,
				decision: "unknown" as any,
				missing_files: [],
				checked_files: [],
				validations: [],
			};
			let cancelResult: CancelResult | null = null;
			const runOutputCheck = async () => {
				if (options.artifactStore && runId && step?.id) {
					return checkStepContract({
						outputs: step.outputs,
						validators,
						artifactStore: options.artifactStore,
						runId,
						stepId: step.id,
						baseDir,
						workflowDir,
						filesystemFallback: options.filesystemFallback !== false,
					});
				}

				return checkOutputs(step.outputs, baseDir, validators, workflowDir);
			};

			while (Date.now() < deadline) {
				await sleep(pollIntervalMs);
				const liveStepState =
					typeof options.getStepState === "function"
						? options.getStepState()
						: null;

				if (usesOutputCompletion(step)) {
					outputCheck = await runOutputCheck();

					if (outputCheck.passed) {
						if (
							outputCheckHasCurrentAttemptProvenance({
								stepState: liveStepState,
								outputCheck,
								runId,
								stepId: step.id,
								attempt: options.attempts,
							})
						) {
							const mapped = statusFromOutputDecision(outputCheck);
							finalStatus = mapped.finalStatus;
							retryable = mapped.retryable;
							errorMsg = mapped.errorMsg;
							break;
						}
					}

					if (
						outputCheck.decision === "blocked" ||
						outputCheck.decision === "retry"
					) {
						if (
							outputCheckHasCurrentAttemptProvenance({
								stepState: liveStepState,
								outputCheck,
								runId,
								stepId: step.id,
								attempt: options.attempts,
							})
						) {
							const mapped = statusFromOutputDecision(outputCheck);
							finalStatus = mapped.finalStatus;
							retryable = mapped.retryable;
							errorMsg = mapped.errorMsg;
							break;
						}
					}

					// Non-terminal while running: parse/schema/fail artifacts can be repaired,
					// and valid direct writes without current-attempt provenance must not short-circuit.
				}

				const statusResult = await adapter.getStatus(
					spawnResult.sessionId,
					options,
				);
				if (statusResult.status === "done") {
					logs = statusResult.logs;

					outputCheck = await runOutputCheck();

					const mapped = statusFromOutputDecision(outputCheck);

					if (mapped.finalStatus === "ok" || mapped.finalStatus === "blocked") {
						finalStatus = mapped.finalStatus;
						retryable = mapped.retryable;
						errorMsg = mapped.errorMsg;
						break;
					}

					finalStatus = mapped.finalStatus;
					retryable = mapped.retryable;
					errorMsg = mapped.errorMsg;
					break;
				}
				if (statusResult.status === "error") {
					outputCheck = await runOutputCheck();
					finalStatus = "failed";
					errorMsg = statusResult.error || "Session error";
					logs = statusResult.logs;
					break;
				}
			}

			if (finalStatus === "ok" || finalStatus === null) {
				outputCheck = await runOutputCheck();
			}

			if (finalStatus === "ok" || finalStatus === null) {
				outputCheck = await runOutputCheck();
			}

			if (finalStatus === null) {
				cancelResult = await (
					adapter.cancel?.(spawnResult.sessionId, {
						...options,
						sessionKey: spawnResult.sessionKey,
						runId: spawnResult.sessionId,
						reason: `workflow_step_timeout:${step.id}`,
						timeoutMs,
						cancelGraceMs: options.cancelGraceMs ?? 30000,
					}) ?? Promise.resolve(null)
				).catch(
					(err): CancelResult =>
						({
							requested: false,
							confirmed: false,
							error: err instanceof Error ? err.message : String(err),
						}) as CancelResult,
				);

				const stopped = await waitForTerminalAfterCancel(
					adapter,
					spawnResult.sessionId,
					options,
					options.cancelGraceMs ?? 30000,
					pollIntervalMs,
				);

				finalStatus = "failed";
				const stopConfirmed = Boolean(cancelResult?.confirmed || stopped);
				const stopRequested = Boolean(cancelResult?.requested);

				failureKind = stopConfirmed
					? "timeout_stop_confirmed"
					: "timeout_stop_unconfirmed";

				retryable = true;

				errorMsg = stopConfirmed
					? `Step timed out after ${step.timeout}s; subagent stop after timeout was confirmed via ${cancelResult?.method || "unknown"}`
					: `Step timed out after ${step.timeout}s; subagent stop after timeout was not confirmed. Previous subagent may still be running. Stop result: ${stopRequested ? "requested" : "not_requested"}`;

				logs = stopped?.logs || logs;
			} else if (finalStatus === "ok") {
				const mapped = statusFromOutputDecision(outputCheck);
				finalStatus = mapped.finalStatus;
				retryable = mapped.retryable;
				errorMsg = mapped.errorMsg;
			}

			return {
				status: finalStatus,
				retryable,
				failure_kind: failureKind,
				session_key: sessionKey,
				output_check: outputCheck,
				error: errorMsg,
				logs,
				duration_ms: Date.now() - startTime,
				cancel_result: cancelResult,
			};
		} catch (err) {
			return {
				status: "failed",
				session_key: sessionKey,
				output_check: emptyOutputCheck(),
				error: err.message,
				duration_ms: Date.now() - startTime,
			};
		} finally {
			if (sealedRunKey) activeSealedRuns.delete(sealedRunKey);
		}
	};
}
