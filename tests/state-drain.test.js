import assert from "node:assert/strict";
import { test } from "node:test";

import { PluginOperationRegistry } from "../dist/plugin-operations.js";
import { FilesystemArtifactStore } from "../dist/state-artifact-stores.js";
import { executeWorkflow } from "../dist/workflow-executor.js";
import { withTempDir } from "./temp-dir.js";

function passOutputCheck() {
	return {
		passed: true,
		decision: "pass",
		missing_files: [],
		checked_files: [],
		validations: [],
	};
}

function outputIdFromStep(step) {
	if (step?.state_consume?.output) return step.state_consume.output;
	const first = step?.outputs?.[0];
	if (typeof first === "string") return first;
	if (first && typeof first === "object") {
		if (typeof first.id === "string") return first.id;
		if (typeof first.path === "string") return first.path;
	}
	return "claim_manifest";
}

test("state_drain expands iterations and stops on empty claim", async () => {
	await withTempDir("state-drain-ok", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const registry = new PluginOperationRegistry();

		let claimCalls = 0;
		let completeCalls = 0;

		registry.register({
			id: "workflow.state_claim",
			async run(ctx) {
				claimCalls += 1;
				const claimedCount = claimCalls === 1 ? 2 : 0;
				const outputId = outputIdFromStep(ctx.step);

				await ctx.artifactStore.commitArtifact({
					runId: ctx.runId,
					stepId: ctx.step.id,
					outputId,
					declaredOutput: { id: outputId },
					data: {
						claimed_count: claimedCount,
						valid_count: claimedCount,
						items: Array.from({ length: claimedCount }, (_unused, index) => ({
							item_key: `item-${claimCalls}-${index + 1}`,
						})),
					},
					validators: ctx.validators,
					attempt: 1,
				});

				return {
					status: "ok",
					output_check: passOutputCheck(),
					error: null,
					logs: null,
					duration_ms: 1,
				};
			},
		});

		registry.register({
			id: "workflow.state_complete",
			async run() {
				completeCalls += 1;
				return {
					status: "ok",
					output_check: passOutputCheck(),
					error: null,
					logs: null,
					duration_ms: 1,
				};
			},
		});

		const workflow = {
			name: "State Drain Success",
			description: "",
			version: "1.0",
			concurrency: 3,
			config: {},
			validators: {},
			steps: [
				{
					id: "classifier_drain",
					name: "Classifier Drain",
					kind: "state_drain",
					drain: {
						worker_group: "classifier",
						max_empty_claims: 1,
					},
					depends_on: [],
					outputs: [],
					timeout: 60,
					retry: 0,
					retry_delay: 1,
					optional: false,
					steps: [
						{
							id: "claim",
							kind: "plugin",
							uses: "workflow.state_claim",
							state_consume: {
								output: "claim_manifest",
							},
							depends_on: [],
							outputs: [{ id: "claim_manifest" }],
							timeout: 30,
							retry: 0,
							retry_delay: 1,
							optional: false,
						},
						{
							id: "classify",
							task: "Classify claimed items",
							depends_on: ["claim"],
							outputs: [],
							timeout: 30,
							retry: 0,
							retry_delay: 1,
							optional: false,
						},
						{
							id: "complete",
							kind: "plugin",
							uses: "workflow.state_complete",
							depends_on: ["classify"],
							outputs: [],
							timeout: 30,
							retry: 0,
							retry_delay: 1,
							optional: false,
						},
					],
				},
			],
		};

		const stepRunner = async () => ({
			status: "ok",
			session_key: null,
			output_check: passOutputCheck(),
			error: null,
			logs: null,
			duration_ms: 1,
		});

		const finalState = await executeWorkflow(
			workflow,
			"state-drain-run-ok",
			null,
			{
				runsDir: dir,
				baseDir: dir,
				concurrency: 3,
				artifactStore,
				pluginRegistry: registry,
			},
			stepRunner,
		);

		assert.equal(finalState.status, "ok");
		assert.equal(finalState.steps.classifier_drain.status, "ok");
		assert.equal(claimCalls, 2);
		assert.equal(completeCalls, 1);

		assert.equal(finalState.steps["classifier_drain:1:claim"].status, "ok");
		assert.equal(finalState.steps["classifier_drain:1:classify"].status, "ok");
		assert.equal(finalState.steps["classifier_drain:1:complete"].status, "ok");
		assert.equal(finalState.steps["classifier_drain:2:claim"].status, "ok");
		assert.equal(
			finalState.steps["classifier_drain:2:classify"].status,
			"skipped",
		);
		assert.equal(
			finalState.steps["classifier_drain:2:complete"].status,
			"skipped",
		);
	});
});

test("state_drain fails when max_iterations is reached before empty claim", async () => {
	await withTempDir("state-drain-max-iterations", async (dir) => {
		const artifactStore = new FilesystemArtifactStore(dir, dir, "on_demand");
		const registry = new PluginOperationRegistry();

		let claimCalls = 0;

		registry.register({
			id: "workflow.state_claim",
			async run(ctx) {
				claimCalls += 1;
				const outputId = outputIdFromStep(ctx.step);
				await ctx.artifactStore.commitArtifact({
					runId: ctx.runId,
					stepId: ctx.step.id,
					outputId,
					declaredOutput: { id: outputId },
					data: {
						claimed_count: 1,
						valid_count: 1,
						items: [{ item_key: `item-${claimCalls}` }],
					},
					validators: ctx.validators,
					attempt: 1,
				});

				return {
					status: "ok",
					output_check: passOutputCheck(),
					error: null,
					logs: null,
					duration_ms: 1,
				};
			},
		});

		const workflow = {
			name: "State Drain Max Iterations",
			description: "",
			version: "1.0",
			concurrency: 2,
			config: {},
			validators: {},
			steps: [
				{
					id: "classifier_drain",
					name: "Classifier Drain",
					kind: "state_drain",
					drain: {
						worker_group: "classifier",
						max_empty_claims: 1,
						max_iterations: 1,
					},
					depends_on: [],
					outputs: [],
					timeout: 60,
					retry: 0,
					retry_delay: 1,
					optional: false,
					steps: [
						{
							id: "claim",
							kind: "plugin",
							uses: "workflow.state_claim",
							state_consume: {
								output: "claim_manifest",
							},
							depends_on: [],
							outputs: [{ id: "claim_manifest" }],
							timeout: 30,
							retry: 0,
							retry_delay: 1,
							optional: false,
						},
					],
				},
			],
		};

		const stepRunner = async () => ({
			status: "ok",
			session_key: null,
			output_check: passOutputCheck(),
			error: null,
			logs: null,
			duration_ms: 1,
		});

		const finalState = await executeWorkflow(
			workflow,
			"state-drain-run-max-iterations",
			null,
			{
				runsDir: dir,
				baseDir: dir,
				concurrency: 2,
				artifactStore,
				pluginRegistry: registry,
			},
			stepRunner,
		);

		assert.equal(finalState.status, "failed");
		assert.equal(finalState.steps.classifier_drain.status, "failed");
		assert.equal(claimCalls, 1);
		assert.match(finalState.steps.classifier_drain.error, /max_iterations=1/);
	});
});
