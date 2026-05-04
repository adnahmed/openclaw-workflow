/**
 * @module state-plugin-operations
 * @description Generic semantic state plugin operations.
 *
 * These operations let YAML describe collections, queues, worker groups,
 * claims, and completions without exposing Redis commands to workflow authors.
 */

import type {
	OutputCheckResult,
	OutputSpec,
	OutputValidationResult,
	PluginOperationContext,
	PluginOperationResult,
	RedisClient,
	StateCollectionSpec,
	StateCompleteSpec,
	StateConsumeSpec,
	StatePublishSpec,
	StateQueueSpec,
	WorkflowPluginOperation,
} from "./types.js";
import { getLocalISOString } from "./workflow-state.js";

type JsonObject = Record<string, unknown>;

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
	const validation: OutputValidationResult = {
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
		validations: [validation],
	};
}

function okResult(
	extra: Partial<PluginOperationResult> = {},
): PluginOperationResult {
	return {
		status: "ok",
		output_check: emptyOutputCheck(),
		error: null,
		logs: null,
		duration_ms: 0,
		...extra,
	};
}

function failResult(
	message: string,
	extra: Partial<PluginOperationResult> = {},
): PluginOperationResult {
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

function asArray<T>(value: T | T[] | undefined | null): T[] {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

function withObject(ctx: PluginOperationContext): JsonObject {
	return (ctx.step.with ?? {}) as unknown as JsonObject;
}

function readPath(value: unknown, selector?: string): unknown {
	const sel = selector ?? "$";
	if (sel === "$") return value;
	if (!sel.startsWith("$.")) {
		throw new Error(
			`Unsupported selector "${sel}". Supported selectors: "$", "$.field", "$.field.child"`,
		);
	}

	let cursor: unknown = value;
	for (const part of sel.slice(2).split(".")) {
		if (cursor == null || typeof cursor !== "object") return undefined;
		cursor = (cursor as JsonObject)[part];
	}
	return cursor;
}

function selectItems(value: unknown, selector?: string): JsonObject[] {
	const selected = readPath(value, selector);

	if (Array.isArray(selected)) {
		return selected.filter(
			(item): item is JsonObject =>
				item != null && typeof item === "object" && !Array.isArray(item),
		);
	}

	if (
		selected != null &&
		typeof selected === "object" &&
		!Array.isArray(selected)
	) {
		const obj = selected as JsonObject;
		if (Array.isArray(obj.records)) {
			return obj.records.filter(
				(item): item is JsonObject =>
					item != null && typeof item === "object" && !Array.isArray(item),
			);
		}
		if (Array.isArray(obj.items)) {
			return obj.items.filter(
				(item): item is JsonObject =>
					item != null && typeof item === "object" && !Array.isArray(item),
			);
		}
		return [obj];
	}

	return [];
}

function singularize(name: string): string {
	if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
	if (name.endsWith("s") && name.length > 1) return name.slice(0, -1);
	return name;
}

function statePrefix(ctx: PluginOperationContext): string {
	const configured =
		ctx.config.redis_prefix ??
		ctx.workflow.state?.key ??
		ctx.workflow.name ??
		"workflow";

	return String(configured).trim().replace(/\s+/g, "_");
}

function collectionSpec(
	ctx: PluginOperationContext,
	collection: string,
): StateCollectionSpec {
	return ctx.workflow.state?.collections?.[collection] ?? {};
}

function queueSpec(
	ctx: PluginOperationContext,
	queue?: string,
): StateQueueSpec | undefined {
	if (!queue) return undefined;
	return ctx.workflow.state?.queues?.[queue];
}

function resolveCollectionFromQueue(
	ctx: PluginOperationContext,
	queue?: string,
): string | undefined {
	if (!queue) return undefined;
	return queueSpec(ctx, queue)?.collection;
}

function queueKeyPart(ctx: PluginOperationContext, queue: string): string {
	const suffix = queueSpec(ctx, queue)?.suffix;
	if (suffix) return suffix;
	return queue.replace(/_/g, ":");
}

function keyspace(
	ctx: PluginOperationContext,
	collection: string,
	itemKey?: string,
	queue?: string,
) {
	const prefix = statePrefix(ctx);
	const date = ctx.date;
	const coll = collectionSpec(ctx, collection);
	const entity = coll.entity ?? singularize(collection);
	const queuePart = queue ? queueKeyPart(ctx, queue) : `${collection}:pending`;

	return {
		seenSet: `${prefix}:set:${collection}:seen:${date}`,
		queuedSet: `${prefix}:set:${queuePart}:queued:${date}`,
		queue: `${prefix}:queue:${queuePart}:${date}`,
		processingQueue: `${prefix}:queue:${queuePart}:processing:${date}`,
		activeHash: `${prefix}:hash:${queuePart}:active:${date}`,
		stream: `${prefix}:stream:${collection}:${date}`,
		document: itemKey ? `${prefix}:doc:${entity}:${itemKey}:${date}` : "",
		hash: itemKey ? `${prefix}:hash:${entity}:${itemKey}:${date}` : "",
		terminalSet: (status: string) =>
			`${prefix}:set:${collection}:${status}:${date}`,
		counter: (name: string) => `${prefix}:counter:${name}:${date}`,
	};
}

function scalarizeForHash(item: JsonObject): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(item)) {
		if (value == null) out[key] = "";
		else if (typeof value === "string") out[key] = value;
		else if (typeof value === "number" || typeof value === "boolean")
			out[key] = String(value);
		else out[key] = JSON.stringify(value);
	}
	return out;
}

