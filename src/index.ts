// @ts-nocheck
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizePluginConfig } from "./config.js";
import { runStep } from "./step-runner.js";
import {
	WorkflowCancelParameters,
	WorkflowListParameters,
	WorkflowRunParameters,
	WorkflowStatusParameters,
} from "./tool-schemas.js";
import {
	dryRun,
	executeWorkflow,
	resumeWorkflow,
} from "./workflow-executor.js";
import { listWorkflows, loadWorkflow } from "./workflow-loader.js";
import {
	findLatestRun,
	generateRunId,
	createRunState,
	readRunState,
	updateRunState,
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
							completed_at: new Date().toISOString(),
							error: message,
						},
						runsDir,
					);
				}
			} catch (stateErr) {
				logger.error(
					`[workflow:${runId}] failed to persist background failure: ${
						stateErr instanceof Error ? `${stateErr.message}\n${stateErr.stack}` : String(stateErr)
					}`,
				);
			}
		}

		function runInBackground(runId, promise) {
			promise.catch((err) => {
				void markBackgroundFailure(runId, err);
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
							),
						);

						const skippedSteps = Object.entries(lastRun.steps)
							.filter(([, step]) => step.status === "ok")
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
						workflow.steps.map((s) => s.id),
						runId,
					);

					const runningState = await updateRunState(
						initialState,
						{
							status: 'running',
							completed_at: null,
						},
						runsDir,
					);

					runInBackground(
						runId,
						executeWorkflow(workflow, runId, api, {
							...execConfig,
							sessionAdapter,
						}, runStep, runningState),
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
					for (const [stepId, stepState] of Object.entries(state.steps)) {
						stepSummary[stepId] = {
							status: stepState.status,
							attempts: stepState.attempts,
							duration_s: stepState.duration_ms
								? Math.round(stepState.duration_ms / 1000)
								: null,
							error: stepState.error,
							logs: stepState.logs,
							started_at: stepState.started_at,
							completed_at: stepState.completed_at,
						};
					}

					const elapsedMs = state.started_at
						? (state.completed_at ? new Date(state.completed_at) : new Date()) -
							new Date(state.started_at)
						: null;
					const steps = Object.values(state.steps);

					return textResult({
						run_id: state.run_id,
						workflow: state.workflow,
						status: state.status,
						started_at: state.started_at,
						completed_at: state.completed_at,
						elapsed_s: elapsedMs ? Math.round(elapsedMs / 1000) : null,
						steps_ok: steps.filter((step) => step.status === "ok").length,
						steps_failed: steps.filter((step) => step.status === "failed")
							.length,
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
			name: "workflow_cancel",
			description:
				"Cancel a running workflow. Running steps may finish, but no new steps will be launched.",
			parameters: WorkflowCancelParameters,
			optional: true,
			async execute(first, second) {
				const { run_id } = readParams(first, second);
				try {
					const state = await readRunState(run_id, runsDir);

					if (["ok", "failed", "cancelled"].includes(state.status)) {
						return textResult({
							run_id,
							message: `Run "${run_id}" is already in terminal state "${state.status}" - nothing to cancel.`,
						});
					}

					const updatedState = await updateRunState(
						state,
						{
							status: "cancelled",
							completed_at: new Date().toISOString(),
						},
						runsDir,
					);

					const inFlightSteps = Object.entries(updatedState.steps)
						.filter(([, step]) => step.status === "running")
						.map(([id]) => id);

					return textResult({
						run_id,
						status: "cancelled",
						message: `Run "${run_id}" marked as cancelled. ${
							inFlightSteps.length > 0
								? `${inFlightSteps.length} step(s) currently in-flight will complete: ${inFlightSteps.join(", ")}`
								: "No steps currently running."
						}`,
					});
				} catch (err) {
					if (err?.code === "ENOENT")
						return errorResult(`Run not found: ${run_id}`);
					return errorResult(err instanceof Error ? err.message : String(err));
				}
			},
		});
	},
});
