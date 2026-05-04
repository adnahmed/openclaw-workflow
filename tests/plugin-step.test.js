/**
 * Tests for kind: plugin step execution:
 *  - PluginOperationRegistry
 *  - workflow.cache_json_document built-in (filesystem only, no redis)
 *  - workflow.redis_run_initializer built-in (filesystem only)
 *  - workflow-loader validates kind: plugin requires `uses`
 *  - executeWorkflow routes plugin steps to runPluginStep
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	createDefaultRegistry,
	PluginOperationRegistry,
} from "../dist/plugin-operations.js";
import { FilesystemArtifactStore } from "../dist/state-artifact-stores.js";
import { executeWorkflow } from "../dist/workflow-executor.js";
import { loadWorkflowFromFile } from "../dist/workflow-loader.js";
import { withTempDir } from "./temp-dir.js";

// ── Registry ─────────────────────────────────────────────────────────────────

test("PluginOperationRegistry: register and get operation", () => {
	const registry = new PluginOperationRegistry();
	const op = {
		id: "test.op",
		description: "A test operation",
		async run(_ctx) {
			return {
				status: "ok",
				output_check: {
					passed: true,
					decision: "pass",
					missing_files: [],
					checked_files: [],
					validations: [],
				},
			};
		},
	};
	registry.register(op);
	assert.strictEqual(registry.has("test.op"), true);
	assert.strictEqual(registry.get("test.op"), op);
	assert.strictEqual(registry.has("nonexistent"), false);
	assert.strictEqual(registry.get("nonexistent"), undefined);
});

test("PluginOperationRegistry: list returns all registered operations", () => {
	const registry = new PluginOperationRegistry();
	registry.register({ id: "a", async run() {} });
	registry.register({ id: "b", async run() {} });
	const ids = registry
		.list()
		.map((o) => o.id)
		.sort();
	assert.deepEqual(ids, ["a", "b"]);
});

test("createDefaultRegistry includes workflow.cache_json_document and workflow.redis_run_initializer", () => {
	const registry = createDefaultRegistry();
	assert.ok(
		registry.has("workflow.cache_json_document"),
		"missing cache_json_document",
	);
	assert.ok(
		registry.has("workflow.redis_run_initializer"),
		"missing redis_run_initializer",
	);
});

// ── workflow.cache_json_document ─────────────────────────────────────────────

test("workflow.cache_json_document: writes artifact from source JSON file", async () => {
	await withTempDir("plugin-cache-json", async (dir) => {
		const artifactsDir = join(dir, ".artifacts");
		await mkdir(artifactsDir, { recursive: true });

		const sourceFile = join(dir, "data.json");
		const payload = { hello: "world", count: 42 };
		await writeFile(sourceFile, JSON.stringify(payload), "utf8");

		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");

		const registry = createDefaultRegistry();
		const op = registry.get("workflow.cache_json_document");
		assert.ok(op, "operation not found");

		const ctx = {
			workflow: { name: "test-wf", config: {} },
			step: {
				id: "cache-step",
				uses: "workflow.cache_json_document",
				with: {
					source_path: sourceFile,
					output_id: "cached-data",
					json_key: "cache:{run_id}",
				},
			},
			config: {},
			runId: "run-cache-001",
			date: "2025-01-01",
			stateStore: null,
			artifactStore,
			redis: null, // filesystem-only
			validators: {},
		};

		const result = await op.run(ctx);
		assert.strictEqual(
			result.status,
			"ok",
			`Expected ok, got: ${result.error}`,
		);

		// Verify artifact was committed
		const artifact = await artifactStore.readArtifact(
			"run-cache-001",
			"cache-step",
			"cached-data",
		);
		assert.ok(artifact, "artifact not found");
		assert.deepEqual(artifact.data, payload);
	});
});

test("workflow.cache_json_document: resolves env-based source_path before base_dir resolution", async () => {
	await withTempDir("plugin-cache-json-env-path", async (dir) => {
		const sourceFile = join(dir, "resume.json");
		const payload = { profile: { name: "Ada" } };
		await writeFile(sourceFile, JSON.stringify(payload), "utf8");

		const previousWorkspace = process.env.OPENCLAW_WORKSPACE;
		process.env.OPENCLAW_WORKSPACE = dir;

		try {
			const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
			const registry = createDefaultRegistry();
			const op = registry.get("workflow.cache_json_document");

			const ctx = {
				workflow: { name: "test-wf", config: {} },
				step: {
					id: "cache-step-env",
					uses: "workflow.cache_json_document",
					with: {
						source_path: "{env.OPENCLAW_WORKSPACE}/resume.json",
						output_id: "cached-data-env",
						json_key: "cache:{run_id}",
						base_dir: join(dir, "should-not-be-used"),
					},
				},
				config: {},
				runId: "run-cache-env-001",
				date: "2025-01-01",
				stateStore: null,
				artifactStore,
				redis: null,
				validators: {},
			};

			const result = await op.run(ctx);
			assert.strictEqual(
				result.status,
				"ok",
				`Expected ok, got: ${result.error}`,
			);

			const artifact = await artifactStore.readArtifact(
				"run-cache-env-001",
				"cache-step-env",
				"cached-data-env",
			);
			assert.ok(artifact, "artifact not found");
			assert.deepEqual(artifact.data, payload);
		} finally {
			if (previousWorkspace === undefined)
				delete process.env.OPENCLAW_WORKSPACE;
			else process.env.OPENCLAW_WORKSPACE = previousWorkspace;
		}
	});
});

test("workflow.cache_json_document: fails gracefully when source_path missing", async () => {
	await withTempDir("plugin-cache-json-missing", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const registry = createDefaultRegistry();
		const op = registry.get("workflow.cache_json_document");

		const ctx = {
			workflow: { name: "test-wf", config: {} },
			step: {
				id: "cache-step",
				uses: "workflow.cache_json_document",
				with: {
					source_path: join(dir, "nonexistent.json"),
					output_id: "cached-data",
				},
			},
			config: {},
			runId: "run-cache-002",
			date: "2025-01-01",
			stateStore: null,
			artifactStore,
			redis: null,
			validators: {},
		};

		const result = await op.run(ctx);
		assert.strictEqual(
			result.status,
			"failed",
			"Should fail when file is missing",
		);
	});
});

// ── workflow.redis_run_initializer ────────────────────────────────────────────

test("workflow.redis_run_initializer: writes artifact even without redis", async () => {
	await withTempDir("plugin-redis-init", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const registry = createDefaultRegistry();
		const op = registry.get("workflow.redis_run_initializer");
		assert.ok(op, "operation not found");

		const ctx = {
			workflow: { name: "test-wf", config: {} },
			step: {
				id: "init-step",
				uses: "workflow.redis_run_initializer",
				with: {
					run_key: "runs:{run_id}",
					stream_key: "events:{run_id}",
					stream_group: "workers",
					output_id: "init-artifact",
				},
			},
			config: {},
			runId: "run-init-001",
			date: "2025-01-01",
			stateStore: null,
			artifactStore,
			redis: null, // filesystem-only
			validators: {},
		};

		const result = await op.run(ctx);
		assert.strictEqual(
			result.status,
			"ok",
			`Expected ok, got: ${result.error}`,
		);

		// Artifact should be written regardless of redis being null
		const artifact = await artifactStore.readArtifact(
			"run-init-001",
			"init-step",
			"init-artifact",
		);
		assert.ok(artifact, "artifact not committed");
		assert.strictEqual(artifact.run_id, "run-init-001");
	});
});

// ── workflow-loader validation ────────────────────────────────────────────────

test("workflow-loader: kind: plugin requires uses field", async () => {
	await withTempDir("wl-plugin-validation", async (dir) => {
		const wfFile = join(dir, "invalid-plugin.yml");
		await writeFile(
			wfFile,
			`
name: Invalid Plugin Workflow
version: "1.0"
steps:
  - id: bad-plugin
    kind: plugin
    depends_on: []
    outputs: []
    timeout: 30
    retry: 0
    optional: false
`,
			"utf8",
		);

		await assert.rejects(
			() => loadWorkflowFromFile(wfFile),
			(err) => {
				assert.ok(
					err.message.includes("uses") || err.message.includes("plugin"),
					`Expected error about missing 'uses', got: ${err.message}`,
				);
				return true;
			},
		);
	});
});

test("workflow-loader: kind: plugin parses uses and with fields", async () => {
	await withTempDir("wl-plugin-parse", async (dir) => {
		const wfFile = join(dir, "valid-plugin.yml");
		await writeFile(
			wfFile,
			`
name: Valid Plugin Workflow
version: "1.0"
steps:
  - id: cache-step
    kind: plugin
    uses: workflow.cache_json_document
    with:
      source_path: /tmp/data.json
      output_id: my-data
    depends_on: []
    outputs: []
    timeout: 30
    retry: 0
    optional: false
`,
			"utf8",
		);

		const wf = await loadWorkflowFromFile(wfFile);
		const step = wf.steps[0];
		assert.strictEqual(step.kind, "plugin");
		assert.strictEqual(step.uses, "workflow.cache_json_document");
		assert.deepEqual(step.with, {
			source_path: "/tmp/data.json",
			output_id: "my-data",
		});
	});
});

// ── executeWorkflow plugin routing ─────────────────────────────────────────────

test("executeWorkflow: plugin step succeeds when operation returns ok", async () => {
	await withTempDir("exec-plugin-ok", async (dir) => {
		const registry = createDefaultRegistry();
		// Register a simple no-op plugin
		registry.register({
			id: "test.noop",
			async run(_ctx) {
				return {
					status: "ok",
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
			},
		});

		const wf = {
			name: "Plugin Workflow",
			description: "",
			version: "1.0",
			concurrency: 1,
			steps: [
				{
					id: "plugin-step",
					kind: "plugin",
					uses: "test.noop",
					with: {},
					depends_on: [],
					outputs: [],
					timeout: 30,
					retry: 0,
					optional: false,
					model: null,
				},
			],
		};

		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");

		const config = {
			runsDir: dir,
			baseDir: dir,
			concurrency: 1,
			artifactStore,
			pluginRegistry: registry,
			redis: null,
		};

		const finalState = await executeWorkflow(
			wf,
			"run-plugin-ok-001",
			null,
			config,
		);
		assert.strictEqual(
			finalState.status,
			"ok",
			`Expected run ok, got: ${finalState.status} — ${finalState.error}`,
		);
		assert.strictEqual(finalState.steps["plugin-step"].status, "ok");
	});
});

test("executeWorkflow: plugin step fails when operation not found", async () => {
	await withTempDir("exec-plugin-notfound", async (dir) => {
		const registry = new PluginOperationRegistry(); // empty registry
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");

		const wf = {
			name: "Plugin Missing Workflow",
			description: "",
			version: "1.0",
			concurrency: 1,
			steps: [
				{
					id: "plugin-step",
					kind: "plugin",
					uses: "nonexistent.operation",
					with: {},
					depends_on: [],
					outputs: [],
					timeout: 30,
					retry: 0,
					optional: false,
					model: null,
				},
			],
		};

		const config = {
			runsDir: dir,
			baseDir: dir,
			concurrency: 1,
			artifactStore,
			pluginRegistry: registry,
			redis: null,
		};

		const finalState = await executeWorkflow(
			wf,
			"run-plugin-missing-001",
			null,
			config,
		);
		assert.strictEqual(finalState.steps["plugin-step"].status, "failed");
		assert.ok(
			finalState.steps["plugin-step"].error?.includes("nonexistent.operation"),
			`Expected error mentioning operation id, got: ${finalState.steps["plugin-step"].error}`,
		);
	});
});