async function redisRaw(
	redis: RedisClient,
	command: string,
	...args: unknown[]
): Promise<unknown> {
	const reply = await redis.multi([[command, ...args]]);
	if (Array.isArray(reply) && reply.length === 1) {
		const first = reply[0] as unknown;
		if (Array.isArray(first) && first.length === 2) {
			const [err, result] = first as [unknown, unknown];
			if (err) throw err instanceof Error ? err : new Error(String(err));
			return result;
		}
		return first;
	}
	return reply;
}

function isPositive(reply: unknown): boolean {
	if (typeof reply === "number") return reply > 0;
	if (typeof reply === "string") return Number(reply) > 0;
	return false;
}

function parseLease(value: unknown): JsonObject | null {
	if (!value) return null;
	if (typeof value === "object") return value as JsonObject;
	try {
		const parsed = JSON.parse(String(value));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as JsonObject)
			: null;
	} catch {
		return null;
	}
}

function leaseIdOf(value: unknown): string {
	const lease = parseLease(value);
	return lease?.lease_id ? String(lease.lease_id) : "";
}

async function claimOne(
	redis: RedisClient,
	keys: ReturnType<typeof keyspace>,
): Promise<string | null> {
	try {
		const moved = await redisRaw(
			redis,
			"LMOVE",
			keys.queue,
			keys.processingQueue,
			"LEFT",
			"RIGHT",
		);
		return moved ? String(moved) : null;
	} catch {
		const moved = await redisRaw(
			redis,
			"RPOPLPUSH",
			keys.queue,
			keys.processingQueue,
		);
		return moved ? String(moved) : null;
	}
}

async function reclaimExpiredLeases(args: {
	redis: RedisClient;
	keys: ReturnType<typeof keyspace>;
	collection: string;
	queue: string;
	runId: string;
	stepId: string;
}): Promise<number> {
	const active = await args.redis.hgetall(args.keys.activeHash);
	const now = Date.now();
	let reclaimed = 0;

	for (const [itemKey, rawLease] of Object.entries(active ?? {})) {
		const lease = parseLease(rawLease);
		const expiresAt = lease?.lease_expires_at
			? Date.parse(String(lease.lease_expires_at))
			: 0;

		if (!expiresAt || expiresAt > now) continue;

		await redisRaw(args.redis, "HDEL", args.keys.activeHash, itemKey);
		await redisRaw(args.redis, "LREM", args.keys.processingQueue, 0, itemKey);
		await redisRaw(args.redis, "LPUSH", args.keys.queue, itemKey);

		await args.redis.xadd(args.keys.stream, "*", {
			event: "lease_expired_requeued",
			collection: args.collection,
			item_key: itemKey,
			queue: args.queue,
			run_id: args.runId,
			step_id: args.stepId,
		});

		reclaimed += 1;
	}

	return reclaimed;
}

async function incrBy(
	redis: RedisClient,
	key: string,
	amount: number,
): Promise<void> {
	if (amount <= 0) return;
	if (amount === 1) {
		await redis.incr(key);
		return;
	}
	await redisRaw(redis, "INCRBY", key, amount);
}

function outputSpecById(
	outputs: OutputSpec[] | undefined,
	outputId: string,
): OutputSpec {
	const match = (outputs ?? []).find((output) => {
		if (typeof output === "string") return output === outputId;
		return output.id === outputId;
	});
	return match ?? { id: outputId };
}

