import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultRegistry } from "../dist/plugin-operations.js";
import { FilesystemArtifactStore } from "../dist/state-artifact-stores.js";
import { executeWorkflow } from "../dist/workflow-executor.js";
import { loadWorkflowFromFile } from "../dist/workflow-loader.js";
import { withTempDir } from "./temp-dir.js";

class FakeRedisClient {
	constructor() {
		this.kind = "native";
		this.commands = [];
	}

	async get(_key) {
		return null;
	}

	async set(key, value, _options) {
		this.commands.push(["set", key, value]);
		return "OK";
	}

	async del(...keys) {
		this.commands.push(["del", ...keys]);
		return keys.length;
	}

	async hset(key, fields) {
		this.commands.push(["hset", key, fields]);
		return Object.keys(fields || {}).length;
	}

	async hgetall(_key) {
		return null;
	}

	async exists(..._keys) {
		return 0;
	}

	async expire(_key, _seconds) {
		return 1;
	}

	async incr(_key) {
		return 1;
	}

	async xadd(key, id, fields) {
		this.commands.push(["xadd", key, id, fields]);
		return "1-0";
	}

	async xgroup(_command, _key, _group, _id, _options) {
		return "OK";
	}

	async multi(commands) {
		for (const command of commands) {
			this.commands.push(["multi", ...command]);
		}
		return [1];
	}

	async disconnect() {}
}

class StatefulFakeRedisClient {
	constructor() {
		this.kind = "native";
		this.commands = [];
		this.values = new Map();
		this.hashes = new Map();
		this.sets = new Map();
		this.lists = new Map();
		this.counters = new Map();
	}

	async get(key) {
		return this.values.get(key) ?? null;
	}

	async set(key, value, _options) {
		this.commands.push(["set", key, value]);
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
		this.commands.push(["hset", key, fields]);
		const existing = this.hashes.get(key) ?? {};
		this.hashes.set(key, { ...existing, ...fields });
		return Object.keys(fields || {}).length;
	}

	async hgetall(key) {
		return this.hashes.get(key) ?? null;
	}

	async exists(...keys) {
		return keys.filter(
			(key) =>
				this.values.has(key) ||
				this.hashes.has(key) ||
				this.sets.has(key) ||
				this.lists.has(key) ||
				this.counters.has(key),
		).length;
	}

	async expire(_key, _seconds) {
		return 1;
	}

	async incr(key) {
		const next = (this.counters.get(key) ?? 0) + 1;
		this.counters.set(key, next);
		return next;
	}

	async xadd(key, id, fields) {
		this.commands.push(["xadd", key, id, fields]);
		const list = this.lists.get(`stream:${key}`) ?? [];
		list.push({ id, fields });
		this.lists.set(`stream:${key}`, list);
		return "1-0";
	}

	async xgroup(_command, _key, _group, _id, _options) {
		return "OK";
	}

