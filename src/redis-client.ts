/**
 * @module redis-client
 * @description Thin Redis client abstraction with priority-based provider selection.
 *
 * Priority order (as specified in the design):
 *   1. Native Redis client (ioredis) — preferred for init/transactional work
 *   2. MCP Redis adapter (MCPorter/MCP_DOCKER) — fallback via agent tool calls
 *
 * ioredis is a peer/optional dependency. If not installed, native client creation
 * throws a clear error pointing to installation instructions.
 *
 * The MCP adapter wraps tool calls made through the OpenClaw api object, translating
 * Redis commands to MCP tool invocations (e.g. MCP_DOCKER__redis_get, etc.).
 */

import type { RedisClient } from "./types.js";

// ─── Native Redis client (ioredis) ──────────────────────────────────────────────

class NativeRedisClient implements RedisClient {
	readonly kind = "native" as const;

	constructor(private client: any) {}

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
		return (this.client as any).set(...args);
	}

	async del(...keys: string[]): Promise<number> {
		return this.client.del(...keys);
	}

	async hset(key: string, fields: Record<string, string>): Promise<number> {
		// ioredis hset accepts (key, object)
		return this.client.hset(key, fields);
	}

	async hgetall(key: string): Promise<Record<string, string> | null> {
		const result = await this.client.hgetall(key);
		// ioredis returns {} for missing keys; normalise to null
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

	async xadd(key: string, id: string, fields: Record<string, string>): Promise<string | null> {
		// ioredis xadd: (key, id, ...fieldValuePairs)
		const pairs: string[] = [];
		for (const [k, v] of Object.entries(fields)) {
			pairs.push(k, v);
		}
		return (this.client as any).xadd(key, id, ...pairs);
	}

	async xgroup(
		command: "CREATE",
		key: string,
		group: string,
		id: string,
		options?: { MKSTREAM?: boolean },
	): Promise<"OK"> {
		if (options?.MKSTREAM) {
			return (this.client as any).xgroup(command, key, group, id, "MKSTREAM");
		}
		return (this.client as any).xgroup(command, key, group, id);
	}

	async multi(commands: Array<[string, ...unknown[]]>): Promise<unknown[]> {
		const pipeline = this.client.multi();
		for (const [cmd, ...args] of commands) {
			(pipeline as any)[cmd.toLowerCase()](...args);
		}
		return pipeline.exec();
	}

	async disconnect(): Promise<void> {
		await this.client.quit();
	}
}

/**
 * Create a native Redis client backed by ioredis.
 * ioredis must be installed as an optional peer dependency.
 */
export async function createNativeRedisClient(
	url: string,
	options: { keyPrefix?: string; lazyConnect?: boolean } = {},
): Promise<RedisClient> {
	let Redis: any;
	try {
		// @ts-ignore – ioredis is an optional peer dependency; absence is caught at runtime
		const mod = await import("ioredis");
		Redis = mod.default ?? mod.Redis;
	} catch {
		throw new Error(
			"ioredis is not installed. Run: npm install ioredis\n" +
				"If you want to use filesystem fallback instead, set stateBackend: 'filesystem' in plugin config.",
		);
	}

	const client = new Redis(url, {
		keyPrefix: options.keyPrefix,
		lazyConnect: options.lazyConnect ?? false,
		enableReadyCheck: true,
		maxRetriesPerRequest: 3,
	});

	// Verify connection
	await client.ping();

	return new NativeRedisClient(client);
}

// ─── MCP Redis adapter ──────────────────────────────────────────────────────────

class McpRedisClient implements RedisClient {
	readonly kind = "mcp" as const;

	constructor(
		private toolPrefix: string,
		private api: any,
	) {}

