import type {
	PluginOperationContext,
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

function scalarizeForHash(obj: JsonRecord): Record<string, string> {
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

async function raw(redis: RedisClient, command: string, ...args: unknown[]) {
	const result = await redis.multi([[command, ...args]]);
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

function buildStateKeyspace(
	ctx: Pick<PluginOperationContext, "config" | "date">,
	contract: StateContractSpec,
) {
	const prefix = String(
		ctx.config["redis_prefix"] ||
			ctx.config["state_key"] ||
			"openclaw:workflow",
	)
		.trim()
		.replace(/\s+/g, "_");
	const date = ctx.date;
	const entity = contract.entity;

	return {
		seenIndex: `${prefix}:set:${entity}s:seen:${date}`,
		pendingQueue: `${prefix}:queue:${entity}s:pending:${date}`,
		stream: `${prefix}:stream:${entity}s:${date}`,

		document: (itemKey: string) => `${prefix}:doc:${entity}:${itemKey}:${date}`,

		hash: (itemKey: string) => `${prefix}:hash:${entity}:${itemKey}:${date}`,
	};
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

		const keyspace = buildStateKeyspace(
			{
				config: {
					...args.config,
					state_key: args.workflow.state?.key,
				},
				date: args.date,
			},
			contract,
		);

		for (const item of items) {
			const itemField = contract.item_key || "id";
			const itemValue = item[itemField];
			const itemKey = itemValue == null ? "" : String(itemValue);
			if (!itemKey) continue;

			if (contract.state_views?.seen_index) {
				await raw(args.redis, "sadd", keyspace.seenIndex, itemKey);
			}

			if (contract.state_views?.document) {
				await args.redis.set(keyspace.document(itemKey), JSON.stringify(item));
			}

			if (contract.state_views?.metadata_hash) {
				await args.redis.hset(keyspace.hash(itemKey), scalarizeForHash(item));
			}

			if (contract.state_views?.pending_queue) {
				await raw(args.redis, "rpush", keyspace.pendingQueue, itemKey);
			}

			if (contract.state_views?.event_stream) {
				await args.redis.xadd(keyspace.stream, "*", {
					entity: contract.entity,
					item_key: itemKey,
					lifecycle: contract.lifecycle || "pending",
					run_id: args.runId,
				});
			}
		}
	}
}
