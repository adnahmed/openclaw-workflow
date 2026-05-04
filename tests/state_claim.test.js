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

	async lrange(key, start, stop) {
		const list = this.lists.get(key) ?? [];
		const normalizedStop = stop < 0 ? list.length + stop + 1 : stop + 1;
		return list.slice(start, normalizedStop).map(String);
	}

	async eval(script, keys, args) {
		const [fromKey, toKey, activeHash] = keys.map(String);
		const leaseJson = String(args?.[0] ?? "");
		if (!script.includes("LMOVE")) {
			throw new Error("unsupported eval script");
		}
		const from = this.lists.get(fromKey) ?? [];
		const to = this.lists.get(toKey) ?? [];
		const value = from.length > 0 ? from.shift() : null;
		this.lists.set(fromKey, from);
		if (value == null) return null;
		to.push(value);
		this.lists.set(toKey, to);
		const existing = this.hashes.get(activeHash) ?? {};
		this.hashes.set(activeHash, {
			...existing,
			[value]: leaseJson.replace(
				'"__ITEM_KEY_PLACEHOLDER__"',
				JSON.stringify(value),
			),
		});
		return value;
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
				case "lmove": {
					const [fromKey, toKey] = args.map(String);
					const from = this.lists.get(fromKey) ?? [];
					const to = this.lists.get(toKey) ?? [];
					const value = from.length > 0 ? from.shift() : null;
					this.lists.set(fromKey, from);
					if (value != null) {
						to.push(value);
						this.lists.set(toKey, to);
					}
					results.push(value);
					break;
				}
				case "rpoplpush": {
					const [fromKey, toKey] = args.map(String);
					const from = this.lists.get(fromKey) ?? [];
					const to = this.lists.get(toKey) ?? [];
					const value = from.length > 0 ? from.pop() : null;
					this.lists.set(fromKey, from);
					if (value != null) {
						to.unshift(value);
						this.lists.set(toKey, to);
					}
					results.push(value);
					break;
				}
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
				case "lpush": {
					const [key, ...values] = args.map(String);
					const list = this.lists.get(key) ?? [];
					list.unshift(...values);
					this.lists.set(key, list);
					results.push(list.length);
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
		name: "Claim Workflow",
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
					batch_size: 24,
					visibility_timeout_s: 900,
				},
			},
			worker_groups: {
				classifier: {
					queue: "jobs_pending",
					batch_size: 24,
					lease_seconds: 900,
				},
			},
		},
	};
}

test("state_claim moves pending to processing, writes active leases, and flattens manifest items", async () => {
	await withTempDir("state-claim-main", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const redis = new StatefulFakeRedisClient();
		const registry = createDefaultRegistry();
		const claim = registry.get("workflow.state_claim");
		assert.ok(claim);

		const pendingQueue = "wf:test:queue:jobs:pending:2026-05-04";
		const processingQueue = "wf:test:queue:jobs:pending:processing:2026-05-04";
		const activeHash = "wf:test:hash:jobs:pending:active:2026-05-04";

		const pending = [];
		for (let i = 1; i <= 24; i += 1) {
			const id = `job_${i}`;
			pending.push(id);
			await redis.set(
				`wf:test:doc:job:${id}:2026-05-04`,
				JSON.stringify({ job_id: id, title: `Job ${i}` }),
			);
		}
		redis.lists.set(pendingQueue, pending);

		const result = await claim.run({
			workflow: workflow(),
			step: {
				id: "claim",
				uses: "workflow.state_claim",
				with: {
					state_consume: {
						worker_group: "classifier",
						output: "claim_manifest",
					},
				},
				depends_on: [],
				outputs: [{ id: "claim_manifest" }],
			},
			config: { redis_prefix: "wf:test" },
			runId: "run-claim-1",
			date: "2026-05-04",
			stateStore: null,
			artifactStore,
			redis,
			validators: {},
		});

		assert.equal(result.status, "ok");

		const manifest = await artifactStore.readArtifact(
			"run-claim-1",
			"claim",
			"claim_manifest",
		);
		assert.equal(manifest.data.items.length, 24);
		assert.equal(Boolean(manifest.data.items[0].item), false);
		assert.equal(typeof manifest.data.items[0].job_id, "string");
		assert.equal(typeof manifest.data.items[0].lease?.lease_id, "string");

		assert.equal((redis.lists.get(pendingQueue) ?? []).length, 0);
		assert.equal((redis.lists.get(processingQueue) ?? []).length, 24);
		assert.equal(Object.keys(redis.hashes.get(activeHash) ?? {}).length, 24);
	});
});

test("state_claim reclaims expired leases back to pending", async () => {
	await withTempDir("state-claim-expired", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const redis = new StatefulFakeRedisClient();
		const registry = createDefaultRegistry();
		const claim = registry.get("workflow.state_claim");
		assert.ok(claim);

		const pendingQueue = "wf:test:queue:jobs:pending:2026-05-04";
		const processingQueue = "wf:test:queue:jobs:pending:processing:2026-05-04";
		const activeHash = "wf:test:hash:jobs:pending:active:2026-05-04";

		redis.lists.set(processingQueue, ["job_expired"]);
		redis.hashes.set(activeHash, {
			job_expired: JSON.stringify({
				lease_id: "lease-old",
				lease_expires_at: "2000-01-01T00:00:00.000Z",
			}),
		});

		const result = await claim.run({
			workflow: workflow(),
			step: {
				id: "claim",
				uses: "workflow.state_claim",
				with: {
					state_consume: {
						queue: "jobs_pending",
						batch_size: 0,
						output: "claim_manifest",
					},
				},
				depends_on: [],
				outputs: [{ id: "claim_manifest" }],
			},
			config: { redis_prefix: "wf:test" },
			runId: "run-claim-2",
			date: "2026-05-04",
			stateStore: null,
			artifactStore,
			redis,
			validators: {},
		});

		assert.equal(result.status, "ok");
		const manifest = await artifactStore.readArtifact(
			"run-claim-2",
			"claim",
			"claim_manifest",
		);
		assert.equal(manifest.data.reclaimed_expired_count, 1);
		assert.equal(
			(redis.lists.get(processingQueue) ?? []).includes("job_expired"),
			false,
		);
		assert.equal(
			(redis.lists.get(pendingQueue) ?? []).includes("job_expired"),
			true,
		);
		assert.equal(
			Object.keys(redis.hashes.get(activeHash) ?? {}).includes("job_expired"),
			false,
		);
	});
});

