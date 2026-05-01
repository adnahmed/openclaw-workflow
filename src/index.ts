import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizePluginConfig } from "./config.js";
import { cancelStepSession, runStep } from "./step-runner.js";
import {
	WorkflowStepCompleteParameters,
	WorkflowStepUpdateParameters,
	WorkflowCancelParameters,
	WorkflowListParameters,
	WorkflowRunParameters,
	WorkflowStatusParameters,
} from "./tool-schemas.js";
import {
	adoptStepContract,
	computeStepContractSignature,
	evaluateCacheFreshness,
	handoffMatchesCurrentAttempt,
	validateStepContract,
	writeStepCacheManifest,
} from "./step-contract.js";
import { outputPathOf } from "./variable-substitution.js";
import type { RunState, StepState } from "./types.js";
import {
	dryRun,
	executeWorkflow,
	resumeWorkflow,
} from "./workflow-executor.js";
import { listWorkflows, loadWorkflow } from "./workflow-loader.js";
import {
	createRunState,
	findLatestRun,
	generateRunId,
	getLocalISOString,
	listRuns,
	readRunState,
	updateRunState,
	updateStepState,
} from "./workflow-state.js";

function textResult(data) {
	const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
	return { content: [{ type: "text", text }] };
}

function errorResult(message) {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		isError: true,
	};
}

function getLogger(api) {
	const logger = api?.logger ?? {};
	return {
		debug:
			typeof logger.debug === "function" ? logger.debug.bind(logger) : () => {},
		info:
			typeof logger.info === "function" ? logger.info.bind(logger) : () => {},
		warn:
			typeof logger.warn === "function" ? logger.warn.bind(logger) : () => {},
		error:
			typeof logger.error === "function" ? logger.error.bind(logger) : () => {},
	};
}

function readParams(first, second) {
	return second && typeof second === "object" ? second : (first ?? {});
}

