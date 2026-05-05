/**
 * @module state-keyspace
 * @description Shared semantic state key naming and Redis helper utilities.
 *
 * Both state_contract projection and workflow.state_* plugin operations must use
 * this module. Do not define Redis key naming separately in those files.
 */

import type { RedisClient } from "./types.js";

export type SemanticStateKeyspaceArgs = {
	config?: Record<string, unknown>;
	stateKey?: string | null;
	workflowName?: string | null;
	date: string;

	/** Semantic collection name, e.g. alerts, jobs, applications. */
	collection: string;

	/** Singular entity name, e.g. alert, job, application. */
	entity?: string;

	/** Optional durable item key. */
	itemKey?: string;

	/** Semantic queue name, e.g. alerts_pending, jobs_needs_classification. */
	queue?: string;

	/** Optional queue suffix override from state.queues.<queue>.suffix. */
	queueSuffix?: string;
};

export type SemanticStateKeyspace = {
	prefix: string;
	collection: string;
	entity: string;
	queuePart: string;

	seenSet: string;
	queuedSet: string;
	queue: string;
	processingQueue: string;
	activeHash: string;
	stream: string;

	document: string;
	hash: string;

	terminalSet(status: string): string;
	counter(name: string): string;

	/**
	 * Secondary index set:
	 * {prefix}:set:{collection}:idx:{field}:{value}:{date}
	 */
	indexSet(field: string, value: string): string;

	/**
	 * Backward-compatible property names for older state_contract code.
	 * These intentionally point to the same canonical keys.
	 */
	seenIndex: string;
	pendingQueue: string;
};

export function singularize(name: string): string {
	if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
	if (name.endsWith("s") && name.length > 1) return name.slice(0, -1);
	return name;
}

export function pluralize(name: string): string {
	if (name.endsWith("s")) return name;
	if (name.endsWith("y")) return `${name.slice(0, -1)}ies`;
	return `${name}s`;
}

export function semanticStatePrefix(args: {
	config?: Record<string, unknown>;
	stateKey?: string | null;
	workflowName?: string | null;
}): string {
	const configured =
		args.config?.["redis_prefix"] ??
		args.config?.["state_key"] ??
		args.stateKey ??
		args.workflowName ??
		"openclaw:workflow";

	return String(configured).trim().replace(/\s+/g, "_");
}

export function semanticQueuePart(
	queue?: string,
	queueSuffix?: string,
	collection?: string,
): string {
	if (queueSuffix) return queueSuffix;
	if (queue) return queue.replace(/_/g, ":");
	return `${collection ?? "items"}:pending`;
}

export function buildSemanticStateKeyspace(
	args: SemanticStateKeyspaceArgs,
): SemanticStateKeyspace {
	const prefix = semanticStatePrefix({
		config: args.config,
		stateKey: args.stateKey,
		workflowName: args.workflowName,
	});

	const collection = args.collection;
	const entity = args.entity ?? singularize(collection);
	const queuePart = semanticQueuePart(args.queue, args.queueSuffix, collection);

	const base = {
		prefix,
		collection,
		entity,
		queuePart,

		seenSet: `${prefix}:set:${collection}:seen:${args.date}`,
		queuedSet: `${prefix}:set:${queuePart}:queued:${args.date}`,
		queue: `${prefix}:queue:${queuePart}:${args.date}`,
		processingQueue: `${prefix}:queue:${queuePart}:processing:${args.date}`,
		activeHash: `${prefix}:hash:${queuePart}:active:${args.date}`,
		stream: `${prefix}:stream:${collection}:${args.date}`,

		document: args.itemKey
			? `${prefix}:doc:${entity}:${args.itemKey}:${args.date}`
			: "",
		hash: args.itemKey
			? `${prefix}:hash:${entity}:${args.itemKey}:${args.date}`
			: "",

		terminalSet(status: string) {
			return `${prefix}:set:${collection}:${status}:${args.date}`;
		},

		counter(name: string) {
			return `${prefix}:counter:${name}:${args.date}`;
		},

		indexSet(field: string, value: string) {
			const safeField = encodeURIComponent(field);
			const safeValue = encodeURIComponent(value);
			return `${prefix}:set:${collection}:idx:${safeField}:${safeValue}:${args.date}`;
		},
	};

	return {
		...base,

		// Compatibility aliases for the previous state_contract projector names.
		seenIndex: base.seenSet,
		pendingQueue: base.queue,
	};
}

export function scalarizeForHash(
	obj: Record<string, unknown>,
): Record<string, string> {
	const out: Record<string, string> = {};

	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null) {
			out[key] = "";
		} else if (typeof value === "string") {
			out[key] = value;
		} else if (typeof value === "number" || typeof value === "boolean") {
			out[key] = String(value);
		} else {
			out[key] = JSON.stringify(value);
		}
	}

	return out;
}

export async function redisRaw(
	redis: RedisClient,
	command: string,
	...args: unknown[]
): Promise<unknown> {
	const result = await redis.multi([[command.toLowerCase(), ...args]]);

	if (Array.isArray(result) && result.length === 1) {
		const first = result[0] as unknown;

		if (Array.isArray(first) && first.length === 2) {
			const [err, value] = first as [unknown, unknown];
			if (err) throw err instanceof Error ? err : new Error(String(err));
			return value;
		}

		return first;
	}

	return result;
}

export function redisReplyIsPositive(reply: unknown): boolean {
	if (typeof reply === "number") return reply > 0;
	if (typeof reply === "string") return Number(reply) > 0;
	return false;
}