async function commitPluginOutput(
	ctx: PluginOperationContext,
	outputId: string,
	data: unknown,
): Promise<void> {
	const declaredOutput = outputSpecById(ctx.step.outputs, outputId);
	const validatorId =
		typeof declaredOutput === "object" ? declaredOutput.validate : undefined;

	const result = await ctx.artifactStore.commitArtifact({
		runId: ctx.runId,
		stepId: ctx.step.id,
		outputId,
		declaredOutput,
		data,
		validatorId,
		validator: validatorId ? ctx.validators[validatorId] : undefined,
		validators: ctx.validators,
		attempt: 1,
	});

	if (!result.committed) {
		throw new Error(
			`commit failed for output "${outputId}": ${result.message ?? result.decision}`,
		);
	}
}

function publishSpecs(ctx: PluginOperationContext): StatePublishSpec[] {
	const stepSpec = (
		ctx.step as unknown as {
			state_publish?: StatePublishSpec | StatePublishSpec[];
		}
	).state_publish;
	const withSpec = withObject(ctx).state_publish ?? withObject(ctx).publish;
	return asArray(
		(withSpec ?? stepSpec) as StatePublishSpec | StatePublishSpec[] | undefined,
	);
}

function consumeSpec(ctx: PluginOperationContext): StateConsumeSpec {
	const stepSpec = (ctx.step as unknown as { state_consume?: StateConsumeSpec })
		.state_consume;
	return (withObject(ctx).state_consume ??
		withObject(ctx).consume ??
		stepSpec ??
		{}) as unknown as StateConsumeSpec;
}

function completeSpecs(ctx: PluginOperationContext): StateCompleteSpec[] {
	const stepSpec = (
		ctx.step as unknown as {
			state_complete?: StateCompleteSpec | StateCompleteSpec[];
		}
	).state_complete;
	const withSpec = withObject(ctx).state_complete ?? withObject(ctx).complete;
	return asArray(
		(withSpec ?? stepSpec) as
			| StateCompleteSpec
			| StateCompleteSpec[]
			| undefined,
	);
}

