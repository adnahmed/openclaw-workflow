import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
	Runtime as McporterRuntime,
	RuntimeLogger,
	ServerDefinition,
} from "mcporter";
import type { RedisClient } from "./types.js";

type LoggerLike = {
	debug?: (...args: unknown[]) => void;
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
};

type JsonObject = Record<string, unknown>;

type NativeRedisOptions = {
	keyPrefix?: string;
	lazyConnect?: boolean;
	enableReadyCheck?: boolean;
	maxRetriesPerRequest?: number;
};

type NativeRedisMulti = Record<
	string,
	(...args: unknown[]) => NativeRedisMulti | Promise<unknown[]>
> & {
	exec(): Promise<unknown[]>;
};

type NativeRedisDriver = {
	get(key: string): Promise<string | null>;
	set(...args: unknown[]): Promise<"OK" | null>;
	del(...keys: string[]): Promise<number>;
	hset(key: string, fields: Record<string, string>): Promise<number>;
	hgetall(key: string): Promise<Record<string, string>>;
	exists(...keys: string[]): Promise<number>;
	expire(key: string, seconds: number): Promise<number>;
	incr(key: string): Promise<number>;
	xadd(key: string, id: string, ...pairs: string[]): Promise<string | null>;
	xgroup(
		command: "CREATE",
		key: string,
		group: string,
		id: string,
		mkstream?: "MKSTREAM",
	): Promise<"OK">;
	multi(): NativeRedisMulti;
	ping(): Promise<string>;
	quit(): Promise<void>;
};

type NativeRedisConstructor = new (
	url: string,
	options: NativeRedisOptions,
) => NativeRedisDriver;

type ToolCallOptions = {
	args?: Record<string, unknown>;
	timeoutMs?: number;
};

type McporterRuntimeLike = Pick<McporterRuntime, "callTool" | "close">;

function asObject(value: unknown): JsonObject | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	const objectValue = asObject(value);
	if (!objectValue) return undefined;

	const entries = Object.entries(objectValue).map(([key, entryValue]) => [
		key,
		String(entryValue),
	]);

	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function expandHomePath(input?: string | null): string | undefined {
	if (!input) return undefined;
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
	return input;
}

function splitCommandString(value: string): string[] {
	const result: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escapeNext = false;

	for (const char of value.trim()) {
		if (escapeNext) {
			current += char;
			escapeNext = false;
			continue;
		}

		if (char === "\\") {
			escapeNext = true;
			continue;
		}

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}

		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}

		if (char === " " && !inSingleQuote && !inDoubleQuote) {
			if (current) {
				result.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) result.push(current);
	return result;
}

function normalizeOpenClawMcpDefinition(
	name: string,
	raw: unknown,
	rootDir?: string | null,
): ServerDefinition | undefined {
	const definition = asObject(raw);
	if (!definition) return undefined;

	const description =
		typeof definition.description === "string"
			? definition.description
			: undefined;

	const url =
		definition.baseUrl ??
		definition.base_url ??
		definition.url ??
		definition.serverUrl ??
		definition.server_url;

	if (typeof url === "string" && url.length > 0) {
		return {
			name,
			description,
			command: {
				kind: "http",
				url: new URL(url),
				headers: asStringRecord(definition.headers),
			},
			env: asStringRecord(definition.env),
			auth: definition.auth as ServerDefinition["auth"],
			allowedTools: Array.isArray(definition.allowedTools)
				? definition.allowedTools.map(String)
				: Array.isArray(definition.allowed_tools)
					? definition.allowed_tools.map(String)
					: undefined,
			blockedTools: Array.isArray(definition.blockedTools)
				? definition.blockedTools.map(String)
				: Array.isArray(definition.blocked_tools)
					? definition.blocked_tools.map(String)
					: undefined,
		} as ServerDefinition;
	}

	const commandValue = definition.command ?? definition.executable;
	let command: string | undefined;
	let args: string[] = [];

	if (Array.isArray(commandValue)) {
		command =
			typeof commandValue[0] === "undefined"
				? undefined
				: String(commandValue[0]);
		args = commandValue.slice(1).map(String);
	} else if (typeof commandValue === "string") {
		if (Array.isArray(definition.args) && definition.args.length > 0) {
			command = commandValue;
			args = definition.args.map(String);
		} else {
			const tokens = splitCommandString(commandValue);
			command = tokens[0];
			args = tokens.slice(1);
		}
	}

	if (!command) return undefined;

	return {
		name,
		description,
		command: {
			kind: "stdio",
			command,
			args,
			cwd:
				expandHomePath(
					(typeof definition.cwd === "string" && definition.cwd) ||
						(typeof definition.workingDirectory === "string" &&
							definition.workingDirectory) ||
						rootDir ||
						null,
				) ?? process.cwd(),
		},
		env: asStringRecord(definition.env),
		auth: definition.auth as ServerDefinition["auth"],
		allowedTools: Array.isArray(definition.allowedTools)
			? definition.allowedTools.map(String)
			: Array.isArray(definition.allowed_tools)
				? definition.allowed_tools.map(String)
				: undefined,
		blockedTools: Array.isArray(definition.blockedTools)
			? definition.blockedTools.map(String)
			: Array.isArray(definition.blocked_tools)
				? definition.blocked_tools.map(String)
				: undefined,
	} as ServerDefinition;
}