	async multi(commands) {
		const results = [];
		for (const [rawCommand, ...args] of commands) {
			const command = String(rawCommand).toLowerCase();
			this.commands.push(["multi", rawCommand, ...args]);

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
				case "lpop": {
					const [key] = args.map(String);
					const list = this.lists.get(key) ?? [];
					const value = list.length > 0 ? list.shift() : null;
					this.lists.set(key, list);
					results.push(value);
					break;
				}
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

test("workflow-loader parses state.contracts and step.state_contract", async () => {
	await withTempDir("semantic-contract-loader", async (dir) => {
		const wfPath = `${dir}/wf.yml`;
		const yaml = `
name: Semantic Contract Workflow
version: "1.0"
state:
  backend: auto
  contracts:
    linkedin_alert_collection:
      kind: collection
      entity: alert
      item_key: alert_key
      source_output: alerts_manifest
      lifecycle: pending
steps:
  - id: collect
    name: Collect
    task: collect
    state_contract: linkedin_alert_collection
    outputs:
      - id: alerts_manifest
    depends_on: []
`;
		await import("node:fs/promises").then((fs) =>
			fs.writeFile(wfPath, yaml, "utf8"),
		);

		const wf = await loadWorkflowFromFile(wfPath);
		assert.equal(wf.steps[0].state_contract, "linkedin_alert_collection");
		assert.equal(
			wf.state.contracts.linkedin_alert_collection.source_output,
			"alerts_manifest",
		);
	});
});

test("workflow-loader parses collections queues worker_groups and explicit state plugin specs", async () => {
	await withTempDir("semantic-plugin-loader", async (dir) => {
		const wfPath = `${dir}/wf.yml`;
		const yaml = [
			"name: Semantic Plugin Workflow",
			'version: "1.0"',
			"state:",
			"  backend: auto",
			"  collections:",
			"    alerts:",
			"      entity: alert",
			"      item_key: alert_key",
			"      default_queue: alerts_pending",
			"  queues:",
			"    alerts_pending:",
			"      collection: alerts",
			"      batch_size: 10",
			"  worker_groups:",
			"    classifier:",
			"      queue: alerts_pending",
			"      batch_size: 5",
			"steps:",
			"  - id: publish",
			"    kind: plugin",
			"    uses: workflow.state_publish",
			"    state_publish:",
			"      from_step: collect",
			"      output: alerts_manifest",
			"      collection: alerts",
			"    depends_on: [collect]",
			"    outputs:",
			"      - id: state_publish_summary",
			"    timeout: 30",
			"    retry: 0",
			"    optional: false",
			"  - id: claim",
			"    kind: plugin",
			"    uses: workflow.state_claim",
			"    state_consume:",
			"      worker_group: classifier",
			"      output: claim_manifest",
			"    depends_on: [publish]",
			"    outputs:",
			"      - id: claim_manifest",
			"    timeout: 30",
			"    retry: 0",
			"    optional: false",
			"  - id: complete",
			"    kind: plugin",
			"    uses: workflow.state_complete",
			"    state_complete:",
			"      from_step: classify",
			"      output: classification_results",
			"      worker_group: classifier",
			"    depends_on: [claim]",
			"    outputs:",
			"      - id: complete_summary",
			"    timeout: 30",
			"    retry: 0",
			"    optional: false",
			"  - id: reclaim",
			"    kind: plugin",
			"    uses: workflow.state_reclaim_expired",
			"    state_reclaim:",
			"      worker_group: classifier",
			"      output: reclaim_summary",
			"    depends_on: [claim]",
			"    outputs:",
			"      - id: reclaim_summary",
			"    timeout: 30",
			"    retry: 0",
			"    optional: false",
			"  - id: collect",
			"    task: collect",
		].join("\n");
		await import("node:fs/promises").then((fs) =>
			fs.writeFile(wfPath, yaml, "utf8"),
		);

		const wf = await loadWorkflowFromFile(wfPath);
		assert.equal(wf.state.collections.alerts.item_key, "alert_key");
		assert.equal(wf.state.queues.alerts_pending.collection, "alerts");
		assert.equal(wf.state.worker_groups.classifier.queue, "alerts_pending");
		assert.equal(wf.steps[0].state_publish.collection, "alerts");
		assert.equal(wf.steps[1].state_consume.worker_group, "classifier");
		assert.equal(wf.steps[2].state_complete.output, "classification_results");
		assert.equal(wf.steps[3].state_reclaim.output, "reclaim_summary");
	});
});

test("createDefaultRegistry includes workflow.state_publish/claim/reclaim/complete", () => {
	const registry = createDefaultRegistry();
	assert.equal(registry.has("workflow.state_publish"), true);
	assert.equal(registry.has("workflow.state_claim"), true);
	assert.equal(registry.has("workflow.state_reclaim_expired"), true);
	assert.equal(registry.has("workflow.state_complete"), true);
});

test("executor projects collection state contract to redis after successful outputs", async () => {
	await withTempDir("semantic-contract-projector", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const redis = new FakeRedisClient();

		const workflow = {
			name: "Contract Projection",
			description: "",
			version: "1.0",
			concurrency: 1,
			config: {
				redis_prefix: "wf:test",
			},
			state: {
				backend: "auto",
				contracts: {
					linkedin_alert_collection: {
						kind: "collection",
						entity: "alert",
						item_key: "alert_key",
						source_output: "alerts_manifest",
						lifecycle: "pending",
						dedupe: {
							by: ["saved_search_id", "href", "query"],
						},
						state_views: {
							document: true,
							metadata_hash: true,
							seen_index: true,
							pending_queue: true,
							event_stream: true,
						},
						on_no_redis: "artifact_only",
					},
				},
			},
			steps: [
				{
					id: "collect_job_alert_notifications",
					name: "Collect",
					task: "collect",
					state_contract: "linkedin_alert_collection",
					depends_on: [],
					outputs: [{ id: "alerts_manifest" }],
					timeout: 30,
					retry: 0,
					retry_delay: 1,
					optional: false,
					model: null,
				},
			],
		};

		const stepRunner = async (step, runId, _api, options) => {
			await options.artifactStore.commitArtifact({
				runId,
				stepId: step.id,
				outputId: "alerts_manifest",
				declaredOutput: { id: "alerts_manifest" },
				data: [
					{
						alert_key: "a1",
						saved_search_id: "s1",
						href: "https://www.linkedin.com/jobs/view/1",
						query: "typescript",
					},
				],
				validators: {},
				attempt: 1,
			});

			return {
				status: "ok",
				session_key: null,
				output_check: {
					passed: true,
					decision: "pass",
					missing_files: [],
					checked_files: [],
					validations: [],
				},
				error: null,
				logs: null,
				duration_ms: 1,
			};
		};

		const finalState = await executeWorkflow(
			workflow,
			"run-semantic-contract-001",
			null,
			{
				runsDir: dir,
				baseDir: dir,
				concurrency: 1,
				artifactStore,
				redis,
			},
			stepRunner,
		);

		assert.equal(finalState.status, "ok");
		assert.equal(finalState.steps.collect_job_alert_notifications.status, "ok");

		const commandNames = redis.commands.map((cmd) => cmd[0]);
		assert.ok(commandNames.includes("set"), "expected document SET");
		assert.ok(commandNames.includes("hset"), "expected metadata HSET");
		assert.ok(commandNames.includes("xadd"), "expected lifecycle XADD");
		assert.ok(
			redis.commands.some((cmd) => cmd[0] === "multi" && cmd[1] === "sadd"),
			"expected seen_index SADD",
		);
		assert.ok(
			redis.commands.some((cmd) => cmd[0] === "multi" && cmd[1] === "rpush"),
			"expected pending_queue RPUSH",
		);
	});
});

test("executor allows artifact-only state contract when redis is unavailable", async () => {
	await withTempDir("semantic-contract-no-redis", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");

		const workflow = {
			name: "Artifact Only Contract",
			description: "",
			version: "1.0",
			concurrency: 1,
			state: {
				backend: "auto",
				contracts: {
					linkedin_alert_collection: {
						kind: "collection",
						entity: "alert",
						item_key: "alert_key",
						source_output: "alerts_manifest",
						on_no_redis: "artifact_only",
					},
				},
			},
			steps: [
				{
					id: "collect_job_alert_notifications",
					name: "Collect",
					task: "collect",
					state_contract: "linkedin_alert_collection",
					depends_on: [],
					outputs: [{ id: "alerts_manifest" }],
					timeout: 30,
					retry: 0,
					retry_delay: 1,
					optional: false,
					model: null,
				},
			],
		};

		const stepRunner = async (step, runId, _api, options) => {
			await options.artifactStore.commitArtifact({
				runId,
				stepId: step.id,
				outputId: "alerts_manifest",
				declaredOutput: { id: "alerts_manifest" },
				data: [{ alert_key: "a1" }],
				validators: {},
				attempt: 1,
			});

			return {
				status: "ok",
				session_key: null,
				output_check: {
					passed: true,
					decision: "pass",
					missing_files: [],
					checked_files: [],
					validations: [],
				},
				error: null,
				logs: null,
				duration_ms: 1,
			};
		};

		const finalState = await executeWorkflow(
			workflow,
			"run-semantic-contract-002",
			null,
			{
				runsDir: dir,
				baseDir: dir,
				concurrency: 1,
				artifactStore,
				redis: null,
			},
			stepRunner,
		);

		assert.equal(finalState.status, "ok");
		assert.equal(finalState.steps.collect_job_alert_notifications.status, "ok");
	});
});

test("state plugin operations publish claim and complete through semantic state", async () => {
	await withTempDir("semantic-plugin-ops", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const redis = new StatefulFakeRedisClient();
		const registry = createDefaultRegistry();

		const workflow = {
			name: "Semantic Plugin Ops",
			version: "1.0",
			description: "",
			config: { redis_prefix: "wf:test" },
			state: {
				collections: {
					alerts: {
						entity: "alert",
						item_key: "alert_key",
						default_queue: "alerts_pending",
						views: {
							document: true,
							metadata_hash: true,
							seen_index: true,
							event_stream: true,
							pending_queue: true,
						},
						counters: {
							published: "alerts_published",
							completed: "alerts_completed",
							failed: "alerts_failed",
						},
					},
				},
				queues: {
					alerts_pending: {
						collection: "alerts",
						batch_size: 2,
						visibility_timeout_s: 900,
					},
				},
				worker_groups: {
					classifier: {
						queue: "alerts_pending",
						batch_size: 2,
						lease_seconds: 900,
					},
				},
			},
		};

		await artifactStore.commitArtifact({
			runId: "run-state-ops-001",
			stepId: "collect_alerts",
			outputId: "alerts_manifest",
			declaredOutput: { id: "alerts_manifest" },
			data: [
				{ alert_key: "a1", title: "One" },
				{ alert_key: "a2", title: "Two" },
			],
			validators: {},
			attempt: 1,
		});

		const publish = registry.get("workflow.state_publish");
		const claim = registry.get("workflow.state_claim");
		const complete = registry.get("workflow.state_complete");
		assert.ok(publish && claim && complete);

		const publishResult = await publish.run({
			workflow,
			step: {
				id: "publish_alerts_state",
				uses: "workflow.state_publish",
				with: {
					state_publish: {
						from_step: "collect_alerts",
						output: "alerts_manifest",
						collection: "alerts",
						queue: "alerts_pending",
						item_key: "alert_key",
						summary_output: "state_publish_summary",
					},
				},
				depends_on: ["collect_alerts"],
				outputs: [{ id: "state_publish_summary" }],
			},
			config: workflow.config,
			runId: "run-state-ops-001",
			date: "2026-05-04",
			stateStore: null,
			artifactStore,
			redis,
			validators: {},
		});
		assert.equal(publishResult.status, "ok");

		const publishSummary = await artifactStore.readArtifact(
			"run-state-ops-001",
			"publish_alerts_state",
			"state_publish_summary",
		);
		assert.equal(publishSummary.data.items[0].published_count, 2);

		const claimResult = await claim.run({
			workflow,
			step: {
				id: "claim_alerts",
				uses: "workflow.state_claim",
				with: {
					state_consume: {
						worker_group: "classifier",
						output: "claim_manifest",
					},
				},
				depends_on: ["publish_alerts_state"],
				outputs: [{ id: "claim_manifest" }],
			},
			config: workflow.config,
			runId: "run-state-ops-001",
			date: "2026-05-04",
			stateStore: null,
			artifactStore,
			redis,
			validators: {},
		});
		assert.equal(claimResult.status, "ok");

		const claimManifest = await artifactStore.readArtifact(
			"run-state-ops-001",
			"claim_alerts",
			"claim_manifest",
		);
		assert.equal(claimManifest.data.items.length, 2);

		await artifactStore.commitArtifact({
			runId: "run-state-ops-001",
			stepId: "classify_alerts",
			outputId: "classification_results",
			declaredOutput: { id: "classification_results" },
			data: {
				items: [
					{ item_key: "a1", status: "completed" },
					{ item_key: "a2", status: "failed" },
				],
			},
			validators: {},
			attempt: 1,
		});

		const completeResult = await complete.run({
			workflow,
			step: {
				id: "complete_alerts",
				uses: "workflow.state_complete",
				with: {
					state_complete: {
						from_step: "classify_alerts",
						output: "classification_results",
						select: "$.items",
						worker_group: "classifier",
						collection: "alerts",
						item_key: "alert_key",
						status_field: "status",
						summary_output: "state_complete_summary",
					},
				},
				depends_on: ["classify_alerts"],
				outputs: [{ id: "state_complete_summary" }],
			},
			config: workflow.config,
			runId: "run-state-ops-001",
			date: "2026-05-04",
			stateStore: null,
			artifactStore,
			redis,
			validators: {},
		});
		assert.equal(completeResult.status, "ok");

		const completeSummary = await artifactStore.readArtifact(
			"run-state-ops-001",
			"complete_alerts",
			"state_complete_summary",
		);
		assert.equal(completeSummary.data.items[0].completed, 1);
		assert.equal(completeSummary.data.items[0].failed, 1);
	});
});
