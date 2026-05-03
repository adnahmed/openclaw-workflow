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
	RedisClient,
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
import { outputIdOf, outputPathOf } from "./variable-substitution.js";

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

async function readJsonArrayIndex(
	redis: RedisClient,
	key: string,
): Promise<string[]> {
	const raw = await redis.get(key);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.map((v) => String(v));
		}
	} catch {
		// ignore malformed index payload and reset lazily
	}
	return [];
}

async function addJsonArrayIndex(
	redis: RedisClient,
	key: string,
	value: string,
): Promise<void> {
	const current = await readJsonArrayIndex(redis, key);
	if (!current.includes(value)) current.push(value);
	await redis.set(key, JSON.stringify(current));
}

function normalizeMaterializeTarget(args: {
	baseDir: string;
	targetPath?: string;
	runId: string;
	stepId: string;
	outputId: string;
}) {
	if (args.targetPath) {
		return isAbsolute(args.targetPath)
			? args.targetPath
			: resolve(args.baseDir, args.targetPath);
	}

	return resolve(
		args.baseDir,
		"data",
		"materialized",
		args.runId,
		args.stepId,
		`${args.outputId}.json`,
	);
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

export class RedisStateStore implements WorkflowStateStore {
	constructor(
		private redis: RedisClient,
		private keyPrefix = "openclaw:workflow",
	) {}

	private runKey(runId: string): string {
		return `${this.keyPrefix}:state:${runId}`;
	}

	private runIndexKey(): string {
		return `${this.keyPrefix}:state:index`;
	}

	private lockKey(runId: string): string {
		return `${this.keyPrefix}:lock:${runId}`;
	}

	async loadRun(runId: string): Promise<RunState> {
		const raw = await this.redis.get(this.runKey(runId));
		if (!raw) {
			const err: NodeJS.ErrnoException = new Error(`Run not found: ${runId}`);
			err.code = "ENOENT";
			throw err;
		}
		return JSON.parse(raw) as RunState;
	}

	async saveRun(state: RunState): Promise<void> {
		await this.redis.set(this.runKey(state.run_id), JSON.stringify(state));
		await addJsonArrayIndex(this.redis, this.runIndexKey(), state.run_id);
	}

	async updateStep(
		runId: string,
		stepId: string,
		patch: Partial<StepState>,
	): Promise<RunState> {
		const state = await this.loadRun(runId);
		const next = {
			...state,
			steps: {
				...state.steps,
				[stepId]: {
					...(state.steps[stepId] || {}),
					...patch,
				},
			},
		};
		await this.saveRun(next as RunState);
		return next as RunState;
	}

	async listRuns(filter?: RunFilter): Promise<RunState[]> {
		const ids = await readJsonArrayIndex(this.redis, this.runIndexKey());
		const runs: RunState[] = [];

		for (const id of ids) {
			try {
				const state = await this.loadRun(id);
				runs.push(state);
			} catch {
				// skip missing/corrupt entries
			}
		}

		let selected = runs;
		if (filter?.workflow) {
			selected = selected.filter(
				(r) => r.workflow === filter.workflow || (r as any).workflow_key === filter.workflow,
			);
		}
		if (filter?.status) {
			selected = selected.filter((r) => r.status === filter.status);
		}

		selected.sort((a, b) => {
			const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
			const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
			return tb - ta;
		});

		if (typeof filter?.limit === "number" && filter.limit > 0) {
			selected = selected.slice(0, filter.limit);
		}

		return selected;
	}

	async acquireLock(runId: string, owner: string, ttlMs: number): Promise<boolean> {
		const result = await this.redis.set(
			this.lockKey(runId),
			JSON.stringify({
				run_id: runId,
				owner,
				acquired_at: getLocalISOString(),
				expires_at_ms: Date.now() + Math.max(250, ttlMs),
			}),
			{ px: Math.max(250, ttlMs), nx: true },
		);

		return result === "OK";
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

export class RedisArtifactStore implements WorkflowArtifactStore {
	constructor(
		private redis: RedisClient,
		private baseDir: string,
		private keyPrefix = "openclaw:workflow",
		private defaultMaterializeMode: "never" | "on_demand" | "always" =
			"on_demand",
	) {}

	private artifactKey(runId: string, stepId: string, outputId: string): string {
		return `${this.keyPrefix}:artifact:${runId}:${stepId}:${encodeURIComponent(outputId)}`;
	}

	private runArtifactIndexKey(runId: string): string {
		return `${this.keyPrefix}:artifact-index:${runId}`;
	}

	private stepArtifactIndexKey(runId: string, stepId: string): string {
		return `${this.keyPrefix}:artifact-index:${runId}:${stepId}`;
	}

	private encodeIndexEntry(stepId: string, outputId: string): string {
		return `${stepId}::${outputId}`;
	}

	private decodeIndexEntry(entry: string): { stepId: string; outputId: string } | null {
		const split = entry.indexOf("::");
		if (split < 0) return null;
		return {
			stepId: entry.slice(0, split),
			outputId: entry.slice(split + 2),
		};
	}

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
			storage_backend: `redis:${this.redis.kind}`,
			materialized_path: null,
			committed_at: getLocalISOString(),
		};

		await this.redis.set(
			this.artifactKey(args.runId, args.stepId, args.outputId),
			JSON.stringify(artifact),
		);
		await addJsonArrayIndex(
			this.redis,
			this.runArtifactIndexKey(args.runId),
			this.encodeIndexEntry(args.stepId, args.outputId),
		);
		await addJsonArrayIndex(
			this.redis,
			this.stepArtifactIndexKey(args.runId, args.stepId),
			args.outputId,
		);

		const materializeMode = args.materialize || this.defaultMaterializeMode;
		if (targetPath && materializeMode === "always") {
			await mkdir(dirname(targetPath), { recursive: true });
			await writeFile(targetPath, serialized, "utf8");
			artifact.materialized_path = targetPath;
			await this.redis.set(
				this.artifactKey(args.runId, args.stepId, args.outputId),
				JSON.stringify(artifact),
			);
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
		const raw = await this.redis.get(this.artifactKey(runId, stepId, outputId));
		if (!raw) return null;
		try {
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
		const entries = stepId
			? (await readJsonArrayIndex(this.redis, this.stepArtifactIndexKey(runId, stepId))).map((outputId) => ({ stepId, outputId }))
			: (await readJsonArrayIndex(this.redis, this.runArtifactIndexKey(runId)))
				.map((entry) => this.decodeIndexEntry(entry))
				.filter((v): v is { stepId: string; outputId: string } => !!v);

		const metas: StoredArtifactMeta[] = [];
		for (const entry of entries) {
			const artifact = await this.readArtifact(runId, entry.stepId, entry.outputId);
			if (!artifact) continue;
			metas.push({
				run_id: artifact.run_id,
				step_id: artifact.step_id,
				output_id: artifact.output_id,
				validator: artifact.validator,
				decision: artifact.decision,
				bytes: artifact.bytes,
				sha256: artifact.sha256,
				attempt: artifact.attempt,
				session_key: artifact.session_key,
				subagent_run_id: artifact.subagent_run_id,
				handoff_token: artifact.handoff_token,
				storage_backend: artifact.storage_backend,
				materialized_path: artifact.materialized_path,
				committed_at: artifact.committed_at,
			});
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

		const target = normalizeMaterializeTarget({
			baseDir: args.baseDir || this.baseDir,
			targetPath: args.targetPath,
			runId: args.runId,
			stepId: args.stepId,
			outputId: args.outputId,
		});

		await mkdir(dirname(target), { recursive: true });
		const content =
			typeof artifact.data === "string"
				? artifact.data
				: `${JSON.stringify(artifact.data, null, 2)}\n`;
		await writeFile(target, content, "utf8");

		artifact.materialized_path = target;
		await this.redis.set(
			this.artifactKey(args.runId, args.stepId, args.outputId),
			JSON.stringify(artifact),
		);

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
