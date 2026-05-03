/**
 * @module plugin-operations
 * @description Registry and built-in implementations for kind:plugin workflow steps.
 *
 * Plugin steps execute deterministic operations (Redis init, JSON caching, slot manifest
 * generation) inside the workflow engine process — no subagent session is allocated.
 * They still participate in deps, retry, reuse_outputs, output gates, and cache signatures.
 *
 * Built-in operations:
 *   - workflow.cache_json_document   — read source JSON, write to RedisJSON + hash
 *   - workflow.redis_run_initializer — idempotent run init: counters, stream groups, locks
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getLocalISOString } from "./workflow-state.js";
import type {
	OutputCheckResult,
	OutputValidationResult,
	PluginOperationContext,
	PluginOperationResult,
	WorkflowPluginOperation,
} from "./types.js";

// ─── Registry ──────────────────────────────────────────────────────────────────

export class PluginOperationRegistry {
	private ops = new Map<string, WorkflowPluginOperation>();

	register(op: WorkflowPluginOperation): void {
		this.ops.set(op.id, op);
	}

	get(id: string): WorkflowPluginOperation | undefined {
		return this.ops.get(id);
	}

	has(id: string): boolean {
		return this.ops.has(id);
	}

	list(): WorkflowPluginOperation[] {
		return [...this.ops.values()];
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function emptyOutputCheck(): OutputCheckResult {
	return {
		passed: true,
		decision: "pass",
		missing_files: [],
		checked_files: [],
		validations: [],
	};
}

function failedOutputCheck(message: string): OutputCheckResult {
	const v: OutputValidationResult = {
		path: "",
		exists: false,
		decision: "fail",
		errors: [message],
	};
	return {
		passed: false,
		decision: "fail",
		missing_files: [],
		checked_files: [],
		validations: [v],
	};
}

function okResult(extra: Partial<PluginOperationResult> = {}): PluginOperationResult {
	return {
		status: "ok",
		output_check: emptyOutputCheck(),
		error: null,
		logs: null,
		duration_ms: 0,
		...extra,
	};
}

function failResult(message: string, extra: Partial<PluginOperationResult> = {}): PluginOperationResult {
	return {
		status: "failed",
		retryable: true,
		output_check: failedOutputCheck(message),
		error: message,
		logs: null,
		duration_ms: 0,
		...extra,
	};
}

function resolveWith<T = Record<string, unknown>>(ctx: PluginOperationContext): T {
	return (ctx.step.with ?? {}) as T;
}

function substituteString(value: string, ctx: PluginOperationContext): string {
	return value
		.replace(/\{date\}/g, ctx.date)
		.replace(/\{run_id\}/g, ctx.runId)
		.replace(/\{config\.([^}]+)\}/g, (_, key) => {
			const v = (ctx.config as Record<string, unknown>)[key];
			return v !== undefined ? String(v) : `{config.${key}}`;
		});
}

function substituteWith(
	obj: Record<string, unknown>,
	ctx: PluginOperationContext,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		out[k] = typeof v === "string" ? substituteString(v, ctx) : v;
	}
	return out;
}

// ─── Built-in: workflow.cache_json_document ─────────────────────────────────────

/**
 * Reads a source JSON file, optionally validates it, writes the full document
 * into RedisJSON (JSON.SET) and selected fields into a Redis hash (HSET).
 *
 * with:
 *   source_path: string         — path to source JSON file (supports {config.X} etc.)
 *   json_key: string            — Redis key for JSON.SET
 *   hash_key: string            — Redis key for HSET
 *   allowed_hash_fields: []     — subset of top-level fields to mirror into the hash
 *   ttl_seconds?: number        — optional TTL to set on both keys
 *   base_dir?: string           — base dir for resolving relative source_path
 */
