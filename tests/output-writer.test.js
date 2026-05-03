import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { writeDeclaredOutput } from "../dist/output-writer.js";
import { FilesystemArtifactStore } from "../dist/state-artifact-stores.js";
import { createRunState } from "../dist/workflow-state.js";
import { withTempDir } from "./temp-dir.js";

function baseWorkflow(dir) {
	return {
		name: "Writer Test",
		version: "1.0",
		description: "",
		config: {},
		__dir: dir,
		validators: {
			result_json: {
				type: "json",
				block_when: 'doc.status == "blocked"',
				retry_when: 'doc.status == "retry"',
				fail_when: 'doc.status == "failed"',
				unknown_policy: "fail",
			},
		},
		steps: [],
		concurrency: 1,
	};
}

function runningStateWithDeclaredOutput(runId, outPath) {
	const state = createRunState("Writer Test", "writer-test", ["step-a"], runId);
	state.status = "running";
	state.steps["step-a"].status = "running";
	state.steps["step-a"].attempts = 1;
	state.steps["step-a"].declared_outputs = [
		{ path: outPath, validate: "result_json" },
	];
	return state;
}

test("writeDeclaredOutput commits blocked decision and records provenance", async () => {
	await withTempDir("output-writer-blocked", async (dir) => {
		const outPath = "output-writer-blocked.json";
		const workflow = baseWorkflow(dir);
		const state = runningStateWithDeclaredOutput("run-writer-1", outPath);

		const result = await writeDeclaredOutput({
			workflow,
			state,
			stepId: "step-a",
			path: outPath,
			data: { status: "blocked" },
			baseDir: dir,
			workflowsDir: dir,
		});

		assert.equal(result.ok, true);
		assert.equal(result.committed, true);
		assert.equal(result.decision, "blocked");
		assert.equal(result.provenance.decision, "blocked");

		const abs = join(dir, outPath);
		const raw = await readFile(abs, "utf8");
		const parsed = JSON.parse(raw);
		assert.equal(parsed.status, "blocked");
	});
});

test("writeDeclaredOutput rejects fail decision and does not commit file", async () => {
	await withTempDir("output-writer-fail", async (dir) => {
		const outPath = "output-writer-fail.json";
		const workflow = baseWorkflow(dir);
		const state = runningStateWithDeclaredOutput("run-writer-2", outPath);

		const result = await writeDeclaredOutput({
			workflow,
			state,
			stepId: "step-a",
			path: outPath,
			data: { status: "failed" },
			baseDir: dir,
			workflowsDir: dir,
		});

		assert.equal(result.ok, false);
		assert.equal(result.committed, false);
		assert.equal(result.decision, "fail");
	});
});

test("writeDeclaredOutput forces materialization for legacy path-only output when artifact mode is on_demand", async () => {
	await withTempDir("output-writer-legacy-materialize", async (dir) => {
		const outPath = "legacy-materialized.json";
		const absPath = join(dir, outPath);
		const workflow = baseWorkflow(dir);
		const state = runningStateWithDeclaredOutput("run-writer-legacy", outPath);
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");

		const result = await writeDeclaredOutput({
			workflow,
			state,
			stepId: "step-a",
			path: outPath,
			data: { status: "blocked" },
			baseDir: dir,
			workflowsDir: dir,
			artifactStore,
			materializeMode: "on_demand",
		});

		assert.equal(result.ok, true);
		assert.equal(result.committed, true);
		assert.equal(result.decision, "blocked");

		const raw = await readFile(absPath, "utf8");
		const parsed = JSON.parse(raw);
		assert.equal(parsed.status, "blocked");
	});
});