function toMcporterLogger(logger?: LoggerLike): RuntimeLogger {
	return {
		debug: (message: string) => logger?.debug?.(`[mcporter] ${message}`),
		info: (message: string) => logger?.info?.(`[mcporter] ${message}`),
		warn: (message: string) => logger?.warn?.(`[mcporter] ${message}`),
		error: (message: string) => logger?.error?.(`[mcporter] ${message}`),
	};
}

class NativeRedisClient implements RedisClient {
	readonly kind = "native" as const;

	constructor(private client: NativeRedisDriver) {}

	async get(key: string): Promise<string | null> {
		return this.client.get(key);
	}

	async set(
		key: string,
		value: string,
		options?: { ex?: number; px?: number; nx?: boolean },
	): Promise<"OK" | null> {
		if (!options) return this.client.set(key, value);

		const args: unknown[] = [key, value];
		if (options.ex) args.push("EX", options.ex);
		if (options.px) args.push("PX", options.px);
		if (options.nx) args.push("NX");

		return this.client.set(...args);
	}

	async del(...keys: string[]): Promise<number> {
		return this.client.del(...keys);
	}

	async hset(key: string, fields: Record<string, string>): Promise<number> {
		return this.client.hset(key, fields);
	}

	async hgetall(key: string): Promise<Record<string, string> | null> {
		const result = await this.client.hgetall(key);
		if (!result || Object.keys(result).length === 0) return null;
		return result;
	}

	async exists(...keys: string[]): Promise<number> {
		return this.client.exists(...keys);
	}

	async expire(key: string, seconds: number): Promise<number> {
		return this.client.expire(key, seconds);
	}

	async incr(key: string): Promise<number> {
		return this.client.incr(key);
	}

	async xadd(
		key: string,
		id: string,
		fields: Record<string, string>,
	): Promise<string | null> {
		const pairs: string[] = [];
		for (const [field, fieldValue] of Object.entries(fields)) {
			pairs.push(field, fieldValue);
		}

		return this.client.xadd(key, id, ...pairs);
	}

	async xgroup(
		command: "CREATE",
		key: string,
		group: string,
		id: string,
		options?: { MKSTREAM?: boolean },
	): Promise<"OK"> {
		return options?.MKSTREAM
			? this.client.xgroup(command, key, group, id, "MKSTREAM")
			: this.client.xgroup(command, key, group, id);
	}

	async multi(commands: Array<[string, ...unknown[]]>): Promise<unknown[]> {
		const pipeline = this.client.multi();

		for (const [command, ...args] of commands) {
			const commandName = command.toLowerCase();
			const method = (pipeline as Record<string, unknown>)[commandName];
			if (typeof method !== "function") {
				throw new Error(
					`Native Redis multi() does not support command: ${command}`,
				);
			}

			Reflect.apply(method, pipeline, args);
		}

		return pipeline.exec();
	}

	async disconnect(): Promise<void> {
		await this.client.quit();
	}
}

