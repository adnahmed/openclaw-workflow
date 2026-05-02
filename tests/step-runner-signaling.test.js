import assert from "node:assert/strict";
import { test } from "node:test";

import { createStepRunner } from "../dist/step-runner.js";

function makeCapturingAdapter() {
	const calls = [];

	return {
		calls,
		async spawn(prompt) {
			calls.push(prompt);
			return { sessionId: "sess-1", sessionKey: "session-key-1" };
		},
		async getStatus() {
			return { status: "done" };
		},
	};
}

test("auto-injects signaling protocol for handoff-oriented steps", async () => {
	const adapter = makeCapturingAdapter();
	const runner = createStepRunner(adapter);

	const step = {
		id: "collect_alerts",
		name: "Collect Alerts",
		task: "Collect and write outputs.",
		complete_when: "handoff_or_outputs",
		depends_on: [],
		outputs: [],
		timeout: 5,
		retry: 0,
		retry_delay: 1,
		optional: false,
		model: null,
	};

	await runner(
		step,
		"run-42",
		{},
		{
			pollIntervalMs: 1,
			baseDir: process.cwd(),
			attempts: 2,
			handoffToken: "run-42:collect_alerts:attempt:2",
			validators: {},
			workflowDir: process.cwd(),
		},
	);

	const prompt = adapter.calls[0] || "";
	assert.match(prompt, /workflow_step_update/);
	assert.match(prompt, /workflow_step_complete/);
	assert.match(prompt, /run_id: "run-42"/);
	assert.match(prompt, /step_id: "collect_alerts"/);
	assert.match(prompt, /attempt: 2/);
	assert.match(prompt, /run-42:collect_alerts:attempt:2/);
});

test("does not inject signaling protocol when signaling is off", async () => {
	const adapter = makeCapturingAdapter();
	const runner = createStepRunner(adapter);

	const step = {
		id: "simple_step",
		name: "Simple Step",
		task: "Do simple work.",
		complete_when: "session",
		signaling: "off",
		depends_on: [],
		outputs: [],
		timeout: 5,
		retry: 0,
		retry_delay: 1,
		optional: false,
		model: null,
	};

	await runner(
		step,
		"run-99",
		{},
		{
			pollIntervalMs: 1,
			baseDir: process.cwd(),
			validators: {},
			workflowDir: process.cwd(),
		},
	);

	const prompt = adapter.calls[0] || "";
	assert.equal(prompt.includes("workflow_step_update"), false);
	assert.equal(prompt.includes("workflow_step_complete"), false);
});

test("injects resolved declared output contract and write_output instructions", async () => {
	const adapter = makeCapturingAdapter();
	const runner = createStepRunner(adapter);

	const step = {
		id: "manifest_step",
		name: "Manifest Step",
		task: "Produce manifest output.",
		complete_when: "outputs",
		depends_on: [],
		outputs: [
			{ path: "data/alerts-manifest.json", validate: "alert_manifest_array" },
		],
		timeout: 5,
		retry: 0,
		retry_delay: 1,
		optional: false,
		model: null,
	};

	await runner(
		step,
		"run-100",
		{},
		{
			pollIntervalMs: 1,
			baseDir: process.cwd(),
			validators: {
				alert_manifest_array: {
					type: "json",
					schema: {
						type: "array",
						items: {
							type: "object",
							required: [
								"alert_key",
								"href",
								"saved_search_id",
								"query",
								"source",
								"status",
							],
							properties: {
								alert_key: {
									type: "string",
									pattern: "^alert_[0-9]+_[a-z0-9_]+$",
								},
								href: { type: "string" },
								saved_search_id: { type: "string" },
								query: { type: "string" },
								source: { type: "string" },
								status: { type: "string" },
								raw_action_target: { type: "string" },
							},
						},
					},
					pass_when: "true",
				},
			},
			workflowDir: process.cwd(),
		},
	);

	const prompt = adapter.calls[0] || "";
	assert.match(
		prompt,
		/Declared output handling is managed by the workflow plugin/,
	);
	assert.match(
		prompt,
		/You must commit declared outputs with the write_output tool/,
	);
	assert.match(prompt, /Output contract 1:/);
	assert.match(prompt, /Path: data\/alerts-manifest.json/);
	assert.match(prompt, /Validator: alert_manifest_array/);
	assert.match(prompt, /Type: JSON array/);
	assert.match(
		prompt,
		/alert_key: string, pattern \^alert_\[0-9\]\+_\[a-z0-9_\]\+\$/,
	);
	assert.match(prompt, /Semantic decision:/);
	assert.match(prompt, /- pass_when: true/);
	assert.match(prompt, /Valid item example:/);
});
