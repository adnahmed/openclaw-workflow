import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultRegistry } from "../dist/plugin-operations.js";
import { FilesystemArtifactStore } from "../dist/state-artifact-stores.js";
import { withTempDir } from "./temp-dir.js";

class StatefulFakeRedisClient {
	constructor() {
		this.kind = "native";
		this.values = new Map();
		this.hashes = new Map();
		this.sets = new Map();
		this.lists = new Map();
	}

	async get(key) {
		return this.values.get(key) ?? null;
	}

	async set(key, value) {
		this.values.set(key, String(value));
		return "OK";
	}

	async del(...keys) {
		for (const key of keys) {
			this.values.delete(key);
			this.hashes.delete(key);
			this.sets.delete(key);
			this.lists.delete(key);
		}
		return keys.length;
	}

	async hset(key, fields) {
		const existing = this.hashes.get(key) ?? {};
		this.hashes.set(key, { ...existing, ...fields });
		return Object.keys(fields || {}).length;
	}

	async hgetall(key) {
		return this.hashes.get(key) ?? null;
	}

	async exists() {
		return 0;
	}

	async expire() {
		return 1;
	}

	async incr() {
		return 1;
	}

	async xadd() {
		return "1-0";
	}

	async xgroup() {
		return "OK";
	}

	async multi(commands) {
		const results = [];
		for (const [rawCommand, ...args] of commands) {
			const command = String(rawCommand).toLowerCase();
			switch (command) {
				case "hdel": {
					const [key, ...fields] = args.map(String);
					const hash = { ...(this.hashes.get(key) ?? {}) };
					let removed = 0;
					for (const field of fields) {
						if (field in hash) {
							delete hash[field];
							removed += 1;
						}
					}
					this.hashes.set(key, hash);
					results.push(removed);
					break;
				}
				case "lrem": {
					const [key, countRaw, valueRaw] = args;
					const keyStr = String(key);
					const value = String(valueRaw);
					const count = Number(countRaw);
					const list = this.lists.get(keyStr) ?? [];
					let removed = 0;
					const next = [];
					for (const item of list) {
						if ((count === 0 || removed < Math.abs(count)) && item === value) {
							removed += 1;
							continue;
						}
						next.push(item);
					}
					this.lists.set(keyStr, next);
					results.push(removed);
					break;
				}
				case "sadd": {
					const [key, ...members] = args.map(String);
					const set = this.sets.get(key) ?? new Set();
					let added = 0;
					for (const member of members) {
						if (!set.has(member)) {
							set.add(member);
							added += 1;
						}
					}
					this.sets.set(key, set);
					results.push(added);
					break;
				}
				default:
					results.push(1);
			}
		}
		return results;
	}

	async disconnect() {}
}

function workflow() {
	return {
		name: "Complete Workflow",
		version: "1.0",
		description: "",
		config: { redis_prefix: "wf:test" },
		state: {
			collections: {
				jobs: {
					entity: "job",
					item_key: "job_id",
				},
			},
			queues: {
				jobs_pending: {
					collection: "jobs",
				},
			},
			worker_groups: {
				classifier: {
					queue: "jobs_pending",
				},
			},
		},
	};
}

async function runComplete({
	artifactStore,
	redis,
	rows,
	runId,
	activeLeaseByKey,
}) {
	const registry = createDefaultRegistry();
	const complete = registry.get("workflow.state_complete");
	assert.ok(complete);

	await artifactStore.commitArtifact({
		runId,
		stepId: "classify",
		outputId: "classification_results",
		declaredOutput: { id: "classification_results" },
		data: { items: rows },
		validators: {},
		attempt: 1,
	});

	const activeHash = "wf:test:hash:jobs:pending:active:2026-05-04";
	const processingQueue = "wf:test:queue:jobs:pending:processing:2026-05-04";
	redis.hashes.set(activeHash, { ...activeLeaseByKey });
	redis.lists.set(processingQueue, Object.keys(activeLeaseByKey));

	return complete.run({
		workflow: workflow(),
		step: {
			id: "complete",
			uses: "workflow.state_complete",
			with: {
				state_complete: {
					from_step: "classify",
					output: "classification_results",
					select: "$.items",
					worker_group: "classifier",
					collection: "jobs",
					item_key: "job_id",
					status_field: "status",
					summary_output: "state_complete_summary",
				},
			},
			depends_on: ["classify"],
			outputs: [{ id: "state_complete_summary" }],
		},
		config: { redis_prefix: "wf:test" },
		runId,
		date: "2026-05-04",
		stateStore: null,
		artifactStore,
		redis,
		validators: {},
	});
}

test("state_complete removes active+processing and marks terminal on matching lease", async () => {
	await withTempDir("state-complete-match", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const redis = new StatefulFakeRedisClient();

		const lease = { lease_id: "lease-1" };
		const result = await runComplete({
			artifactStore,
			redis,
			rows: [{ item_key: "job_1", status: "completed", lease }],
			runId: "run-complete-1",
			activeLeaseByKey: {
				job_1: JSON.stringify(lease),
			},
		});

		assert.equal(result.status, "ok");
		const activeHash = "wf:test:hash:jobs:pending:active:2026-05-04";
		const processingQueue = "wf:test:queue:jobs:pending:processing:2026-05-04";
		const completedSet = "wf:test:set:jobs:completed:2026-05-04";
		assert.equal(
			Object.keys(redis.hashes.get(activeHash) ?? {}).includes("job_1"),
			false,
		);
		assert.equal(
			(redis.lists.get(processingQueue) ?? []).includes("job_1"),
			false,
		);
		assert.equal(
			(redis.sets.get(completedSet) ?? new Set()).has("job_1"),
			true,
		);
	});
});

test("state_complete skips stale lease without terminal mark", async () => {
	await withTempDir("state-complete-stale", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const redis = new StatefulFakeRedisClient();

		const result = await runComplete({
			artifactStore,
			redis,
			rows: [
				{
					item_key: "job_2",
					status: "completed",
					lease: { lease_id: "lease-stale" },
				},
			],
			runId: "run-complete-2",
			activeLeaseByKey: {
				job_2: JSON.stringify({ lease_id: "lease-active" }),
			},
		});

		assert.equal(result.status, "ok");

		const summary = await artifactStore.readArtifact(
			"run-complete-2",
			"complete",
			"state_complete_summary",
		);
		assert.equal(summary.data.items[0].stale_count, 1);

		const activeHash = "wf:test:hash:jobs:pending:active:2026-05-04";
		const completedSet = "wf:test:set:jobs:completed:2026-05-04";
		assert.equal(
			Object.keys(redis.hashes.get(activeHash) ?? {}).includes("job_2"),
			true,
		);
		assert.equal(
			(redis.sets.get(completedSet) ?? new Set()).has("job_2"),
			false,
		);
	});
});