const cacheJsonDocument: WorkflowPluginOperation = {
	id: "workflow.cache_json_document",
	description:
		"Read a JSON document from disk, write full doc to RedisJSON and selected fields to a Redis hash.",

	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();
		const rawWith = substituteWith(resolveWith(ctx), ctx);

		const sourcePath = rawWith["source_path"] as string | undefined;
		const jsonKey = rawWith["json_key"] as string | undefined;
		const hashKey = rawWith["hash_key"] as string | undefined;
		const allowedHashFields = (rawWith["allowed_hash_fields"] as string[] | undefined) ?? [];
		const ttlSeconds = typeof rawWith["ttl_seconds"] === "number" ? rawWith["ttl_seconds"] : undefined;
		const baseDir = (rawWith["base_dir"] as string | undefined) ?? ctx.config["baseDir"] as string ?? process.cwd();

		if (!sourcePath) return failResult("workflow.cache_json_document: with.source_path is required");
		if (!jsonKey) return failResult("workflow.cache_json_document: with.json_key is required");
		if (!hashKey && ctx.redis) return failResult("workflow.cache_json_document: with.hash_key is required");

		const absSourcePath = isAbsolute(sourcePath) ? sourcePath : resolve(baseDir, sourcePath);

		let doc: Record<string, unknown>;
		try {
			const raw = await readFile(absSourcePath, "utf8");
			doc = JSON.parse(raw);
		} catch (err) {
			return failResult(
				`workflow.cache_json_document: failed to read/parse source file "${absSourcePath}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const logs: string[] = [`read ${absSourcePath} (${Object.keys(doc).length} top-level keys)`];

		// Commit to artifact store as the declared output
		let artifactResult: unknown = null;
		const declaredOutputs = ctx.step.outputs ?? [];
		const firstOutput = declaredOutputs[0];
		const outputId =
			firstOutput && typeof firstOutput === "object" && firstOutput.id
				? firstOutput.id
				: (rawWith["output_id"] as string | undefined) ?? "applicant_profile_cache";

		if (ctx.artifactStore) {
			const validator = firstOutput && typeof firstOutput === "object" && firstOutput.validate
				? firstOutput.validate
				: undefined;
			const validatorSpec = validator ? (ctx.validators[validator] ?? undefined) : undefined;

			const result = await ctx.artifactStore.commitArtifact({
				runId: ctx.runId,
				stepId: ctx.step.id,
				outputId,
				declaredOutput: firstOutput ?? { id: outputId },
				data: doc,
				validatorId: validator,
				validator: validatorSpec,
				validators: ctx.validators,
				attempt: 1,
			});

			if (!result.committed) {
				return failResult(
					`workflow.cache_json_document: artifact commit failed — ${result.message ?? result.decision}`,
				);
			}
			logs.push(`committed artifact ${outputId} (decision=${result.decision})`);
			artifactResult = result.artifact;
		}

				// Redis path (optional — fall through to filesystem-only if no redis client)
		if (!ctx.redis) {
			logs.push("no redis client — skipping RedisJSON/hash write (filesystem artifact only)");
		} else {
			// Write full JSON document to RedisJSON
			try {
				await ctx.redis.set(jsonKey, JSON.stringify(doc));
				logs.push(`set ${jsonKey}`);
				if (ttlSeconds) {
					await ctx.redis.expire(jsonKey, ttlSeconds);
					logs.push(`expire ${jsonKey} ${ttlSeconds}s`);
				}
			} catch (err) {
				return failResult(
					`workflow.cache_json_document: RedisJSON set "${jsonKey}" failed: ${err instanceof Error ? err.message : String(err)}`,
					{ duration_ms: Date.now() - start },
				);
			}

			// Write hash fields
			if (allowedHashFields.length > 0) {
				const hashFields: Record<string, string> = {};
				for (const field of allowedHashFields) {
					if (field in doc) {
						hashFields[field] = typeof doc[field] === "string"
							? doc[field] as string
							: JSON.stringify(doc[field]);
					}
				}

				if (Object.keys(hashFields).length > 0) {
					try {
						await ctx.redis.hset(hashKey, hashFields);
						logs.push(`hset ${hashKey} (${Object.keys(hashFields).length} fields)`);
						if (ttlSeconds) {
							await ctx.redis.expire(hashKey, ttlSeconds);
							logs.push(`expire ${hashKey} ${ttlSeconds}s`);
						}
					} catch (err) {
						return failResult(
							`workflow.cache_json_document: HSET "${hashKey}" failed: ${err instanceof Error ? err.message : String(err)}`,
							{ duration_ms: Date.now() - start },
						);
					}
				}
			}
		}

		return okResult({
			duration_ms: Date.now() - start,
			logs: logs.join("\n"),
		});
	},
};

// ─── Built-in: workflow.redis_run_initializer ───────────────────────────────────

/**
 * Idempotent run initialization: creates counters, stream groups, and state hash.
 * Safe to re-run (checks for existing keys before creating).
 *
 * with:
 *   run_key: string                   — hash key for storing run metadata
 *   stream_key?: string               — stream key for event log
 *   stream_group?: string             — consumer group name (default: "workers")
 *   counter_keys?: Record<string,number>  — counters to initialize (only if not exist)
 *   metadata?: Record<string,string>  — fields to set in the run hash
 *   ttl_seconds?: number              — optional TTL on all created keys
 */
const redisRunInitializer: WorkflowPluginOperation = {
	id: "workflow.redis_run_initializer",
	description:
		"Idempotent Redis run initialization: state hash, stream group, counters.",

	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();
		const rawWith = substituteWith(resolveWith(ctx), ctx);

		const runKey = rawWith["run_key"] as string | undefined;
		const streamKey = rawWith["stream_key"] as string | undefined;
		const streamGroup = (rawWith["stream_group"] as string | undefined) ?? "workers";
		const counterKeys = rawWith["counter_keys"] as Record<string, number> | undefined;
		const metadata = rawWith["metadata"] as Record<string, string> | undefined;
		const ttlSeconds = typeof rawWith["ttl_seconds"] === "number" ? rawWith["ttl_seconds"] : undefined;

		if (!runKey) return failResult("workflow.redis_run_initializer: with.run_key is required");

		const logs: string[] = [];

		// Commit artifact for the declared output even when no Redis (filesystem-only mode)
		const declaredOutputs = ctx.step.outputs ?? [];
		const firstOutput = declaredOutputs[0];
		const outputId =
			firstOutput && typeof firstOutput === "object" && firstOutput.id
				? firstOutput.id
				: (rawWith["output_id"] as string | undefined) ?? "run_config";

		const initRecord = {
			run_id: ctx.runId,
			run_key: runKey,
			initialized_at: getLocalISOString(),
			stream_key: streamKey ?? null,
			stream_group: streamKey ? streamGroup : null,
			counters: Object.keys(counterKeys ?? {}),
			metadata: metadata ?? {},
		};

		if (ctx.artifactStore) {
			const validator = firstOutput && typeof firstOutput === "object" && firstOutput.validate
				? firstOutput.validate
				: undefined;
			const validatorSpec = validator ? (ctx.validators[validator] ?? undefined) : undefined;

			const result = await ctx.artifactStore.commitArtifact({
				runId: ctx.runId,
				stepId: ctx.step.id,
				outputId,
				declaredOutput: firstOutput ?? { id: outputId },
				data: initRecord,
				validatorId: validator,
				validator: validatorSpec,
				validators: ctx.validators,
				attempt: 1,
			});

			if (!result.committed) {
				return failResult(
					`workflow.redis_run_initializer: artifact commit failed — ${result.message ?? result.decision}`,
				);
			}
			logs.push(`committed artifact ${outputId} (decision=${result.decision})`);
		}

		if (!ctx.redis) {
			logs.push("no redis client — skipping Redis initialization (filesystem artifact only)");
			return okResult({ duration_ms: Date.now() - start, logs: logs.join("\n") });
		}

		// Write run hash (idempotent: merge new metadata without overwriting existing)
		const existing = await ctx.redis.hgetall(runKey);
		const merged: Record<string, string> = {
			run_id: ctx.runId,
			initialized_at: getLocalISOString(),
			...(metadata ?? {}),
		};
		if (!existing || !existing["run_id"]) {
			await ctx.redis.hset(runKey, merged);
			logs.push(`hset ${runKey} (initialized)`);
		} else {
			// Only set new fields, not overwrite existing ones
			const newFields: Record<string, string> = {};
			for (const [k, v] of Object.entries(merged)) {
				if (!(k in existing)) newFields[k] = v;
			}
			if (Object.keys(newFields).length > 0) {
				await ctx.redis.hset(runKey, newFields);
				logs.push(`hset ${runKey} (${Object.keys(newFields).length} new fields)`);
			} else {
				logs.push(`hset ${runKey} (already initialized — skipped)`);
			}
		}

		if (ttlSeconds) {
			await ctx.redis.expire(runKey, ttlSeconds);
			logs.push(`expire ${runKey} ${ttlSeconds}s`);
		}

		// Create stream + consumer group (idempotent)
		if (streamKey) {
			try {
				await ctx.redis.xgroup("CREATE", streamKey, streamGroup, "0", { MKSTREAM: true });
				logs.push(`xgroup CREATE ${streamKey} ${streamGroup} (created)`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// BUSYGROUP is the expected error when group already exists
				if (msg.includes("BUSYGROUP") || msg.includes("already exists")) {
					logs.push(`xgroup CREATE ${streamKey} ${streamGroup} (already exists — skipped)`);
				} else {
					return failResult(
						`workflow.redis_run_initializer: xgroup CREATE failed: ${msg}`,
						{ duration_ms: Date.now() - start },
					);
				}
			}
		}

		// Initialize counters (only if key does not exist)
		for (const [key, initial] of Object.entries(counterKeys ?? {})) {
			const fullKey = substituteString(key, ctx);
			const exists = await ctx.redis.exists(fullKey);
			if (!exists) {
				await ctx.redis.set(fullKey, String(initial));
				logs.push(`set counter ${fullKey} = ${initial}`);
				if (ttlSeconds) {
					await ctx.redis.expire(fullKey, ttlSeconds);
				}
			} else {
				logs.push(`counter ${fullKey} already exists — skipped`);
			}
		}

		return okResult({ duration_ms: Date.now() - start, logs: logs.join("\n") });
	},
};

// ─── Default registry factory ───────────────────────────────────────────────────

export function createDefaultRegistry(): PluginOperationRegistry {
	const registry = new PluginOperationRegistry();
	registry.register(cacheJsonDocument);
	registry.register(redisRunInitializer);
	return registry;
}
