/**
 * @module state-plugin-operations
 * @description Generic semantic state plugin operations.
 *
 * These operations let YAML describe collections, queues, worker groups,
 * claims, and completions without exposing Redis commands to workflow authors.
 */

import {
	buildSemanticStateKeyspace,
	redisRaw,
	redisReplyIsPositive,
	scalarizeForHash,
} from "./state-keyspace.js";
import type {
	OutputCheckResult,
	OutputSpec,
	OutputValidationResult,
	PluginOperationContext,
	PluginOperationResult,
	RedisClient,
	StateArtifactSourceMode,
	StateCollectionSpec,
	StateCompleteSpec,
	StateConsumeSpec,
	StatePartitionSpec,
	StatePatchOutputsSpec,
	StatePublishSpec,
	StateQuerySpec,
	StateQueueSpec,
	StateReclaimSpec,
	StateReportSpec,
	StateRouteQueueSpec,
	StateWhereSpec,
	WorkflowPluginOperation,
} from "./types.js";
import { getLocalISOString } from "./workflow-state.js";

type JsonObject = Record<string, unknown>;
type SourceArtifact = {
	stepId: string;
	outputId: string;
	data: unknown;
};

type ReclaimStats = {
	reclaimedExpiredCount: number;
	reclaimedOrphanedCount: number;
};

const CLAIM_WITH_LEASE_SCRIPT = `
local item = redis.call('LMOVE', KEYS[1], KEYS[2], 'LEFT', 'RIGHT')
if not item then
  return nil
end

local lease = string.gsub(ARGV[1], '"__ITEM_KEY_PLACEHOLDER__"', cjson.encode(item), 1)
redis.call('HSET', KEYS[3], item, lease)
return item
`;

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

