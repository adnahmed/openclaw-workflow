// @ts-nocheck
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
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { checkOutputs } from "./output-checker.js";
import { StepRunResult, OutputCheckResult } from "./types.js";

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
async function runOpenClaw(args, options = {}) {
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

Browser File Upload Protocol:
The file to upload is already present in OpenClaw's uploads directory.
Never interact with the native OS file picker. Do not click inside it, type a
filename into it, or wait for a human to choose a file.

Use OpenClaw's upload command as the upload mechanism.

For JS upload buttons, hidden file inputs, or dynamically-created file inputs:
1. Take a fresh browser snapshot.
2. Find the ref for the visible upload button, upload area, dropzone, or control
   that would normally open the file chooser.
3. Run:
   openclaw browser upload "<UPLOADS_DIR>\\<FILE>" --ref <UPLOAD_TRIGGER_REF>
4. Do NOT click the upload button normally before running upload.
5. Do NOT try to operate the native OS file picker if it appears.
6. If the ref is stale or upload fails, take a fresh snapshot and retry with the
   new upload trigger ref.

For already-visible file inputs:
1. Take a fresh browser snapshot.
2. Find the ref for the actual file input.
3. Run:
   openclaw browser upload "<UPLOADS_DIR>\\<FILE>" --input-ref <INPUT_REF>

Path rules:
- On Windows-native OpenClaw, <UPLOADS_DIR> is usually:
  %TEMP%\\openclaw\\uploads
- On WSL/Docker/Linux OpenClaw, <UPLOADS_DIR> is usually:
  /tmp/openclaw/uploads
- Use the path visible to the OpenClaw Gateway/browser-control process.
- Do not mix Windows host paths with WSL/Docker/Linux paths.

Important distinction:
- Use --ref for a visible upload button/dropzone/control that opens the chooser.
- Use --input-ref only when the real file input itself is visible in the snapshot.
- Prefer --ref for hidden or dynamically-created file inputs.
- Do not use CSS --element targeting in existing-session/user-profile uploads.

Browser-use rule:
Use browser-use upload_file only when a real file input is available. Do not click an
upload button and then wait on the native OS picker. If browser-use cannot access a
usable file input, use OpenClaw's upload flow above.
`;

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
	} = options;

	if (cancelled) {
		return {
			status: "failed",
			session_key: null,
			output_check: { passed: false, missing_files: [], checked_files: [] },
			error: "Step was cancelled",
			logs: null,
			duration_ms: 0,
		};
	}

	const startTime = Date.now();
	const adapter = selectAdapter(api, options.sessionAdapter || "auto");
	let sessionKey = null;

	try {
		const model = step.model || defaultModel || null;
		const taskWithPreamble = EXEC_POLL_PREAMBLE + step.task;

		const spawnResult = await adapter.spawn(taskWithPreamble, {
			model,
			timeout: step.timeout,
			sessionTarget: "isolated",
			label: `wf:${runId}:${step.id}`,
			cronDeliveryMode,
			cronDeliveryChannel,
			cronDeliveryTo,
			cliTimeoutMs,
			cronAddTimeoutMs,
			cronRunTimeoutMs,
			cronPollTimeoutMs,
		});
		sessionKey = spawnResult.sessionKey;

		const timeoutMs = step.timeout * 1000;
		const deadline = Date.now() + timeoutMs;
		let finalStatus = null;
		let retryable = false;
		let errorMsg = null;
		let logs = null;
		let outputCheck = { passed: false, missing_files: [], checked_files: [] };

		while (Date.now() < deadline) {
			await sleep(pollIntervalMs);

			if (step.complete_when === "outputs" && step.outputs && step.outputs.length > 0) {
				outputCheck = await checkOutputs(step.outputs, baseDir, validators, workflowDir);
				const mapped = statusFromOutputDecision(outputCheck);
				finalStatus = mapped.finalStatus;
				retryable = mapped.retryable;
				errorMsg = mapped.errorMsg;
				if (finalStatus !== null) {
					break;
				}
			}

			const statusResult = await adapter.getStatus(spawnResult.sessionId, options);

			if (statusResult.status === "done") {
				logs = statusResult.logs;
				outputCheck = await checkOutputs(step.outputs, baseDir, validators, workflowDir);

				const mapped = statusFromOutputDecision(outputCheck);
				finalStatus = mapped.finalStatus;
				retryable = mapped.retryable;
				errorMsg = mapped.errorMsg;

				break;
			}
			if (statusResult.status === "error") {
				outputCheck = await checkOutputs(step.outputs, baseDir, validators, workflowDir);
				finalStatus = "failed";
				errorMsg = statusResult.error || "Step session exited with error";
				logs = statusResult.logs;
				break;
			}
		}

		if (finalStatus === "ok" || finalStatus === null) {
			outputCheck = await checkOutputs(step.outputs, baseDir, validators, workflowDir);
		}

		if (finalStatus === null) {
			const cancelResult = await adapter.cancel?.(spawnResult.sessionId, {
				...options,
				sessionKey: spawnResult.sessionKey,
				runId: spawnResult.sessionId,
				reason: `workflow_step_timeout:${step.id}`,
				timeoutMs,
				cancelGraceMs: options.cancelGraceMs ?? 30000,
			}).catch((err) => ({
				requested: false,
				confirmed: false,
				error: err instanceof Error ? err.message : String(err),
			}));

			const stopped = await waitForTerminalAfterCancel(
				adapter,
				spawnResult.sessionId,
				options,
				options.cancelGraceMs ?? 30000,
				pollIntervalMs,
			);

			finalStatus = "failed";
			errorMsg =
				stopped
					? `Step timed out after ${step.timeout}s; cancellation requested via ${cancelResult?.method || "unknown"}`
					: `Step timed out after ${step.timeout}s; cancellation was not confirmed. Do not retry automatically. Cancel result: ${cancelResult?.error || "unknown"}`;

			logs = stopped?.logs || logs;
		} else if (finalStatus === "ok") {
			// The final status is already determined by statusFromOutputDecision in the polling loop.
			// We keep this block for compatibility or if finalStatus was set to "ok" elsewhere,
			// but the logic is now centralized.
			const mapped = statusFromOutputDecision(outputCheck);
			finalStatus = mapped.finalStatus;
			retryable = mapped.retryable;
			errorMsg = mapped.errorMsg;
		}

		return {
			status: finalStatus,
			retryable,
			session_key: sessionKey,
			output_check: outputCheck,
			error: errorMsg,
			logs: logs,
			duration_ms: Date.now() - startTime,
		};
	} catch (err) {
		return {
			status: "failed",
			session_key: sessionKey,
			output_check: { passed: false, missing_files: [], checked_files: [] },
			error: err.message,
			logs: null,
			duration_ms: Date.now() - startTime,
		};
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
class RuntimeSubagentAdapter {
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
		this.sessionsByRunId = new Map();
	}

	/**
	 * @param {string} prompt - Task prompt
	 * @param {Object} options - Spawn options (model, timeout, label, etc.)
	 * @returns {Promise<{ sessionId: string, sessionKey: string }>}
	 */
	async spawn(prompt, options = {}) {
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
	async getStatus(runId, options = {}) {
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

	async cancel(runId, options = {}) {
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

		const attempts = [
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
function selectAdapter(api, requestedAdapter = "auto") {
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

	if (requestedAdapter === "runtime-subagent") {
		if (!hasRuntimeSubagent) {
			throw new Error(
				"sessionAdapter=runtime-subagent requested, but api.runtime.subagent.run/waitForRun is unavailable",
			);
		}

		logger?.info?.("[workflow] using RuntimeSubagentAdapter");
		return new RuntimeSubagentAdapter(api.runtime, api, logger);
	}

	if (requestedAdapter === "legacy-api") {
		if (!hasLegacyApi) {
			throw new Error(
				"sessionAdapter=legacy-api requested, but api.sessions.spawn/getStatus is unavailable",
			);
		}

		logger?.info?.("[workflow] using legacy ApiAdapter");
		return new ApiAdapter(api.sessions);
	}

	if (requestedAdapter === "cli") {
		logger?.warn?.("[workflow] using CliAdapter because sessionAdapter=cli");
		return new CliAdapter();
	}

	if (requestedAdapter !== "auto") {
		throw new Error(
			`Invalid sessionAdapter "${requestedAdapter}". Expected auto, runtime-subagent, legacy-api, or cli.`,
		);
	}

	if (hasRuntimeSubagent) {
		logger?.info?.("[workflow] using RuntimeSubagentAdapter");
		return new RuntimeSubagentAdapter(api.runtime, api, logger);
	}

	if (hasLegacyApi) {
		logger?.info?.("[workflow] using legacy ApiAdapter");
		return new ApiAdapter(api.sessions);
	}

	logger?.warn?.("[workflow] using CliAdapter fallback; steps will run through cron");
	return new CliAdapter();
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
class ApiAdapter {
	/**
	 * @param {Object} sessions - api.sessions object from OpenClaw
	 */
	constructor(sessions) {
		this.sessions = sessions;
	}

	/**
	 * @param {string} prompt  - Task prompt for the subagent
	 * @param {Object} options - Spawn options (model, timeout, label, etc.)
	 * @returns {Promise<{ sessionId: string, sessionKey: string }>}
	 */
	async spawn(prompt, options) {
		return await this.sessions.spawn(prompt, options);
	}

	/**
	 * @param {string} sessionId - Session ID returned by spawn()
	 * @returns {Promise<{ status: string, error?: string }>}
	 */
	async getStatus(sessionId, options) {
		const status = await this.sessions.getStatus(sessionId);
		return {
			status: status.status === "done" ? "done" : status.status,
			error: status.error,
			logs: status.logs,
		};
	}

	async cancel(sessionId, options = {}) {
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

export class CliAdapter {
	/**
	 * @param {Function} [executor] - Optional function to execute OpenClaw commands.
	 * Defaults to the module-level `runOpenClaw`.
	 */
	constructor(executor = runOpenClaw) {
		this.executor = executor;
	}

	/**
	 * @param {string} prompt  - Task prompt
	 * @param {Object} options - Options (model, timeout, label)
	 * @returns {Promise<{ sessionId: string, sessionKey: string }>}
	 */
	async spawn(prompt, options) {
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
	async getStatus(sessionId, options = {}) {
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

	async cancel(sessionId, options = {}) {
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
export class MockAdapter {
	/**
	 * @param {Object} options
	 * @param {number}  [options.resolveIn=100]    - Simulated duration in ms
	 * @param {boolean} [options.shouldFail=false] - Whether the session should fail
	 * @param {string}  [options.failMessage]      - Error message if shouldFail is true
	 */
	constructor(options = {}) {
		this.resolveIn = options.resolveIn ?? 100;
		this.shouldFail = options.shouldFail ?? false;
		this.failMessage = options.failMessage || "Mock step failure";
		this._sessions = new Map();
		this._counter = 0;
	}

	async spawn(prompt, options) {
		const sessionId = `mock-session-${++this._counter}`;
		const sessionKey = `agent:mock:subagent:${sessionId}`;

		// Schedule completion after resolveIn ms
		const result = { status: this.shouldFail ? "error" : "done" };
		if (this.shouldFail) result.error = this.failMessage;

		setTimeout(() => {
			this._sessions.set(sessionId, result);
		}, this.resolveIn);

		this._sessions.set(sessionId, { status: "running" });
		return { sessionId, sessionKey };
	}

	async getStatus(sessionId) {
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
				output_check: { passed: false, missing_files: [], checked_files: [] },
				error: "Step was cancelled",
				duration_ms: 0,
			};
		}
		const startTime = Date.now();
		let sessionKey = null;

		try {
			const model = step.model || options.defaultModel || null;
			const taskWithPreamble = EXEC_POLL_PREAMBLE + step.task;
			const spawnResult = await adapter.spawn(taskWithPreamble, {
				model,
				timeout: step.timeout,
				sessionTarget: "isolated",
				label: `wf:${runId}:${step.id}`,
			});
			sessionKey = spawnResult.sessionKey;

			const timeoutMs = step.timeout * 1000;
			const deadline = Date.now() + timeoutMs;
			let finalStatus = null;
			let errorMsg = null;
			let outputCheck = { passed: false, missing_files: [], checked_files: [] };

			while (Date.now() < deadline) {
				await sleep(pollIntervalMs);

				if (step.complete_when === "outputs" && step.outputs && step.outputs.length > 0) {
					outputCheck = await checkOutputs(step.outputs, baseDir, validators, workflowDir);
					const mapped = statusFromOutputDecision(outputCheck);
					finalStatus = mapped.finalStatus;
					if (finalStatus !== null) {
						break;
					}
				}

				const statusResult = await adapter.getStatus(
					spawnResult.sessionId,
					options,
				);
				if (statusResult.status === "done") {
					outputCheck = await checkOutputs(step.outputs, baseDir, validators, workflowDir);
					const mapped = statusFromOutputDecision(outputCheck);
					finalStatus = mapped.finalStatus;
					break;
				}
				if (statusResult.status === "error") {
					outputCheck = await checkOutputs(step.outputs, baseDir, validators, workflowDir);
					finalStatus = "failed";
					errorMsg = statusResult.error || "Session error";
					break;
				}
			}

			if (finalStatus === "ok" || finalStatus === null) {
				outputCheck = await checkOutputs(step.outputs, baseDir, validators, workflowDir);
			}

			if (finalStatus === null) {
				const hasOutputs = step.outputs && step.outputs.length > 0;
				if (hasOutputs && outputCheck.decision === "pass") {
					finalStatus = "ok";
				} else {
					finalStatus = "failed";
					errorMsg = `Step timed out after ${step.timeout}s`;
				}
			} else if (finalStatus === "ok") {
				const mapped = statusFromOutputDecision(outputCheck);
				finalStatus = mapped.finalStatus;
				errorMsg = mapped.errorMsg;
			}

			return {
				status: finalStatus,
				session_key: sessionKey,
				output_check: outputCheck,
				error: errorMsg,
				duration_ms: Date.now() - startTime,
			};
		} catch (err) {
			return {
				status: "failed",
				session_key: sessionKey,
				output_check: { passed: false, missing_files: [], checked_files: [] },
				error: err.message,
				duration_ms: Date.now() - startTime,
			};
		}
	};
}