export const statePublishOperation: WorkflowPluginOperation = {
	id: "workflow.state_publish",
	description: "Publish validated artifact items into semantic workflow state.",

	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();
		const logs: string[] = [];

		try {
			const specs = publishSpecs(ctx);
			if (specs.length === 0) {
				return failResult(
					"workflow.state_publish: no state_publish specs configured",
				);
			}

			const summaries: JsonObject[] = [];
			let totalSelected = 0;
			let totalPublished = 0;
			let totalUpdated = 0;
			let totalEnqueued = 0;

			for (const spec of specs) {
				if (!spec.output)
					return failResult("workflow.state_publish: output is required");
				if (!spec.collection)
					return failResult("workflow.state_publish: collection is required");

				const fromStep = spec.from_step ?? ctx.step.depends_on?.[0];
				if (!fromStep) {
					return failResult(
						"workflow.state_publish: from_step is required when the plugin step has no dependency",
					);
				}

				const artifact = await ctx.artifactStore.readArtifact(
					ctx.runId,
					fromStep,
					spec.output,
				);
				if (!artifact) {
					return failResult(
						`workflow.state_publish: artifact not found for ${fromStep}.${spec.output}`,
					);
				}
				const items = selectItems(artifact.data, spec.select);

				const collection = spec.collection;
				const coll = collectionSpec(ctx, collection);
				const itemKeyField = spec.item_key ?? coll.item_key ?? "id";
				const lifecycle = spec.lifecycle ?? coll.lifecycle ?? "pending";
				const queue = spec.queue ?? coll.default_queue;

				const views = {
					document: true,
					metadata_hash: true,
					seen_index: true,
					event_stream: true,
					pending_queue: !!queue,
					...(coll.views ?? {}),
				};

				let published = 0;
				let updated = 0;
				let enqueued = 0;
				const rejected: JsonObject[] = [];

				if (!ctx.redis) {
					const policy =
						spec.on_no_redis ?? coll.on_no_redis ?? "artifact_only";
					if (policy === "fail") {
						return failResult(
							`workflow.state_publish: no Redis client for collection "${collection}"`,
						);
					}
					logs.push(`no redis client; ${collection} publish is artifact-only`);
				} else {
					for (const item of items) {
						const rawItemKey = item[itemKeyField];
						const itemKey = rawItemKey == null ? "" : String(rawItemKey);

						if (!itemKey) {
							rejected.push({
								reason: `missing item key field "${itemKeyField}"`,
								item,
							});
							continue;
						}

						const keys = keyspace(ctx, collection, itemKey, queue);
						let firstSeen = true;

						if (views.seen_index) {
							const addedSeen = await redisRaw(
								ctx.redis,
								"SADD",
								keys.seenSet,
								itemKey,
							);
							firstSeen = isPositive(addedSeen);
						}

						if (views.document) {
							await ctx.redis.set(keys.document, JSON.stringify(item));
						}

						if (views.metadata_hash) {
							await ctx.redis.hset(keys.hash, scalarizeForHash(item));
						}

						if (queue && views.pending_queue) {
							const added = await redisRaw(
								ctx.redis,
								"SADD",
								keys.queuedSet,
								itemKey,
							);
							if (isPositive(added)) {
								await redisRaw(ctx.redis, "RPUSH", keys.queue, itemKey);
								enqueued += 1;
							}
						}

						if (views.event_stream) {
							await ctx.redis.xadd(keys.stream, "*", {
								event: firstSeen ? "published" : "updated",
								collection,
								item_key: itemKey,
								lifecycle,
								queue: queue ?? "",
								run_id: ctx.runId,
								step_id: ctx.step.id,
							});
						}

						if (firstSeen) published += 1;
						else updated += 1;
					}

					if (coll.counters?.published) {
						await incrBy(
							ctx.redis,
							keyspace(ctx, collection).counter(coll.counters.published),
							published,
						);
					}

					if (coll.counters?.rejected) {
						await incrBy(
							ctx.redis,
							keyspace(ctx, collection).counter(coll.counters.rejected),
							rejected.length,
						);
					}
				}

				totalSelected += items.length;
				totalPublished += published;
				totalUpdated += updated;
				totalEnqueued += enqueued;

				summaries.push({
					collection,
					from_step: fromStep,
					output: spec.output,
					selected_count: items.length,
					published_count: published,
					updated_count: updated,
					enqueued_count: enqueued,
					rejected_items: rejected,
					queue: queue ?? null,
				});

				logs.push(
					`published ${published}/${items.length} item(s) to collection ${collection}`,
				);
			}

			const summaryOutput =
				(withObject(ctx).summary_output as string | undefined) ??
				specs[0]?.summary_output ??
				"state_publish_summary";

			await commitPluginOutput(ctx, summaryOutput, {
				status: "ok",
				backend: ctx.redis ? "redis" : "filesystem",
				mode: ctx.redis ? "stateful" : "artifact_only",
				generated_at: getLocalISOString(),
				selected_count: totalSelected,
				published_count: totalPublished,
				updated_count: totalUpdated,
				enqueued_count: totalEnqueued,
				valid_count: totalPublished,
				items: summaries,
				rejected_items: summaries.flatMap(
					(item) => (item.rejected_items as unknown[]) ?? [],
				),
				workflow_result: {
					ok: true,
					retryable: false,
					blocked: false,
					failed: false,
				},
			});

			return okResult({
				duration_ms: Date.now() - start,
				logs: logs.join("\n"),
			});
		} catch (err) {
			return failResult(
				`workflow.state_publish: ${err instanceof Error ? err.message : String(err)}`,
				{
					duration_ms: Date.now() - start,
				},
			);
		}
	},
};

