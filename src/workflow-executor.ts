/**
 * @module workflow-executor
 * @description The core workflow execution engine. Orchestrates step scheduling,
 * dependency resolution, parallel execution, retry logic, and state management
 * for a complete workflow run.
 *
 * ## Architecture Overview
 *
 * The executor implements a **dependency-driven scheduler**:
 *
 * 1. On each tick (loop iteration), it scans all pending steps and determines
 *    which ones are now "ready" — meaning all their dependencies are satisfied
 *    (see Dependency Resolution Rules below).
 *
 * 2. Ready steps that fit within the concurrency limit are launched immediately.
 *    Launched steps run in background (Promises); the loop doesn't await them.
 *
 * 3. The loop uses a simple poll-sleep approach rather than event-driven callbacks.
 *    This is intentional: it's simpler to reason about, tolerates step-runner
 *    failures gracefully, and the `TICK_INTERVAL` (500ms) is imperceptible.
 *
 * 4. When a step completes (via `stepPromises` resolution), the scheduler loop
 *    picks it up on the next tick and re-evaluates readiness.
 *
 * ## Dependency Resolution Rules
 *   - A step is ready when all dependencies are satisfied
 *   - Satisfied: 'ok', or ('failed'/'blocked' AND optional). 'skipped' blocks.
 *   - 'always_run' steps wait for any terminal state.
 *   - If a non-optional dependency fails, all transitively-dependent steps are
 *     marked `skipped` (not failed) — this prevents false failure counts
 *
 * ## Retry Logic
 *   - On failure, if `step.retry > 0` and `attempts < retry + 1`, re-queue the step
 *   - Wait `step.retry_delay` seconds before re-queuing
 *   - After all retries exhausted, mark as `failed`
 *
 * Dependencies: node:timers/promises, ./workflow-state.js, ./variable-substitution.js
 *
 * @example
 * import { executeWorkflow } from './workflow-executor.js';
 * const finalState = await executeWorkflow(workflowDef, runId, api, config, stepRunner);
 */

import fs, { appendFile } from "node:fs/promises";
import path, { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeJsonAtomic } from "./json-io.js";
import {
	resolveList,
	resolvePathToList,
	validateLoopItems,
} from "./list-resolver.js";
import type { PluginOperationRegistry } from "./plugin-operations.js";
import { FilesystemStateStore } from "./state-artifact-stores.js";
import { projectStateContracts } from "./state-contract-projector.js";
import {
	adoptStepContract,
	buildStepHandoffToken,
	computeStepContractSignature,
	decisionAcceptedForReuse,
	evaluateCacheFreshness,
	evaluateReuseCondition,
	markCacheProbe,
	validateStepContract,
	writeStepCacheManifest,
} from "./step-contract.js";
import { emptyOutputCheck, runStep } from "./step-runner.js";
import { validateWorkflowTemplates } from "./template-schema-validator.js";
import type { RunState, StepState, WorkflowStep } from "./types.js";
import {
	assertSafeOutputPath,
	buildContext,
	outputIdOf,
	outputPathOf,
	substituteDeep,
} from "./variable-substitution.js";
import { createRunState, getLocalISOString } from "./workflow-state.js";

/** Scheduler tick interval in milliseconds. Lower = more responsive but more CPU. */
const TICK_INTERVAL_MS = 500;

/**
 * @typedef {Object} ExecutorConfig
 * @property {string}   runsDir        - Directory for state files
 * @property {string}   baseDir        - Base directory for output path resolution
 * @property {number}   concurrency    - Max parallel steps (from workflow or config)
 * @property {string}   [notifyChannel]  - Channel to send notifications to
 * @property {number}   [pollIntervalMs] - Poll interval for step runners
 * @property {string}   [defaultModel]   - Default model for steps without a model
 * @property {Function} [notify]         - Function(message) for sending notifications
 * @property {'none'|'announce'} [cronDeliveryMode] - Delivery mode for cron jobs
 * @property {string}   [cronDeliveryChannel] - Delivery channel for cron jobs
 * @property {string}   [cronDeliveryTo] - Delivery target for cron jobs
 * @property {number}   [cliTimeoutMs] - General CLI timeout (ms)
 * @property {number}   [cronAddTimeoutMs] - Timeout for cron add (ms)
 * @property {number}   [cronRunTimeoutMs] - Timeout for cron run (ms)
 * @property {number}   [cronPollTimeoutMs] - Timeout for cron poll (ms)
 */

export async function compileWorkflow(workflow, runId, config) {
	validateWorkflowTemplates(workflow);
	const varCtx = buildContext(
		runId,
		workflow.config,
		new Date(),
		workflow.config?.timezone,
		config.runsDir,
		workflow.name,
	);
	const plannedSteps = [];

	for (const step of workflow.steps) {
		if (step.for_each) {
			plannedSteps.push({
				id: step.id,
				controller: step.id,
				dynamic: true,
				for_each: substituteDeep(step.for_each, varCtx),
				parser: step.parser || "auto",
				outputs: step.outputs || [],
			});

			continue;
		}

		const expanded = substituteDeep(step, varCtx) as WorkflowStep;

		for (const output of expanded.outputs || []) {
			assertSafeOutputPath(outputPathOf(output));
		}

		plannedSteps.push({
			id: step.id,
			outputs: expanded.outputs || [],
		});
	}

	return plannedSteps;
}