export async function createNativeRedisClient(
	url: string,
	options: { keyPrefix?: string; lazyConnect?: boolean } = {},
): Promise<RedisClient> {
	let RedisCtor: NativeRedisConstructor;

	try {
		const mod = (await import("ioredis")) as unknown as {
			default?: NativeRedisConstructor;
			Redis?: NativeRedisConstructor;
		};
		RedisCtor = mod.default ?? mod.Redis ?? null;
	} catch {
		throw new Error(
			"ioredis is not installed. Run: npm install ioredis\n" +
				"If you want to use filesystem fallback instead, set stateBackend: 'filesystem' in plugin config.",
		);
	}

	if (!RedisCtor) {
		throw new Error("ioredis was loaded, but no Redis constructor was found.");
	}

	const client = new RedisCtor(url, {
		keyPrefix: options.keyPrefix,
		lazyConnect: options.lazyConnect ?? false,
		enableReadyCheck: true,
		maxRetriesPerRequest: 3,
	});

	await client.ping();

	return new NativeRedisClient(client);
}

export type McporterRedisOptions = {
	server: string;
	configPath?: string | null;
	rootDir?: string | null;
	serverDefinition?: unknown;
	callTimeoutMs?: number;
	logger?: LoggerLike;
	runtimeFactory?: () => Promise<McporterRuntimeLike>;
};

class McporterRedisClient implements RedisClient {
	readonly kind = "mcp" as const;

	private runtimePromise: Promise<McporterRuntimeLike> | null = null;

	constructor(private options: McporterRedisOptions) {}

	private async runtime(): Promise<McporterRuntimeLike> {
		if (!this.runtimePromise) {
			this.runtimePromise = (async () => {
				if (this.options.runtimeFactory) {
					return this.options.runtimeFactory();
				}

				const { createRuntime } = await import("mcporter");

				const inlineDefinition = normalizeOpenClawMcpDefinition(
					this.options.server,
					this.options.serverDefinition,
					this.options.rootDir,
				);

				return inlineDefinition
					? createRuntime({
							servers: [inlineDefinition],
							rootDir: expandHomePath(this.options.rootDir),
							logger: toMcporterLogger(this.options.logger),
							clientInfo: {
								name: "openclaw-workflow",
								version: "1.0.0",
							},
						})
					: createRuntime({
							configPath: expandHomePath(this.options.configPath),
							rootDir: expandHomePath(this.options.rootDir),
							logger: toMcporterLogger(this.options.logger),
							clientInfo: {
								name: "openclaw-workflow",
								version: "1.0.0",
							},
						});
			})();
		}

		return this.runtimePromise;
	}

	private async callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		const runtime = await this.runtime();

