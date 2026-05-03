import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizePluginConfig } from "./config.js";
import { writeDeclaredOutput } from "./output-writer.js";
import { createDefaultRegistry } from "./plugin-operations.js";
import { resolveRedisClient } from "./redis-client.js";
import {
	FilesystemArtifactStore,
	FilesystemStateStore,
	RedisArtifactStore,
	RedisStateStore,
	resolveStateBackend,
} from "./state-artifact-stores.js";
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
	WorkflowListOutputsParameters,
	WorkflowListParameters,
	WorkflowMaterializeOutputParameters,
	WorkflowReadOutputParameters,
	WorkflowRunParameters,
	WorkflowStateGetParameters,
	WorkflowStatusParameters,
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
	dryRun,
	executeWorkflow,
	resumeWorkflow,
} from "./workflow-executor.js";
import { listWorkflows, loadWorkflow } from "./workflow-loader.js";
import {
	createRunState,
	generateRunId,
	getLocalISOString,
} from "./workflow-state.js";

Error.stackTraceLimit = 50;

const DEBUG_STACKS =
	process.env.OPENCLAW_WORKFLOW_DEBUG === "1" ||
	process.env.OPENCLAW_WORKFLOW_DEBUG === "true";

function dumpError(label: string, err: unknown) {
	const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);

	console.error(`[openclaw-workflow] ${label}`);
	console.error(stack);

	return stack;
}

function textResult(data) {
	const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
	return { content: [{ type: "text", text }] };
}