export const stateClaimOperation: WorkflowPluginOperation = {
	id: "workflow.state_claim",
	description:
		"Claim a batch from a semantic workflow queue and commit a claim manifest.",

	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();

		try {
			const spec = consumeSpec(ctx);
			const workerGroup = spec.worker_group
				? ctx.workflow.state?.worker_groups?.[spec.worker_group]
				: undefined;

			const queue = spec.queue ?? workerGroup?.queue;
			if (!queue) {
				return failResult(
					"workflow.state_claim: queue or worker_group is required",
				);
			}

			const qSpec = queueSpec(ctx, queue);
			const collection = spec.collection ?? qSpec?.collection;
			if (!collection) {
				return failResult(
					`workflow.state_claim: collection could not be resolved for queue "${queue}"`,
				);
			}

			const batchSize =
				spec.batch_size ?? workerGroup?.batch_size ?? qSpec?.batch_size ?? 1;
			const leaseSeconds =
				spec.lease_seconds ??
				workerGroup?.lease_seconds ??
				qSpec?.visibility_timeout_s ??
				900;

			const outputId = spec.output ?? "state_claim_manifest";

			if (!ctx.redis) {
				if (spec.on_empty === "fail") {
					return failResult("workflow.state_claim: no Redis client available");
				}

				await commitPluginOutput(ctx, outputId, {
					status: "ok",
					backend: "filesystem",
					mode: "artifact_only",
					generated_at: getLocalISOString(),
					valid_count: 0,
					claimed_count: 0,
					reclaimed_expired_count: 0,
					items: [],
					rejected_items: [],
					workflow_result: {
						ok: true,
						retryable: false,
						blocked: false,
						failed: false,
					},
				});

				return okResult({
					duration_ms: Date.now() - start,
					logs: "no redis client; committed empty claim manifest",
				});
			}

			const collectionKeys = keyspace(ctx, collection, undefined, queue);
			const reclaimedExpiredCount = await reclaimExpiredLeases({
				redis: ctx.redis,
				keys: collectionKeys,
				collection,
				queue,
				runId: ctx.runId,
				stepId: ctx.step.id,
			});

			const claimedItemKeys: string[] = [];

			for (let i = 0; i < batchSize; i += 1) {
				const moved = await claimOne(ctx.redis, collectionKeys);
				if (!moved) break;
				claimedItemKeys.push(moved);
			}

			const now = Date.now();
			const leaseExpiresAt = new Date(now + leaseSeconds * 1000).toISOString();
			const itemKeyField = collectionSpec(ctx, collection).item_key ?? "id";
			const items: JsonObject[] = [];

			for (const itemKey of claimedItemKeys) {
				const itemKeys = keyspace(ctx, collection, itemKey, queue);
				const docRaw = await ctx.redis.get(itemKeys.document);

				let item: JsonObject = { [itemKeyField]: itemKey };
				if (docRaw) {
					try {
						const parsed = JSON.parse(docRaw);
						if (
							parsed &&
							typeof parsed === "object" &&
							!Array.isArray(parsed)
						) {
							item = parsed as JsonObject;
						}
					} catch {
						item = { [itemKeyField]: itemKey, raw: docRaw };
					}
				}

				const leaseId = `${ctx.runId}:${ctx.step.id}:${itemKey}:${now}`;
				const lease = {
					lease_id: leaseId,
					item_key: itemKey,
					collection,
					queue,
					worker_group: spec.worker_group ?? null,
					leased_at: getLocalISOString(),
					lease_expires_at: leaseExpiresAt,
					lease_seconds: leaseSeconds,
					run_id: ctx.runId,
					step_id: ctx.step.id,
				};

				await ctx.redis.hset(collectionKeys.activeHash, {
					[itemKey]: JSON.stringify(lease),
				});

				await ctx.redis.xadd(keyspace(ctx, collection).stream, "*", {
					event: "claimed",
					collection,
					item_key: itemKey,
					queue,
					run_id: ctx.runId,
					step_id: ctx.step.id,
				});

				items.push({
					...item,
					item_key: itemKey,
					lease,
				});
			}

			await commitPluginOutput(ctx, outputId, {
				status: "ok",
				backend: "redis",
				mode: "stateful",
				generated_at: getLocalISOString(),
				valid_count: items.length,
				claimed_count: items.length,
				reclaimed_expired_count: reclaimedExpiredCount,
				items,
				rejected_items: [],
				workflow_result: {
					ok: true,
					retryable: false,
					blocked: false,
					failed: false,
				},
			});

			return okResult({
				duration_ms: Date.now() - start,
				logs: `claimed ${items.length} item(s) from ${queue} (reclaimed expired: ${reclaimedExpiredCount})`,
			});
		} catch (err) {
			return failResult(
				`workflow.state_claim: ${err instanceof Error ? err.message : String(err)}`,
				{
					duration_ms: Date.now() - start,
				},
			);
		}
	},
};

