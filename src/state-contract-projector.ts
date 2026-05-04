import {
	buildSemanticStateKeyspace,
	pluralize,
	redisRaw,
	redisReplyIsPositive,
	scalarizeForHash,
} from "./state-keyspace.js";
import type {
	RedisClient,
	StateContractSpec,
	StoredArtifact,
	WorkflowStep,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function normalizeArray<T>(value: T | T[] | undefined | null): T[] {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

function itemArrayFromArtifact(artifact: StoredArtifact | null): JsonRecord[] {
	if (!artifact) return [];
	if (Array.isArray(artifact.data)) {
		return artifact.data.filter(
			(item): item is JsonRecord =>
				Boolean(item) && typeof item === "object" && !Array.isArray(item),
		);
	}
	return [];
}

function dedupeItems(items: JsonRecord[], by: string[]): JsonRecord[] {
	if (!Array.isArray(by) || by.length === 0) return items;
	const seen = new Set<string>();
	const out: JsonRecord[] = [];

	for (const item of items) {
		const key = by
			.map((field) => {
				const value = item[field];
				return value == null ? "" : String(value);
			})
			.join("\u241f");

		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}

	return out;
}

export async function projectStateContracts(args: {
	workflow: {
		state?: { contracts?: Record<string, StateContractSpec>; key?: string };
	};
	step: WorkflowStep;
	runId: string;
	date: string;
	artifactStore: {
		readArtifact(
			runId: string,
			stepId: string,
			outputId: string,
		): Promise<StoredArtifact | null>;
	};
	redis: RedisClient | null;
	config: Record<string, unknown>;
}): Promise<void> {
	const contractNames = normalizeArray(args.step.state_contract);
	if (contractNames.length === 0) return;

	for (const contractName of contractNames) {
		const contract = args.workflow.state?.contracts?.[contractName];
		if (!contract) {
			throw new Error(`Unknown state contract: ${contractName}`);
		}

		if (contract.kind !== "collection") continue;

		const sourceOutput = contract.source_output;
		if (!sourceOutput) {
			throw new Error(`${contractName}: source_output required for collection`);
		}

		const artifact = await args.artifactStore.readArtifact(
			args.runId,
			args.step.id,
			sourceOutput,
		);
		if (!artifact) {
			throw new Error(
				`${contractName}: source artifact not found for output ${sourceOutput}`,
			);
		}

		const baseItems = itemArrayFromArtifact(artifact);
		const items = dedupeItems(baseItems, contract.dedupe?.by || []);

		if (!args.redis) {
			if (contract.on_no_redis === "fail") {
				throw new Error(`${contractName}: no Redis client available`);
			}
			continue;
		}

		const collection = contract.collection ?? pluralize(contract.entity);
		const queue = contract.queue;
		for (const item of items) {
			const itemField = contract.item_key || "id";
			const itemValue = item[itemField];
			const itemKey = itemValue == null ? "" : String(itemValue);
			if (!itemKey) continue;

			const itemKeys = buildSemanticStateKeyspace({
				config: {
					...args.config,
					state_key: args.workflow.state?.key,
				},
				stateKey: args.workflow.state?.key,
				workflowName: null,
				date: args.date,
				collection,
				entity: contract.entity,
				itemKey,
				queue,
				queueSuffix: contract.queue_suffix,
			});

			if (contract.state_views?.seen_index) {
				await redisRaw(args.redis, "SADD", itemKeys.seenSet, itemKey);
			}

			if (contract.state_views?.document) {
				await args.redis.set(itemKeys.document, JSON.stringify(item));
			}

			if (contract.state_views?.metadata_hash) {
				await args.redis.hset(itemKeys.hash, scalarizeForHash(item));
			}

			if (contract.state_views?.pending_queue) {
				const added = await redisRaw(
					args.redis,
					"SADD",
					itemKeys.queuedSet,
					itemKey,
				);
				if (redisReplyIsPositive(added)) {
					await redisRaw(args.redis, "RPUSH", itemKeys.queue, itemKey);
				}
			}

			if (contract.state_views?.event_stream) {
				await args.redis.xadd(itemKeys.stream, "*", {
					event: "published",
					collection,
					entity: contract.entity,
					item_key: itemKey,
					lifecycle: contract.lifecycle || "pending",
					queue: queue ?? "",
					run_id: args.runId,
					step_id: args.step.id,
				});
			}
		}
	}
}