function errorResult(err: unknown) {
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;

	return {
		content: [
			{
				type: "text",
				text:
					DEBUG_STACKS && stack
						? `Error: ${message}\n\n${stack}`
						: `Error: ${message}`,
			},
		],
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

function getOpenClawMcpServerDefinition(
	api: unknown,
	serverName: string,
): unknown {
	if (!api || typeof api !== "object") return null;

	const apiObject = api as Record<string, unknown>;
	const config =
		(apiObject.config && typeof apiObject.config === "object"
			? (apiObject.config as Record<string, unknown>)
			: null) ||
		(apiObject.runtime &&
		apiObject.runtime &&
		typeof apiObject.runtime === "object" &&
		(apiObject.runtime as Record<string, unknown>).config &&
		typeof (apiObject.runtime as Record<string, unknown>).config === "object"
			? ((apiObject.runtime as Record<string, unknown>).config as Record<
					string,
					unknown
				>)
			: null);

	const mcp =
		config?.mcp && typeof config.mcp === "object"
			? (config.mcp as Record<string, unknown>)
			: null;
	const servers =
		mcp?.servers && typeof mcp.servers === "object"
			? (mcp.servers as Record<string, unknown>)
			: null;

	return servers?.[serverName] ?? null;
}

function resolveRedisMode(stateBackend, redisPrefer) {
	if (stateBackend === "redis") {
		if (redisPrefer === "native") return "redis-native";
		if (redisPrefer === "mcp") return "redis-mcp";
	}

	return stateBackend;
}

export default definePluginEntry({
	id: "openclaw-workflow",
	name: "Workflow Orchestrator",
	description: "YAML/JSON workflow orchestration for OpenClaw agents.",
	register(api) {
		try {
			const logger = getLogger(api);
			logger.info("[workflow] plugin api capabilities", {
				hasTopLevelSessions: !!api?.sessions,
				hasTopLevelSessionsSpawn: typeof api?.sessions?.spawn === "function",
				hasRuntime: !!api?.runtime,
				hasRuntimeSubagent: !!api?.runtime?.subagent,
				hasRuntimeSubagentRun:
					typeof api?.runtime?.subagent?.run === "function",
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
			const redisPrefix =
				config.redisPrefix ||
				process.env.OPENCLAW_WORKFLOW_REDIS_PREFIX ||
				"openclaw:workflow";

			// Plugin registry — always created with default built-ins
			const pluginRegistry = createDefaultRegistry();

			let redisClientPromise: Promise<any> | null = null;

			async function resolveRedisHandle() {
				const redisUrl =
					config.redisUrl || process.env.OPENCLAW_WORKFLOW_REDIS_URL || null;
				const redisMcpServer =
					config.redisMcpServer ??
					config.redisMcpToolPrefix ??
					process.env.OPENCLAW_WORKFLOW_REDIS_MCP_SERVER ??
					process.env.OPENCLAW_WORKFLOW_REDIS_MCP_TOOL_PREFIX ??
					null;

				if (!redisUrl && !redisMcpServer) return null;

				if (!redisClientPromise) {
					const inlineMcpDefinition =
						config.redisMcpServerDefinition ||
						(redisMcpServer
							? getOpenClawMcpServerDefinition(api, redisMcpServer)
							: null);
					const redisMode = resolveRedisMode(
						config.stateBackend,
						config.redisPrefer,
					);

					redisClientPromise = resolveRedisClient({
						url: redisUrl,
						mcpServer: redisMcpServer || undefined,
						mcpConfigPath:
							config.redisMcpConfigPath || process.env.MCPORTER_CONFIG || null,
						mcpRootDir: config.redisMcpRootDir || baseDir,
						mcpServerDefinition: inlineMcpDefinition || undefined,
						mcpCallTimeoutMs: config.redisMcpCallTimeoutMs,
						keyPrefix: undefined,
						mode: redisMode,
						logger,
						filesystemFallback: config.filesystemFallback !== false,
					}).catch((err) => {
						logger.error(
							`[workflow] Redis backend resolution failed: ${
								err instanceof Error ? err.stack || err.message : String(err)
							}`,
						);

						if (
							config.filesystemFallback === false ||
							(config.stateBackend === "redis" &&
								config.filesystemFallback !== true) ||
							(config.stateBackend === "redis-native" &&
								config.filesystemFallback !== true) ||
							(config.stateBackend === "redis-mcp" &&
								config.filesystemFallback !== true)
						) {
							throw err;
						}

						return null;
					});
				}
				return redisClientPromise;
			}

			function filesystemRuntime() {
				return {
					stateStore: filesystemStateStore,
					artifactStore: filesystemArtifactStore,
					stateBackendResolution: {
						requested: "filesystem",
						resolved: "filesystem",
						reason: "filesystem runtime",
						checked_at: getLocalISOString(),
						fallback: "filesystem",
					},
					redis: null,
				};
			}

			async function redisRuntime() {
				const redis = await resolveRedisHandle();
				if (!redis) return null;
				return {
					stateStore: new RedisStateStore(redis, redisPrefix),
					artifactStore: new RedisArtifactStore(
						redis,
						baseDir,
						redisPrefix,
						config.materializeOutputs || "on_demand",
					),
					stateBackendResolution: {
						requested: "redis",
						resolved: redis.kind === "mcp" ? "redis-mcp" : "redis-native",
						reason: "redis runtime",
						checked_at: getLocalISOString(),
						fallback: "filesystem",
						provider:
							redis.kind === "mcp"
								? config.redisMcpServer ||
									config.redisMcpToolPrefix ||
									"MCP_DOCKER"
								: undefined,
					},
					redis,
				};
			}

			async function resolveWorkflowRuntime(workflowOrRun?: any) {
				const fsRuntime = filesystemRuntime();

				const runId =
					typeof workflowOrRun === "string"
						? workflowOrRun
						: workflowOrRun?.run_id || null;

				if (runId) {
					const redisRt = await redisRuntime();
					if (redisRt) {
						try {
							await redisRt.stateStore.loadRun(runId);
							return redisRt;
						} catch {
							// Fall through to filesystem.
						}
					}

					try {
						const fsState = await fsRuntime.stateStore.loadRun(runId);
						if (
							(fsState?.state_backend?.resolved === "redis-native" ||
								fsState?.state_backend?.resolved === "redis-mcp") &&
							redisRt
						) {
							return redisRt;
						}
						return fsRuntime;
					} catch {
						if (redisRt) return redisRt;
						throw new Error(`Run not found: ${runId}`);
					}
				}

				const backendResolution =
					workflowOrRun?.state_backend ||
					resolveStateBackend({
						workflowState: workflowOrRun?.state,
						pluginConfig: {
							stateBackend: config.stateBackend,
							redisUrl:
								config.redisUrl ||
								process.env.OPENCLAW_WORKFLOW_REDIS_URL ||
								null,
							redisMcpServer:
								config.redisMcpServer ||
								config.redisMcpToolPrefix ||
								process.env.OPENCLAW_WORKFLOW_REDIS_MCP_SERVER ||
								process.env.OPENCLAW_WORKFLOW_REDIS_MCP_TOOL_PREFIX ||
								null,
							redisMcpToolPrefix:
								config.redisMcpToolPrefix ||
								process.env.OPENCLAW_WORKFLOW_REDIS_MCP_TOOL_PREFIX ||
								null,
							filesystemFallback: config.filesystemFallback,
						},
					});

				if (
					backendResolution?.resolved === "redis-native" ||
					backendResolution?.resolved === "redis-mcp"
				) {
					const redisRt = await redisRuntime();
					if (redisRt) {
						return {
							...redisRt,
							stateBackendResolution: backendResolution,
						};
					}
				}

				return {
					...fsRuntime,
					stateBackendResolution: backendResolution,
				};
			}

			async function buildExecutorConfig(workflow, notify) {
				const runtime = await resolveWorkflowRuntime(workflow);

				return {
					runsDir,
					baseDir,
					concurrency: workflow.concurrency ?? concurrencyDefault,
					stateStore: runtime.stateStore,
					artifactStore: runtime.artifactStore,
					stateBackendResolution: runtime.stateBackendResolution,
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
					redis: runtime.redis,
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
					const runtime = await resolveWorkflowRuntime(runId);
					const state = await runtime.stateStore.loadRun(runId);
					if (!["ok", "failed", "cancelled"].includes(state.status)) {
						await runtime.stateStore.updateRun(runId, {
							status: "failed",
							completed_at: getLocalISOString(),
							error: message,
						});
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
				const stores: WorkflowStateStore[] = [filesystemStateStore];
				const redisRt = await redisRuntime();
				if (redisRt) stores.push(redisRt.stateStore);

				const interruptedMap = new Map<string, RunState>();
				for (const store of stores) {
					try {
						const runs = await store.listRuns({ status: "running" });
						for (const run of runs)
							interruptedMap.set(run.run_id, run as RunState);
					} catch {
						// Ignore inaccessible backend during auto-resume scan.
					}
				}

				const interrupted = [...interruptedMap.values()];

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

						const runtime = await resolveWorkflowRuntime(previousRun);
						await runtime.stateStore.updateRun(previousRun.run_id, {
							status: "failed",
							completed_at: getLocalISOString(),
							error: `Gateway restart detected; auto-resumed as ${newRunId}`,
							resumed_as: newRunId,
						});

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

			api.registerTool(
				{
					name: "write_output",
					description:
						"Safely write a declared workflow step output using the step's declared validator.",
					parameters: WorkflowWriteOutputParameters,
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

							const runtime = await resolveWorkflowRuntime(run_id);
							let state = await runtime.stateStore.loadRun(run_id);
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
								artifactStore: runtime.artifactStore,
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

							state = await runtime.stateStore.updateStep(run_id, step_id, {
								output_writes: outputWrites,
								last_update_at: now,
								last_message: `Committed declared output: ${outputKey}`,
							});

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
							dumpError("write_output failed", err);
							if (err?.code === "ENOENT") {
								return errorResult(`Run not found: ${run_id}`);
							}
							return errorResult(err);
						}
					},
				},
				{ optional: true },
			);

			api.registerTool(
				{
					name: "workflow_run",
					description:
						"Run a named workflow asynchronously. Supports dry_run validation and resume from the most recent run.",
					parameters: WorkflowRunParameters,
					async execute(first, second) {
						const {
							name,
							dry_run = false,
							resume = false,
						} = readParams(first, second);
						try {
							const workflow = await loadWorkflow(name, workflowsDir);
							const runtime = await resolveWorkflowRuntime(workflow);
							const backendResolution = runtime.stateBackendResolution;
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
								const [lastRun] = await runtime.stateStore.listRuns({
									workflow: name,
									limit: 1,
								});
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
							const runningState: RunState = {
								...initialState,
								status: "running" as const,
								completed_at: null,
								state_backend: backendResolution,
							};
							await runtime.stateStore.saveRun(runningState);

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
							dumpError("workflow_run failed", err);
							return errorResult(err);
						}
					},
				},
				{ optional: true },
			);

			api.registerTool(
				{
					name: "read_output",
					description:
						"Read one committed declared output artifact by output_id.",
					parameters: WorkflowReadOutputParameters,
					async execute(first, second) {
						const { run_id, step_id, output_id, limit, fields } = readParams(
							first,
							second,
						);

						try {
							const runtime = await resolveWorkflowRuntime(run_id);
							await runtime.stateStore.loadRun(run_id);
							const artifact = await runtime.artifactStore.readArtifact(
								run_id,
								step_id,
								output_id,
							);
							if (!artifact) {
								return errorResult(
									`Output not found: run=${run_id} step=${step_id} output_id=${output_id}`,
								);
							}

							let projected = artifact.data;
							if (Array.isArray(projected) && typeof limit === "number") {
								projected = projected.slice(0, Math.max(1, limit));
							}

							if (
								Array.isArray(projected) &&
								Array.isArray(fields) &&
								fields.length > 0
							) {
								projected = projected.map((item) => {
									if (!item || typeof item !== "object") return item;
									const picked = {};
									for (const key of fields) {
										if (Object.hasOwn(item, key)) {
											picked[key] = item[key];
										}
									}
									return picked;
								});
							}

							const totalCount = Array.isArray(artifact.data)
								? artifact.data.length
								: 1;
							const items = Array.isArray(projected) ? projected : [projected];

							return textResult({
								ok: true,
								run_id,
								step_id,
								output_id,
								count: items.length,
								total_count: totalCount,
								items,
								meta: {
									validator: artifact.validator,
									decision: artifact.decision,
									bytes: artifact.bytes,
									sha256: artifact.sha256,
									storage_backend: artifact.storage_backend,
									materialized_path: artifact.materialized_path ?? null,
								},
							});
						} catch (err) {
							dumpError("read_output failed", err);
							return errorResult(err);
						}
					},
				},
				{ optional: true },
			);

			api.registerTool(
				{
					name: "list_outputs",
					description:
						"List committed output artifacts for a run (optionally scoped to one step).",
					parameters: WorkflowListOutputsParameters,
					async execute(first, second) {
						const { run_id, step_id } = readParams(first, second);
						try {
							const runtime = await resolveWorkflowRuntime(run_id);
							await runtime.stateStore.loadRun(run_id);
							const artifacts = await runtime.artifactStore.listArtifacts(
								run_id,
								step_id,
							);
							return textResult({
								run_id,
								step_id: step_id || null,
								count: artifacts.length,
								artifacts,
							});
						} catch (err) {
							dumpError("list_outputs failed", err);
							return errorResult(err);
						}
					},
				},
				{ optional: true },
			);

			api.registerTool(
				{
					name: "materialize_output",
					description:
						"Materialize a stored output artifact to a file path on demand.",
					parameters: WorkflowMaterializeOutputParameters,
					async execute(first, second) {
						const { run_id, step_id, output_id, path } = readParams(
							first,
							second,
						);
						try {
							const runtime = await resolveWorkflowRuntime(run_id);
							await runtime.stateStore.loadRun(run_id);
							const materializedPath =
								await runtime.artifactStore.materializeArtifact({
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
							dumpError("materialize_output failed", err);
							return errorResult(err);
						}
					},
				},
				{ optional: true },
			);

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
							const runtime = await resolveWorkflowRuntime(run_id);
							state = await runtime.stateStore.loadRun(run_id);
						} else if (name) {
							const workflow = await loadWorkflow(name, workflowsDir);
							const runtime = await resolveWorkflowRuntime(workflow);
							const [latest] = await runtime.stateStore.listRuns({
								workflow: name,
								limit: 1,
							});
							state = latest || null;
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
						dumpError("workflow_status failed", err);
						if (err?.code === "ENOENT")
							return errorResult(`Run not found: ${run_id || name}`);
						return errorResult(err);
					}
				},
			});

			api.registerTool({
				name: "workflow_state_get",
				description:
					"Read raw run state (including backend resolution) for debugging/admin.",
				parameters: WorkflowStateGetParameters,
				async execute(first, second) {
					const { run_id, include_steps = true } = readParams(first, second);
					try {
						const runtime = await resolveWorkflowRuntime(run_id);
						const state = await runtime.stateStore.loadRun(run_id);
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
						dumpError("workflow_state_get failed", err);
						if (err?.code === "ENOENT") {
							return errorResult(`Run not found: ${run_id}`);
						}
						return errorResult(err);
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
								let lastRun = null;
								try {
									const loaded = await loadWorkflow(
										workflow.name,
										workflowsDir,
									);
									const runtime = await resolveWorkflowRuntime(loaded);
									const [latest] = await runtime.stateStore.listRuns({
										workflow: workflow.name,
										limit: 1,
									});
									lastRun = latest || null;
								} catch {
									lastRun = null;
								}
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
						dumpError("workflow_list failed", err);
						return errorResult(err);
					}
				},
			});

			api.registerTool(
				{
					name: "workflow_step_update",
					description:
						"Report non-authoritative step progress and counters for an active workflow run.",
					parameters: WorkflowStepUpdateParameters,
					async execute(first, second) {
						const { run_id, step_id, status, message, counters } = readParams(
							first,
							second,
						);

						try {
							const runtime = await resolveWorkflowRuntime(run_id);
							let state = await runtime.stateStore.loadRun(run_id);
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

							state = await runtime.stateStore.updateStep(run_id, step_id, {
								reported_status: status || step.reported_status || "progress",
								counters:
									Object.keys(mergedCounters).length > 0
										? mergedCounters
										: null,
								last_update_at: now,
								last_message: message || step.last_message || null,
							});

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
							dumpError("workflow_step_update failed", err);
							if (err?.code === "ENOENT") {
								return errorResult(`Run not found: ${run_id}`);
							}
							return errorResult(err);
						}
					},
				},
				{ optional: true },
			);

			api.registerTool(
				{
					name: "workflow_step_complete",
					description:
						"Request step completion by validating the declared output contract for the active attempt.",
					parameters: WorkflowStepCompleteParameters,
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
							const runtime = await resolveWorkflowRuntime(run_id);
							let state = await runtime.stateStore.loadRun(run_id);
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
									const runArtifactStore = runtime.artifactStore;
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
										state = await runtime.stateStore.updateStep(
											run_id,
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
										);

										return textResult({
											ok: true,
											decision: "late_success_candidate",
											message:
												"Stale attempt, but declared outputs validate and will be adopted by runner.",
										});
									}
								}

								state = await runtime.stateStore.updateStep(run_id, step_id, {
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
								});

								return textResult({
									ok: false,
									decision: "fail",
									message: `Handoff rejected: ${attemptMatch.reason}`,
								});
							}

							const workflow = await loadWorkflowForRun(state as RunState);
							const runArtifactStore = runtime.artifactStore;
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
												workflowStepDef?.reuse_outputs?.require_signature !==
												false,
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
							state = await runtime.stateStore.updateStep(run_id, step_id, {
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
							});

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
								stateStore: runtime.stateStore,
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
									outputs: declaredOutputs.map((o: OutputSpec) =>
										outputIdOf(o),
									),
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
							dumpError("workflow_step_complete failed", err);
							if (err?.code === "ENOENT") {
								return errorResult(`Run not found: ${run_id}`);
							}
							return errorResult(err);
						}
					},
				},
				{ optional: true },
			);

			api.registerTool({
				name: "workflow_cancel",
				description: "Cancel a running workflow and abort active workers.",
				parameters: WorkflowCancelParameters,
				optional: true,

				async execute(first, second) {
					const { run_id } = readParams(first, second);

					try {
						const runtime = await resolveWorkflowRuntime(run_id);
						let state = await runtime.stateStore.loadRun(run_id);

						const terminal = ["ok", "failed", "cancelled"].includes(
							state.status,
						);
						const runningSteps = Object.entries(
							(state as RunState).steps,
						).filter(([, step]) => (step as StepState).status === "running");

						if (terminal && runningSteps.length === 0) {
							return textResult({
								run_id,
								message: `Run "${run_id}" is already in terminal state "${state.status}" - nothing to cancel.`,
							});
						}

						const now = getLocalISOString();
						state = await runtime.stateStore.updateRun(run_id, {
							status: "cancelled",
							cancel_requested_at: now,
							cancelled_at: now,
							completed_at: now,
						});

						const results = [];

						for (const [stepId, stepRaw] of runningSteps) {
							const step = stepRaw as StepState;
							const sessionKey = step.session_key;
							const sessionId = step.session_id || step.subagent_run_id || null;

							state = await runtime.stateStore.updateStep(run_id, stepId, {
								cancel_requested_at: now,
								cancellation_reason: `workflow_cancel:${run_id}`,
							});

							if (!sessionKey) {
								const result = {
									step_id: stepId,
									requested: false,
									confirmed: false,
									method: null,
									error: "missing session_key; cannot abort active worker",
								};

								results.push(result);

								state = await runtime.stateStore.updateStep(run_id, stepId, {
									cancel_error: result.error,
								});

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

							state = await runtime.stateStore.updateStep(run_id, stepId, {
								cancel_method: cancelResult.method || null,
								cancel_error: cancelResult.error || null,
								cancel_confirmed_at: cancelResult.confirmed
									? getLocalISOString()
									: null,
							});
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
						dumpError("workflow_cancel failed", err);
						if (err?.code === "ENOENT") {
							return errorResult(`Run not found: ${run_id}`);
						}

						return errorResult(err);
					}
				},
			});
		} catch (err) {
			dumpError("plugin registration failed", err);
			throw err;
		}
	},
});
