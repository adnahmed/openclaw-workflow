import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { checkStepContract } from "./output-checker.js";
import { validateReturnContract } from "./return-contract.js";
import { normalizeSealedSpec } from "./sealed-policy.js";
import {
	type SealedResultEnvelope,
	spoolStream,
	summarizeTextLike,
} from "./sealed-spool.js";
import type {
	StepRunResult,
	ValidatorSpec,
	WorkflowArtifactStore,
	WorkflowStep,
} from "./types.js";

export type SealedRunnerOptions = {
	artifactStore: WorkflowArtifactStore;
	validators: Record<string, ValidatorSpec>;
	baseDir: string;
	workflowDir: string;
	filesystemFallback?: boolean;
};

function normalizeCommand(command: WorkflowStep["sealed"]["command"]): {
	argv: string[];
	cwd?: string;
	env?: Record<string, string>;
} {
	if (!command) {
		throw new Error("Sealed command step is missing sealed.command");
	}

	if (typeof command === "string") {
		return {
			argv:
				process.platform === "win32"
					? ["cmd.exe", "/d", "/s", "/c", command]
					: ["/bin/sh", "-lc", command],
		};
	}

	if (!Array.isArray(command.argv) || command.argv.length === 0) {
		throw new Error("sealed.command.argv must be a non-empty array");
	}

	return {
		argv: command.argv,
		cwd: command.cwd,
		env: command.env,
	};
}

async function spawnBounded(
	step: WorkflowStep,
	runId: string,
	artifactStore: WorkflowArtifactStore,
): Promise<{
	status: "ok" | "failed";
	exitCode: number;
	stdout: string;
	stderr: string;
	envelope: Record<string, unknown>;
	durationMs: number;
}> {
	const sealed = normalizeSealedSpec(step.sealed);
	const command = normalizeCommand(sealed.command);
	const maxStdout = Math.max(
		256,
		sealed.stdout_policy.max_stdout_bytes ?? 2048,
	);
	const maxStderr = Math.max(
		256,
		sealed.stdout_policy.max_stderr_bytes ?? 4096,
	);
	const maxProcess = Math.max(
		1024,
		sealed.stdout_policy.max_process_output_bytes ?? 100 * 1024 * 1024,
	);

	const startedAt = Date.now();

	const child = spawn(command.argv[0], command.argv.slice(1), {
		cwd: command.cwd ? resolve(command.cwd) : process.cwd(),
		env: { ...process.env, ...(command.env || {}) },
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});

	let stdout = "";
	let stderr = "";
	let totalBytes = 0;
	let exceededProcessCap = false;

	child.stdout.on("data", (chunk: Buffer | string) => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		stdout += text;
		totalBytes += Buffer.byteLength(text);
		if (totalBytes > maxProcess) {
			exceededProcessCap = true;
			child.kill("SIGKILL");
		}
	});

	child.stderr.on("data", (chunk: Buffer | string) => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		stderr += text;
		totalBytes += Buffer.byteLength(text);
		if (totalBytes > maxProcess) {
			exceededProcessCap = true;
			child.kill("SIGKILL");
		}
	});

	const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("close", (code) => resolveExit(code ?? -1));
	});

	const stdoutEnvelope =
		Buffer.byteLength(stdout) > maxStdout
			? await spoolStream({
					artifactStore,
					runId,
					stepId: step.id,
					outputId: "__sealed_spool/stdout",
					text: stdout,
					maxPreviewBytes: maxStdout,
				})
			: summarizeTextLike(stdout);

	const stderrEnvelope =
		Buffer.byteLength(stderr) > maxStderr
			? await spoolStream({
					artifactStore,
					runId,
					stepId: step.id,
					outputId: "__sealed_spool/stderr",
					text: stderr,
					maxPreviewBytes: maxStderr,
				})
			: summarizeTextLike(stderr);

	const envelope = {
		status: exceededProcessCap || exitCode !== 0 ? "failed" : "ok",
		exit_code: exitCode,
		exceeded_process_output_cap: exceededProcessCap,
		stdout: stdoutEnvelope,
		stderr: stderrEnvelope,
	};

	return {
		status: exceededProcessCap || exitCode !== 0 ? "failed" : "ok",
		exitCode,
		stdout,
		stderr,
		envelope,
		durationMs: Date.now() - startedAt,
	};
}

function extractTinyReturn(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		const firstBrace = trimmed.indexOf("{");
		const lastBrace = trimmed.lastIndexOf("}");
		if (firstBrace >= 0 && lastBrace > firstBrace) {
			try {
				return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
			} catch {
				return null;
			}
		}
		return null;
	}
}

function addEnvelopeRef(
	envelope: Record<string, unknown>,
	ret?: SealedResultEnvelope,
): Record<string, unknown> {
	if (!ret) return envelope;
	return {
		...envelope,
		return_ref: ret,
	};
}

export async function runSealedCommandStep(
	step: WorkflowStep,
	runId: string,
	options: SealedRunnerOptions,
): Promise<StepRunResult> {
	const sealed = normalizeSealedSpec(step.sealed);
	const result = await spawnBounded(step, runId, options.artifactStore);

	const tinyReturn = extractTinyReturn(result.stdout);
	const returnValidation = validateReturnContract(
		tinyReturn,
		sealed.return_contract,
	);
	if (!returnValidation.ok) {
		const validationErrors =
			"errors" in returnValidation ? returnValidation.errors : [];
		return {
			status: "failed",
			retryable: false,
			failure_kind: "schema",
			session_key: null,
			output_check: {
				passed: false,
				decision: "fail",
				missing_files: [],
				checked_files: [],
				validations: [],
			},
			error: "Sealed return_contract validation failed",
			logs: JSON.stringify(
				addEnvelopeRef(result.envelope, {
					status: "failed",
					kind: "json_object",
					preview: {
						errors: validationErrors,
					},
				}),
			),
			duration_ms: result.durationMs,
		};
	}

	if (tinyReturn !== null) {
		await options.artifactStore.commitArtifact({
			runId,
			stepId: step.id,
			outputId: "__sealed_return",
			declaredOutput: { id: "__sealed_return" },
			data: tinyReturn,
		});
	}

	const outputCheck = await checkStepContract({
		outputs: step.outputs,
		validators: options.validators,
		artifactStore: options.artifactStore,
		runId,
		stepId: step.id,
		baseDir: options.baseDir,
		workflowDir: options.workflowDir,
		filesystemFallback: options.filesystemFallback,
	});

	if (!outputCheck.passed) {
		return {
			status: "failed",
			retryable: true,
			failure_kind: outputCheck.validations[0]?.failure_kind ?? "missing_file",
			session_key: null,
			output_check: outputCheck,
			error: `Sealed command did not satisfy output contract (${outputCheck.decision})`,
			logs: JSON.stringify(result.envelope),
			duration_ms: result.durationMs,
		};
	}

	if (result.status !== "ok") {
		return {
			status: "failed",
			retryable: true,
			failure_kind: result.exitCode === 0 ? "other" : "fail_when",
			session_key: null,
			output_check: outputCheck,
			error: `Sealed command exited with code ${result.exitCode}`,
			logs: JSON.stringify(result.envelope),
			duration_ms: result.durationMs,
		};
	}

	return {
		status: "ok",
		session_key: null,
		output_check: outputCheck,
		error: null,
		logs: JSON.stringify(result.envelope),
		duration_ms: result.durationMs,
	};
}