export default definePluginEntry({
	id: "openclaw-workflow",
	name: "Workflow Orchestrator",
	description: "YAML/JSON workflow orchestration for OpenClaw agents.",
	register(api) {
		const logger = getLogger(api);
		logger.info("[workflow] plugin api capabilities", {
			hasTopLevelSessions: !!api?.sessions,
			hasTopLevelSessionsSpawn: typeof api?.sessions?.spawn === "function",
			hasRuntime: !!api?.runtime,
			hasRuntimeSubagent: !!api?.runtime?.subagent,
			hasRuntimeSubagentRun: typeof api?.runtime?.subagent?.run === "function",
			hasRuntimeSubagentWaitForRun:
				typeof api?.runtime?.subagent?.waitForRun === "function",
			hasRuntimeAgentRunEmbeddedPiAgent:
				typeof api?.runtime?.agent?.runEmbeddedPiAgent === "function",
		});

		const rawPluginConfig =
			api?.pluginConfig ??
			api?.config?.plugins?.entries?.["openclaw-workflow"]?.config ??
			{};

		const config = normalizePluginConfig(rawPluginConfig, api?.runtime ?? {});

		const sessionAdapter =
			process.env.OPENCLAW_WORKFLOW_SESSION_ADAPTER ||
			config.sessionAdapter ||
			"auto";

		logger.info("[workflow] session adapter requested", {
			sessionAdapter,
			source: process.env.OPENCLAW_WORKFLOW_SESSION_ADAPTER
				? "env"
				: config.sessionAdapter !== "auto"
					? "plugin-config"
					: "default",
		});

		const {
			workflowsDir,
			runsDir,
			baseDir,
			concurrency: concurrencyDefault,
			pollIntervalMs,
			defaultModel,
			notifyChannel,
			cronDeliveryMode,
			cronDeliveryChannel,
			cronDeliveryTo,
			cliTimeoutMs,
			cronAddTimeoutMs,
			cronRunTimeoutMs,
			cronPollTimeoutMs,
			cancelGraceMs,
		} = config;

		function buildExecutorConfig(workflow, notify) {
			return {
				runsDir,
				baseDir,
				concurrency: workflow.concurrency ?? concurrencyDefault,
				notify,
				pollIntervalMs,
				defaultModel,
				cronDeliveryMode,
				cronDeliveryChannel,
				cronDeliveryTo,
				cliTimeoutMs,
				cronAddTimeoutMs,
				cronRunTimeoutMs,
				cronPollTimeoutMs,
				cancelGraceMs,
				workflowsDir,
			};
		}

		function buildNotifier() {
			if (!notifyChannel) return () => Promise.resolve();

			return async (message) => {
				if (
					api?.notifications &&
					typeof api.notifications.send === "function"
				) {
					await api.notifications.send({ channel: notifyChannel, message });
					return;
				}
				logger.info(`[workflow-notify:${notifyChannel}] ${message}`);
			};
		}

		async function markBackgroundFailure(runId, err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(
				`[workflow:${runId}] background execution failed: ${
					err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
				}`,
			);
			try {
				const state = await readRunState(runId, runsDir);
				if (!["ok", "failed", "cancelled"].includes(state.status)) {
					await updateRunState(
						state,
						{
							status: "failed",
							completed_at: getLocalISOString(),
							error: message,
						},
						runsDir,
					);
				}
			} catch (stateErr) {
				logger.error(
					`[workflow:${runId}] failed to persist background failure: ${
						stateErr instanceof Error
							? `${stateErr.message}\n${stateErr.stack}`
							: String(stateErr)
					}`,
				);
			}
		}

		function runInBackground(runId, promise) {
			promise.catch((err) => {
				void markBackgroundFailure(runId, err);
			});
		}

		async function loadWorkflowForRun(run: RunState) {
			if (run.workflow_key) {
				try {
					return await loadWorkflow(run.workflow_key, workflowsDir);
				} catch {
					// Fall through to display name search if key fails
				}
			}

			try {
				return await loadWorkflow(run.workflow, workflowsDir);
			} catch {
				// Fallback: scan workflow files and match by display name.
			}

			const available = await listWorkflows(workflowsDir);

			for (const item of available) {
				const candidate = await loadWorkflow(item.name, workflowsDir);
				if (candidate.name === run.workflow) {
					return candidate;
				}
			}

			throw new Error(
				`Could not find workflow definition for interrupted run ${run.run_id} (${run.workflow})`,
			);
		}

		async function autoResumeInterruptedRuns() {
			const runs = await listRuns(runsDir);
			const interrupted = runs.filter((run) => run.status === "running");

			if (interrupted.length === 0) {
				logger.info("[workflow] auto-resume: no interrupted runs found");
				return;
			}

			logger.warn(
				`[workflow] auto-resume: found ${interrupted.length} interrupted run(s)`,
			);

			for (const previousRun of interrupted) {
				try {
					const workflow = await loadWorkflowForRun(previousRun);
					const newRunId = generateRunId(workflow.name);

					await updateRunState(
						previousRun,
						{
							status: "failed",
							completed_at: getLocalISOString(),
							error: `Gateway restart detected; auto-resumed as ${newRunId}`,
							resumed_as: newRunId,
						},
						runsDir,
					);

					const notify = buildNotifier();
					const execConfig = buildExecutorConfig(workflow, notify);

					runInBackground(
						newRunId,
						resumeWorkflow(
							previousRun,
							workflow,
							newRunId,
							api,
							{ ...execConfig, sessionAdapter },
							runStep,
							previousRun.workflow_key,
						),
					);

					logger.info(
						`[workflow] auto-resume: ${previousRun.run_id} -> ${newRunId}`,
					);
				} catch (err) {
					logger.error(
						`[workflow] auto-resume failed for ${previousRun.run_id}: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}
		}

		if (config.autoResumeOnStartup && api.registrationMode === "full") {
			api.registerService?.({
				id: "openclaw-workflow-auto-resume",
				async start() {
					runInBackground("auto-resume", autoResumeInterruptedRuns());
				},
			});
		}

		api.registerTool({
			name: "workflow_run",
			description:
				"Run a named workflow asynchronously. Supports dry_run validation and resume from the most recent run.",
			parameters: WorkflowRunParameters,
			optional: true,
			async execute(first, second) {
				const {
					name,
					dry_run = false,
					resume = false,
				} = readParams(first, second);
				try {
					const workflow = await loadWorkflow(name, workflowsDir);
					const runId = generateRunId(workflow.name);

					if (dry_run) {
						const plan = dryRun(workflow, runId);
						return textResult({
							dry_run: true,
							message: `Workflow "${workflow.name}" is valid. ${workflow.steps.length} step(s) would run.`,
							...plan,
						});
					}

					const notify = buildNotifier();
					const execConfig = buildExecutorConfig(workflow, notify);

					if (resume) {
						const lastRun = await findLatestRun(name, runsDir);
						if (!lastRun) {
							return errorResult(
								`No previous run found for workflow "${name}" to resume from. Run without resume:true to start fresh.`,
							);
						}

						runInBackground(
							runId,
							resumeWorkflow(
								lastRun,
								workflow,
								runId,
								api,
								{
									...execConfig,
									sessionAdapter,
								},
								runStep,
								lastRun.workflow_key,
							),
						);

						const skippedSteps = Object.entries((lastRun as RunState).steps)
							.filter(([, step]) => (step as StepState).status === "ok")
							.map(([id]) => id);

						return textResult({
							run_id: runId,
							status: "running",
							resumed_from: lastRun.run_id,
							skipped_steps: skippedSteps,
							message: `Workflow "${workflow.name}" resumed. ${skippedSteps.length} step(s) skipped (already ok). Use workflow_status to track progress.`,
						});
					}

					const initialState = createRunState(
						workflow.name,
						name,
						workflow.steps.map((s) => s.id),
						runId,
					);

					const runningState = await updateRunState(
						initialState,
						{
							status: "running",
							completed_at: null,
						},
						runsDir,
					);

					runInBackground(
						runId,
						executeWorkflow(
							workflow,
							runId,
							api,
							{
								...execConfig,
								sessionAdapter,
							},
							runStep,
							runningState,
							name,
						),
					);

					const stepSummary = {};
					for (const step of workflow.steps) {
						stepSummary[step.id] = {
							status: "pending",
							depends_on: step.depends_on,
						};
					}

					return textResult({
						run_id: runId,
						workflow: workflow.name,
						status: "running",
						total_steps: workflow.steps.length,
						steps: stepSummary,
						message: `Workflow "${workflow.name}" started. Use workflow_status with run_id "${runId}" to track progress.`,
					});
				} catch (err) {
					return errorResult(err instanceof Error ? err.message : String(err));
				}
			},
		});

		api.registerTool({
			name: "workflow_status",
			description:
				"Check workflow run status by run_id, or provide name to get the most recent run for a workflow.",
			parameters: WorkflowStatusParameters,
			async execute(first, second) {
				const { run_id, name } = readParams(first, second);
				try {
					let state;
					if (run_id) {
						state = await readRunState(run_id, runsDir);
					} else if (name) {
						state = await findLatestRun(name, runsDir);
						if (!state)
							return errorResult(`No runs found for workflow "${name}"`);
					} else {
						return errorResult("Provide either run_id or name");
					}

					const stepSummary = {};
					for (const [stepId, stepState] of Object.entries(
						(state as RunState).steps,
					)) {
						const s = stepState as StepState;
						stepSummary[stepId] = {
							status: s.status,
							attempts: s.attempts,
							duration_s: s.duration_ms
								? Math.round(s.duration_ms / 1000)
								: null,
							error: s.error,
							logs: s.logs,
							started_at: s.started_at,
							completed_at: s.completed_at,
						};
					}

					const s = state as RunState;
					const elapsedMs = s.started_at
						? (s.completed_at
								? new Date(s.completed_at).getTime()
								: Date.now()) - new Date(s.started_at).getTime()
						: null;
					const steps = Object.values(state.steps);

					return textResult({
						run_id: state.run_id,
						workflow: state.workflow,
						status: state.status,
						started_at: state.started_at,
						completed_at: state.completed_at,
						elapsed_s: elapsedMs ? Math.round(elapsedMs / 1000) : null,
						steps_ok: steps.filter(
							(step) => (step as StepState).status === "ok",
						).length,
						steps_failed: steps.filter(
							(step) => (step as StepState).status === "failed",
						).length,
						steps_blocked: steps.filter(
							(step) => (step as StepState).status === "blocked",
						).length,
						steps_total: steps.length,
						steps: stepSummary,
					});
				} catch (err) {
					if (err?.code === "ENOENT")
						return errorResult(`Run not found: ${run_id || name}`);
					return errorResult(err instanceof Error ? err.message : String(err));
				}
			},
		});

		api.registerTool({
			name: "workflow_list",
			description:
				"List available YAML/JSON workflow definitions and their most recent run status.",
			parameters: WorkflowListParameters,
			async execute() {
				try {
					const availableWorkflows = await listWorkflows(workflowsDir);
					const workflows = await Promise.all(
						availableWorkflows.map(async (workflow) => {
							const lastRun = await findLatestRun(workflow.name, runsDir);
							return {
								name: workflow.name,
								display_name: workflow.displayName || workflow.name,
								description: workflow.description,
								file: workflow.filePath,
								last_run: lastRun
									? {
											run_id: lastRun.run_id,
											status: lastRun.status,
											started_at: lastRun.started_at,
											completed_at: lastRun.completed_at,
										}
									: null,
							};
						}),
					);

					return textResult({
						workflows_dir: workflowsDir,
						count: workflows.length,
						workflows,
					});
				} catch (err) {
					return errorResult(err instanceof Error ? err.message : String(err));
				}
			},
		});

		api.registerTool({
			name: "workflow_step_update",
			description:
				"Report non-authoritative step progress and counters for an active workflow run.",
			parameters: WorkflowStepUpdateParameters,
			optional: true,
			async execute(first, second) {
				const { run_id, step_id, status, message, counters } = readParams(
					first,
					second,
				);

				try {
					let state = await readRunState(run_id, runsDir);
					const step = (state as RunState).steps?.[step_id] as StepState | undefined;

					if (!step) {
						return errorResult(
							`Step "${step_id}" does not exist in run "${run_id}".`,
						);
					}

					if (state.status !== "running") {
						return errorResult(
							`Run "${run_id}" is not active (status=${state.status}).`,
						);
					}

					const now = getLocalISOString();
					const mergedCounters = {
						...((step.counters as Record<string, number>) || {}),
						...(counters || {}),
					};

					state = await updateStepState(
						state,
						step_id,
						{
							reported_status: status || step.reported_status || "progress",
							counters:
								Object.keys(mergedCounters).length > 0 ? mergedCounters : null,
							last_update_at: now,
							last_message: message || step.last_message || null,
						},
						runsDir,
					);

					return textResult({
						ok: true,
						run_id,
						step_id,
						status: state.steps[step_id].status,
						reported_status: state.steps[step_id].reported_status,
						last_update_at: state.steps[step_id].last_update_at,
						message: "Progress update recorded.",
					});
				} catch (err) {
					if (err?.code === "ENOENT") {
						return errorResult(`Run not found: ${run_id}`);
					}
					return errorResult(err instanceof Error ? err.message : String(err));
				}
			},
		});

		api.registerTool({
			name: "workflow_step_complete",
			description:
				"Request step completion by validating the declared output contract for the active attempt.",
			parameters: WorkflowStepCompleteParameters,
			optional: true,
			async execute(first, second) {
				const params = readParams(first, second);
				const {
					run_id,
					step_id,
					reason = "generated",
					outputs,
					message,
					counters,
					metadata,
					attempt,
					session_key,
					subagent_run_id,
					handoff_token,
				} = params;

				try {
					let state = await readRunState(run_id, runsDir);
					const step = (state as RunState).steps?.[step_id] as StepState | undefined;

					if (!step) {
						return errorResult(
							`Step "${step_id}" does not exist in run "${run_id}".`,
						);
					}

					if (state.status !== "running") {
						return errorResult(
							`Run "${run_id}" is not active (status=${state.status}).`,
						);
					}

					if (step.status !== "running") {
						return errorResult(
							`Step "${step_id}" is not currently running (status=${step.status}).`,
						);
					}

					const attemptMatch = handoffMatchesCurrentAttempt({
						stepState: step,
						attempt,
						session_key,
						subagent_run_id,
						handoff_token,
					});

					if (!attemptMatch.ok) {
						const now = getLocalISOString();
						state = await updateStepState(
							state,
							step_id,
							{
								handoff: {
									...(step.handoff || {}),
									requested_at: now,
									reason,
									message,
									outputs: outputs || undefined,
									metadata,
									attempt,
									session_key,
									subagent_run_id,
									token: handoff_token,
								},
								last_update_at: now,
								last_message:
									message || `Handoff rejected: ${attemptMatch.reason}`,
							},
							runsDir,
						);

						return textResult({
							ok: false,
							decision: "fail",
							message: `Handoff rejected: ${attemptMatch.reason}`,
						});
					}

					const workflow = await loadWorkflowForRun(state as RunState);
					const workflowStepDef = workflow.steps.find((s) => s.id === step_id);

					const outputCheck = await validateStepContract({
						workflow,
						step: {
							id: step_id,
							outputs:
								(outputs && outputs.length > 0
									? outputs
									: step.declared_outputs || []),
						} as any,
						baseDir,
						workflowsDir,
						outputsOverride: outputs,
					});

					const decision = outputCheck.decision;
					let freshness: any = {
						ok: true,
						reason: "signature_match",
						current_signature: "",
						previous_signature: undefined,
						producer_run_id: undefined,
						validator_hash: undefined,
					};

					if (reason === "cache_hit" || reason === "cache_repaired") {
						freshness = await evaluateCacheFreshness({
							workflow,
							step: {
								id: step_id,
								task: workflowStepDef?.task || null,
								outputs: (step.declared_outputs || []) as any,
								output_contract_version:
									workflowStepDef?.output_contract_version,
								reuse_outputs: {
									enabled: true,
									require_signature:
										workflowStepDef?.reuse_outputs?.require_signature !== false,
									legacy_unsigned_cache:
										workflowStepDef?.reuse_outputs?.legacy_unsigned_cache ||
										"stale",
									freshness: workflowStepDef?.reuse_outputs?.freshness,
								},
							} as any,
							state,
							baseDir,
							workflowsDir,
							outputsOverride: outputs,
						});
					}

					const handoffValid =
						(decision === "pass" || decision === "blocked") && freshness.ok;

					const now = getLocalISOString();
					state = await updateStepState(
						state,
						step_id,
						{
							handoff: {
								...(step.handoff || {}),
								requested_at: now,
								reason,
								message,
								outputs: outputs || undefined,
								metadata,
								attempt,
								session_key,
								subagent_run_id,
								token: handoff_token,
							},
							counters: counters || step.counters || null,
							last_update_at: now,
							last_message: message || step.last_message || null,
							output_check: outputCheck,
						},
						runsDir,
					);

					if (!handoffValid) {
						const invalidOutputs = outputCheck.validations
							.filter((v) => v.decision !== "pass")
							.map((v) => ({
								path: v.path,
								validator: v.validator,
								errors: v.errors,
							}));

						return textResult({
							ok: false,
							decision: freshness.ok ? decision : "stale",
							missing_outputs: outputCheck.missing_files,
							invalid_outputs: invalidOutputs,
							message:
								freshness.ok
									? "Handoff received but step contract did not validate."
									: "Cached outputs passed validators but were produced under an older output contract.",
							action: freshness.ok ? "fix_outputs" : "continue_running",
						});
					}

					state = await adoptStepContract({
						state,
						runsDir,
						stepId: step_id,
						outputCheck,
						reason,
						message,
						metadata,
						counters,
					});

					try {
						const signature = await computeStepContractSignature({
							workflow,
							step: {
								id: step_id,
								task: workflowStepDef?.task || null,
								outputs: (step.declared_outputs || []) as any,
								output_contract_version:
									workflowStepDef?.output_contract_version,
								reuse_outputs: {
									enabled: true,
									freshness: workflowStepDef?.reuse_outputs?.freshness,
								},
							} as any,
							state,
							baseDir,
							workflowsDir,
							outputsOverride: outputs,
						});

						await writeStepCacheManifest({
							baseDir,
							stepId: step_id,
							outputs:
								(outputs && outputs.length > 0
									? outputs
									: (step.declared_outputs || []).map((o) => outputPathOf(o as any))),
							producerRunId: run_id,
							reason,
							decision: outputCheck.decision,
							signature,
						});
					} catch {
						// Non-fatal: handoff completion should not fail solely on manifest persistence.
					}

					const latest = state.steps[step_id] as StepState;
					if (latest.session_key && latest.status !== "running") {
						await cancelStepSession(api, {
							sessionAdapter: latest.session_adapter || sessionAdapter,
							sessionId: latest.session_id || latest.subagent_run_id,
							sessionKey: latest.session_key,
							runId: latest.session_id || run_id,
							reason: `workflow_step_handoff_complete:${step_id}`,
							cronRunTimeoutMs,
							cancelGraceMs: config.cancelGraceMs ?? 30000,
							logger,
						}).catch(() => null);
					}

					return textResult({
						ok: true,
						decision,
						status: state.steps[step_id].status,
						message:
							"Handoff accepted and step contract validated successfully.",
					});
				} catch (err) {
					if (err?.code === "ENOENT") {
						return errorResult(`Run not found: ${run_id}`);
					}
					return errorResult(err instanceof Error ? err.message : String(err));
				}
			},
		});

		api.registerTool({
			name: "workflow_cancel",
			description: "Cancel a running workflow and abort active workers.",
			parameters: WorkflowCancelParameters,
			optional: true,

			async execute(first, second) {
				const { run_id } = readParams(first, second);

				try {
					let state = await readRunState(run_id, runsDir);

					const terminal = ["ok", "failed", "cancelled"].includes(state.status);
					const runningSteps = Object.entries((state as RunState).steps).filter(
						([, step]) => (step as StepState).status === "running",
					);

					if (terminal && runningSteps.length === 0) {
						return textResult({
							run_id,
							message: `Run "${run_id}" is already in terminal state "${state.status}" - nothing to cancel.`,
						});
					}

					const now = getLocalISOString();
					state = await updateRunState(
						state,
						{
							status: "cancelled",
							cancel_requested_at: now,
							cancelled_at: now,
							completed_at: now,
						},
						runsDir,
					);

					const results = [];

					for (const [stepId, stepRaw] of runningSteps) {
						const step = stepRaw as StepState;
						const sessionKey = step.session_key;
						const sessionId = step.session_id || step.subagent_run_id || null;

						state = await updateStepState(
							state,
							stepId,
							{
								cancel_requested_at: now,
								cancellation_reason: `workflow_cancel:${run_id}`,
							},
							runsDir,
						);

						if (!sessionKey) {
							const result = {
								step_id: stepId,
								requested: false,
								confirmed: false,
								method: null,
								error: "missing session_key; cannot abort active worker",
							};

							results.push(result);

							state = await updateStepState(
								state,
								stepId,
								{
									cancel_error: result.error,
								},
								runsDir,
							);

							continue;
						}

						let cancelResult;

						try {
							cancelResult = await cancelStepSession(api, {
								sessionAdapter: step.session_adapter || sessionAdapter,
								sessionId,
								sessionKey,
								runId: sessionId || run_id,
								reason: `workflow_cancel:${run_id}`,
								cronRunTimeoutMs,
								cancelGraceMs: config.cancelGraceMs ?? 30000,
								logger,
							});
						} catch (err) {
							cancelResult = {
								requested: false,
								confirmed: false,
								method: null,
								error: err instanceof Error ? err.message : String(err),
							};
						}

						results.push({
							step_id: stepId,
							session_key: sessionKey,
							session_id: sessionId,
							...cancelResult,
						});

						state = await updateStepState(
							state,
							stepId,
							{
								cancel_method: cancelResult.method || null,
								cancel_error: cancelResult.error || null,
								cancel_confirmed_at: cancelResult.confirmed
									? getLocalISOString()
									: null,
							},
							runsDir,
						);
					}

					return textResult({
						run_id,
						status: "cancelled",
						running_steps: runningSteps.length,
						abort_requested: results.filter((r) => r.requested).length,
						abort_failed: results.filter((r) => !r.requested).length,
						results,
						message:
							runningSteps.length === 0
								? `Run "${run_id}" marked as cancelled. No workers were active.`
								: `Run "${run_id}" marked as cancelled. Abort requested for ${
										results.filter((r) => r.requested).length
									}/${runningSteps.length} active worker(s).`,
					});
				} catch (err) {
					if (err?.code === "ENOENT") {
						return errorResult(`Run not found: ${run_id}`);
					}

					return errorResult(err instanceof Error ? err.message : String(err));
				}
			},
		});
	},
});
