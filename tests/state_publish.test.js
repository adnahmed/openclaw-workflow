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
		this.counters = new Map();
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

	async exists(...keys) {
		return keys.filter((key) => this.values.has(key)).length;
	}

	async expire() {
		return 1;
	}

	async incr(key) {
		const next = (this.counters.get(key) ?? 0) + 1;
		this.counters.set(key, next);
		return next;
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
				case "rpush": {
					const [key, ...values] = args.map(String);
					const list = this.lists.get(key) ?? [];
					list.push(...values);
					this.lists.set(key, list);
					results.push(list.length);
					break;
				}
				case "incrby": {
					const [key, amount] = args;
					const next = (this.counters.get(String(key)) ?? 0) + Number(amount);
					this.counters.set(String(key), next);
					results.push(next);
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

test("state_publish is idempotent for published counters and queueing", async () => {
	await withTempDir("state-publish-idempotent", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const redis = new StatefulFakeRedisClient();
		const registry = createDefaultRegistry();
		const publish = registry.get("workflow.state_publish");
		assert.ok(publish);

		const workflow = {
			name: "Publish Workflow",
			version: "1.0",
			description: "",
			config: { redis_prefix: "wf:test" },
			state: {
				collections: {
					jobs: {
						entity: "job",
						item_key: "job_id",
						default_queue: "jobs_pending",
						counters: {
							published: "jobs_published",
						},
					},
				},
				queues: {
					jobs_pending: {
						collection: "jobs",
					},
				},
			},
		};

		await artifactStore.commitArtifact({
			runId: "run-publish-1",
			stepId: "collect",
			outputId: "jobs_manifest",
			declaredOutput: { id: "jobs_manifest" },
			data: [{ job_id: "job_123", title: "Backend Engineer" }],
			validators: {},
			attempt: 1,
		});

		const runPublish = async (stepId, summaryOutput) =>
			publish.run({
				workflow,
				step: {
					id: stepId,
					uses: "workflow.state_publish",
					with: {
						state_publish: {
							from_step: "collect",
							output: "jobs_manifest",
							collection: "jobs",
							queue: "jobs_pending",
							item_key: "job_id",
							summary_output: summaryOutput,
						},
					},
					depends_on: ["collect"],
					outputs: [{ id: summaryOutput }],
				},
				config: workflow.config,
				runId: "run-publish-1",
				date: "2026-05-04",
				stateStore: null,
				artifactStore,
				redis,
				validators: {},
			});

		const first = await runPublish("publish-1", "state_publish_summary_1");
		assert.equal(first.status, "ok");

		const summary1 = await artifactStore.readArtifact(
			"run-publish-1",
			"publish-1",
			"state_publish_summary_1",
		);
		assert.equal(summary1.data.published_count, 1);
		assert.equal(summary1.data.updated_count, 0);
		assert.equal(summary1.data.enqueued_count, 1);

		const second = await runPublish("publish-2", "state_publish_summary_2");
		assert.equal(second.status, "ok");

		const summary2 = await artifactStore.readArtifact(
			"run-publish-1",
			"publish-2",
			"state_publish_summary_2",
		);
		assert.equal(summary2.data.published_count, 0);
		assert.equal(summary2.data.updated_count, 1);
		assert.equal(summary2.data.enqueued_count, 0);

		const queueKey = "wf:test:queue:jobs:pending:2026-05-04";
		assert.equal((redis.lists.get(queueKey) ?? []).length, 1);

		const counterKey = "wf:test:counter:jobs_published:2026-05-04";
		assert.equal(redis.counters.get(counterKey), 1);
	});
});