export const stateCompleteOperation: WorkflowPluginOperation = {
	id: "workflow.state_complete",
	description:
		"Mark claimed semantic state items complete or failed from a result artifact.",

	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();
		const logs: string[] = [];

		try {
			const specs = completeSpecs(ctx);
			if (specs.length === 0) {
				return failResult(
					"workflow.state_complete: no state_complete specs configured",
				);
			}

			const summaries: JsonObject[] = [];

			for (const spec of specs) {
				if (!spec.output)
					return failResult("workflow.state_complete: output is required");

				const fromStep = spec.from_step ?? ctx.step.depends_on?.[0];
				if (!fromStep) {
					return failResult(
						"workflow.state_complete: from_step is required when the plugin step has no dependency",
					);
				}

				const queue =
					spec.queue ??
					(spec.worker_group
						? ctx.workflow.state?.worker_groups?.[spec.worker_group]?.queue
						: undefined);
				const collection =
					spec.collection ?? resolveCollectionFromQueue(ctx, queue);

				if (!collection) {
					return failResult(
						"workflow.state_complete: collection could not be resolved",
					);
				}

				const artifact = await ctx.artifactStore.readArtifact(
					ctx.runId,
					fromStep,
					spec.output,
				);
				if (!artifact) {
					return failResult(
						`workflow.state_complete: artifact not found for ${fromStep}.${spec.output}`,
					);
				}
				const rows = selectItems(artifact.data, spec.select);
				const itemKeyField =
					spec.item_key ?? collectionSpec(ctx, collection).item_key ?? "id";
				const statusField = spec.status_field ?? "status";

				let completed = 0;
				let failed = 0;
				let skipped = 0;
				let stale = 0;

				if (!ctx.redis) {
					logs.push(
						`no redis client; ${collection} completion is artifact-only`,
					);
				} else {
					for (const row of rows) {
						const itemKey = String(row.item_key ?? row[itemKeyField] ?? "");
						if (!itemKey) {
							skipped += 1;
							continue;
						}

						const status = String(row[statusField] ?? "completed");
						const terminal =
							status === "failed" || status === "blocked" || status === "error"
								? "failed"
								: "completed";

						const keys = keyspace(ctx, collection, itemKey, queue);
						const queueKeys = queue
							? keyspace(ctx, collection, undefined, queue)
							: null;

						if (queue && queueKeys) {
							const active = await ctx.redis.hgetall(queueKeys.activeHash);
							const activeLeaseRaw = active?.[itemKey];
							const activeLeaseId = leaseIdOf(activeLeaseRaw);
							const rowLeaseId = leaseIdOf(row.lease);

							if (activeLeaseId && rowLeaseId && activeLeaseId !== rowLeaseId) {
								stale += 1;

								await ctx.redis.xadd(keys.stream, "*", {
									event: "completion_stale_lease_skipped",
									collection,
									item_key: itemKey,
									queue,
									status,
									run_id: ctx.runId,
									step_id: ctx.step.id,
								});

								continue;
							}

							await redisRaw(ctx.redis, "HDEL", queueKeys.activeHash, itemKey);
							await redisRaw(
								ctx.redis,
								"LREM",
								queueKeys.processingQueue,
								0,
								itemKey,
							);
						}

						await redisRaw(
							ctx.redis,
							"SADD",
							keys.terminalSet(terminal),
							itemKey,
						);

						await ctx.redis.xadd(keys.stream, "*", {
							event: terminal,
							collection,
							item_key: itemKey,
							queue: queue ?? "",
							status,
							run_id: ctx.runId,
							step_id: ctx.step.id,
						});

						if (terminal === "failed") failed += 1;
						else completed += 1;
					}

					const coll = collectionSpec(ctx, collection);
					if (coll.counters?.completed) {
						await incrBy(
							ctx.redis,
							keyspace(ctx, collection).counter(coll.counters.completed),
							completed,
						);
					}
					if (coll.counters?.failed) {
						await incrBy(
							ctx.redis,
							keyspace(ctx, collection).counter(coll.counters.failed),
							failed,
						);
					}
				}

				summaries.push({
					collection,
					queue: queue ?? null,
					rows: rows.length,
					completed,
					failed,
					skipped,
					stale_count: stale,
				});

				logs.push(
					`completed=${completed} failed=${failed} skipped=${skipped} stale=${stale} collection=${collection}`,
				);
			}

			const summaryOutput =
				(withObject(ctx).summary_output as string | undefined) ??
				specs[0]?.summary_output ??
				"state_complete_summary";

			await commitPluginOutput(ctx, summaryOutput, {
				status: "ok",
				generated_at: getLocalISOString(),
				valid_count: summaries.reduce(
					(sum, item) =>
						sum + Number(item.completed ?? 0) + Number(item.failed ?? 0),
					0,
				),
				items: summaries,
				rejected_items: [],
				workflow_result: {
					ok: true,
					retryable: false,
					blocked: false,
					failed: false,
				},
			});

			return okResult({
				duration_ms: Date.now() - start,
				logs: logs.join("\n"),
			});
		} catch (err) {
			return failResult(
				`workflow.state_complete: ${err instanceof Error ? err.message : String(err)}`,
				{
					duration_ms: Date.now() - start,
				},
			);
		}
	},
};
