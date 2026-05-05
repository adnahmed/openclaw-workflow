import { runSealedCommandStep } from "./sealed-command-runner.js";
import { normalizeSealedSpec } from "./sealed-policy.js";
import { runStep } from "./step-runner.js";
import type {
	StepRunResult,
	ValidatorSpec,
	WorkflowArtifactStore,
	WorkflowDefinition,
	WorkflowStep,
} from "./types.js";

type RunStepOptionsLike = {
	pollIntervalMs?: number;
	baseDir?: string;
	defaultModel?: string;
	attempts?: number;
	handoffToken?: string;
	validators?: Record<string, ValidatorSpec>;
	workflowDir?: string;
	artifactStore?: WorkflowArtifactStore | null;
	filesystemFallback?: boolean;
	workflow?: WorkflowDefinition;
	sessionAdapter?: string;
	injectedContext?: Record<string, unknown>;
	injectedContextLogs?: string[];
	[k: string]: unknown;
};

function buildSealedWorkerPreamble(args: {
	step: WorkflowStep;
	runId: string;
	attempt?: number;
	handoffToken?: string;
}): string {
	const attemptLine =
		typeof args.attempt === "number"
			? `- attempt: ${args.attempt}`
			: "- attempt: <current attempt>";
	const tokenLine = args.handoffToken
		? `- handoff_token: "${args.handoffToken}"`
		: "- handoff_token: <injected by workflow runtime>";

	return `
IMPORTANT — sealed worker boundary:
- Tool calls in this step return sealed observation envelopes, not raw payloads.
- Use envelope.control to decide whether an action worked:
	- control.ok / control.error
	- control.url / control.title / control.page_loaded
	- control.visible_item_count
	- control.scroll.near_bottom
	- control.batch_items / control.total_items / control.exhausted
- Do not ask tools to return full DOM, full page text, full logs, or full network payloads.
- When more detail is needed, use workflow_observation_read, workflow_observation_search, or workflow_observation_json_path with bounded max_bytes.
- The final source of truth is declared outputs written with write_output.

Execution metadata:
- run_id: "${args.runId}"
- step_id: "${args.step.id}"
${attemptLine}
${tokenLine}
`;
}

export async function runSealedStep(
	step: WorkflowStep,
	runId: string,
	api: unknown,
	options: RunStepOptionsLike,
): Promise<StepRunResult> {
	const sealed = normalizeSealedSpec(step.sealed);

	if (sealed.mode === "command" || sealed.no_model) {
		if (!options.artifactStore) {
			return {
				status: "failed",
				retryable: false,
				failure_kind: "other",
				session_key: null,
				output_check: {
					passed: false,
					decision: "fail",
					missing_files: [],
					checked_files: [],
					validations: [],
				},
				error: "sealed command mode requires artifactStore",
				logs: null,
				duration_ms: 0,
			};
		}

		return runSealedCommandStep(step, runId, {
			artifactStore: options.artifactStore,
			validators: options.validators || {},
			baseDir: options.baseDir || process.cwd(),
			workflowDir: options.workflowDir || process.cwd(),
			filesystemFallback: options.filesystemFallback !== false,
		});
	}

	const workerPreamble = buildSealedWorkerPreamble({
		step,
		runId,
		attempt: options.attempts,
		handoffToken: options.handoffToken,
	});

	const workerStep: WorkflowStep = {
		...step,
		task: `${workerPreamble}\n${step.task || ""}`,
	};

	return (await runStep(workerStep, runId, api, {
		...options,
		sealed,
	})) as StepRunResult;
}
