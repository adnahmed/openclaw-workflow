import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const DEFAULT_WORKFLOWS_DIR = "~/.openclaw/workflows";
export const DEFAULT_RUNS_DIR = "~/.openclaw/workflow-runs";
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_POLL_INTERVAL_MS = 5000;

type RawPluginConfig = {
	workflowsDir?: string;
	runsDir?: string;
	baseDir?: string;
	concurrency?: number;
	notifyChannel?: string;
	sessionModel?: string;
	sessionAdapter?: "auto" | "runtime-subagent" | "legacy-api" | "cli";
	pollIntervalMs?: number;
	cronDeliveryMode?: "none" | "announce";
	cronDeliveryChannel?: string;
	cronDeliveryTo?: string;
	cliTimeoutMs?: number;
	cronAddTimeoutMs?: number;
	cronRunTimeoutMs?: number;
	cronPollTimeoutMs?: number;
	cancelGraceMs?: number;
	autoResumeOnStartup?: boolean;
	stateBackend?:
		| "filesystem"
		| "redis"
		| "redis-native"
		| "redis-mcp"
		| "auto"
		| "dual";
	redisUrl?: string;
	redisPrefix?: string;
	redisPrefer?: "native" | "mcp" | "auto";
	redisMcpToolPrefix?: string | null;
	redisMcpServer?: string | null;
	redisMcpConfigPath?: string | null;
	redisMcpRootDir?: string | null;
	redisMcpCallTimeoutMs?: number;
	redisMcpServerDefinition?: Record<string, unknown> | null;
	filesystemFallback?: boolean;
	materializeOutputs?: "never" | "on_demand" | "always";
	requireSealedToolResultMiddleware?: boolean;
};

type RuntimeConfig = {
	cwd?: string;
};

export function expandHome(input) {
	if (!input || typeof input !== "string") return input;
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
	return input;
}

export function resolveConfigPath(value, fallback, cwd = process.cwd()) {
	const raw = value || fallback;
	const expanded = expandHome(raw);
	if (isAbsolute(expanded)) return resolve(expanded);
	return resolve(cwd, expanded);
}

export function normalizePluginConfig(
	rawConfig: RawPluginConfig = {},
	runtime: RuntimeConfig = {},
) {
	const cwd = typeof runtime.cwd === "string" ? runtime.cwd : process.cwd();
	const concurrency = Number.isInteger(rawConfig.concurrency)
		? Math.max(1, rawConfig.concurrency)
		: DEFAULT_CONCURRENCY;
	const pollIntervalMs = Number.isInteger(rawConfig.pollIntervalMs)
		? Math.max(rawConfig.pollIntervalMs, 250)
		: DEFAULT_POLL_INTERVAL_MS;

	const allowedSessionAdapters = new Set([
		"auto",
		"runtime-subagent",
		"legacy-api",
		"cli",
	]);

	if (
		rawConfig.sessionAdapter &&
		!allowedSessionAdapters.has(rawConfig.sessionAdapter)
	) {
		throw new Error(
			`Invalid sessionAdapter "${rawConfig.sessionAdapter}". Expected auto, runtime-subagent, legacy-api, or cli.`,
		);
	}

	return {
		workflowsDir: resolveConfigPath(
			rawConfig.workflowsDir,
			DEFAULT_WORKFLOWS_DIR,
			cwd,
		),
		runsDir: resolveConfigPath(rawConfig.runsDir, DEFAULT_RUNS_DIR, cwd),
		baseDir: resolveConfigPath(rawConfig.baseDir, cwd, cwd),
		concurrency,
		notifyChannel: rawConfig.notifyChannel || null,
		defaultModel: rawConfig.sessionModel || null,
		pollIntervalMs,
		sessionAdapter: rawConfig.sessionAdapter || "auto",
		cronDeliveryMode: rawConfig.cronDeliveryMode || "none",
		cronDeliveryChannel: rawConfig.cronDeliveryChannel || null,
		cronDeliveryTo: rawConfig.cronDeliveryTo || null,
		cliTimeoutMs: rawConfig.cliTimeoutMs ?? 120000,
		cronAddTimeoutMs: rawConfig.cronAddTimeoutMs ?? 120000,
		cronRunTimeoutMs: rawConfig.cronRunTimeoutMs ?? 60000,
		cronPollTimeoutMs: rawConfig.cronPollTimeoutMs ?? 60000,
		cancelGraceMs: rawConfig.cancelGraceMs ?? 10000,
		autoResumeOnStartup: rawConfig.autoResumeOnStartup === true,
		stateBackend: rawConfig.stateBackend || "filesystem",
		redisUrl: rawConfig.redisUrl || null,
		redisPrefix: rawConfig.redisPrefix || "openclaw:workflow",
		redisPrefer: rawConfig.redisPrefer || "auto",
		redisMcpToolPrefix: rawConfig.redisMcpToolPrefix ?? null,
		redisMcpServer:
			rawConfig.redisMcpServer ?? rawConfig.redisMcpToolPrefix ?? null,
		redisMcpConfigPath: rawConfig.redisMcpConfigPath ?? null,
		redisMcpRootDir: rawConfig.redisMcpRootDir ?? null,
		redisMcpCallTimeoutMs: rawConfig.redisMcpCallTimeoutMs ?? 30000,
		redisMcpServerDefinition: rawConfig.redisMcpServerDefinition ?? null,
		filesystemFallback: rawConfig.filesystemFallback !== false,
		materializeOutputs: rawConfig.materializeOutputs || "on_demand",
		requireSealedToolResultMiddleware:
			rawConfig.requireSealedToolResultMiddleware === true,
	};
}
