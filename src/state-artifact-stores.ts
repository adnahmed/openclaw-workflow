import { createHash } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeJsonAtomic } from "./json-io.js";
import { validateOutputValue } from "./output-validator.js";
import type {
	ArtifactCommitResult,
	CommitArtifactArgs,
	MaterializeArtifactArgs,
	OutputValidationResult,
	RunFilter,
	RunState,
	StateBackendResolution,
	StoredArtifact,
	StoredArtifactMeta,
	StepState,
	ValidationDecision,
	WorkflowArtifactStore,
	WorkflowStateStore,
} from "./types.js";
import {
	findLatestRun,
	getLocalISOString,
	listRuns,
	readRunState,
	saveRunState,
	updateStepState,
} from "./workflow-state.js";
import { outputPathOf } from "./variable-substitution.js";

function sha256(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function isCommittableDecision(decision: ValidationDecision): boolean {
	return decision === "pass" || decision === "blocked" || decision === "retry";
}

function serializeForStorage(value: unknown, validatorType?: string): string {
	if (validatorType === "json") {
		return `${JSON.stringify(value, null, 2)}\n`;
	}
	return typeof value === "string" ? value : String(value ?? "");
}

function artifactRoot(runsDir: string): string {
	return join(runsDir, ".artifacts");
}

function lockPath(runsDir: string, runId: string): string {
	return join(runsDir, ".locks", `${runId}.lock.json`);
}

function artifactFilePath(
	runsDir: string,
	runId: string,
	stepId: string,
	outputId: string,
): string {
	return join(artifactRoot(runsDir), runId, stepId, `${outputId}.json`);
}

async function listJsonFiles(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listJsonFiles(full)));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".json")) {
			files.push(full);
		}
	}

	return files;
}

export class FilesystemStateStore implements WorkflowStateStore {
	constructor(private runsDir: string) {}

	async loadRun(runId: string): Promise<RunState> {
		return readRunState(runId, this.runsDir);
	}

	async saveRun(state: RunState): Promise<void> {
		await saveRunState(state, this.runsDir);
	}

	async updateStep(
		runId: string,
		stepId: string,
		patch: Partial<StepState>,
	): Promise<RunState> {
		const state = await readRunState(runId, this.runsDir);
		return updateStepState(state, stepId, patch, this.runsDir);
	}

	async listRuns(filter?: RunFilter): Promise<RunState[]> {
		const runs = await listRuns(this.runsDir, filter?.workflow || null);
		let selected = runs;
		if (filter?.status) {
			selected = selected.filter((r) => r.status === filter.status);
		}
		if (typeof filter?.limit === "number" && filter.limit > 0) {
			selected = selected.slice(0, filter.limit);
		}
		return selected;
	}

	async acquireLock(runId: string, owner: string, ttlMs: number): Promise<boolean> {
		const path = lockPath(this.runsDir, runId);
		await mkdir(dirname(path), { recursive: true });

		const now = Date.now();
		const next = {
			run_id: runId,
			owner,
			acquired_at: getLocalISOString(),
			expires_at_ms: now + Math.max(250, ttlMs),
		};

		try {
			await writeFile(path, JSON.stringify(next, null, 2), {
				encoding: "utf8",
				flag: "wx",
			});
			return true;
		} catch {
			try {
				const raw = await readFile(path, "utf8");
				const existing = JSON.parse(raw);
				if ((existing?.expires_at_ms || 0) > now) {
					return false;
				}
			} catch {
				// Best effort: if lock file is unreadable, allow overwrite.
			}

			await writeJsonAtomic(path, next);
			return true;
		}
	}
}

export class FilesystemArtifactStore implements WorkflowArtifactStore {
	constructor(
		private runsDir: string,
		private baseDir: string,
		private defaultMaterializeMode: "never" | "on_demand" | "always" =
			"on_demand",
	) {}