		return runtime.callTool(this.options.server, name, {
			args,
			timeoutMs: this.options.callTimeoutMs,
		} as ToolCallOptions);
	}

	private parseToolPayload(result: unknown): unknown {
		if (result == null || typeof result !== "object") return result;

		const objectResult = asObject(result);
		if (!objectResult) return result;

		if ("result" in objectResult) return objectResult.result;
		if ("data" in objectResult) return objectResult.data;
		if ("value" in objectResult && Object.keys(objectResult).length === 1) {
			return objectResult.value;
		}

		const content = Array.isArray(objectResult.content)
			? objectResult.content
			: null;

		if (content && content.length > 0) {
			const textChunk = content.find((chunk) => {
				const chunkObject = asObject(chunk);
				return (
					chunkObject?.type === "text" && typeof chunkObject.text === "string"
				);
			});

			const text = asObject(textChunk)?.text;
			if (typeof text === "string") {
				try {
					return JSON.parse(text);
				} catch {
					return text;
				}
			}
		}

		return result;
	}

	private asBoolean(value: unknown): boolean {
		if (typeof value === "boolean") return value;
		if (typeof value === "number") return value !== 0;
		if (typeof value === "string") {
			const normalized = value.trim().toLowerCase();
			return normalized === "1" || normalized === "true" || normalized === "ok";
		}
		return Boolean(value);
	}

	private asNumber(value: unknown, fallback = 0): number {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
		return fallback;
	}

	async get(key: string): Promise<string | null> {
		const result = this.parseToolPayload(await this.callTool("get", { key }));
		if (typeof result === "string") return result;

		const objectResult = asObject(result);
		if (objectResult && "value" in objectResult) {
			return objectResult.value == null ? null : String(objectResult.value);
		}

		return null;
	}

	async set(
		key: string,
		value: string,
		options?: { ex?: number; px?: number; nx?: boolean },
	): Promise<"OK" | null> {
		const args: Record<string, unknown> = { key, value };
		if (options?.ex) args.ex = options.ex;
		if (options?.px) args.px = options.px;
		if (options?.nx) args.nx = true;

		const result = this.parseToolPayload(await this.callTool("set", args));

		if (typeof result === "string") {
			return result.toUpperCase() === "OK" ? "OK" : null;
		}

		const objectResult = asObject(result);
		if (objectResult) {
			if (
				typeof objectResult.result === "string" &&
				objectResult.result.toUpperCase() === "OK"
			) {
				return "OK";
			}

			if (this.asBoolean(objectResult.ok)) return "OK";
		}

		return null;
	}

	async del(...keys: string[]): Promise<number> {
		const args = keys.length === 1 ? { key: keys[0], keys } : { keys };
		const result = this.parseToolPayload(await this.callTool("del", args));

		if (typeof result === "number") return result;

		const objectResult = asObject(result);
		if (objectResult) {
			return this.asNumber(
				objectResult.deleted ?? objectResult.count ?? objectResult.value,
				0,
			);
		}

		return 0;
	}

	async hset(key: string, fields: Record<string, string>): Promise<number> {
		const result = this.parseToolPayload(
			await this.callTool("hset", { key, fields }),
		);

		if (typeof result === "number") return result;

		const objectResult = asObject(result);
		if (objectResult) {
			return this.asNumber(
				objectResult.added ?? objectResult.count ?? objectResult.value,
				0,
			);
		}

		return 0;
	}

	async hgetall(key: string): Promise<Record<string, string> | null> {
		const result = this.parseToolPayload(
			await this.callTool("hgetall", { key }),
		);
		const objectResult = asObject(result);
		if (!objectResult) return null;

		const fieldsValue = asObject(objectResult.fields) ?? objectResult;
		if (Object.keys(fieldsValue).length === 0) return null;

		const normalized: Record<string, string> = {};
		for (const [field, fieldValue] of Object.entries(fieldsValue)) {
			normalized[field] = String(fieldValue);
		}

		return normalized;
	}

	async exists(...keys: string[]): Promise<number> {
		const args = keys.length === 1 ? { key: keys[0], keys } : { keys };
		const result = this.parseToolPayload(await this.callTool("exists", args));

		if (typeof result === "number") return result;

		const objectResult = asObject(result);
		if (objectResult) {
			return this.asNumber(objectResult.count ?? objectResult.value, 0);
		}

		return 0;
	}

	async expire(key: string, seconds: number): Promise<number> {
		const result = this.parseToolPayload(
			await this.callTool("expire", { key, seconds }),
		);

		if (typeof result === "number") return result;

		const objectResult = asObject(result);
		if (objectResult) {
			if ("value" in objectResult) return this.asNumber(objectResult.value, 0);
			if ("ok" in objectResult) return this.asBoolean(objectResult.ok) ? 1 : 0;
		}

		return this.asBoolean(result) ? 1 : 0;
	}

	async incr(key: string): Promise<number> {
		const result = this.parseToolPayload(await this.callTool("incr", { key }));

		if (typeof result === "number") return result;

		const objectResult = asObject(result);
		if (objectResult) {
			return this.asNumber(objectResult.value, 0);
		}

		return this.asNumber(result, 0);
	}

	async xadd(
		key: string,
		id: string,
		fields: Record<string, string>,
	): Promise<string | null> {
		const result = this.parseToolPayload(
			await this.callTool("xadd", { key, id, fields }),
		);

		if (typeof result === "string") return result;

		const objectResult = asObject(result);
		if (objectResult && "id" in objectResult) {
			return String(objectResult.id);
		}

		return null;
	}

	async xgroup(
		command: "CREATE",
		key: string,
		group: string,
		id: string,
		options?: { MKSTREAM?: boolean },
	): Promise<"OK"> {
		await this.callTool("xgroup_create", {
			command,
			key,
			group,
			id,
			mkstream: options?.MKSTREAM ?? false,
		});
		return "OK";
	}

	async multi(commands: Array<[string, ...unknown[]]>): Promise<unknown[]> {
		const results: unknown[] = [];

		for (const [rawCommand, ...args] of commands) {
			const command = rawCommand.toLowerCase();

			switch (command) {
				case "get": {
					const [key] = args;
					results.push(await this.callTool("get", { key }));
					break;
				}

				case "set": {
					const [key, value, ...rest] = args;
					const payload: Record<string, unknown> = { key, value };

					for (let i = 0; i < rest.length; i += 2) {
						const token = String(rest[i] ?? "").toUpperCase();
						const next = rest[i + 1];

						if (token === "EX") payload.ex = next;
						if (token === "PX") payload.px = next;
						if (token === "NX") payload.nx = true;
					}

					results.push(await this.callTool("set", payload));
					break;
				}

				case "del":
					results.push(await this.callTool("del", { keys: args }));
					break;

				case "hset": {
					const [key, fieldsOrFirstField, ...rest] = args;
					const fields: Record<string, string> = {};

					if (
						fieldsOrFirstField &&
						typeof fieldsOrFirstField === "object" &&
						!Array.isArray(fieldsOrFirstField)
					) {
						for (const [field, fieldValue] of Object.entries(
							fieldsOrFirstField as Record<string, unknown>,
						)) {
							fields[field] = String(fieldValue);
						}
					} else if (typeof fieldsOrFirstField !== "undefined") {
						fields[String(fieldsOrFirstField)] =
							rest.length > 0 ? String(rest[0]) : "";

						for (let i = 1; i < rest.length; i += 2) {
							const field = rest[i];
							const fieldValue = rest[i + 1];
							if (typeof field !== "undefined") {
								fields[String(field)] = String(fieldValue ?? "");
							}
						}
					}

					results.push(await this.callTool("hset", { key, fields }));
					break;
				}

				case "hgetall": {
					const [key] = args;
					results.push(await this.callTool("hgetall", { key }));
					break;
				}

				case "exists":
					results.push(await this.callTool("exists", { keys: args }));
					break;

				case "expire": {
					const [key, seconds] = args;
					results.push(await this.callTool("expire", { key, seconds }));
					break;
				}

				case "incr": {
					const [key] = args;
					results.push(await this.callTool("incr", { key }));
					break;
				}

				case "xadd": {
					const [key, id, fields] = args;
					results.push(
						await this.callTool("xadd", {
							key,
							id,
							fields: (fields as Record<string, unknown>) ?? {},
						}),
					);
					break;
				}

				case "xgroup":
				case "xgroup_create": {
					const [groupCommand, key, group, id, xgroupOptions] = args;
					results.push(
						await this.callTool("xgroup_create", {
							command: groupCommand,
							key,
							group,
							id,
							mkstream: Boolean(
								(xgroupOptions as { MKSTREAM?: boolean } | undefined)?.MKSTREAM,
							),
						}),
					);
					break;
				}

				default:
					throw new Error(
						`MCP Redis multi() does not support command: ${rawCommand}`,
					);
			}
		}

		return results;
	}

	async disconnect(): Promise<void> {
		const runtime = await this.runtimePromise;
		await runtime?.close(this.options.server);
		this.runtimePromise = null;
	}
}

