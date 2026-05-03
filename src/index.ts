import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizePluginConfig } from "./config.js";
import { writeDeclaredOutput } from "./output-writer.js";
import {
	adoptStepContract,
	computeStepContractSignature,
	evaluateCacheFreshness,
	handoffMatchesCurrentAttempt,
	validateStepContract,
	writeStepCacheManifest,
} from "./step-contract.js";
import { cancelStepSession, runStep } from "./step-runner.js";
import {
	WorkflowCancelParameters,
	WorkflowListParameters,
	WorkflowListOutputsParameters,
	WorkflowMaterializeOutputParameters,
	WorkflowReadOutputParameters,
	WorkflowRunParameters,
	WorkflowStatusParameters,
	WorkflowStateGetParameters,
	WorkflowStepCompleteParameters,
	WorkflowStepUpdateParameters,
	WorkflowWriteOutputParameters,
} from "./tool-schemas.js";
import type {
	CancelResult,
	OutputSpec,
	RunState,
	StepState,
	WorkflowArtifactStore,
	WorkflowStateStore,
	WorkflowStep,
} from "./types.js";
import { outputIdOf, outputPathOf } from "./variable-substitution.js";
import {
	FilesystemArtifactStore,
	FilesystemStateStore,
	RedisArtifactStore,
	RedisStateStore,
	resolveStateBackend,
} from "./state-artifact-stores.js";
import {
	dryRun,
	executeWorkflow,
	resumeWorkflow,
} from "./workflow-executor.js";
import { listWorkflows, loadWorkflow } from "./workflow-loader.js";
import { createDefaultRegistry } from "./plugin-operations.js";
import { resolveRedisClient } from "./redis-client.js";
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

		const filesystemStateStore = new FilesystemStateStore(runsDir);
		const filesystemArtifactStore = new FilesystemArtifactStore(
			runsDir,
			baseDir,
			config.materializeOutputs || "on_demand",
		);
		const stateStore = filesystemStateStore;
		const artifactStore = filesystemArtifactStore;

		// Plugin registry — always created with default built-ins
		const pluginRegistry = createDefaultRegistry();

		async function buildExecutorConfig(workflow, notify) {
			const backendResolution = resolveStateBackend({
				workflowState: workflow?.state,
				pluginConfig: {
					stateBackend: config.stateBackend,
					redisUrl: config.redisUrl,
					redisMcpToolPrefix: config.redisMcpToolPrefix,
					filesystemFallback: config.filesystemFallback,
				},
			});

			// Resolve Redis client per call (graceful fallback to null)
			let redis = null;
			if (config.redisUrl || config.redisMcpToolPrefix) {
				try {
					redis = await resolveRedisClient({
						url: config.redisUrl,
						mcpToolPrefix: config.redisMcpToolPrefix,
						api,
						filesystemFallback: config.filesystemFallback !== false,
					});
				} catch (redisErr) {
					logger.warn(`[workflow] Redis client init failed: ${redisErr?.message ?? redisErr}`);
				}
			}

			let stateStore: WorkflowStateStore = filesystemStateStore;
			let artifactStore: WorkflowArtifactStore = filesystemArtifactStore;

			if (redis && backendResolution.resolved === "redis-native") {
				stateStore = new RedisStateStore(redis);
				artifactStore = new RedisArtifactStore(
					redis,
					baseDir,
					"openclaw:workflow",
					config.materializeOutputs || "on_demand",
				);
			}

			return {
				runsDir,
				baseDir,
				concurrency: workflow.concurrency ?? concurrencyDefault,
				stateStore,
				artifactStore,
				stateBackendResolution: backendResolution,
				filesystemFallback: config.filesystemFallback,
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
				pluginRegistry,
				redis,
			};
		}

		let redisClientPromise: Promise<any> | null = null;

		async function resolveRedisHandle() {
			if (!config.redisUrl && !config.redisMcpToolPrefix) return null;
			if (!redisClientPromise) {
				redisClientPromise = resolveRedisClient({
					url: config.redisUrl,
					mcpToolPrefix: config.redisMcpToolPrefix,
					api,
					filesystemFallback: config.filesystemFallback !== false,
				}).catch((err) => {
					logger.warn(`[workflow] Redis client init failed: ${err?.message ?? err}`);
					return null;
				});
			}
			return redisClientPromise;
		}

		function isRedisResolvedBackend(backendResolution: any): boolean {
			return (
				backendResolution?.resolved === "redis-native" ||
				backendResolution?.resolved === "redis-mcp"
			);
		}

		async function resolveArtifactStoreForRun(args: {
			runState?: RunState | null;
			workflow?: any;
		}) {
			const backendResolution =
				(args.runState as any)?.state_backend ||
				resolveStateBackend({
					workflowState: args.workflow?.state,
					pluginConfig: {
						stateBackend: config.stateBackend,
						redisUrl: config.redisUrl,
						redisMcpToolPrefix: config.redisMcpToolPrefix,
						filesystemFallback: config.filesystemFallback,
					},
				});

			if (!isRedisResolvedBackend(backendResolution)) {
				return filesystemArtifactStore;
			}

			const redis = await resolveRedisHandle();
			if (!redis) return filesystemArtifactStore;

			return new RedisArtifactStore(
				redis,
				baseDir,
				"openclaw:workflow",
				config.materializeOutputs || "on_demand",
			);
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
					const execConfig = await buildExecutorConfig(workflow, notify);

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
			name: "write_output",
			description:
				"Safely write a declared workflow step output using the step's declared validator.",
			parameters: WorkflowWriteOutputParameters,
			optional: true,
			async execute(first, second) {
				const params = readParams(first, second);
				const {
					run_id,
					step_id,
					path,
					output_id,
					data,
					text,
					attempt,
					session_key,
					subagent_run_id,
					handoff_token,
				} = params;

				try {
					if (!run_id || !step_id) {
						return errorResult(
							"write_output requires run_id and step_id. These must be injected into the step prompt by the workflow runner.",
						);
					}

					if (
						(typeof data === "undefined" && typeof text === "undefined") ||
						(typeof data !== "undefined" && typeof text !== "undefined")
					) {
						return errorResult("Provide exactly one of 'data' or 'text'.");
					}

					if (!path && !output_id) {
						return errorResult("Provide one of: path or output_id.");
					}

					let state = await stateStore.loadRun(run_id);
					const step = (state as RunState).steps?.[step_id] as
						| StepState
						| undefined;

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
						return textResult({
							ok: false,
							committed: false,
							decision: "fail",
							message: `write_output rejected: ${attemptMatch.reason}`,
						});
					}

					const workflow = await loadWorkflowForRun(state as RunState);
					const runArtifactStore = await resolveArtifactStoreForRun({
						runState: state as RunState,
						workflow,
					});

					const result = await writeDeclaredOutput({
						workflow,
						state: state as RunState,
						stepId: step_id,
						path,
						output_id,
						data,
						text,
						baseDir,
						workflowsDir,
						artifactStore: runArtifactStore,
						materializeMode: config.materializeOutputs,
						attempt,
						session_key,
						subagent_run_id,
						handoff_token,
					});

					if (!result.ok || !result.committed) {
						return textResult(result);
					}

					const now = getLocalISOString();
					const outputKey =
						result.provenance.output_id || output_id || path || "(unknown)";
					const outputWrites = {
						...(step.output_writes || {}),
						[outputKey]: result.provenance,
					};

					state = await stateStore.updateStep(
						run_id,
						step_id,
						{
							output_writes: outputWrites,
							last_update_at: now,
							last_message: `Committed declared output: ${outputKey}`,
						},
					);

					return textResult({
						ok: true,
						committed: true,
						path: result.provenance.path || path,
						output_id: result.provenance.output_id || output_id,
						stored: result.provenance.storage_backend || "filesystem",
						decision: result.decision,
						validator: result.provenance.validator,
						bytes: result.provenance.bytes,
						sha256: result.provenance.sha256,
						message: "Declared output committed.",
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
					const backendResolution = resolveStateBackend({
						workflowState: workflow.state,
						pluginConfig: {
							stateBackend: config.stateBackend,
							redisUrl: config.redisUrl,
							redisMcpToolPrefix: config.redisMcpToolPrefix,
							filesystemFallback: config.filesystemFallback,
						},
					});
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
					const execConfig = await buildExecutorConfig(workflow, notify);

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
							state_backend: backendResolution,
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
						state_backend: backendResolution,
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
			name: "read_output",
			description: "Read one committed declared output artifact by output_id.",
			parameters: WorkflowReadOutputParameters,
			optional: true,
			async execute(first, second) {
				const { run_id, step_id, output_id, limit, fields } = readParams(
					first,
					second,
				);

				try {
					const runState = await readRunState(run_id, runsDir);
					const runArtifactStore = await resolveArtifactStoreForRun({
						runState,
					});
					const artifact = await runArtifactStore.readArtifact(
						run_id,
						step_id,
						output_id,
					);
					if (!artifact) {
						return errorResult(
							`Output not found: run=${run_id} step=${step_id} output_id=${output_id}`,
						);
					}

					let payload = artifact.data;
					if (Array.isArray(payload) && typeof limit === "number") {
						payload = payload.slice(0, Math.max(1, limit));
					}

					if (
						Array.isArray(payload) &&
						Array.isArray(fields) &&
						fields.length > 0
					) {
						payload = payload.map((item) => {
							if (!item || typeof item !== "object") return item;
							const picked = {};
							for (const key of fields) {
								if (Object.prototype.hasOwnProperty.call(item, key)) {
									picked[key] = item[key];
								}
							}
							return picked;
						});
					}

					return textResult({
						run_id,
						step_id,
						output_id,
						validator: artifact.validator,
						decision: artifact.decision,
						bytes: artifact.bytes,
						sha256: artifact.sha256,
						stored: artifact.storage_backend,
						materialized_path: artifact.materialized_path || null,
						data: payload,
					});
				} catch (err) {
					return errorResult(err instanceof Error ? err.message : String(err));
				}
			},
		});

		api.registerTool({
			name: "list_outputs",
			description: "List committed output artifacts for a run (optionally scoped to one step).",
			parameters: WorkflowListOutputsParameters,
			optional: true,
			async execute(first, second) {
				const { run_id, step_id } = readParams(first, second);
				try {
					const runState = await readRunState(run_id, runsDir);
					const runArtifactStore = await resolveArtifactStoreForRun({
						runState,
					});
					const artifacts = await runArtifactStore.listArtifacts(run_id, step_id);
					return textResult({
						run_id,
						step_id: step_id || null,
						count: artifacts.length,
						artifacts,
					});
				} catch (err) {
					return errorResult(err instanceof Error ? err.message : String(err));
				}
			},
		});

		api.registerTool({
			name: "materialize_output",
			description: "Materialize a stored output artifact to a file path on demand.",
			parameters: WorkflowMaterializeOutputParameters,
			optional: true,
			async execute(first, second) {
				const { run_id, step_id, output_id, path } = readParams(first, second);
				try {
					const runState = await readRunState(run_id, runsDir);
					const runArtifactStore = await resolveArtifactStoreForRun({
						runState,
					});
					const materializedPath = await runArtifactStore.materializeArtifact({
						runId: run_id,
						stepId: step_id,
						outputId: output_id,
						targetPath: path,
						baseDir,
					});

					return textResult({
						ok: true,
						run_id,
						step_id,
						output_id,
						path: materializedPath,
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
					let state: RunState | null = null;
					if (run_id) {
						state = await readRunState(run_id, runsDir);
					} else if (name) {
						state = await findLatestRun(name, runsDir);
						if (!state)
							return errorResult(`No runs found for workflow "${name}"`);
					} else {
						return errorResult("Provide either run_id or name");
					}

					const runState = state as RunState;

					const stepSummary = {};
					for (const [stepId, stepState] of Object.entries(runState.steps)) {
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

					const s = runState;
					const elapsedMs = s.started_at
						? (s.completed_at
								? new Date(s.completed_at).getTime()
								: Date.now()) - new Date(s.started_at).getTime()
						: null;
					const steps = Object.values(runState.steps);

					return textResult({
						run_id: runState.run_id,
						workflow: runState.workflow,
						status: runState.status,
						started_at: runState.started_at,
						completed_at: runState.completed_at,
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
			name: "workflow_state_get",
			description: "Read raw run state (including backend resolution) for debugging/admin.",
			parameters: WorkflowStateGetParameters,
			optional: true,
			async execute(first, second) {
				const { run_id, include_steps = true } = readParams(first, second);
				try {
					const state = await stateStore.loadRun(run_id);
					const snapshot = include_steps
						? state
						: {
							run_id: state.run_id,
							workflow: state.workflow,
							workflow_key: state.workflow_key,
							status: state.status,
							started_at: state.started_at,
							completed_at: state.completed_at,
							cancel_requested_at: state.cancel_requested_at,
							cancelled_at: state.cancelled_at,
							state_backend: (state as any).state_backend || null,
						};

					return textResult(snapshot);
				} catch (err) {
					if (err?.code === "ENOENT") {
						return errorResult(`Run not found: ${run_id}`);
					}
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
					const step = (state as RunState).steps?.[step_id] as
						| StepState
						| undefined;

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
					const step = (state as RunState).steps?.[step_id] as
						| StepState
						| undefined;

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

						// Stale-attempt fast path: if outputs already validate, store as a
						// late_success_candidate so the executor can adopt before next retry.
						if (attemptMatch.reason === "stale_attempt") {
							const workflow = await loadWorkflowForRun(state as RunState);
							const runArtifactStore = await resolveArtifactStoreForRun({
								runState: state as RunState,
								workflow,
							});
							const workflowStepDef = workflow.steps.find(
								(s) => s.id === step_id,
							);
							const declaredOutputs = step.declared_outputs || [];
							const contractStep: WorkflowStep = {
								...(workflowStepDef || {
									id: step_id,
									name: step_id,
									task: null,
									depends_on: [],
									outputs: declaredOutputs,
									timeout: 60,
									retry: 0,
									retry_delay: 0,
									optional: false,
								}),
								id: step_id,
								outputs: declaredOutputs,
							};
							const lateOutputCheck = await validateStepContract({
								workflow,
								step: contractStep,
								baseDir,
								workflowsDir,
								runId: run_id,
								stepId: step_id,
								artifactStore: runArtifactStore,
							});

							if (lateOutputCheck.passed) {
								state = await updateStepState(
									state,
									step_id,
									{
										late_success_candidate: {
											attempt: attempt ?? 0,
											handoff_token: handoff_token ?? null,
											checked_at: now,
											output_check: lateOutputCheck,
											reason: "stale_attempt_but_outputs_passed",
										},
										last_update_at: now,
										last_message: `Stale attempt ${attempt} — outputs validated; queued for adoption`,
									},
									runsDir,
								);

								return textResult({
									ok: true,
									decision: "late_success_candidate",
									message:
										"Stale attempt, but declared outputs validate and will be adopted by runner.",
								});
							}
						}

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
					const runArtifactStore = await resolveArtifactStoreForRun({
						runState: state as RunState,
						workflow,
					});
					const workflowStepDef = workflow.steps.find((s) => s.id === step_id);
					const declaredOutputs = step.declared_outputs || [];
					const contractStep: WorkflowStep = {
						...(workflowStepDef || {
							id: step_id,
							name: step_id,
							task: null,
							depends_on: [],
							outputs: declaredOutputs,
							timeout: 60,
							retry: 0,
							retry_delay: 0,
							optional: false,
						}),
						id: step_id,
						outputs: declaredOutputs,
					};

					const outputCheck = await validateStepContract({
						workflow,
						step: contractStep,
						baseDir,
						workflowsDir,
						runId: run_id,
						stepId: step_id,
						artifactStore: runArtifactStore,
					});

					const decision = outputCheck.decision;
					let freshness: {
						ok: boolean;
						reason?: string;
						current_signature: string;
						previous_signature?: string;
						producer_run_id?: string;
						validator_hash?: string;
					} = {
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
								...contractStep,
								reuse_outputs: {
									enabled: true,
									require_signature:
										workflowStepDef?.reuse_outputs?.require_signature !== false,
									legacy_unsigned_cache:
										workflowStepDef?.reuse_outputs?.legacy_unsigned_cache ||
										"stale",
									freshness: workflowStepDef?.reuse_outputs?.freshness,
								},
							},
							state,
							baseDir,
							workflowsDir,
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
							message: freshness.ok
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
								...contractStep,
								reuse_outputs: {
									enabled: true,
									freshness: workflowStepDef?.reuse_outputs?.freshness,
								},
							},
							state,
							baseDir,
							workflowsDir,
						});

						await writeStepCacheManifest({
							baseDir,
							stepId: step_id,
							outputs: declaredOutputs.map((o: OutputSpec) => outputIdOf(o)),
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

						let cancelResult: CancelResult;

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