function configFailResult(
	ctx: PluginOperationContext,
	operation: string,
	message: string,
	details: Record<string, unknown> = {},
): PluginOperationResult {
	const compiledFrom = (ctx.step as Record<string, unknown>)[
		"__compiled_from"
	] as
		| {
				source_pointer?: string;
				pointer?: string;
		  }
		| undefined;
	const sourcePointer =
		compiledFrom?.source_pointer ??
		compiledFrom?.pointer ??
		`/steps/${ctx.step.id}`;

	return failResult(
		`${operation}: invalid configuration at ${sourcePointer}: ${message}`,
		{
			retryable: false,
			failure_kind: "configuration",
			logs: JSON.stringify(
				{
					phase: "plugin_config_validation",
					operation,
					step_id: ctx.step.id,
					source_pointer: sourcePointer,
					message,
					step_keys: Object.keys(ctx.step as Record<string, unknown>).sort(),
					with_keys: Object.keys(withObject(ctx)).sort(),
					...details,
				},
				null,
				2,
			),
		},
	);
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

function withObject(ctx: PluginOperationContext): JsonObject {
	return (ctx.step.with ?? {}) as unknown as JsonObject;
}

type ConfigResolution<T> =
	| {
			ok: true;
			spec: T;
			source: string;
	  }
	| {
			ok: false;
			result: PluginOperationResult;
	  };

const STATE_CONFIG_ALIASES: Record<string, string[]> = {
	state_publish: ["publish"],
	state_consume: ["consume"],
	state_complete: ["complete"],
	state_reclaim: ["reclaim"],
	state_query: ["query"],
	state_partition: ["partition"],
	state_patch_outputs: ["patch_outputs"],
	state_report: ["report"],
};

function resolveStateConfig<T extends Record<string, unknown>>(
	ctx: PluginOperationContext,
	operation: string,
	key: string,
): ConfigResolution<T> {
	const step = ctx.step as unknown as Record<string, unknown>;
	const withObj = withObject(ctx);

	const topLevel = step[key];
	const canonicalWith = withObj[key];

	const aliases = STATE_CONFIG_ALIASES[key] ?? [];
	const aliasHits = aliases
		.filter((alias) => withObj[alias] !== undefined)
		.map((alias) => ({ alias, value: withObj[alias] }));

	if (aliasHits.length > 1) {
		return {
			ok: false,
			result: configFailResult(
				ctx,
				operation,
				`multiple legacy config aliases found for ${key}: ${aliasHits.map((h) => h.alias).join(", ")}`,
				{ expected: [`${key}`, `with.${key}`] },
			),
		};
	}

	const aliasValue = aliasHits[0]?.value;

	if (canonicalWith !== undefined && aliasValue !== undefined) {
		return {
			ok: false,
			result: configFailResult(
				ctx,
				operation,
				`conflicting config paths with.${key} and with.${aliasHits[0].alias}`,
				{ expected: [`${key}`, `with.${key}`] },
			),
		};
	}

	const withValue = canonicalWith ?? aliasValue;
	const withSource =
		canonicalWith !== undefined
			? `with.${key}`
			: aliasHits[0]
				? `with.${aliasHits[0].alias}`
				: null;

	if (
		topLevel !== undefined &&
		withValue !== undefined &&
		JSON.stringify(topLevel) !== JSON.stringify(withValue)
	) {
		return {
			ok: false,
			result: configFailResult(
				ctx,
				operation,
				`conflicting config at ${key} and ${withSource}`,
				{
					top_level_key: key,
					with_key: withSource,
				},
			),
		};
	}

	const spec = withValue ?? topLevel;

	if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
		return {
			ok: false,
			result: configFailResult(ctx, operation, `missing config ${key}`, {
				expected: [key, `with.${key}`],
				legacy_aliases: aliases.map((alias) => `with.${alias}`),
			}),
		};
	}

	return {
		ok: true,
		spec: spec as T,
		source: withSource ?? key,
	};
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

async function readSourceArtifacts(args: {
	ctx: PluginOperationContext;
	fromStep: string;
	output: string;
	source?: StateArtifactSourceMode;
}): Promise<SourceArtifact[]> {
	const source = args.source ?? "auto";

	if (source === "exact" || source === "auto") {
		const exact = await args.ctx.artifactStore.readArtifact(
			args.ctx.runId,
			args.fromStep,
			args.output,
		);

		if (exact) {
			return [
				{
					stepId: args.fromStep,
					outputId: args.output,
					data: exact.data,
				},
			];
		}

		if (source === "exact") return [];
	}

	const metas = await args.ctx.artifactStore.listArtifacts(args.ctx.runId);

	const matches = metas.filter((meta) => {
		if (meta.output_id !== args.output) return false;
		return meta.step_id.startsWith(`${args.fromStep}:`);
	});

	const out: SourceArtifact[] = [];

	for (const meta of matches) {
		const artifact = await args.ctx.artifactStore.readArtifact(
			args.ctx.runId,
			meta.step_id,
			meta.output_id,
		);

		if (!artifact) continue;

		out.push({
			stepId: meta.step_id,
			outputId: meta.output_id,
			data: artifact.data,
		});
	}

	return out;
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

function keyspace(
	ctx: PluginOperationContext,
	collection: string,
	itemKey?: string,
	queue?: string,
) {
	const coll = collectionSpec(ctx, collection);
	const qSpec = queueSpec(ctx, queue);

	return buildSemanticStateKeyspace({
		config: ctx.config,
		stateKey: ctx.workflow.state?.key,
		workflowName: ctx.workflow.name,
		date: ctx.date,
		collection,
		entity: coll.entity,
		itemKey,
		queue,
		queueSuffix: qSpec?.suffix,
	});
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

function buildLeaseRecord(args: {
	ctx: PluginOperationContext;
	collection: string;
	queue: string;
	workerGroup?: string;
	leaseSeconds: number;
	leaseId: string;
	leasedAt: string;
	leaseExpiresAt: string;
}): JsonObject {
	return {
		lease_id: args.leaseId,
		item_key: "__ITEM_KEY_PLACEHOLDER__",
		collection: args.collection,
		queue: args.queue,
		worker_group: args.workerGroup ?? null,
		leased_at: args.leasedAt,
		lease_expires_at: args.leaseExpiresAt,
		lease_seconds: args.leaseSeconds,
		run_id: args.ctx.runId,
		step_id: args.ctx.step.id,
	};
}

async function claimOneWithLease(args: {
	redis: RedisClient;
	keys: ReturnType<typeof keyspace>;
	leaseJson: string;
}): Promise<string | null> {
	if (typeof args.redis.eval === "function") {
		try {
			const claimed = await args.redis.eval(
				CLAIM_WITH_LEASE_SCRIPT,
				[args.keys.queue, args.keys.processingQueue, args.keys.activeHash],
				[args.leaseJson],
			);
			return claimed ? String(claimed) : null;
		} catch {
			// Fall through to compatibility mode.
		}
	}

	const moved = await claimOne(args.redis, args.keys);
	if (!moved) return null;

	await args.redis.hset(args.keys.activeHash, {
		[moved]: args.leaseJson.replace(
			'"__ITEM_KEY_PLACEHOLDER__"',
			JSON.stringify(moved),
		),
	});

	return moved;
}

function resolveQueueContext(
	ctx: PluginOperationContext,
	spec: {
		queue?: string;
		worker_group?: string;
		collection?: string;
	},
) {
	const workerGroup = spec.worker_group
		? ctx.workflow.state?.worker_groups?.[spec.worker_group]
		: undefined;
	const queue = spec.queue ?? workerGroup?.queue;
	if (!queue) {
		return { error: "queue or worker_group is required" } as const;
	}

	const qSpec = queueSpec(ctx, queue);
	const collection = spec.collection ?? qSpec?.collection;
	if (!collection) {
		return {
			error: `collection could not be resolved for queue "${queue}"`,
		} as const;
	}

	return { workerGroup, queue, collection } as const;
}

async function reclaimExpiredLeases(args: {
	redis: RedisClient;
	keys: ReturnType<typeof keyspace>;
	collection: string;
	queue: string;
	runId: string;
	stepId: string;
}): Promise<ReclaimStats> {
	const active = await args.redis.hgetall(args.keys.activeHash);
	const processingItems =
		typeof args.redis.lrange === "function"
			? await args.redis.lrange(args.keys.processingQueue, 0, -1)
			: [];
	const now = Date.now();
	let reclaimedExpiredCount = 0;
	let reclaimedOrphanedCount = 0;
	const processingSet = new Set(processingItems);

	for (const itemKey of processingItems) {
		if (active?.[itemKey]) continue;

		await redisRaw(args.redis, "LREM", args.keys.processingQueue, 0, itemKey);
		await redisRaw(args.redis, "LPUSH", args.keys.queue, itemKey);

		await args.redis.xadd(args.keys.stream, "*", {
			event: "claim_orphan_requeued",
			collection: args.collection,
			item_key: itemKey,
			queue: args.queue,
			run_id: args.runId,
			step_id: args.stepId,
		});

		reclaimedOrphanedCount += 1;
	}

	for (const [itemKey, rawLease] of Object.entries(active ?? {})) {
		const lease = parseLease(rawLease);
		const expiresAt = lease?.lease_expires_at
			? Date.parse(String(lease.lease_expires_at))
			: 0;

		if (expiresAt && expiresAt > now) continue;

		if (!expiresAt && processingSet.has(itemKey)) {
			await redisRaw(args.redis, "HDEL", args.keys.activeHash, itemKey);
			await redisRaw(args.redis, "LREM", args.keys.processingQueue, 0, itemKey);
			await redisRaw(args.redis, "LPUSH", args.keys.queue, itemKey);

			await args.redis.xadd(args.keys.stream, "*", {
				event: "lease_missing_requeued",
				collection: args.collection,
				item_key: itemKey,
				queue: args.queue,
				run_id: args.runId,
				step_id: args.stepId,
			});

			reclaimedOrphanedCount += 1;
			continue;
		}

		if (!expiresAt) continue;

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

		reclaimedExpiredCount += 1;
	}

	return {
		reclaimedExpiredCount,
		reclaimedOrphanedCount,
	};
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

function reclaimSpec(ctx: PluginOperationContext): StateReclaimSpec {
	const stepSpec = (ctx.step as unknown as { state_reclaim?: StateReclaimSpec })
		.state_reclaim;
	return (withObject(ctx).state_reclaim ??
		withObject(ctx).reclaim ??
		stepSpec ??
		{}) as unknown as StateReclaimSpec;
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

function querySpecResolved(ctx: PluginOperationContext) {
	return resolveStateConfig<StateQuerySpec>(
		ctx,
		"workflow.state_query",
		"state_query",
	);
}

function partitionSpecResolved(ctx: PluginOperationContext) {
	return resolveStateConfig<StatePartitionSpec>(
		ctx,
		"workflow.state_partition",
		"state_partition",
	);
}

function patchOutputsSpec(ctx: PluginOperationContext): StatePatchOutputsSpec {
	const stepSpec = (
		ctx.step as unknown as { state_patch_outputs?: StatePatchOutputsSpec }
	).state_patch_outputs;
	return (withObject(ctx).state_patch_outputs ??
		withObject(ctx).patch_outputs ??
		stepSpec ??
		{}) as StatePatchOutputsSpec;
}

function reportSpecResolved(ctx: PluginOperationContext) {
	return resolveStateConfig<StateReportSpec>(
		ctx,
		"workflow.state_report",
		"state_report",
	);
}

function projectItem(
	item: JsonObject,
	projection?: string[],
	itemKeyField = "id",
): JsonObject {
	if (!projection || projection.length === 0) return item;

	const out: JsonObject = {};
	for (const field of projection) {
		if (field in item) out[field] = item[field];
	}

	if ("item_key" in item && !("item_key" in out)) {
		out.item_key = item.item_key;
	}

	if (itemKeyField in item && !(itemKeyField in out)) {
		out[itemKeyField] = item[itemKeyField];
	}

	return out;
}

function matchesFlatWhere(
	item: JsonObject,
	where?: Record<string, unknown>,
): boolean {
	if (!where) return true;

	for (const [field, expected] of Object.entries(where)) {
		const actual = item[field];

		if (Array.isArray(expected)) {
			if (!expected.map(String).includes(String(actual))) return false;
			continue;
		}

		if (expected !== null && typeof expected === "object") {
			const rule = expected as Record<string, unknown>;

			if ("exists" in rule) {
				const exists = actual !== undefined && actual !== null && actual !== "";
				if (Boolean(rule.exists) !== exists) return false;
			}

			if ("eq" in rule && String(actual) !== String(rule.eq)) return false;
			if ("ne" in rule && String(actual) === String(rule.ne)) return false;
			if ("in" in rule) {
				const values = Array.isArray(rule.in) ? rule.in.map(String) : [];
				if (!values.includes(String(actual))) return false;
			}

			continue;
		}

		if (String(actual) !== String(expected)) return false;
	}

	return true;
}

function matchesWhere(item: JsonObject, where?: StateWhereSpec): boolean {
	if (!where) return true;

	const w = where as Record<string, unknown>;

	if ("all" in w) {
		return matchesFlatWhere(item, w.all as Record<string, unknown>);
	}

	if ("any" in w) {
		const any = Array.isArray(w.any) ? w.any : [];
		return any.some((branch) => matchesFlatWhere(item, branch));
	}

	if ("not" in w) {
		return !matchesFlatWhere(item, w.not as Record<string, unknown>);
	}

	return matchesFlatWhere(item, w);
}

function fieldsForMerge(row: JsonObject, mergeFields?: string[]): JsonObject {
	const out: JsonObject = {};

	if (mergeFields && mergeFields.length > 0) {
		for (const field of mergeFields) {
			if (field in row) out[field] = row[field];
		}
		return out;
	}

	for (const [key, value] of Object.entries(row)) {
		if (key === "lease" || key === "item_key" || key.startsWith("_")) {
			continue;
		}
		out[key] = value;
	}

	return out;
}

async function loadCollectionItemKeys(args: {
	ctx: PluginOperationContext;
	collection: string;
	where?: StateWhereSpec;
}): Promise<string[]> {
	if (!args.ctx.redis) {
		throw new Error("Redis is required for state query operations");
	}

	const keys = keyspace(args.ctx, args.collection);
	const coll = collectionSpec(args.ctx, args.collection);
	const indexedFields = new Set(coll.indexes ?? []);
	const where = args.where as JsonObject | undefined;

	if (where && "any" in where && Array.isArray(where.any)) {
		const unionKeys: string[] = [];

		for (const branch of where.any) {
			const terms = simpleIndexedTerms({
				where: branch as StateWhereSpec,
				indexedFields,
			});

			for (const term of terms) {
				for (const value of term.values) {
					unionKeys.push(keys.indexSet(term.field, value));
				}
			}
		}

		if (unionKeys.length > 0) {
			const members = await redisRaw(args.ctx.redis, "SUNION", ...unionKeys);
			return Array.isArray(members) ? members.map(String) : [];
		}
	}

	const terms = simpleIndexedTerms({
		where: args.where,
		indexedFields,
	});

	if (terms.length > 0) {
		const indexKeys = terms.flatMap((term) =>
			term.values.map((value) => keys.indexSet(term.field, value)),
		);

		if (indexKeys.length === 1) {
			const members = await redisRaw(args.ctx.redis, "SMEMBERS", indexKeys[0]);
			return Array.isArray(members) ? members.map(String) : [];
		}

		const members = await redisRaw(args.ctx.redis, "SINTER", ...indexKeys);
		return Array.isArray(members) ? members.map(String) : [];
	}

	const members = await redisRaw(args.ctx.redis, "SMEMBERS", keys.seenSet);
	return Array.isArray(members) ? members.map(String) : [];
}

function simpleIndexedTerms(args: {
	where?: StateWhereSpec;
	indexedFields: Set<string>;
}): Array<{ field: string; values: string[] }> {
	const where = args.where as JsonObject | undefined;
	if (!where) return [];

	const flat =
		"all" in where
			? (where.all as JsonObject)
			: !("any" in where) && !("not" in where)
				? where
				: null;

	if (!flat) return [];

	const terms: Array<{ field: string; values: string[] }> = [];

	for (const [field, expected] of Object.entries(flat)) {
		if (!args.indexedFields.has(field)) continue;
		if (expected === null || expected === undefined) continue;

		if (typeof expected !== "object") {
			terms.push({ field, values: [String(expected)] });
			continue;
		}

		const rule = expected as JsonObject;

		if ("eq" in rule && rule.eq != null) {
			terms.push({ field, values: [String(rule.eq)] });
		} else if ("in" in rule && Array.isArray(rule.in)) {
			terms.push({ field, values: rule.in.map(String) });
		}
	}

	return terms;
}

async function loadRedisDocument(args: {
	ctx: PluginOperationContext;
	collection: string;
	itemKey: string;
}): Promise<JsonObject> {
	const coll = collectionSpec(args.ctx, args.collection);
	const itemKeyField = coll.item_key ?? "id";
	const keys = keyspace(args.ctx, args.collection, args.itemKey);
	const raw = await args.ctx.redis?.get(keys.document);

	if (!raw) return { [itemKeyField]: args.itemKey, item_key: args.itemKey };

	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return {
				...(parsed as JsonObject),
				item_key: args.itemKey,
			};
		}
	} catch {
		// Fall through.
	}

	return { [itemKeyField]: args.itemKey, item_key: args.itemKey };
}

async function writeRedisDocument(args: {
	ctx: PluginOperationContext;
	collection: string;
	itemKey: string;
	next: JsonObject;
	mode: "replace" | "merge";
	indexes?: string[];
}): Promise<void> {
	if (!args.ctx.redis) {
		throw new Error("Redis is required for document write");
	}

	const keys = keyspace(args.ctx, args.collection, args.itemKey);
	const existing = await loadRedisDocument({
		ctx: args.ctx,
		collection: args.collection,
		itemKey: args.itemKey,
	});

	const merged =
		args.mode === "replace"
			? {
					...args.next,
					item_key: args.itemKey,
					updated_at: getLocalISOString(),
				}
			: {
					...existing,
					...args.next,
					item_key: args.itemKey,
					updated_at: getLocalISOString(),
				};

	const coll = collectionSpec(args.ctx, args.collection);
	const indexFields = new Set([
		...(coll.indexes ?? []),
		...(args.indexes ?? []),
	]);

	for (const field of indexFields) {
		const oldValue = existing[field];
		const newValue = merged[field];

		if (
			oldValue !== undefined &&
			oldValue !== null &&
			oldValue !== "" &&
			String(oldValue) !== String(newValue)
		) {
			await redisRaw(
				args.ctx.redis,
				"SREM",
				keyspace(args.ctx, args.collection).indexSet(field, String(oldValue)),
				args.itemKey,
			);
		}
	}

	await args.ctx.redis.set(keys.document, JSON.stringify(merged));
	await args.ctx.redis.hset(keys.hash, scalarizeForHash(merged));

	for (const field of indexFields) {
		const value = merged[field];
		if (value === undefined || value === null || value === "") continue;

		await redisRaw(
			args.ctx.redis,
			"SADD",
			keyspace(args.ctx, args.collection).indexSet(field, String(value)),
			args.itemKey,
		);

		await redisRaw(
			args.ctx.redis,
			"SADD",
			keyspace(args.ctx, args.collection).indexValuesSet(field),
			String(value),
		);
	}
}

async function loadQueryItems(args: {
	ctx: PluginOperationContext;
	collection: string;
	where?: StateWhereSpec;
	projection?: string[];
	limit?: number;
	offset?: number;
}): Promise<JsonObject[]> {
	const limit = Math.max(0, args.limit ?? 1000);
	const offset = Math.max(0, args.offset ?? 0);

	if (limit === 0) return [];

	const itemKeys = await loadCollectionItemKeys({
		ctx: args.ctx,
		collection: args.collection,
		where: args.where,
	});
	const coll = collectionSpec(args.ctx, args.collection);
	const itemKeyField = coll.item_key ?? "id";

	const out: JsonObject[] = [];
	let skipped = 0;

	for (const itemKey of itemKeys) {
		const doc = await loadRedisDocument({
			ctx: args.ctx,
			collection: args.collection,
			itemKey,
		});

		if (!matchesWhere(doc, args.where)) continue;

		if (skipped < offset) {
			skipped += 1;
			continue;
		}

		out.push(projectItem(doc, args.projection, itemKeyField));

		if (limit && out.length >= limit) break;
	}

	return out;
}

type EnqueueStateItemResult = {
	queued: boolean;
	duplicate: boolean;
	queue_key: string;
};

type RouteQueueResult = {
	item_key: string;
	queue: string;
	lifecycle: string | null;
};

/**
 * Shared helper: enqueue a single item key into a semantic queue with optional
 * dedupe via a :seen Redis set. Used by state_complete route_queues and
 * state_partition queue routing.
 */
async function enqueueStateItem(args: {
	ctx: PluginOperationContext;
	collectionName: string;
	queueName: string;
	queueSpec: StateQueueSpec;
	itemKey: string;
	lifecycle?: string;
	dedupe?: boolean;
	documentPatch?: JsonObject;
}): Promise<EnqueueStateItemResult> {
	const redis = args.ctx.redis;
	if (!redis) throw new Error("Redis is required for enqueueStateItem");

	const qKeys = keyspace(
		args.ctx,
		args.collectionName,
		undefined,
		args.queueName,
	);
	const queueKey = qKeys.queue;

	if (args.dedupe !== false) {
		// Use the existing queuedSet as the dedupe guard (same key used by state_publish/state_partition).
		if (typeof redis.sadd === "function") {
			const added = await redis.sadd(qKeys.queuedSet, args.itemKey);
			if (added === 0) {
				return { queued: false, duplicate: true, queue_key: queueKey };
			}
		} else {
			// Fallback: use SADD via redisRaw.
			const added = await redisRaw(
				redis,
				"SADD",
				qKeys.queuedSet,
				args.itemKey,
			);
			if (!redisReplyIsPositive(added)) {
				return { queued: false, duplicate: true, queue_key: queueKey };
			}
		}
	}

	await redisRaw(redis, "RPUSH", queueKey, args.itemKey);

	if (args.documentPatch && Object.keys(args.documentPatch).length > 0) {
		await writeRedisDocument({
			ctx: args.ctx,
			collection: args.collectionName,
			itemKey: args.itemKey,
			next: args.documentPatch,
			mode: "merge",
		});
	}

	await redis.xadd(qKeys.stream, "*", {
		event: "routed",
		collection: args.collectionName,
		item_key: args.itemKey,
		queue: args.queueName,
		lifecycle: args.lifecycle ?? args.queueSpec.lifecycle ?? "",
		run_id: args.ctx.runId,
		step_id: args.ctx.step.id,
	});

	return { queued: true, duplicate: false, queue_key: queueKey };
}

/**
 * After a claimed item is completed and merged, enqueue it into downstream
 * queues based on state_complete.route_queues predicates.
 */
async function routeCompletedItemToQueues(args: {
	ctx: PluginOperationContext;
	spec: StateCompleteSpec;
	collectionName: string;
	itemKey: string;
	row: JsonObject;
	mergedDocument: JsonObject;
}): Promise<RouteQueueResult[]> {
	const routes: StateRouteQueueSpec[] = args.spec.route_queues ?? [];
	const results: RouteQueueResult[] = [];

	for (const route of routes) {
		const matches = matchesWhere(
			{ ...args.mergedDocument, ...args.row } as JsonObject,
			route.when,
		);

		if (!matches) continue;

		const qSpec = args.ctx.workflow.state?.queues?.[route.queue];
		if (!qSpec) {
			throw new Error(
				`state_complete.route_queues references unknown queue "${route.queue}"`,
			);
		}

		if (qSpec.collection !== args.collectionName) {
			throw new Error(
				`state_complete.route_queues queue "${route.queue}" belongs to collection ` +
					`"${qSpec.collection}", not "${args.collectionName}"`,
			);
		}

		const resolvedLifecycle = route.lifecycle ?? qSpec.lifecycle ?? null;

		const enqueueResult = await enqueueStateItem({
			ctx: args.ctx,
			collectionName: args.collectionName,
			queueName: route.queue,
			queueSpec: qSpec,
			itemKey: args.itemKey,
			lifecycle: resolvedLifecycle ?? undefined,
			dedupe: route.dedupe !== false,
			documentPatch: {
				lifecycle: resolvedLifecycle,
				queued_for: route.queue,
				queued_at: new Date().toISOString(),
			},
		});

		if (!enqueueResult.duplicate) {
			results.push({
				item_key: args.itemKey,
				queue: route.queue,
				lifecycle: resolvedLifecycle,
			});
		}
	}

	return results;
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
					return configFailResult(
						ctx,
						"workflow.state_publish",
						"missing required field state_publish.output",
						{
							required_fields: ["output", "collection"],
							accepted_paths: [
								"state_publish.output",
								"with.state_publish.output",
							],
						},
					);
				if (!spec.collection)
					return configFailResult(
						ctx,
						"workflow.state_publish",
						"missing required field state_publish.collection",
						{
							required_fields: ["output", "collection"],
							accepted_paths: [
								"state_publish.collection",
								"with.state_publish.collection",
							],
						},
					);

				const fromStep = spec.from_step ?? ctx.step.depends_on?.[0];
				if (!fromStep) {
					return failResult(
						"workflow.state_publish: from_step is required when the plugin step has no dependency",
					);
				}

				const sourceArtifacts = await readSourceArtifacts({
					ctx,
					fromStep,
					output: spec.output,
					source: spec.source ?? "auto",
				});

				if (sourceArtifacts.length === 0) {
					if (spec.allow_missing_source === true) {
						const summaryOutput =
							(withObject(ctx).summary_output as string | undefined) ??
							spec.summary_output ??
							"state_publish_summary";

						await commitPluginOutput(ctx, summaryOutput, {
							status: "ok",
							reason: "missing_source_allowed",
							processed_count: 0,
							published_count: 0,
							workflow_result: {
								ok: true,
								retryable: false,
								blocked: false,
								failed: false,
							},
						});

						return okResult({
							logs: `no source artifacts found for ${fromStep}.${spec.output}; allow_missing_source=true`,
						});
					}

					return failResult(
						`workflow.state_publish: artifact not found for ${fromStep}.${spec.output}`,
					);
				}

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
				let selected = 0;
				const rejected: JsonObject[] = [];

				if (!ctx.redis) {
					const policy =
						spec.on_no_redis ?? coll.on_no_redis ?? "artifact_only";
					const requiresQueue = Boolean(queue && views.pending_queue);
					if (policy === "fail" || requiresQueue) {
						return failResult(
							requiresQueue
								? `workflow.state_publish: queue-backed publish for collection "${collection}" requires Redis; artifact_only does not provide a consumable queue`
								: `workflow.state_publish: no Redis client for collection "${collection}"`,
						);
					}
					logs.push(`no redis client; ${collection} publish is artifact-only`);
				}

				for (const sourceArtifact of sourceArtifacts) {
					const items = selectItems(sourceArtifact.data, spec.select);
					selected += items.length;

					const sourceRejected: JsonObject[] = [];
					let sourcePublished = 0;
					let sourceUpdated = 0;
					let sourceEnqueued = 0;

					if (ctx.redis) {
						for (const item of items) {
							const rawItemKey = item[itemKeyField];
							const itemKey = rawItemKey == null ? "" : String(rawItemKey);

							if (!itemKey) {
								const entry = {
									reason: `missing item key field "${itemKeyField}"`,
									item,
								};
								sourceRejected.push(entry);
								rejected.push(entry);
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
								firstSeen = redisReplyIsPositive(addedSeen);
							}

							if (views.document || views.metadata_hash) {
								await writeRedisDocument({
									ctx,
									collection,
									itemKey,
									next: item,
									mode: "replace",
									indexes: [],
								});
							}

							if (queue && views.pending_queue) {
								const added = await redisRaw(
									ctx.redis,
									"SADD",
									keys.queuedSet,
									itemKey,
								);
								if (redisReplyIsPositive(added)) {
									await redisRaw(ctx.redis, "RPUSH", keys.queue, itemKey);
									enqueued += 1;
									sourceEnqueued += 1;
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

							if (firstSeen) {
								published += 1;
								sourcePublished += 1;
							} else {
								updated += 1;
								sourceUpdated += 1;
							}
						}
					}

					summaries.push({
						collection,
						from_step: fromStep,
						source_step: sourceArtifact.stepId,
						output: spec.output,
						selected_count: items.length,
						published_count: sourcePublished,
						updated_count: sourceUpdated,
						enqueued_count: sourceEnqueued,
						rejected_items: sourceRejected,
						queue: queue ?? null,
					});
				}

				if (ctx.redis && coll.counters?.published) {
					await incrBy(
						ctx.redis,
						keyspace(ctx, collection).counter(coll.counters.published),
						published,
					);
				}

				if (ctx.redis && coll.counters?.rejected) {
					await incrBy(
						ctx.redis,
						keyspace(ctx, collection).counter(coll.counters.rejected),
						rejected.length,
					);
				}

				totalSelected += selected;
				totalPublished += published;
				totalUpdated += updated;
				totalEnqueued += enqueued;

				logs.push(
					`published ${published}/${selected} item(s) to collection ${collection}`,
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
			const resolved = resolveQueueContext(ctx, spec);
			if ("error" in resolved) {
				return failResult(`workflow.state_claim: ${resolved.error}`);
			}

			const { workerGroup, queue, collection } = resolved;
			const qSpec = queueSpec(ctx, queue);

			const batchSize =
				spec.batch_size ?? workerGroup?.batch_size ?? qSpec?.batch_size ?? 1;
			const leaseSeconds =
				spec.lease_seconds ??
				workerGroup?.lease_seconds ??
				qSpec?.visibility_timeout_s ??
				900;

			const outputId = spec.output ?? "state_claim_manifest";

			if (!ctx.redis) {
				return failResult(
					"workflow.state_claim: Redis is required for queue claims; artifact_only does not provide a consumable queue backend",
					{
						duration_ms: Date.now() - start,
						retryable: false,
					},
				);
			}

			const collectionKeys = keyspace(ctx, collection, undefined, queue);
			const reclaimStats = await reclaimExpiredLeases({
				redis: ctx.redis,
				keys: collectionKeys,
				collection,
				queue,
				runId: ctx.runId,
				stepId: ctx.step.id,
			});

			const claimedItemKeys: string[] = [];
			const claimedLeases = new Map<string, JsonObject>();

			for (let i = 0; i < batchSize; i += 1) {
				const leaseNow = Date.now();
				const lease = buildLeaseRecord({
					ctx,
					collection,
					queue,
					workerGroup: spec.worker_group,
					leaseSeconds,
					leaseId: `${ctx.runId}:${ctx.step.id}:${leaseNow}:${i}`,
					leasedAt: new Date(leaseNow).toISOString(),
					leaseExpiresAt: new Date(
						leaseNow + leaseSeconds * 1000,
					).toISOString(),
				});
				const moved = await claimOneWithLease({
					redis: ctx.redis,
					keys: collectionKeys,
					leaseJson: JSON.stringify(lease),
				});
				if (!moved) break;
				claimedItemKeys.push(moved);
				claimedLeases.set(moved, {
					...lease,
					item_key: moved,
				});
			}

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

				const lease = claimedLeases.get(itemKey) ?? { item_key: itemKey };

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
				reclaimed_expired_count: reclaimStats.reclaimedExpiredCount,
				reclaimed_orphaned_count: reclaimStats.reclaimedOrphanedCount,
				reclaimed_count:
					reclaimStats.reclaimedExpiredCount +
					reclaimStats.reclaimedOrphanedCount,
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
				logs:
					`claimed ${items.length} item(s) from ${queue} ` +
					`(reclaimed expired: ${reclaimStats.reclaimedExpiredCount}, orphaned: ${reclaimStats.reclaimedOrphanedCount})`,
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

export const stateReclaimExpiredOperation: WorkflowPluginOperation = {
	id: "workflow.state_reclaim_expired",
	description:
		"Requeue expired or orphaned in-flight claims for a semantic workflow queue.",

	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();

		try {
			const spec = reclaimSpec(ctx);
			const resolved = resolveQueueContext(ctx, spec);
			if ("error" in resolved) {
				return failResult(`workflow.state_reclaim_expired: ${resolved.error}`);
			}

			const { queue, collection } = resolved;
			const outputId = spec.output ?? "state_reclaim_summary";

			if (!ctx.redis) {
				return failResult(
					"workflow.state_reclaim_expired: Redis is required for queue lease recovery",
					{
						duration_ms: Date.now() - start,
						retryable: false,
					},
				);
			}

			const reclaimStats = await reclaimExpiredLeases({
				redis: ctx.redis,
				keys: keyspace(ctx, collection, undefined, queue),
				collection,
				queue,
				runId: ctx.runId,
				stepId: ctx.step.id,
			});

			await commitPluginOutput(ctx, outputId, {
				status: "ok",
				backend: "redis",
				mode: "stateful",
				generated_at: getLocalISOString(),
				queue,
				collection,
				reclaimed_expired_count: reclaimStats.reclaimedExpiredCount,
				reclaimed_orphaned_count: reclaimStats.reclaimedOrphanedCount,
				reclaimed_count:
					reclaimStats.reclaimedExpiredCount +
					reclaimStats.reclaimedOrphanedCount,
				items: [],
				rejected_items: [],
				valid_count:
					reclaimStats.reclaimedExpiredCount +
					reclaimStats.reclaimedOrphanedCount,
				workflow_result: {
					ok: true,
					retryable: false,
					blocked: false,
					failed: false,
				},
			});

			return okResult({
				duration_ms: Date.now() - start,
				logs:
					`reclaimed queue=${queue} expired=${reclaimStats.reclaimedExpiredCount} ` +
					`orphaned=${reclaimStats.reclaimedOrphanedCount}`,
			});
		} catch (err) {
			return failResult(
				`workflow.state_reclaim_expired: ${err instanceof Error ? err.message : String(err)}`,
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
					return configFailResult(
						ctx,
						"workflow.state_complete",
						"missing required field state_complete.output",
						{
							required_fields: ["output"],
							accepted_paths: [
								"state_complete.output",
								"with.state_complete.output",
							],
						},
					);

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

				if (spec.require_rows === true && rows.length === 0) {
					return failResult(
						`workflow.state_complete: selected zero rows from ${fromStep}.${spec.output}`,
						{ duration_ms: Date.now() - start, retryable: true },
					);
				}

				const itemKeyField =
					spec.item_key ?? collectionSpec(ctx, collection).item_key ?? "id";
				const statusField = spec.status_field ?? "status";

				let completed = 0;
				let failed = 0;
				let skipped = 0;
				let stale = 0;
				let routedCount = 0;
				let routeDuplicates = 0;
				const routedByQueue: Record<string, number> = {};

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

						const shouldMerge =
							spec.merge_document === true ||
							Boolean(spec.merge_fields?.length) ||
							Boolean(spec.indexes?.length);

						let mergedDocument: JsonObject = {};

						if (shouldMerge) {
							const patch = fieldsForMerge(row, spec.merge_fields);

							patch[statusField] = row[statusField] ?? status;
							patch.lifecycle = terminal;
							patch.completed_at = getLocalISOString();

							await writeRedisDocument({
								ctx,
								collection,
								itemKey,
								next: patch,
								mode: "merge",
								indexes: spec.indexes,
							});

							mergedDocument = patch;
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

						if (spec.route_queues && spec.route_queues.length > 0) {
							const routeResults = await routeCompletedItemToQueues({
								ctx,
								spec,
								collectionName: collection,
								itemKey,
								row,
								mergedDocument,
							});
							for (const r of routeResults) {
								routedCount += 1;
								routedByQueue[r.queue] = (routedByQueue[r.queue] ?? 0) + 1;
							}
							const attempted = spec.route_queues.length;
							routeDuplicates += attempted - routeResults.length;
						}
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
					routed_count: routedCount,
					routed_by_queue: routedByQueue,
					route_duplicates: routeDuplicates,
					route_skipped: rows.length - completed - failed - skipped - stale,
				});

				logs.push(
					`completed=${completed} failed=${failed} skipped=${skipped} stale=${stale} routed=${routedCount} collection=${collection}`,
				);

				if (spec.fail_on_skipped !== false && skipped > 0) {
					return failResult(
						`workflow.state_complete: skipped ${skipped} row(s) because item key was missing`,
						{ duration_ms: Date.now() - start, retryable: false },
					);
				}

				if (spec.fail_on_stale !== false && stale > 0) {
					return failResult(
						`workflow.state_complete: skipped ${stale} stale lease completion(s)`,
						{ duration_ms: Date.now() - start, retryable: true },
					);
				}
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
				routed_count: summaries.reduce(
					(sum, item) => sum + Number(item.routed_count ?? 0),
					0,
				),
				routed_by_queue: summaries.reduce(
					(acc: Record<string, number>, item) => {
						const byQueue = (item.routed_by_queue ?? {}) as Record<
							string,
							number
						>;
						for (const [q, n] of Object.entries(byQueue)) {
							acc[q] = (acc[q] ?? 0) + n;
						}
						return acc;
					},
					{},
				),
				route_duplicates: summaries.reduce(
					(sum, item) => sum + Number(item.route_duplicates ?? 0),
					0,
				),
				route_skipped: summaries.reduce(
					(sum, item) => sum + Number(item.route_skipped ?? 0),
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

export const stateQueryOperation: WorkflowPluginOperation = {
	id: "workflow.state_query",
	description:
		"Query Redis semantic state and commit a bounded manifest artifact.",
	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();

		try {
			const resolved = querySpecResolved(ctx);
			if (resolved.ok === false) return resolved.result;

			const spec = resolved.spec;

			if (!spec.collection) {
				return configFailResult(
					ctx,
					"workflow.state_query",
					"missing required field state_query.collection",
					{
						required_fields: ["collection", "output"],
						accepted_paths: [
							"state_query.collection",
							"with.state_query.collection",
						],
					},
				);
			}

			if (!spec.output) {
				return configFailResult(
					ctx,
					"workflow.state_query",
					"missing required field state_query.output",
					{
						required_fields: ["collection", "output"],
						accepted_paths: ["state_query.output", "with.state_query.output"],
					},
				);
			}

			if (!ctx.redis) {
				return failResult(
					"workflow.state_query: Redis is required; artifact globbing is intentionally unsupported",
					{ duration_ms: Date.now() - start, retryable: false },
				);
			}

			const items = await loadQueryItems({
				ctx,
				collection: spec.collection,
				where: spec.where,
				projection: spec.projection,
				limit: spec.limit ?? 1000,
				offset: spec.offset ?? 0,
			});

			await commitPluginOutput(ctx, spec.output, items);

			const summaryOutput = spec.summary_output;
			if (summaryOutput) {
				await commitPluginOutput(ctx, summaryOutput, {
					status: "ok",
					backend: "redis",
					mode: "stateful",
					collection: spec.collection,
					generated_at: getLocalISOString(),
					count: items.length,
					valid_count: items.length,
					items: [],
					rejected_items: [],
					workflow_result: {
						ok: true,
						retryable: false,
						blocked: false,
						failed: false,
					},
				});
			}

			return okResult({
				duration_ms: Date.now() - start,
				logs: `queried ${items.length} item(s) from ${spec.collection}`,
			});
		} catch (err) {
			return failResult(
				`workflow.state_query: ${err instanceof Error ? err.message : String(err)}`,
				{ duration_ms: Date.now() - start },
			);
		}
	},
};

export const statePatchOutputsOperation: WorkflowPluginOperation = {
	id: "workflow.state_patch_outputs",
	description:
		"Merge result artifact rows back into Redis semantic documents without exposing them to model context.",
	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();

		try {
			const spec = patchOutputsSpec(ctx);

			if (!spec.collection) {
				return configFailResult(
					ctx,
					"workflow.state_patch_outputs",
					"missing required field state_patch_outputs.collection",
					{
						required_fields: ["collection", "output"],
						accepted_paths: [
							"state_patch_outputs.collection",
							"with.state_patch_outputs.collection",
						],
					},
				);
			}

			if (!spec.output) {
				return configFailResult(
					ctx,
					"workflow.state_patch_outputs",
					"missing required field state_patch_outputs.output",
					{
						required_fields: ["collection", "output"],
						accepted_paths: [
							"state_patch_outputs.output",
							"with.state_patch_outputs.output",
						],
					},
				);
			}

			if (!ctx.redis) {
				return failResult("workflow.state_patch_outputs: Redis is required", {
					duration_ms: Date.now() - start,
					retryable: false,
				});
			}

			const fromStep = spec.from_step ?? ctx.step.depends_on?.[0];

			if (!fromStep) {
				return failResult(
					"workflow.state_patch_outputs: from_step is required when the plugin step has no dependency",
				);
			}

			const sourceArtifacts = await readSourceArtifacts({
				ctx,
				fromStep,
				output: spec.output,
				source: spec.source ?? "auto",
			});

			if (sourceArtifacts.length === 0) {
				return failResult(
					`workflow.state_patch_outputs: artifact not found for ${fromStep}.${spec.output}`,
				);
			}

			const coll = collectionSpec(ctx, spec.collection);
			const itemKeyField = spec.item_key ?? coll.item_key ?? "id";

			let patched = 0;
			let skipped = 0;
			const rejected: JsonObject[] = [];

			for (const sourceArtifact of sourceArtifacts) {
				const rows = selectItems(sourceArtifact.data, spec.select);

				for (const row of rows) {
					const itemKey = String(row.item_key ?? row[itemKeyField] ?? "");

					if (!itemKey) {
						skipped += 1;
						rejected.push({
							reason: `missing item key field "${itemKeyField}"`,
							artifact: `${sourceArtifact.stepId}.${sourceArtifact.outputId}`,
						});
						continue;
					}

					const patch = fieldsForMerge(row, spec.merge_fields);

					if (spec.status_field && row[spec.status_field] != null) {
						patch[spec.status_field] = row[spec.status_field];
					}

					await writeRedisDocument({
						ctx,
						collection: spec.collection,
						itemKey,
						next: patch,
						mode: "merge",
						indexes: spec.indexes,
					});

					patched += 1;
				}
			}

			const summaryOutput =
				spec.summary_output ?? "state_patch_outputs_summary";

			await commitPluginOutput(ctx, summaryOutput, {
				status: "ok",
				backend: "redis",
				mode: "stateful",
				collection: spec.collection,
				from_step: fromStep,
				output: spec.output,
				generated_at: getLocalISOString(),
				artifact_count: sourceArtifacts.length,
				patched_count: patched,
				skipped_count: skipped,
				valid_count: patched,
				items: [],
				rejected_items: rejected,
				workflow_result: {
					ok: true,
					retryable: false,
					blocked: false,
					failed: false,
				},
			});

			return okResult({
				duration_ms: Date.now() - start,
				logs: `patched ${patched} Redis document(s) from ${sourceArtifacts.length} artifact(s)`,
			});
		} catch (err) {
			return failResult(
				`workflow.state_patch_outputs: ${err instanceof Error ? err.message : String(err)}`,
				{ duration_ms: Date.now() - start },
			);
		}
	},
};

export const statePartitionOperation: WorkflowPluginOperation = {
	id: "workflow.state_partition",
	description:
		"Partition Redis semantic collection items into bounded artifacts and optional Redis queues.",
	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();

		try {
			const resolved = partitionSpecResolved(ctx);
			if (resolved.ok === false) return resolved.result;

			const spec = resolved.spec;

			if (!spec.collection) {
				return configFailResult(
					ctx,
					"workflow.state_partition",
					"missing required field state_partition.collection",
					{
						required_fields: ["collection", "partitions"],
						accepted_paths: [
							"state_partition.collection",
							"with.state_partition.collection",
						],
					},
				);
			}

			if (!spec.partitions || Object.keys(spec.partitions).length === 0) {
				return configFailResult(
					ctx,
					"workflow.state_partition",
					"missing required field state_partition.partitions",
					{
						required_fields: ["collection", "partitions"],
						accepted_paths: [
							"state_partition.partitions",
							"with.state_partition.partitions",
						],
					},
				);
			}

			if (!ctx.redis) {
				return failResult("workflow.state_partition: Redis is required", {
					duration_ms: Date.now() - start,
					retryable: false,
				});
			}

			const summaries: JsonObject[] = [];
			let total = 0;

			for (const [name, partition] of Object.entries(spec.partitions)) {
				const items = await loadQueryItems({
					ctx,
					collection: spec.collection,
					where: partition.where,
					projection: spec.projection,
					limit: spec.limit_per_partition ?? 10000,
					offset: 0,
				});

				await commitPluginOutput(ctx, partition.output, items);

				let enqueued = 0;

				if (partition.queue) {
					const queue = partition.queue;
					const qSpec = queueSpec(ctx, queue);

					if (!qSpec) {
						return failResult(
							`workflow.state_partition: unknown queue "${queue}"`,
						);
					}

					if (qSpec.collection !== spec.collection) {
						return failResult(
							`workflow.state_partition: queue "${queue}" belongs to collection "${qSpec.collection}", not "${spec.collection}"`,
						);
					}

					const coll = collectionSpec(ctx, spec.collection);
					const itemKeyField = spec.item_key ?? coll.item_key ?? "id";
					const qKeys = keyspace(ctx, spec.collection, undefined, queue);

					for (const item of items) {
						const itemKey = String(item.item_key ?? item[itemKeyField] ?? "");
						if (!itemKey) continue;

						const added = await redisRaw(
							ctx.redis,
							"SADD",
							qKeys.queuedSet,
							itemKey,
						);
						if (redisReplyIsPositive(added)) {
							await redisRaw(ctx.redis, "RPUSH", qKeys.queue, itemKey);
							enqueued += 1;
						}

						if (partition.lifecycle) {
							await writeRedisDocument({
								ctx,
								collection: spec.collection,
								itemKey,
								next: {
									lifecycle: partition.lifecycle,
									queued_for: queue,
									partition: name,
								},
								mode: "merge",
								indexes: spec.indexes,
							});
						}

						await ctx.redis.xadd(keyspace(ctx, spec.collection).stream, "*", {
							event: "partitioned",
							collection: spec.collection,
							partition: name,
							item_key: itemKey,
							queue,
							lifecycle: partition.lifecycle ?? name,
							run_id: ctx.runId,
							step_id: ctx.step.id,
						});
					}
				}

				summaries.push({
					partition: name,
					output: partition.output,
					queue: partition.queue ?? null,
					count: items.length,
					enqueued_count: enqueued,
				});

				total += items.length;
			}

			const summaryOutput = spec.summary_output ?? "state_partition_summary";

			await commitPluginOutput(ctx, summaryOutput, {
				status: "ok",
				backend: "redis",
				mode: "stateful",
				collection: spec.collection,
				generated_at: getLocalISOString(),
				count: total,
				valid_count: total,
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
				logs: `partitioned ${total} item(s) from ${spec.collection}`,
			});
		} catch (err) {
			return failResult(
				`workflow.state_partition: ${err instanceof Error ? err.message : String(err)}`,
				{ duration_ms: Date.now() - start },
			);
		}
	},
};

export const stateReportOperation: WorkflowPluginOperation = {
	id: "workflow.state_report",
	description:
		"Generate a bounded final report from Redis semantic state, counters, and indexes.",
	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();

		try {
			const resolved = reportSpecResolved(ctx);
			if (resolved.ok === false) return resolved.result;

			const spec = resolved.spec;

			if (!spec.json_output) {
				return configFailResult(
					ctx,
					"workflow.state_report",
					"missing required field state_report.json_output",
					{
						required_fields: ["json_output"],
						accepted_paths: [
							"state_report.json_output",
							"with.state_report.json_output",
						],
					},
				);
			}

			if (!ctx.redis) {
				return failResult("workflow.state_report: Redis is required", {
					duration_ms: Date.now() - start,
					retryable: false,
				});
			}

			const collections =
				spec.collections ?? Object.keys(ctx.workflow.state?.collections ?? {});
			const includeSamples = Math.max(0, spec.include_samples ?? 25);
			const collectionSummaries: JsonObject[] = [];

			for (const collection of collections) {
				const keys = keyspace(ctx, collection);
				const seen = await redisRaw(ctx.redis, "SCARD", keys.seenSet);

				const completed = await redisRaw(
					ctx.redis,
					"SCARD",
					keys.terminalSet("completed"),
				);

				const failed = await redisRaw(
					ctx.redis,
					"SCARD",
					keys.terminalSet("failed"),
				);

				const sampleItems = includeSamples
					? await loadQueryItems({
							ctx,
							collection,
							limit: includeSamples,
							offset: 0,
						})
					: [];

				const requestedIndexFields =
					spec.indexes?.[collection] ??
					collectionSpec(ctx, collection).indexes ??
					[];

				const indexBreakdowns: Record<string, Record<string, number>> = {};

				for (const field of requestedIndexFields) {
					const valuesRaw = await redisRaw(
						ctx.redis,
						"SMEMBERS",
						keyspace(ctx, collection).indexValuesSet(field),
					);

					const values = Array.isArray(valuesRaw) ? valuesRaw.map(String) : [];
					const counts: Record<string, number> = {};

					for (const value of values) {
						const count = await redisRaw(
							ctx.redis,
							"SCARD",
							keyspace(ctx, collection).indexSet(field, value),
						);

						counts[value] = Number(count ?? 0);
					}

					indexBreakdowns[field] = counts;
				}

				collectionSummaries.push({
					collection,
					seen_count: Number(seen ?? 0),
					completed_count: Number(completed ?? 0),
					failed_count: Number(failed ?? 0),
					indexes: indexBreakdowns,
					sample_items: sampleItems,
				});
			}

			const counterValues: Record<string, number> = {};

			for (const counterName of spec.counters ?? []) {
				const raw = await ctx.redis.get(
					keyspace(ctx, collections[0] ?? "state").counter(counterName),
				);
				counterValues[counterName] = Number(raw ?? 0);
			}

			const report = {
				status: "ok",
				backend: "redis",
				mode: "stateful",
				generated_at: getLocalISOString(),
				run_id: ctx.runId,
				workflow: ctx.workflow.name,
				counts: counterValues,
				collections: collectionSummaries,
				audit: {
					source: "redis_semantic_state",
					artifact_globs_used: false,
					step_id: ctx.step.id,
				},
			};

			await commitPluginOutput(ctx, spec.json_output, report);

			if (spec.markdown_output) {
				const indexLines = collectionSummaries.flatMap((item) => {
					const perCollection: string[] = [];
					const indexes =
						(item.indexes as Record<string, Record<string, number>>) ?? {};

					for (const [field, counts] of Object.entries(indexes)) {
						perCollection.push(`- ${item.collection}.${field}`);
						for (const [value, count] of Object.entries(counts)) {
							perCollection.push(`  - ${value}: ${count}`);
						}
					}

					return perCollection;
				});

				const markdown = [
					`# ${ctx.workflow.name} report`,
					"",
					`Generated: ${report.generated_at}`,
					"",
					"## Collections",
					"",
					...collectionSummaries.map(
						(item) =>
							`- ${item.collection}: seen=${item.seen_count}, completed=${item.completed_count}, failed=${item.failed_count}`,
					),
					"",
					"## Indexes",
					"",
					...(indexLines.length > 0 ? indexLines : ["- (none)"]),
					"",
					"## Counters",
					"",
					...Object.entries(counterValues).map(([k, v]) => `- ${k}: ${v}`),
					"",
				].join("\n");

				await commitPluginOutput(ctx, spec.markdown_output, markdown);
			}

			return okResult({
				duration_ms: Date.now() - start,
				logs: `generated Redis state report for ${collections.length} collection(s)`,
			});
		} catch (err) {
			return failResult(
				`workflow.state_report: ${err instanceof Error ? err.message : String(err)}`,
				{ duration_ms: Date.now() - start },
			);
		}
	},
};