	async commitArtifact(args: CommitArtifactArgs): Promise<ArtifactCommitResult> {
		const validatorType = args.validator?.type;
		const value = validatorType === "json" ? args.data : (args.text ?? args.data);
		const serialized = serializeForStorage(value, validatorType);
		const bytes = Buffer.byteLength(serialized);
		const declaredPath = outputPathOf(args.declaredOutput);
		const targetPath = declaredPath
			? isAbsolute(declaredPath)
				? declaredPath
				: resolve(args.baseDir || this.baseDir, declaredPath)
			: undefined;

		const validation = await validateOutputValue({
			value,
			validatorId: args.validatorId,
			validator: args.validator,
			validators: args.validators || {},
			workflowDir: args.workflowDir,
			path: targetPath || args.outputId,
			bytes,
			exists: true,
		});

		if (!isCommittableDecision(validation.decision)) {
			return {
				ok: false,
				committed: false,
				decision: validation.decision,
				validation,
				message: "Artifact was not committed because validation failed.",
			};
		}

		const artifact: StoredArtifact = {
			run_id: args.runId,
			step_id: args.stepId,
			output_id: args.outputId,
			validator: args.validatorId,
			decision: validation.decision,
			data: value,
			text: typeof value === "string" ? value : undefined,
			bytes,
			sha256: sha256(serialized),
			attempt: args.attempt,
			session_key: args.sessionKey || null,
			subagent_run_id: args.subagentRunId || null,
			handoff_token: args.handoffToken || null,
			storage_backend: "filesystem",
			materialized_path: null,
			committed_at: getLocalISOString(),
		};

		const artifactPath = artifactFilePath(
			this.runsDir,
			args.runId,
			args.stepId,
			args.outputId,
		);
		await mkdir(dirname(artifactPath), { recursive: true });
		await writeJsonAtomic(artifactPath, artifact);

		const materializeMode = args.materialize || this.defaultMaterializeMode;
		if (targetPath && materializeMode === "always") {
			await mkdir(dirname(targetPath), { recursive: true });
			await writeFile(targetPath, serialized, "utf8");
			artifact.materialized_path = targetPath;
			await writeJsonAtomic(artifactPath, artifact);
		}

		return {
			ok: true,
			committed: true,
			decision: validation.decision,
			validation,
			artifact,
		};
	}

	async readArtifact(
		runId: string,
		stepId: string,
		outputId: string,
	): Promise<StoredArtifact | null> {
		const filePath = artifactFilePath(this.runsDir, runId, stepId, outputId);
		try {
			const raw = await readFile(filePath, "utf8");
			return JSON.parse(raw) as StoredArtifact;
		} catch {
			return null;
		}
	}

	async validateArtifact(args: {
		artifact: StoredArtifact;
		validatorId?: string;
		validator?: any;
		validators?: Record<string, any>;
		workflowDir?: string;
	}): Promise<OutputValidationResult> {
		return validateOutputValue({
			value: args.artifact.data,
			validatorId: args.validatorId || args.artifact.validator,
			validator: args.validator,
			validators: args.validators,
			workflowDir: args.workflowDir,
			path: args.artifact.output_id,
			bytes: args.artifact.bytes,
			exists: true,
		});
	}

	async listArtifacts(runId: string, stepId?: string): Promise<StoredArtifactMeta[]> {
		const root = stepId
			? join(artifactRoot(this.runsDir), runId, stepId)
			: join(artifactRoot(this.runsDir), runId);
		const files = await listJsonFiles(root);
		const metas: StoredArtifactMeta[] = [];

		for (const filePath of files) {
			try {
				const raw = await readFile(filePath, "utf8");
				const parsed = JSON.parse(raw) as StoredArtifact;
				metas.push({
					run_id: parsed.run_id,
					step_id: parsed.step_id,
					output_id: parsed.output_id,
					validator: parsed.validator,
					decision: parsed.decision,
					bytes: parsed.bytes,
					sha256: parsed.sha256,
					attempt: parsed.attempt,
					session_key: parsed.session_key,
					subagent_run_id: parsed.subagent_run_id,
					handoff_token: parsed.handoff_token,
					storage_backend: parsed.storage_backend,
					materialized_path: parsed.materialized_path,
					committed_at: parsed.committed_at,
				});
			} catch {
				// skip invalid artifacts
			}
		}

		metas.sort((a, b) => b.committed_at.localeCompare(a.committed_at));
		return metas;
	}