test("state_claim reclaims orphaned processing items without active leases", async () => {
	await withTempDir("state-claim-orphaned", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const redis = new StatefulFakeRedisClient();
		const registry = createDefaultRegistry();
		const claim = registry.get("workflow.state_claim");
		assert.ok(claim);

		const pendingQueue = "wf:test:queue:jobs:pending:2026-05-04";
		const processingQueue = "wf:test:queue:jobs:pending:processing:2026-05-04";

		redis.lists.set(processingQueue, ["job_orphaned"]);
		await redis.set(
			"wf:test:doc:job:job_orphaned:2026-05-04",
			JSON.stringify({ job_id: "job_orphaned", title: "Recovered" }),
		);

		const result = await claim.run({
			workflow: workflow(),
			step: {
				id: "claim",
				uses: "workflow.state_claim",
				with: {
					state_consume: {
						queue: "jobs_pending",
						batch_size: 1,
						output: "claim_manifest",
					},
				},
				depends_on: [],
				outputs: [{ id: "claim_manifest" }],
			},
			config: { redis_prefix: "wf:test" },
			runId: "run-claim-3",
			date: "2026-05-04",
			stateStore: null,
			artifactStore,
			redis,
			validators: {},
		});

		assert.equal(result.status, "ok");

		const manifest = await artifactStore.readArtifact(
			"run-claim-3",
			"claim",
			"claim_manifest",
		);
		assert.equal(manifest.data.reclaimed_orphaned_count, 1);
		assert.equal(manifest.data.claimed_count, 1);
		assert.equal(manifest.data.items[0].job_id, "job_orphaned");
		assert.equal((redis.lists.get(pendingQueue) ?? []).length, 0);
	});
});

test("state_claim fails without redis instead of emitting an empty artifact-only manifest", async () => {
	await withTempDir("state-claim-no-redis", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const registry = createDefaultRegistry();
		const claim = registry.get("workflow.state_claim");
		assert.ok(claim);

		const result = await claim.run({
			workflow: workflow(),
			step: {
				id: "claim",
				uses: "workflow.state_claim",
				with: {
					state_consume: {
						worker_group: "classifier",
						output: "claim_manifest",
					},
				},
				depends_on: [],
				outputs: [{ id: "claim_manifest" }],
			},
			config: { redis_prefix: "wf:test" },
			runId: "run-claim-no-redis",
			date: "2026-05-04",
			stateStore: null,
			artifactStore,
			redis: null,
			validators: {},
		});

		assert.equal(result.status, "failed");
		assert.match(result.error, /Redis is required/i);

		const manifest = await artifactStore.readArtifact(
			"run-claim-no-redis",
			"claim",
			"claim_manifest",
		);
		assert.equal(manifest, null);
	});
});

test("state_reclaim_expired requeues expired and orphaned processing items", async () => {
	await withTempDir("state-reclaim-expired", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const redis = new StatefulFakeRedisClient();
		const registry = createDefaultRegistry();
		const reclaim = registry.get("workflow.state_reclaim_expired");
		assert.ok(reclaim);

		const pendingQueue = "wf:test:queue:jobs:pending:2026-05-04";
		const processingQueue = "wf:test:queue:jobs:pending:processing:2026-05-04";
		const activeHash = "wf:test:hash:jobs:pending:active:2026-05-04";

		redis.lists.set(processingQueue, ["job_expired", "job_orphaned"]);
		redis.hashes.set(activeHash, {
			job_expired: JSON.stringify({
				lease_id: "lease-old",
				lease_expires_at: "2000-01-01T00:00:00.000Z",
			}),
		});

		const result = await reclaim.run({
			workflow: workflow(),
			step: {
				id: "reclaim",
				uses: "workflow.state_reclaim_expired",
				with: {
					state_reclaim: {
						queue: "jobs_pending",
						output: "reclaim_summary",
					},
				},
				depends_on: [],
				outputs: [{ id: "reclaim_summary" }],
			},
			config: { redis_prefix: "wf:test" },
			runId: "run-reclaim-1",
			date: "2026-05-04",
			stateStore: null,
			artifactStore,
			redis,
			validators: {},
		});

		assert.equal(result.status, "ok");

		const summary = await artifactStore.readArtifact(
			"run-reclaim-1",
			"reclaim",
			"reclaim_summary",
		);
		assert.equal(summary.data.reclaimed_expired_count, 1);
		assert.equal(summary.data.reclaimed_orphaned_count, 1);
		assert.deepEqual(redis.lists.get(processingQueue) ?? [], []);
		assert.deepEqual(redis.lists.get(pendingQueue) ?? [], [
			"job_expired",
			"job_orphaned",
		]);
	});
});