	private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		const toolName = `${this.toolPrefix}__${name}`;
		if (typeof this.api?.tools?.call === "function") {
			return this.api.tools.call(toolName, args);
		}
		if (typeof this.api?.callTool === "function") {
			return this.api.callTool(toolName, args);
		}
		throw new Error(
			`MCP Redis: no tool call surface found on api object for tool "${toolName}". ` +
				"Expected api.tools.call() or api.callTool().",
		);
	}

	async get(key: string): Promise<string | null> {
		const result = await this.callTool("redis_get", { key }) as any;
		return result?.value ?? null;
	}

	async set(
		key: string,
		value: string,
		options?: { ex?: number; px?: number; nx?: boolean },
	): Promise<"OK" | null> {
		const args: Record<string, unknown> = { key, value };
		if (options?.ex) args["ex"] = options.ex;
		if (options?.px) args["px"] = options.px;
		if (options?.nx) args["nx"] = true;
		const result = await this.callTool("redis_set", args) as any;
		return result?.ok ? "OK" : null;
	}

	async del(...keys: string[]): Promise<number> {
		const result = await this.callTool("redis_del", { keys }) as any;
		return result?.deleted ?? 0;
	}

	async hset(key: string, fields: Record<string, string>): Promise<number> {
		const result = await this.callTool("redis_hset", { key, fields }) as any;
		return result?.added ?? 0;
	}

	async hgetall(key: string): Promise<Record<string, string> | null> {
		const result = await this.callTool("redis_hgetall", { key }) as any;
		return result?.fields ?? null;
	}

	async exists(...keys: string[]): Promise<number> {
		const result = await this.callTool("redis_exists", { keys }) as any;
		return result?.count ?? 0;
	}

	async expire(key: string, seconds: number): Promise<number> {
		const result = await this.callTool("redis_expire", { key, seconds }) as any;
		return result?.ok ? 1 : 0;
	}

	async incr(key: string): Promise<number> {
		const result = await this.callTool("redis_incr", { key }) as any;
		return result?.value ?? 0;
	}

	async xadd(key: string, id: string, fields: Record<string, string>): Promise<string | null> {
		const result = await this.callTool("redis_xadd", { key, id, fields }) as any;
		return result?.id ?? null;
	}

	async xgroup(
		command: "CREATE",
		key: string,
		group: string,
		id: string,
		options?: { MKSTREAM?: boolean },
	): Promise<"OK"> {
		await this.callTool("redis_xgroup_create", {
			key,
			group,
			id,
			mkstream: options?.MKSTREAM ?? false,
		});
		return "OK";
	}

	async multi(commands: Array<[string, ...unknown[]]>): Promise<unknown[]> {
		// MCP doesn't support MULTI natively — execute sequentially
		const results: unknown[] = [];
		for (const [cmd, ...args] of commands) {
			results.push(await this.callTool(`redis_${cmd.toLowerCase()}`, { args }));
		}
		return results;
	}

	async disconnect(): Promise<void> {
		// MCP connection is stateless — nothing to close
	}
}

/**
 * Create an MCP-backed Redis client that routes calls through OpenClaw tool invocations.
 */
export function createMcpRedisClient(toolPrefix: string, api: unknown): RedisClient {
	return new McpRedisClient(toolPrefix, api);
}

// ─── Priority-based factory ─────────────────────────────────────────────────────

export type RedisClientOptions = {
	url?: string | null;
	keyPrefix?: string;
	mcpToolPrefix?: string;
	api?: unknown;
	prefer?: "native" | "mcp" | "auto";
	filesystemFallback?: boolean;
};

/**
 * Resolve and create a Redis client using priority order:
 *   1. Native (ioredis) if url is provided and prefer !== "mcp"
 *   2. MCP adapter if api is provided and mcpToolPrefix is set
 *   3. null if filesystemFallback is true (caller uses filesystem-only path)
 *   4. throws if no backend available and filesystemFallback is false
 */
export async function resolveRedisClient(options: RedisClientOptions): Promise<RedisClient | null> {
	const prefer = options.prefer ?? "auto";

	// 1. Native Redis (strongly preferred for init/transactional work)
	if (options.url && prefer !== "mcp") {
		try {
			return await createNativeRedisClient(options.url, {
				keyPrefix: options.keyPrefix,
			});
		} catch (err) {
			// If ioredis missing and filesystemFallback allowed, proceed to MCP
			const isIoredisAbsent =
				err instanceof Error && err.message.includes("ioredis is not installed");
			if (!isIoredisAbsent) throw err;
			// Fall through to MCP if ioredis not installed
		}
	}

	// 2. MCP Redis adapter
	if (options.mcpToolPrefix && options.api) {
		return createMcpRedisClient(options.mcpToolPrefix, options.api);
	}

	// 3. Filesystem fallback
	if (options.filesystemFallback !== false) {
		return null;
	}

	throw new Error(
		"No Redis backend available (no URL, no MCP adapter) and filesystem fallback is disabled.",
	);
}