/**
 * Execute a workflow run to completion.

 *
 * This is the main entry point for the execution engine. It:
 *   1. Creates initial run state
 *   2. Runs the scheduling loop until all steps complete or the run is cancelled
 *   3. Marks the run as completed (ok, failed, or cancelled)
 *   4. Returns the final run state
 *
 * This function is intentionally async and long-running. The `workflow_run` tool
 * launches it in the background (not awaited) and returns immediately with the run_id.
 *
 * @param {import('./workflow-loader.js').WorkflowDefinition} workflow - Workflow definition
 * @param {string}         runId        - Pre-generated run ID
 * @param {Object}         api          - OpenClaw plugin api
 * @param {ExecutorConfig} config       - Executor configuration
 * @param {Function}       stepRunner   - Step runner function (injectable for testing)
 * @returns {Promise<import('./workflow-state.js').RunState>} Final run state
 *
 * @example
 * const finalState = await executeWorkflow(
 *   workflow,
 *   'seo-pipeline-20260309T082000',
 *   api,
 *   { runsDir, baseDir, concurrency: 3, notify: (msg) => console.log(msg) },
 *   runStep
 * );
 */
export async function executeWorkflow(
	workflow,
	runId,
	api,
	config,
	stepRunner = runStep,
	initialState = null,
	workflowKey = null,
) {
	let planningError: unknown = null;
	try {
		await fs.mkdir(config.runsDir, { recursive: true });
		const plan = await compileWorkflow(workflow, runId, config);
		await writeJsonAtomic(join(config.runsDir, `${runId}.plan.json`), plan);
	} catch (err) {
		planningError = err;
	}

	const {
		runsDir,
		baseDir,
		concurrency,
		stateStore,
		notify = () => {},
		pollIntervalMs = 5000,
		defaultModel,
		sessionAdapter = "auto",
		cronDeliveryMode = "none",
		cronDeliveryChannel,
		cronDeliveryTo,
		cliTimeoutMs,
		cronAddTimeoutMs,
		cronRunTimeoutMs,
		cronPollTimeoutMs,
		cancelGraceMs,
		workflowsDir,
		artifactStore,
		pluginRegistry,
		redis = null,
	} = config;

	const activeStateStore = stateStore || new FilesystemStateStore(runsDir);

	async function persistRunPatch(patch: Partial<RunState>): Promise<RunState> {
		return activeStateStore.updateRun(runId, patch);
	}

	async function persistStepPatch(
		stepId: string,
		patch: Partial<StepState>,
	): Promise<RunState> {
		return activeStateStore.updateStep(runId, stepId, patch);
	}

	async function persistRunState(nextState: RunState): Promise<RunState> {
		await activeStateStore.saveRun(nextState);
		return nextState;
	}

	async function loadRunStateSnapshot(): Promise<RunState> {
		return activeStateStore.loadRun(runId);
	}

	// Build substitution context once for the entire run
	const varCtx = buildContext(
		runId,
		workflow.config,
		new Date(),
		workflow.config?.timezone,
		runsDir,
		workflow.name,
	);

	// Apply variable substitution to all top-level steps.
	// Loop steps are preserved as-is (their inner steps will be substituted during expansion).
	const steps = workflow.steps.map((step) =>
		step.for_each ? { ...step } : substituteDeep(step, varCtx),
	);

	// Initialize run state — either use a provided initial state (for resume) or create fresh.

	// When resuming, the initialState already has 'ok' steps pre-populated so they are skipped.
	let state = initialState
		? { ...initialState, run_id: runId }
		: createRunState(
				workflow.name,
				workflowKey || workflow.name,
				steps.map((s) => s.id),
				runId,
			);

	await persistRunState(state);

	if (planningError) {
		return persistRunPatch({
			status: "failed",
			phase: "compile",
			error:
				planningError instanceof Error
					? planningError.message
					: String(planningError),
			completed_at: getLocalISOString(),
			spawned_sessions: 0,
		});
	}

	// Transition run to 'running' immediately (overwrites 'pending' from fresh create,
	// or re-sets 'failed'/'cancelled' to 'running' for a resume scenario)
	state = await persistRunPatch({ status: "running", completed_at: null });

	// Map of step ID → Promise (for in-flight steps)
	/** @type {Map<string, Promise<void>>} */
	const inFlight = new Map();

	// Step definitions keyed by ID for O(1) lookup
	const stepMap = new Map<string, WorkflowStep>(steps.map((s) => [s.id, s]));
	/** @type {Map<string, number>} */
	const runningCounts = new Map();
	let stateWriteQueue = Promise.resolve();

	async function mutateState(mutator) {
		let nextState;
		stateWriteQueue = stateWriteQueue
			.then(async () => {
				try {
					nextState = await mutator(state);
					state = nextState;
					await persistRunState(state);
				} catch (err) {
					api?.logger?.error?.(
						`[workflow:${runId}] state mutation failed`,
						err,
					);
				}
			})
			.catch((err) => {
				api?.logger?.error?.(`[workflow:${runId}] state queue error`, err);
			});
		await stateWriteQueue;
		return nextState;
	}

	function isTerminalStatus(status) {
		return ["ok", "failed", "blocked", "skipped"].includes(status);
	}

	/**
	 * Determine if a step's dependencies are all satisfied.
	 * A dependency is satisfied only if:
	 *   - it is 'ok', or
	 *   - it is 'failed'/'blocked' and the dependency step is optional.
	 * Skipped dependencies block normal downstream steps.
	 * 'always_run' steps wait for dependencies to reach any terminal state.
	 *
	 * @param {import('./workflow-loader.js').WorkflowStep} step
	 * @returns {{ ready: boolean, blocked: boolean }}
	 *   ready: true if all deps are satisfied (step can run)
	 *   blocked: true if a non-optional dependency failed (step should be skipped)
	 */
	function evalDependencies(step) {
		if (step.always_run) {
			const allDepsTerminal = (step.depends_on || []).every((depId) => {
				const depState = state.steps[depId];
				return depState && isTerminalStatus(depState.status);
			});

			return {
				ready: allDepsTerminal,
				blocked: false,
			};
		}

		for (const depId of step.depends_on || []) {
			const depState = state.steps[depId];
			if (!depState) continue;

			const depDef = stepMap.get(depId);
			const depOptional = depDef?.optional === true;

			if (depState.status === "ok") continue;
			if (depState.status === "skipped") {
				return { ready: false, blocked: true };
			}
			if (depState.status === "failed" && depOptional) continue;
			if (depState.status === "blocked" && depOptional) continue;

			if (depState.status === "failed" || depState.status === "blocked") {
				return { ready: false, blocked: true };
			}

			return { ready: false, blocked: false };
		}

		return { ready: true, blocked: false };
	}

	/**
	 * Mark a step and all steps transitively depending on it as 'skipped'.
	 * Called when a non-optional dependency fails.
	 * State is saved after marking all skipped steps in one pass.
	 *
	 * @param {string} failedStepId - The step that failed
	 */
	async function cascadeSkip(failedStepId) {
		const toSkip = [];
		// BFS to find all downstream steps
		const queue = [failedStepId];
		const visited = new Set();

		while (queue.length > 0) {
			const current = queue.shift();
			for (const step of steps) {
				if (step.depends_on.includes(current) && !visited.has(step.id)) {
					const currentStatus = state.steps[step.id]?.status;
					if (currentStatus === "pending" && !step.always_run) {
						visited.add(step.id);
						toSkip.push(step.id);
						queue.push(step.id);
					}
				}
			}
		}

		for (const stepId of toSkip) {
			await mutateState(() => persistStepPatch(stepId, { status: "skipped" }));
		}
	}

	async function failLoopExpansion(step, err) {
		const message = err instanceof Error ? err.message : String(err);
		const now = getLocalISOString();

		await mutateState(async (current) => {
			let next = await persistStepPatch(step.id, {
				status: step.optional ? "ok" : "failed",
				started_at: current.steps[step.id]?.started_at ?? now,
				completed_at: now,
				duration_ms: current.steps[step.id]?.started_at
					? Date.now() - new Date(current.steps[step.id].started_at).getTime()
					: 0,
				error: step.optional ? null : `Loop expansion failed: ${message}`,
				logs: JSON.stringify(
					{
						phase: "expand_loop",
						loop_step: step.id,
						error: message,
					},
					null,
					2,
				),
			});

			if (!step.optional) {
				next = await persistRunPatch({
					status: "failed",
					phase: "expand_loop",
					completed_at: now,
					error: `Loop expansion failed in ${step.id}: ${message}`,
				});
			}

			return next;
		});
	}

	/**
	 * Execute a plugin step (kind: plugin) synchronously within the engine process.
	 * No agent session is allocated. The registered operation runs directly and returns
	 * a StepRunResult-compatible object.
	 */
	async function runPluginStep(
		step,
		ctx: {
			workflow: any;
			runId: string;
			varCtx: any;
			baseDir: string;
			artifactStore: any;
			pluginRegistry: PluginOperationRegistry | null | undefined;
			redis: any;
		},
	) {
		const start = Date.now();
		const usesId = step.uses;

		if (!usesId) {
			return {
				status: "failed" as const,
				retryable: false,
				output_check: {
					passed: false,
					decision: "fail" as const,
					missing_files: [],
					checked_files: [],
					validations: [
						{
							path: "",
							exists: false,
							decision: "fail" as const,
							errors: [`Plugin step "${step.id}" is missing the "uses" field.`],
						},
					],
				},
				error: `Plugin step "${step.id}" is missing the "uses" field.`,
				logs: null,
				duration_ms: Date.now() - start,
			};
		}

		const operation = ctx.pluginRegistry?.get(usesId);
		if (!operation) {
			const available = ctx.pluginRegistry
				? ctx.pluginRegistry
						.list()
						.map((o) => o.id)
						.join(", ")
				: "(no registry)";
			const msg = `Plugin step "${step.id}" uses unknown operation "${usesId}". Available: ${available}`;
			return {
				status: "failed" as const,
				retryable: false,
				output_check: {
					passed: false,
					decision: "fail" as const,
					missing_files: [],
					checked_files: [],
					validations: [
						{
							path: "",
							exists: false,
							decision: "fail" as const,
							errors: [msg],
						},
					],
				},
				error: msg,
				logs: null,
				duration_ms: Date.now() - start,
			};
		}

		const opCtx = {
			workflow: ctx.workflow,
			step,
			config: ctx.workflow.config || {},
			runId: ctx.runId,
			date: ctx.varCtx?.date ?? new Date().toISOString().slice(0, 10),
			substitutionContext: ctx.varCtx ?? null,
			stateStore: config.stateStore ?? null,
			artifactStore: ctx.artifactStore ?? null,
			redis: ctx.redis ?? null,
			validators: ctx.workflow.validators || {},
		};

		let opResult;
		try {
			opResult = await operation.run(opCtx);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				status: "failed" as const,
				retryable: true,
				output_check: {
					passed: false,
					decision: "fail" as const,
					missing_files: [],
					checked_files: [],
					validations: [
						{
							path: "",
							exists: false,
							decision: "fail" as const,
							errors: [msg],
						},
					],
				},
				error: msg,
				logs: null,
				duration_ms: Date.now() - start,
			};
		}

		// Map to StepRunResult shape
		return {
			status: opResult.status,
			retryable: opResult.retryable,
			failure_kind: opResult.failure_kind ?? null,
			session_key: null,
			output_check: opResult.output_check,
			error: opResult.error,
			logs: opResult.logs,
			duration_ms: opResult.duration_ms || Date.now() - start,
			output_writes: opResult.output_writes,
		};
	}

	/**
	 * Launch a single step as a background Promise.
	 * Updates state to 'running', runs the step, then handles the result.
	 *
	 * @param {import('./workflow-loader.js').WorkflowStep} step
	 */
	async function launchStep(step) {
		const trackingId = step.original_id || step.id;
		runningCounts.set(trackingId, (runningCounts.get(trackingId) || 0) + 1);

		// Increment attempts before launch
		const attempts = (state.steps[step.id]?.attempts || 0) + 1;

		// Mark as running immediately.
		// For cancellation safety, state writes should be ordered.
		const handoffToken = buildStepHandoffToken({
			runId,
			stepId: step.id,
			attempts,
		});

		// Before spawning a new session, check whether a previous stale attempt
		// already produced valid declared outputs and stored a late_success_candidate.
		const existingStepState = state.steps[step.id];
		if (existingStepState?.late_success_candidate) {
			const candidate = existingStepState.late_success_candidate;
			const recheck = await validateStepContract({
				workflow,
				step,
				baseDir,
				workflowsDir,
				runId,
				stepId: step.id,
				artifactStore,
			});
			if (recheck.passed) {
				runningCounts.set(
					trackingId,
					Math.max(0, (runningCounts.get(trackingId) || 1) - 1),
				);
				await mutateState(async (current) => {
					const next = await adoptStepContract({
						state: current,
						stateStore: activeStateStore,
						stepId: step.id,
						outputCheck: recheck,
						reason: "generated",
						message: `Late handoff adopted (attempt ${candidate.attempt})`,
					});
					return activeStateStore.updateStep(runId, step.id, {
						late_success_candidate: null,
						attempts,
					});
				});
				await notify(`✅ ${step.name} complete (late handoff adopted)`);
				return;
			}
		}

		await mutateState(() =>
			persistStepPatch(step.id, {
				status: "running",
				started_at: getLocalISOString(),
				retry_not_before: null,
				attempts,
				declared_outputs: step.outputs || [],
				...(attempts === 1 ? { first_started_at_ms: Date.now() } : {}),

				session_key: null,
				session_id: null,
				subagent_run_id: null,
				session_adapter: sessionAdapter,
				handoff_token: handoffToken,
				handoff: null,
				output_writes: null,
				late_success_candidate: null,

				cancel_requested_at: null,
				cancel_confirmed_at: null,
				cancel_method: null,
				cancel_error: null,
				cancellation_reason: null,
			}),
		);

		const promise = (async () => {
			try {
				// Path safety gate: ensure substituted output paths are safe before execution
				if (step.outputs) {
					for (const outPath of step.outputs) {
						assertSafeOutputPath(outputPathOf(outPath));
					}
				}

				let result;

				// ── Plugin step path ──────────────────────────────────────────────────────
				if (step.kind === "plugin") {
					result = await runPluginStep(step, {
						workflow,
						runId,
						varCtx,
						baseDir,
						artifactStore,
						pluginRegistry,
						redis,
					});
				} else {
					try {
						result = await stepRunner(step, runId, api, {
							pollIntervalMs,
							baseDir,
							defaultModel,
							attempts,
							handoffToken,
							runStartedAtMs: new Date(state.started_at).getTime(),
							cronDeliveryMode,
							cronDeliveryChannel,
							cronDeliveryTo,
							cliTimeoutMs,
							cronAddTimeoutMs,
							cronRunTimeoutMs,
							cronPollTimeoutMs,
							cancelGraceMs,
							sessionAdapter,
							validators: workflow.validators || {},
							workflowDir: workflow.__dir || workflowsDir,
							artifactStore,
							filesystemFallback: config.filesystemFallback !== false,
							workflow,
							getStepState: () => state.steps[step.id],

							onSpawn: async (spawn) => {
								await mutateState(() =>
									persistStepPatch(step.id, {
										status: "running",
										session_key: spawn.sessionKey,
										session_id: spawn.sessionId,
										subagent_run_id: spawn.sessionId,
										session_adapter: spawn.sessionAdapter,
										spawned_at: spawn.spawnedAt,
									}),
								);
							},
						});
					} catch (err) {
						result = {
							status: "failed",
							session_key: null,
							output_check: emptyOutputCheck(),
							error: err.message,
							duration_ms: 0,
						};
					}
				} // end else (subagent path)

				// Merge plugin output_writes back into run state
				if (step.kind === "plugin" && result.output_writes) {
					await mutateState((current) => {
						const existing = current.steps[step.id]?.output_writes ?? {};
						return persistStepPatch(step.id, {
							output_writes: { ...existing, ...result.output_writes },
						});
					});
				}

				const completedAt = getLocalISOString();
				const startedAt = state.steps[step.id]?.started_at;
				const durationMs =
					result.duration_ms ||
					(startedAt ? Date.now() - new Date(startedAt).getTime() : 0);

				const liveStepState = state.steps[step.id];
				if (liveStepState && liveStepState.status !== "running") {
					return;
				}

				if (result.status === "ok" && step.state_contract) {
					try {
						await projectStateContracts({
							workflow,
							step,
							runId,
							date:
								typeof varCtx?.date === "string"
									? varCtx.date
									: new Date().toISOString().slice(0, 10),
							artifactStore,
							redis,
							config: workflow.config || {},
						});
					} catch (projectionErr) {
						const projectionMsg =
							projectionErr instanceof Error
								? projectionErr.message
								: String(projectionErr);
						result = {
							...result,
							status: "failed",
							retryable: true,
							error: `State contract projection failed: ${projectionMsg}`,
						};
					}
				}

				if (result.status === "ok") {
					// Success path
					await mutateState(() =>
						persistStepPatch(step.id, {
							status: "ok",
							completed_at: completedAt,
							duration_ms: durationMs,
							session_key: result.session_key,
							output_check: result.output_check,
							error: null,
							logs: result.logs,
							attempts,
						}),
					);

					try {
						const signature = await computeStepContractSignature({
							workflow,
							step,
							state,
							baseDir,
							workflowsDir,
						});
						await writeStepCacheManifest({
							baseDir,
							stepId: step.id,
							outputs: (step.outputs || []).map((o) => outputIdOf(o)),
							producerRunId: runId,
							reason: "generated",
							decision: result.output_check?.decision || "pass",
							signature,
						});
					} catch (manifestErr) {
						api?.logger?.warn?.(
							`[workflow:${runId}] failed to write cache manifest for ${step.id}`,
							manifestErr,
						);
					}

					const durationSec = Math.round(durationMs / 1000);
					await notify(`✅ ${step.name} complete (${durationSec}s)`);
				} else if (result.status === "blocked") {
					// Blocked path — non-retryable terminal state
					await mutateState(() =>
						persistStepPatch(step.id, {
							status: "blocked",
							completed_at: completedAt,
							duration_ms: durationMs,
							session_key: result.session_key,
							output_check: result.output_check,
							error: result.error,
							logs: result.logs,
							attempts,
						}),
					);

					try {
						const signature = await computeStepContractSignature({
							workflow,
							step,
							state,
							baseDir,
							workflowsDir,
						});
						await writeStepCacheManifest({
							baseDir,
							stepId: step.id,
							outputs: (step.outputs || []).map((o) => outputIdOf(o)),
							producerRunId: runId,
							reason: "blocked_result",
							decision: result.output_check?.decision || "blocked",
							signature,
						});
					} catch (manifestErr) {
						api?.logger?.warn?.(
							`[workflow:${runId}] failed to write cache manifest for blocked step ${step.id}`,
							manifestErr,
						);
					}

					await notify(
						`⛔ ${step.name} blocked: ${result.error || "validator blocked step"}`,
					);
					if (!step.optional && step.on_block !== "continue") {
						await cascadeSkip(step.id);
					}
				} else {
					// Failure path — check for retry
					const maxAttempts = (step.retry || 0) + 1;
					function retryKindMatches(
						policyKind: string,
						actualKind: string,
					): boolean {
						if (policyKind === actualKind) return true;
						if (policyKind === "timeout" && actualKind.startsWith("timeout"))
							return true;
						return false;
					}

					const outputFailureKinds =
						result.output_check?.validations
							?.map((v) => v.failure_kind)
							.filter((kind): kind is string => Boolean(kind)) ?? [];

					const resultFailureKind =
						typeof result.failure_kind === "string"
							? result.failure_kind
							: null;

					const failureKinds = [
						...(resultFailureKind ? [resultFailureKind] : []),
						...outputFailureKinds,
					];

					const isTimeout =
						failureKinds.some((kind) => kind.startsWith("timeout")) ||
						(typeof result.error === "string" &&
							result.error.includes("timed out"));

					const stopUnconfirmed =
						failureKinds.includes("timeout_stop_unconfirmed") ||
						(typeof result.error === "string" &&
							(result.error.includes(
								"subagent stop after output completion was not confirmed",
							) ||
								result.error.includes(
									"subagent stop after timeout was not confirmed",
								)));

					if (isTimeout && failureKinds.length === 0) {
						failureKinds.push(
							stopUnconfirmed ? "timeout_stop_unconfirmed" : "timeout",
						);
					}

					const retryExcept = step.retry_except ?? [];
					const retryOn = step.retry_on ?? [];

					const excludedByPolicy = failureKinds.some((kind) =>
						retryExcept.some((excluded) => retryKindMatches(excluded, kind)),
					);

					const includedByPolicy = failureKinds.some((kind) =>
						retryOn.some((included) => retryKindMatches(included, kind)),
					);

					const retryableByPolicy =
						!excludedByPolicy &&
						(result.retryable === true ||
							includedByPolicy ||
							(retryOn.includes("timeout") && isTimeout));

					const shouldRetry =
						result.status === "failed" &&
						attempts < maxAttempts &&
						retryableByPolicy;

					if (shouldRetry) {
						// Notify retry, schedule re-launch after retry_delay
						const nextAttempt = attempts + 1;
						await notify(
							`❌ ${step.name} failed — retrying (attempt ${nextAttempt}/${maxAttempts})`,
						);

						const retryNotBefore = getLocalISOString(
							new Date(Date.now() + step.retry_delay * 1000),
						);

						await mutateState(() =>
							persistStepPatch(step.id, {
								status: "pending",
								retry_not_before: retryNotBefore,
								error: result.error,
								logs: result.logs,
								attempts,
								cancel_requested_at: result.cancel_result?.requested
									? completedAt
									: null,
								cancel_confirmed_at: result.cancel_result?.confirmed
									? completedAt
									: null,
								cancel_method: result.cancel_result?.method ?? null,
								cancel_error: result.cancel_result?.error ?? null,
								cancellation_reason: result.cancel_result?.requested
									? `workflow_step_timeout:${step.id}`
									: null,
							}),
						);

						return;
					} else {
						// All retries exhausted — mark as failed
						await mutateState(() =>
							persistStepPatch(step.id, {
								status: "failed",
								completed_at: completedAt,
								duration_ms: durationMs,
								session_key: result.session_key,
								output_check: result.output_check,
								error: result.error,
								logs: result.logs,
								attempts,
								cancel_requested_at: result.cancel_result?.requested
									? completedAt
									: null,
								cancel_confirmed_at: result.cancel_result?.confirmed
									? completedAt
									: null,
								cancel_method: result.cancel_result?.method ?? null,
								cancel_error: result.cancel_result?.error ?? null,
								cancellation_reason: result.cancel_result?.requested
									? `workflow_step_timeout:${step.id}`
									: null,
							}),
						);

						const wasRetried = step.retry > 0;
						if (wasRetried) {
							await notify(
								`❌ ${step.name} failed after ${attempts} attempt(s): ${result.error}`,
							);
						} else {
							await notify(`❌ ${step.name} failed: ${result.error}`);
						}

						// If not optional, cascade skip to dependent steps
						if (!step.optional) {
							await cascadeSkip(step.id);
						} else {
							// Optional failure — log it but don't cascade
							await notify(
								`⚠️  ${step.name} failed (optional — continuing pipeline)`,
							);
						}
					}
				}
			} finally {
				// Remove from in-flight map when done (whether ok, failed, or retrying)
				inFlight.delete(step.id);
				const trackingId = step.original_id || step.id;
				runningCounts.set(
					trackingId,
					Math.max(0, (runningCounts.get(trackingId) || 1) - 1),
				);
			}
		})();

		inFlight.set(step.id, promise);
	}

	async function tryReuseStepOutputs(step) {
		if (!step.reuse_outputs?.enabled) {
			return { adopted: false, skippedLaunch: false };
		}

		const reuseGate = evaluateReuseCondition({
			reuseOutputs: step.reuse_outputs,
			context: {
				config: workflow.config || {},
				run_id: runId,
				workflow: workflow.name,
				step: step.id,
			},
		});

		if (!reuseGate.allowed) {
			if (reuseGate.error) {
				await notify(
					`⚠️ reuse_outputs.when evaluation failed for ${step.name}: ${reuseGate.error}`,
				);
			}
			return { adopted: false, skippedLaunch: false };
		}

		const outputCheck = await validateStepContract({
			workflow,
			step,
			baseDir,
			workflowsDir,
			runId,
			stepId: step.id,
			artifactStore,
		});

		const freshness = await evaluateCacheFreshness({
			workflow,
			step,
			state,
			baseDir,
			workflowsDir,
		});

		if (!freshness.ok) {
			await mutateState((current) =>
				markCacheProbe({
					state: current,
					stateStore: activeStateStore,
					stepId: step.id,
					hit: true,
					adopted: false,
					decision: outputCheck.decision,
					reason: freshness.reason || "stale_contract",
					producer_run_id: freshness.producer_run_id,
					previous_contract_signature: freshness.previous_signature,
					current_contract_signature: freshness.current_signature,
					validator_hash: freshness.validator_hash,
				}),
			);

			return { adopted: false, skippedLaunch: false };
		}

		const accepted = decisionAcceptedForReuse(
			step.reuse_outputs,
			outputCheck.decision,
		);

		if (accepted) {
			await mutateState(async (current) => {
				let next = await markCacheProbe({
					state: current,
					stateStore: activeStateStore,
					stepId: step.id,
					hit: true,
					adopted: true,
					decision: outputCheck.decision,
					reason: "cache_hit",
					producer_run_id: freshness.producer_run_id,
					contract_signature: freshness.current_signature,
					validator_hash: freshness.validator_hash,
				});

				next = await adoptStepContract({
					state: next,
					stateStore: activeStateStore,
					stepId: step.id,
					outputCheck,
					reason: step.reuse_outputs?.on_hit?.reason || "cache_hit",
					message: `Step reused cached outputs (${outputCheck.decision})`,
				});

				return next;
			});

			await notify(`♻️ Reused cached outputs for ${step.name}`);

			if (state.steps[step.id]?.status === "failed" && !step.optional) {
				await cascadeSkip(step.id);
			}

			return { adopted: true, skippedLaunch: true };
		}

		await mutateState((current) =>
			markCacheProbe({
				state: current,
				stateStore: activeStateStore,
				stepId: step.id,
				hit: false,
				adopted: false,
				decision: outputCheck.decision,
				reason: "cache_invalid",
				producer_run_id: freshness.producer_run_id,
				contract_signature: freshness.current_signature,
				validator_hash: freshness.validator_hash,
			}),
		);

		if (step.reuse_outputs?.on_invalid === "fail_step") {
			await mutateState(() =>
				persistStepPatch(step.id, {
					status: "failed",
					completed_at: getLocalISOString(),
					output_check: outputCheck,
					error: `Cache validation failed (${outputCheck.decision}) and on_invalid=fail_step`,
				}),
			);

			if (!step.optional) {
				await cascadeSkip(step.id);
			}

			return { adopted: false, skippedLaunch: true };
		}

		return { adopted: false, skippedLaunch: false };
	}

	// ── Main scheduling loop ───────────────────────────────────────────────────
	// Runs until all steps reach a terminal state or the run is cancelled.
	let iterationGuard = 0;
	const MAX_ITERATIONS = 100000; // Safety valve against infinite loops

	while (iterationGuard++ < MAX_ITERATIONS) {
		// ── Loop Controller Status Update ────────────────────────────────────────
		// Check if any running loop-controllers have all their iterations finished.
		for (const step of steps) {
			if (step.for_each && state.steps[step.id]?.status === "running") {
				const childrenIds = Object.keys(state.steps).filter((id) =>
					id.startsWith(`${step.id}:`),
				);
				const childStates = childrenIds.map((id) => state.steps[id]?.status);

				const TERMINAL_STEP_STATUSES = ["ok", "failed", "blocked", "skipped"];

				if (
					childrenIds.length > 0 &&
					childStates.every((s) => TERMINAL_STEP_STATUSES.includes(s))
				) {
					const anyFailed = childStates.includes("failed");
					const anyBlocked = childStates.includes("blocked");
					const startedAt = state.steps[step.id]?.started_at;
					const completedAt = getLocalISOString();
					const durationMs = startedAt
						? Date.now() - new Date(startedAt).getTime()
						: 0;

					const parentStatus =
						anyFailed && !step.optional
							? "failed"
							: anyBlocked && !step.optional
								? "blocked"
								: "ok";

					await mutateState(() =>
						persistStepPatch(step.id, {
							status: parentStatus,
							completed_at: completedAt,
							duration_ms: durationMs,
						}),
					);

					if (parentStatus === "failed" || parentStatus === "blocked") {
						await cascadeSkip(step.id);
					}
					await notify(
						`${parentStatus === "ok" ? "✅" : "❌"} Loop "${step.id}" complete`,
					);
				}
			}
		}

		// Re-read state from disk to pick up external updates (handoff, progress, cancel).
		if (iterationGuard % 2 === 0) {
			try {
				const diskState = await loadRunStateSnapshot();
				state = diskState;
				if (diskState.status === "cancelled") {
					// External cancel: mark running steps as cancellation-requested, drain active promises, and exit.
					for (const [stepId] of inFlight.entries()) {
						await mutateState((current) =>
							persistStepPatch(stepId, {
								cancel_requested_at:
									current.steps[stepId]?.cancel_requested_at ||
									getLocalISOString(),
								cancellation_reason:
									current.steps[stepId]?.cancellation_reason ||
									`external_cancel:${runId}`,
							}),
						);
					}

					await Promise.allSettled([...inFlight.values()]);
					return await activeStateStore.loadRun(runId);
				}
			} catch {
				// If we can't read the state file, continue with in-memory state
			}
		}

		// Check if all steps have reached terminal status
		const allTerminal = steps.every((s) => {
			const status = (state as RunState).steps[s.id]?.status;
			return ["ok", "failed", "blocked", "skipped"].includes(status);
		});

		if (allTerminal) break;

		// Launch ready steps up to concurrency limit
		const slotsAvailable = concurrency - inFlight.size;

		if (slotsAvailable > 0) {
			// Find all pending steps that could be launched
			for (const step of steps) {
				if (inFlight.size >= concurrency) break;
				if ((state as RunState).steps[step.id]?.status !== "pending") continue;
				if (inFlight.has(step.id)) continue; // Already tracked

				const retryNotBefore = (state as RunState).steps[step.id]
					?.retry_not_before;
				if (retryNotBefore && Date.now() < new Date(retryNotBefore).getTime())
					continue;

				if (step.concurrency) {
					const trackingId = step.original_id || step.id;
					const currentRunning = runningCounts.get(trackingId) || 0;
					if (currentRunning >= step.concurrency) continue;
				}

				const { ready, blocked } = evalDependencies(step);

				const ready_final = ready;
				const blocked_final = blocked;

				if (blocked_final) {
					// Dep failed and not optional — skip this step
					await mutateState(() =>
						persistStepPatch(step.id, { status: "skipped" }),
					);
					continue;
				}

				if (ready_final) {
					if (step.for_each) {
						await mutateState((current) =>
							persistStepPatch(step.id, {
								status: "running",
								started_at:
									current.steps[step.id]?.started_at ?? getLocalISOString(),
								attempts: (current.steps[step.id]?.attempts || 0) + 1,
								error: null,
							}),
						);

						try {
							const list = await resolveList(
								step.for_each,
								varCtx,
								baseDir,
								step.parser,
							);
							validateLoopItems(step, list);

							const expandedChildren = [];

							if (list.length > 0) {
								let innerStepsDef = step.steps || [];

								if (innerStepsDef.length === 0 && step.task) {
									innerStepsDef = [
										{
											id: "task",
											name: step.name,
											task: step.task,
											model: step.model,
											concurrency: step.concurrency,
											timeout: step.timeout,
											retry: step.retry,
											retry_delay: step.retry_delay,
											retry_on: step.retry_on,
											retry_except: step.retry_except,
											optional: step.optional,
											outputs: step.outputs,
											depends_on: [],
											required_skills: step.required_skills,
											required_mcp_servers: step.required_mcp_servers,
											complete_when: step.complete_when,
											on_block: step.on_block,
										},
									];
								}

								for (let i = 0; i < list.length; i++) {
									const item = list[i];
									const prefix = `${step.id}:${i}:`;
									const itemCtx = { ...varCtx, item };

									for (const innerDef of innerStepsDef) {
										const substitutedInner = substituteDeep(
											innerDef,
											itemCtx,
										) as WorkflowStep;

										const originalInnerId = substitutedInner.id;
										substitutedInner.id = prefix + originalInnerId;
										substitutedInner.original_id = `${step.id}:${originalInnerId}`;

										substitutedInner.depends_on = (
											substitutedInner.depends_on || []
										).map((depId) => {
											if (innerStepsDef.some((s) => s.id === depId)) {
												return prefix + depId;
											}

											return depId;
										});

										expandedChildren.push(substitutedInner);
									}
								}

								for (const child of expandedChildren) {
									steps.push(child);
									stepMap.set(child.id, child);
									await mutateState(() =>
										persistStepPatch(child.id, { status: "pending" }),
									);
								}
							}

							if (expandedChildren.length > 0) {
								await mutateState(() =>
									persistStepPatch(step.id, { status: "running" }),
								);
							} else {
								await mutateState(() =>
									persistStepPatch(step.id, {
										status: "ok",
										completed_at: getLocalISOString(),
										duration_ms: 0,
									}),
								);
							}

							if (list.length > 0) {
								await notify(
									`🔄 Expanded loop "${step.id}" into ${list.length} iterations`,
								);
							}

							continue;
						} catch (err) {
							await failLoopExpansion(step, err);

							if (!step.optional) {
								await cascadeSkip(step.id);
							}

							const message = err instanceof Error ? err.message : String(err);
							await notify(
								`❌ Loop "${step.id}" failed during expansion: ${message}`,
							);

							continue;
						}
					}

					if (step.skip_if_empty) {
						const checkPath = substituteDeep(step.skip_if_empty, varCtx);
						await notify(
							`🔍 Checking skip_if_empty for ${step.id}: ${checkPath}`,
						);

						const list = await resolvePathToList(checkPath, baseDir);
						await notify(`📊 List length for ${step.id}: ${list.length}`);

						if (list.length === 0) {
							await mutateState(() =>
								persistStepPatch(step.id, {
									status: "ok",
									completed_at: getLocalISOString(),
									duration_ms: 0,
								}),
							);
							await notify(`⏩ Skipped ${step.name} (input data empty)`);
							continue;
						}
					}

					const reuse = await tryReuseStepOutputs(step);
					if (reuse.skippedLaunch) {
						continue;
					}

					await launchStep(step);
				}
			}
		}

		// Wait before next tick
		await sleep(TICK_INTERVAL_MS);
	}

	// Wait for any remaining in-flight promises to settle
	await Promise.allSettled([...inFlight.values()]);

	// ── Determine final run status ─────────────────────────────────────────────
	// Only non-optional step failures or blocks cause the pipeline to fail/block.
	const finalStepStatuses = Object.values((state as RunState).steps).map(
		(s) => (s as StepState).status,
	);
	const anyNonOptionalFailed = steps.some((s) => {
		const stepState = state.steps[s.id];
		return !s.optional && stepState?.status === "failed";
	});
	const anyNonOptionalBlocked = steps.some((s) => {
		const stepState = state.steps[s.id];
		return (
			!s.optional &&
			s.on_block !== "continue" &&
			stepState?.status === "blocked"
		);
	});

	let finalStatus: RunState["status"] = "ok";
	if (anyNonOptionalBlocked) finalStatus = "blocked";
	else if (anyNonOptionalFailed) finalStatus = "failed";

	state = await persistRunPatch({
		status: finalStatus,
		completed_at: getLocalISOString(),
	});

	// ── Final notification ─────────────────────────────────────────────────────
	const okCount = finalStepStatuses.filter((s) => s === "ok").length;
	const totalCount = steps.length;

	if (finalStatus === "ok") {
		await notify(
			`🏁 Pipeline "${workflow.name}" complete — ${okCount}/${totalCount} steps passed`,
		);
	} else if (finalStatus === "blocked") {
		const blockedCount = finalStepStatuses.filter(
			(s) => s === "blocked",
		).length;
		await notify(
			`🛑 Pipeline "${workflow.name}" blocked — ${blockedCount} step(s) blocked, ${okCount}/${totalCount} passed`,
		);
	} else {
		const failedCount = finalStepStatuses.filter((s) => s === "failed").length;
		await notify(
			`💥 Pipeline "${workflow.name}" failed — ${failedCount} step(s) failed, ${okCount}/${totalCount} passed`,
		);
	}

	return state;
}

