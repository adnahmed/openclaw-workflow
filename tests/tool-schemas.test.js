import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";

import { toolSchemas } from "../dist/tool-schemas.js";

test("tool schemas validate expected parameters", () => {
	assert.deepEqual(Object.keys(toolSchemas).sort(), [
		"workflow_cancel",
		"workflow_list",
		"workflow_run",
		"workflow_status",
		"workflow_step_complete",
		"workflow_step_update",
		"write_output",
	]);

	assert.equal(
		Value.Check(toolSchemas.workflow_run, { name: "deploy", dry_run: true }),
		true,
	);
	assert.equal(Value.Check(toolSchemas.workflow_run, { dry_run: true }), false);
	assert.equal(
		Value.Check(toolSchemas.workflow_status, { run_id: "run-1" }),
		true,
	);
	assert.equal(
		Value.Check(toolSchemas.workflow_status, { name: "deploy" }),
		true,
	);
	assert.equal(
		Value.Check(toolSchemas.workflow_cancel, { run_id: "run-1" }),
		true,
	);
	assert.equal(Value.Check(toolSchemas.workflow_cancel, {}), false);
	assert.equal(
		Value.Check(toolSchemas.write_output, {
			run_id: "run-1",
			step_id: "step-a",
			path: "tmp/out.json",
			data: { ok: true },
		}),
		true,
	);
	assert.equal(
		Value.Check(toolSchemas.write_output, {
			run_id: "run-1",
			step_id: "step-a",
			path: "tmp/out.txt",
			text: "hello",
		}),
		true,
	);
	assert.equal(
		Value.Check(toolSchemas.write_output, { path: "tmp/out.json" }),
		false,
	);
	assert.equal(Value.Check(toolSchemas.workflow_list, {}), true);
	assert.equal(Value.Check(toolSchemas.workflow_list, { extra: true }), false);
	assert.equal(
		Value.Check(toolSchemas.workflow_step_update, {
			run_id: "run-1",
			step_id: "step-a",
			status: "progress",
			counters: { processed: 1 },
		}),
		true,
	);
	assert.equal(
		Value.Check(toolSchemas.workflow_step_complete, {
			run_id: "run-1",
			step_id: "step-a",
			reason: "generated",
		}),
		true,
	);
});