export function createMcpRedisClient(
	options: McporterRedisOptions,
): RedisClient {
	return new McporterRedisClient(options);
}

export type RedisBackendMode =
	| "filesystem"
	| "auto"
	| "redis"
	| "redis-native"
	| "redis-mcp"
	| "dual";

type RedisAttempt = {
	provider: "native" | "mcp";
	ok: boolean;
	error?: unknown;
};

export class RedisResolutionError extends Error {
	constructor(
		message: string,
		readonly attempts: RedisAttempt[],
	) {
		super(message);
		this.name = "RedisResolutionError";
	}
}

function formatRedisAttemptErrors(attempts: RedisAttempt[]): string {
	return attempts
		.filter((attempt) => !attempt.ok)
		.map((attempt) => {
			const error = attempt.error;
			const detail =
				error instanceof Error
					? error.stack || error.message
					: typeof error === "string"
						? error
						: JSON.stringify(error);

			return `[${attempt.provider}] ${detail}`;
		})
		.join("\n");
}

export type RedisClientOptions = {
	url?: string | null;
	keyPrefix?: string;
	mcpServer?: string | null;
	mcpConfigPath?: string | null;
	mcpRootDir?: string | null;
	mcpServerDefinition?: unknown;
	mcpCallTimeoutMs?: number;
	mode?: RedisBackendMode;
	filesystemFallback?: boolean;
	logger?: LoggerLike;
};

