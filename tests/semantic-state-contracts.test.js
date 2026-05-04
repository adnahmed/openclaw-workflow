import assert from "node:assert/strict";
import { test } from "node:test";

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
