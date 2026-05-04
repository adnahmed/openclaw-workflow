import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

test("manifest exposes only the workflow tool contract and strict config schema", async () => {
	const manifest = JSON.parse(
		await readFile(resolve("openclaw.plugin.json"), "utf8"),
	);

	assert.equal(manifest.id, "openclaw-workflow");
	assert.deepEqual(manifest.contracts.tools, [
		"workflow_run",
		"workflow_status",
		"workflow_list",
		"workflow_cancel",
		"write_output",
		"read_output",
		"list_outputs",
		"materialize_output",
		"workflow_state_get",
		"workflow_step_update",
		"workflow_step_complete",
	]);

	assert.equal(manifest.configSchema.type, "object");
	assert.equal(manifest.configSchema.additionalProperties, false);
	assert.equal(manifest.configSchema.properties.concurrency.type, "integer");
	assert.equal(manifest.configSchema.properties.concurrency.minimum, 1);
	assert.equal(manifest.configSchema.properties.pollIntervalMs.type, "integer");
	assert.ok(manifest.configSchema.properties.pollIntervalMs.minimum >= 250);

	for (const key of [
		"workflowsDir",
		"runsDir",
		"baseDir",
		"concurrency",
		"notifyChannel",
		"sessionModel",
		"pollIntervalMs",
		"stateBackend",
		"redisUrl",
		"filesystemFallback",
	]) {
		assert.ok(manifest.uiHints[key], `missing uiHints.${key}`);
	}
});