export async function resolveRedisClient(
	options: RedisClientOptions,
): Promise<RedisClient | null> {
	const mode = options.mode ?? "auto";
	const attempts: RedisAttempt[] = [];

	const canTryNative =
		Boolean(options.url) && mode !== "filesystem" && mode !== "redis-mcp";

	const canTryMcp =
		Boolean(options.mcpServer) &&
		mode !== "filesystem" &&
		mode !== "redis-native";

	if (mode === "filesystem") {
		return null;
	}

	if (mode === "redis-native" && !options.url) {
		throw new RedisResolutionError(
			"stateBackend is redis-native, but redisUrl is not configured.",
			attempts,
		);
	}

	if (mode === "redis-mcp" && !canTryMcp) {
		throw new RedisResolutionError(
			"stateBackend is redis-mcp, but MCP Redis is not explicitly configured.",
			attempts,
		);
	}

	if (canTryNative) {
		try {
			const redisUrl = options.url;
			if (!redisUrl) {
				throw new Error("Redis URL disappeared before native initialization.");
			}

			const client = await createNativeRedisClient(redisUrl, {
				keyPrefix: options.keyPrefix,
			});

			attempts.push({ provider: "native", ok: true });
			options.logger?.info?.("[workflow] Redis backend resolved: native");
			return client;
		} catch (error) {
			attempts.push({ provider: "native", ok: false, error });
			const nativeFallbackAllowed =
				mode === "redis-native" && options.filesystemFallback === true;
			options.logger?.warn?.(
				`[workflow] Native Redis init failed${
					mode === "redis-native" && !nativeFallbackAllowed
						? " and filesystemFallback is disabled"
						: mode === "redis-native"
							? "; filesystemFallback=true, will fall back to filesystem"
							: "; trying fallback if available"
				}: ${error instanceof Error ? error.message : String(error)}`,
			);

			if (mode === "redis-native" && !nativeFallbackAllowed) {
				throw new RedisResolutionError(
					`Native Redis required by stateBackend=redis-native, but initialization failed.\n${formatRedisAttemptErrors(
						attempts,
					)}`,
					attempts,
				);
			}
		}
	}

	if (canTryMcp) {
		try {
			const mcpServer = options.mcpServer;
			if (!mcpServer) {
				throw new Error("MCP server disappeared before MCP initialization.");
			}

			const client = createMcpRedisClient({
				server: mcpServer,
				configPath: options.mcpConfigPath,
				rootDir: options.mcpRootDir,
				serverDefinition: options.mcpServerDefinition,
				callTimeoutMs: options.mcpCallTimeoutMs,
				logger: options.logger,
			});

			const probeKey = `__openclaw_workflow_probe:${Date.now()}:${Math.random()
				.toString(16)
				.slice(2)}`;

			await client.set(probeKey, "1", { ex: 30 });
			await client.del(probeKey);

			attempts.push({ provider: "mcp", ok: true });
			options.logger?.info?.(
				`[workflow] Redis backend resolved: mcp (${mcpServer})`,
			);
			return client;
		} catch (error) {
			attempts.push({ provider: "mcp", ok: false, error });
			options.logger?.warn?.(
				`[workflow] MCP Redis init/probe failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	const redisRequired =
		mode === "redis" ||
		(mode === "redis-native" && options.filesystemFallback !== true) ||
		(mode === "redis-mcp" && options.filesystemFallback !== true) ||
		options.filesystemFallback === false;

	if (redisRequired) {
		throw new RedisResolutionError(
			`No usable Redis backend was resolved for stateBackend=${mode}.\n${formatRedisAttemptErrors(
				attempts,
			)}`,
			attempts,
		);
	}

	options.logger?.warn?.(
		`[workflow] No usable Redis backend; falling back to filesystem. Attempts:\n${
			formatRedisAttemptErrors(attempts) || "none"
		}`,
	);

	return null;
}
