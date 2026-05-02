import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createStepRunner } from "../dist/step-runner.js";
import { withTempDir } from "./temp-dir.js";

test("repairs stale malformed output and early-completes once current-attempt provenance exists", async () => {
	await withTempDir("step-runner-gating-stale", async (dir) => {
		const outputPath = join(dir, "alerts-ready-summary.json");
		const liveStepState = {
			status: "running",
			attempts: 1,
			output_writes: null,
		};

		// Simulate stale malformed artifact from a previous attempt.
		await writeFile(outputPath, '{"incomplete": true', "utf8");

		let polls = 0;
		const adapter = {
			async spawn() {
				return { sessionId: "sess-1", sessionKey: "session-key-1" };
			},
			async getStatus() {
				polls += 1;
				if (polls === 1) {
					// Repair happens while the session is still running.
					const content = JSON.stringify({ ok: true }, null, 2);
					await writeFile(outputPath, content, "utf8");
					liveStepState.output_writes = {
						"alerts-ready-summary.json": {
							path: "alerts-ready-summary.json",
							abs_path: outputPath,
							decision: "pass",
							run_id: "run-gating-1",
							step_id: "collect_alerts",
							attempt: 1,
							bytes: Buffer.byteLength(content),
							sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
							committed_at: new Date().toISOString(),
						},
					};
					return { status: "running" };
				}
				return { status: "running" };
			},
		};

		const runner = createStepRunner(adapter);

		const step = {
			id: "collect_alerts",
			name: "Collect Alerts",
			task: "Repair malformed output and continue.",
			complete_when: "outputs",
			depends_on: [],
			outputs: [{ path: outputPath, validate: "jsonDoc" }],
			timeout: 1,
			retry: 0,
			retry_delay: 1,
			optional: false,
			model: null,
		};

		const result = await runner(
			step,
			"run-gating-1",
			{},
			{
				pollIntervalMs: 10,
				baseDir: dir,
				attempts: 1,
				getStepState: () => liveStepState,
				validators: {
					jsonDoc: { type: "json", pass_when: "true" },
				},
				workflowDir: dir,
			},
		);

		assert.equal(result.status, "ok");
		assert.equal(result.output_check?.decision, "pass");
	});
});

test("does not terminal-fail fresh hard output failure while session is still running", async () => {
	await withTempDir("step-runner-gating-fresh", async (dir) => {
		const outputPath = join(dir, "alerts-ready-summary.json");

		let polls = 0;
		const adapter = {
			async spawn() {
				return { sessionId: "sess-2", sessionKey: "session-key-2" };
			},
			async getStatus() {
				polls += 1;
				if (polls === 1) {
					// Fresh malformed artifact produced during this attempt.
					await writeFile(outputPath, '{"fresh": true', "utf8");
				}
				return { status: "running" };
			},
		};

		const runner = createStepRunner(adapter);

		const step = {
			id: "collect_alerts",
			name: "Collect Alerts",
			task: "Write malformed output.",
			complete_when: "outputs",
			depends_on: [],
			outputs: [{ path: outputPath, validate: "jsonDoc" }],
			timeout: 1,
			retry: 0,
			retry_delay: 1,
			optional: false,
			model: null,
		};

		const result = await runner(
			step,
			"run-gating-2",
			{},
			{
				pollIntervalMs: 10,
				cancelGraceMs: 1,
				baseDir: dir,
				validators: {
					jsonDoc: { type: "json", pass_when: "true" },
				},
				workflowDir: dir,
			},
		);

		assert.equal(result.status, "failed");
		assert.equal(result.output_check?.decision, "fail");
		assert.match(result.error || "", /timed out/);
	});
});

test("early-completes only when current-attempt provenance matches output file", async () => {
	await withTempDir("step-runner-gating-provenance", async (dir) => {
		const outputPath = join(dir, "alerts-ready-summary.json");
		const liveStepState = {
			status: "running",
			attempts: 2,
			output_writes: null,
		};

		let polls = 0;
		const adapter = {
			async spawn() {
				return { sessionId: "sess-3", sessionKey: "session-key-3" };
			},
			async getStatus() {
				polls += 1;
				if (polls === 1) {
					const content = JSON.stringify({ ok: true }, null, 2);
					await writeFile(outputPath, content, "utf8");
					const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
					liveStepState.output_writes = {
						"alerts-ready-summary.json": {
							path: "alerts-ready-summary.json",
							abs_path: outputPath,
							decision: "pass",
							run_id: "run-gating-3",
							step_id: "collect_alerts",
							attempt: 2,
							bytes: Buffer.byteLength(content),
							sha256,
							committed_at: new Date().toISOString(),
						},
					};
				}
				return { status: "running" };
			},
		};

		const runner = createStepRunner(adapter);
		const step = {
			id: "collect_alerts",
			name: "Collect Alerts",
			task: "Write output via tool.",
			complete_when: "outputs",
			depends_on: [],
			outputs: [{ path: outputPath, validate: "jsonDoc" }],
			timeout: 1,
			retry: 0,
			retry_delay: 1,
			optional: false,
			model: null,
		};

		const result = await runner(
			step,
			"run-gating-3",
			{},
			{
				pollIntervalMs: 10,
				baseDir: dir,
				attempts: 2,
				getStepState: () => liveStepState,
				validators: {
					jsonDoc: { type: "json", pass_when: "true" },
				},
				workflowDir: dir,
			},
		);

		assert.equal(result.status, "ok");
		assert.equal(result.output_check?.decision, "pass");
	});
});

test("does not early-complete on direct write without provenance while session is still running", async () => {
	await withTempDir("step-runner-gating-direct-write", async (dir) => {
		const outputPath = join(dir, "alerts-ready-summary.json");
		const liveStepState = {
			status: "running",
			attempts: 1,
			output_writes: null,
		};

		let polls = 0;
		const adapter = {
			async spawn() {
				return { sessionId: "sess-4", sessionKey: "session-key-4" };
			},
			async getStatus() {
				polls += 1;
				if (polls === 1) {
					await writeFile(
						outputPath,
						JSON.stringify({ ok: true }, null, 2),
						"utf8",
					);
				}
				return { status: "running" };
			},
		};

		const runner = createStepRunner(adapter);
		const step = {
			id: "collect_alerts",
			name: "Collect Alerts",
			task: "Write output manually.",
			complete_when: "outputs",
			depends_on: [],
			outputs: [{ path: outputPath, validate: "jsonDoc" }],
			timeout: 0.05,
			retry: 0,
			retry_delay: 1,
			optional: false,
			model: null,
		};

		const result = await runner(
			step,
			"run-gating-4",
			{},
			{
				pollIntervalMs: 10,
				cancelGraceMs: 1,
				baseDir: dir,
				attempts: 1,
				getStepState: () => liveStepState,
				validators: {
					jsonDoc: { type: "json", pass_when: "true" },
				},
				workflowDir: dir,
			},
		);

		assert.equal(result.status, "failed");
		assert.match(result.error || "", /timed out/);
	});
});