	async materializeArtifact(args: MaterializeArtifactArgs): Promise<string> {
		const artifact = await this.readArtifact(args.runId, args.stepId, args.outputId);
		if (!artifact) {
			throw new Error(
				`Artifact not found: run=${args.runId} step=${args.stepId} output=${args.outputId}`,
			);
		}

		const target = args.targetPath
			? isAbsolute(args.targetPath)
				? args.targetPath
				: resolve(args.baseDir || this.baseDir, args.targetPath)
			: resolve(
				args.baseDir || this.baseDir,
				"data",
				"materialized",
				args.runId,
				args.stepId,
				`${args.outputId}.json`,
			);

		await mkdir(dirname(target), { recursive: true });
		const content =
			typeof artifact.data === "string"
				? artifact.data
				: `${JSON.stringify(artifact.data, null, 2)}\n`;
		await writeFile(target, content, "utf8");

		artifact.materialized_path = target;
		const artifactPath = artifactFilePath(
			this.runsDir,
			args.runId,
			args.stepId,
			args.outputId,
		);
		await writeJsonAtomic(artifactPath, artifact);

		return target;
	}
}

export function resolveStateBackend(args: {
	workflowState?: {
		backend?: "filesystem" | "redis" | "auto" | "dual";
		fallback?: "filesystem" | "none";
		redis?: { provider?: "auto" | "native" | "mcp"; tool_prefix?: string };
	};
	pluginConfig?: {
		stateBackend?: "filesystem" | "redis" | "auto" | "dual";
		redisUrl?: string | null;
		redisMcpToolPrefix?: string | null;
		filesystemFallback?: boolean;
	};
}): StateBackendResolution {
	const requested =
		args.workflowState?.backend || args.pluginConfig?.stateBackend || "filesystem";

	const checked_at = getLocalISOString();
	const redisUrl = args.pluginConfig?.redisUrl || process.env.OPENCLAW_WORKFLOW_REDIS_URL;
	if (requested === "filesystem") {
		return {
			requested,
			resolved: "filesystem",
			reason: "workflow requested filesystem",
			checked_at,
			fallback: "filesystem",
		};
	}

	if (redisUrl) {
		return {
			requested,
			resolved: "redis-native",
			reason: "redis url configured",
			checked_at,
			fallback: args.workflowState?.fallback || "filesystem",
		};
	}

	const mcpProvider =
		args.workflowState?.redis?.provider === "mcp" ||
		args.workflowState?.redis?.provider === "auto";
	if (mcpProvider) {
		return {
			requested,
			resolved: "redis-mcp",
			provider:
				args.workflowState?.redis?.tool_prefix ||
				args.pluginConfig?.redisMcpToolPrefix ||
				"MCP_DOCKER",
			reason: "workflow requested MCP redis provider",
			checked_at,
			fallback: args.workflowState?.fallback || "filesystem",
		};
	}

	if (
		args.workflowState?.fallback === "filesystem" ||
		args.pluginConfig?.filesystemFallback !== false
	) {
		return {
			requested,
			resolved: "filesystem",
			reason: "redis unavailable; filesystem fallback enabled",
			checked_at,
			fallback: "filesystem",
		};
	}

	throw new Error(
		"Workflow requested Redis state, but no Redis URL or MCP Redis provider was configured and filesystem fallback is disabled.",
	);
}