/**
 * Resume a previously failed or partial workflow run.
 * Resets steps that previously failed (or were skipped due to failures)
 * back to 'pending' so they can be retried, while keeping 'ok' steps intact.
 *
 * @param {import('./workflow-state.js').RunState} previousState - State from previous run
 * @param {import('./workflow-loader.js').WorkflowDefinition} workflow - Workflow definition
 * @param {string} newRunId - New run ID for this resume attempt
 * @param {Object} api - OpenClaw plugin api
 * @param {ExecutorConfig} config - Executor configuration
 * @param {Function} stepRunner - Step runner function
 * @returns {Promise<import('./workflow-state.js').RunState>}
 *
 * @example
 * // Resume after a partial failure:
 * const finalState = await resumeWorkflow(failedState, workflow, newRunId, api, config, stepRunner);
 */
export async function resumeWorkflow(
	previousState,
	workflow,
	newRunId,
	api,
	config,
	stepRunner,
	workflowKey = null,
) {
	// Build a new state based on the previous one, resetting non-ok steps.
	// Steps that were 'ok' in the previous run are preserved — they'll be
	// skipped by the executor's scheduler loop (which only launches 'pending' steps).
	const state = createRunState(
		workflow.name,
		workflowKey || workflow.name,
		workflow.steps.map((s) => s.id),
		newRunId,
	);

	// Copy over 'ok' steps from previous run (preserve their results)
	for (const [stepId, stepStateRaw] of Object.entries(
		(previousState as RunState).steps,
	)) {
		const stepState = stepStateRaw as StepState;
		if (stepState.status === "ok") {
			(state as RunState).steps[stepId] = { ...stepState };
		}
		// All other statuses (failed, skipped, running) remain as 'pending' (reset to retry)
	}

	if (!config.stateStore || typeof config.stateStore.saveRun !== "function") {
		throw new Error("resumeWorkflow requires stateStore.saveRun");
	}

	// Save the bootstrapped state before running so it's on disk for status checks
	await config.stateStore.saveRun(state);

	// Pass initialState so executeWorkflow doesn't overwrite our pre-seeded ok steps
	return executeWorkflow(
		workflow,
		newRunId,
		api,
		config,
		stepRunner,
		state,
		workflowKey,
	);
}

/**
 * Perform a dry run — validate the workflow and report what would execute.
 * Does not spawn any sessions or write any run state.
 *
 * @param {import('./workflow-loader.js').WorkflowDefinition} workflow - Workflow definition
 * @param {string} runId - The run ID that would be used
 * @returns {Object} Dry run report with execution plan
 *
 * @example
 * const report = dryRun(workflow, 'seo-pipeline-20260309T082000');
 * console.log(report.execution_plan);
 */
export function dryRun(workflow, runId) {
	validateWorkflowTemplates(workflow);
	const varCtx = buildContext(
		runId,
		workflow.config,
		new Date(),
		workflow.config?.timezone,
		null,
		workflow.name,
	);
	const steps = workflow.steps.map((step) =>
		step.for_each ? { ...step } : substituteDeep(step, varCtx),
	);

	// Build execution waves (steps with no unresolved deps execute together)
	const waves = [];
	const completed = new Set();
	let remaining = [...steps];

	while (remaining.length > 0) {
		const wave = remaining.filter((step) => {
			if (step.for_each) return true; // Loops are always ready as they are controllers
			return step.depends_on.every((dep) => completed.has(dep));
		});

		if (wave.length === 0) {
			break;
		}

		waves.push(
			wave.map((s) => ({
				id: s.id,
				name: s.name,
				model: s.model,
				timeout_s: s.timeout,
				retry: s.retry,
				optional: s.optional,
				outputs: s.outputs,
				is_dynamic_loop: !!s.for_each,
			})),
		);

		wave.forEach((s) => completed.add(s.id));
		remaining = remaining.filter((s) => !completed.has(s.id));
	}

	return {
		run_id: runId,
		workflow: workflow.name,
		description: workflow.description,
		total_steps: steps.length,
		concurrency: workflow.concurrency,
		execution_waves: waves,
		estimated_min_duration_s: waves.reduce((sum, wave) => {
			const maxTimeout = Math.max(...wave.map((s) => s.timeout_s || 0));
			return sum + maxTimeout;
		}, 0),
		variable_context: varCtx,
	};
}
