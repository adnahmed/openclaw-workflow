/**
 * Tests for workflow-loader.js
 * Covers: YAML parsing, JSON parsing, validation, cycle detection, defaults normalization
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	listWorkflows,
	loadWorkflow,
	loadWorkflowFromFile,
} from "../dist/workflow-loader.js";
import { withTempDir } from "./temp-dir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

// ── YAML fixture loading ───────────────────────────────────────────────────

test("loads simple-linear.yml correctly", async () => {
	const wf = await loadWorkflow("simple-linear", FIXTURES_DIR);
	assert.equal(wf.name, "Simple Linear Pipeline");
	assert.equal(wf.steps.length, 3);
	assert.equal(wf.steps[0].id, "step-a");
	assert.equal(wf.steps[1].id, "step-b");
	assert.deepEqual(wf.steps[1].depends_on, ["step-a"]);
	assert.equal(wf.steps[2].id, "step-c");
	assert.deepEqual(wf.steps[2].depends_on, ["step-b"]);
});

test("loads parallel-steps.yml and respects concurrency", async () => {
	const wf = await loadWorkflow("parallel-steps", FIXTURES_DIR);
	assert.equal(wf.concurrency, 2);
	assert.equal(wf.steps[2].depends_on.length, 2);
	assert.deepEqual(wf.steps[2].depends_on, ["step-a", "step-b"]);
});

test("loads optional-step.yml and marks step as optional", async () => {
	const wf = await loadWorkflow("optional-step", FIXTURES_DIR);
	const optionalStep = wf.steps.find((s) => s.id === "optional-report");
	assert.ok(optionalStep, "optional-report step should exist");
	assert.equal(optionalStep.optional, true);
});

test("loads retry-workflow.yml with retry config", async () => {
	const wf = await loadWorkflow("retry-workflow", FIXTURES_DIR);
	const flaky = wf.steps.find((s) => s.id === "flaky-step");
	assert.equal(flaky.retry, 2);
	assert.equal(flaky.retry_delay, 1);
});

// ── Default normalization ──────────────────────────────────────────────────

test("normalizes missing optional fields to defaults", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "minimal.yml"),
			`
name: Minimal Workflow
steps:
  - id: only-step
    task: Do something
`,
		);
		const wf = await loadWorkflow("minimal", dir);
		assert.equal(wf.version, "1.0");
		assert.equal(wf.description, "");
		assert.equal(wf.concurrency, 3);
		const step = wf.steps[0];
		assert.deepEqual(step.depends_on, []);
		assert.deepEqual(step.outputs, []);
		assert.equal(step.model, null);
		assert.equal(step.timeout, 300);
		assert.equal(step.retry, 0);
		assert.equal(step.retry_delay, 30);
		assert.equal(step.optional, false);
		assert.equal(step.name, "only-step"); // falls back to id
	});
});

test("step name defaults to id when not provided", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "wf.yml"),
			`
name: Test
steps:
  - id: my-step
    task: Do it
`,
		);
		const wf = await loadWorkflow("wf", dir);
		assert.equal(wf.steps[0].name, "my-step");
	});
});

test("concurrency minimum is 1", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "wf.yml"),
			`
name: Test
concurrency: 0
steps:
  - id: step-1
    task: Do it
`,
		);
		const wf = await loadWorkflow("wf", dir);
		assert.equal(wf.concurrency, 1);
	});
});

// ── JSON format ───────────────────────────────────────────────────────────

test("loads workflow from JSON format", async () => {
	await withTempDir("wf-test", async (dir) => {
		const workflow = {
			name: "JSON Workflow",
			version: "1.0",
			steps: [
				{ id: "step-1", task: "Do step 1", name: "Step 1" },
				{
					id: "step-2",
					task: "Do step 2",
					name: "Step 2",
					depends_on: ["step-1"],
				},
			],
		};
		await writeFile(
			join(dir, "json-wf.json"),
			JSON.stringify(workflow, null, 2),
		);
		const wf = await loadWorkflow("json-wf", dir);
		assert.equal(wf.name, "JSON Workflow");
		assert.equal(wf.steps.length, 2);
	});
});

// ── Validation errors ─────────────────────────────────────────────────────

test("throws if workflow name is missing", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "bad.yml"),
			`
steps:
  - id: step-1
    task: Do it
`,
		);
		await assert.rejects(
			() => loadWorkflow("bad", dir),
			/missing required field "name"/,
		);
	});
});

test("throws if steps array is empty", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "empty.yml"),
			`
name: Empty Workflow
steps: []
`,
		);
		await assert.rejects(
			() => loadWorkflow("empty", dir),
			/non-empty "steps" array/,
		);
	});
});

test("throws if step is missing id", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "bad.yml"),
			`
name: Bad Workflow
steps:
  - task: No ID here
`,
		);
		await assert.rejects(
			() => loadWorkflow("bad", dir),
			/invalid or missing "id"/,
		);
	});
});

test("throws on duplicate step IDs", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "dup.yml"),
			`
name: Dup IDs
steps:
  - id: step-1
    task: First
  - id: step-1
    task: Duplicate
`,
		);
		await assert.rejects(() => loadWorkflow("dup", dir), /Duplicate step ID/);
	});
});

test("throws on unknown dependency reference", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "bad-dep.yml"),
			`
name: Bad Dep
steps:
  - id: step-a
    task: Do A
  - id: step-b
    task: Do B
    depends_on: [nonexistent-step]
`,
		);
		await assert.rejects(
			() => loadWorkflow("bad-dep", dir),
			/unknown step ID "nonexistent-step"/,
		);
	});
});

test("throws on circular dependency A → B → A", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "cycle.yml"),
			`
name: Circular
steps:
  - id: step-a
    task: Do A
    depends_on: [step-b]
  - id: step-b
    task: Do B
    depends_on: [step-a]
`,
		);
		await assert.rejects(
			() => loadWorkflow("cycle", dir),
			/Circular dependency/,
		);
	});
});

test("throws on three-step cycle A → B → C → A", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "cycle3.yml"),
			`
name: Three Cycle
steps:
  - id: a
    task: A
    depends_on: [c]
  - id: b
    task: B
    depends_on: [a]
  - id: c
    task: C
    depends_on: [b]
`,
		);
		await assert.rejects(
			() => loadWorkflow("cycle3", dir),
			/Circular dependency/,
		);
	});
});

test("throws if step is missing task", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "notask.yml"),
			`
name: No Task
steps:
  - id: step-1
    name: Step without task
`,
		);
		await assert.rejects(
			() => loadWorkflow("notask", dir),
			/missing required field "task"/,
		);
	});
});

test("throws if workflow file not found", async () => {
	await assert.rejects(
		() => loadWorkflow("does-not-exist", FIXTURES_DIR),
		/not found/,
	);
});

// ── YAML extension variants ────────────────────────────────────────────────

test("loads .yaml extension", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "wf.yaml"),
			`
name: YAML Extension
steps:
  - id: step-1
    task: Do it
`,
		);
		const wf = await loadWorkflow("wf", dir);
		assert.equal(wf.name, "YAML Extension");
	});
});

// ── Loop validation ──────────────────────────────────────────────────────────

test("loads workflow with for_each loops correctly", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "loop.yml"),
			`
name: Loop Workflow
steps:
  - id: process-items
    for_each: "{items}"
    steps:
      - id: sub-step-1
        task: "Do part 1"
      - id: sub-step-2
        depends_on: [sub-step-1]
        task: "Do part 2"
`,
		);
		const wf = await loadWorkflow("loop", dir);
		assert.equal(wf.steps[0].id, "process-items");
		assert.equal(wf.steps[0].for_each, "{items}");
		assert.equal(wf.steps[0].steps.length, 2);
		assert.equal(wf.steps[0].steps[0].id, "sub-step-1");
	});
});

test("throws if loop step is missing steps array", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "bad-loop.yml"),
			`
name: Bad Loop
steps:
  - id: my-loop
    for_each: "{items}"
`,
		);
		await assert.rejects(
			() => loadWorkflow("bad-loop", dir),
			/must have either a "task" or a non-empty "steps" array/,
		);
	});
});

test("throws if inner loop step is missing task", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "bad-inner.yml"),
			`
name: Bad Inner
steps:
  - id: my-loop
    for_each: "{items}"
    steps:
      - id: inner-1
`,
		);
		await assert.rejects(
			() => loadWorkflow("bad-inner", dir),
			/missing required field "task"/,
		);
	});
});

test("throws on duplicate IDs within a loop", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "dup-inner.yml"),
			`
name: Dup Inner
steps:
  - id: my-loop
    for_each: "{items}"
    steps:
      - id: step-1
        task: First
      - id: step-1
        task: Duplicate
`,
		);
		await assert.rejects(
			() => loadWorkflow("dup-inner", dir),
			/Duplicate step ID "step-1" in loop "my-loop"/,
		);
	});
});

test('normalizes parser to "auto" when not provided', async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "parser.yml"),
			`
name: Parser Test
steps:
  - id: loop-step
    for_each: "{items}"
    steps:
      - id: inner
        task: Do it
`,
		);
		const wf = await loadWorkflow("parser", dir);
		assert.equal(wf.steps[0].parser, "auto");
	});
});
test("listWorkflows returns sorted list of available workflows", async () => {
	const list = await listWorkflows(FIXTURES_DIR);
	assert.ok(
		list.length >= 5,
		`Expected at least 5 fixtures, got ${list.length}`,
	);
	// Verify sorted
	for (let i = 1; i < list.length; i++) {
		assert.ok(
			list[i - 1].name <= list[i].name,
			"Should be sorted alphabetically",
		);
	}
});

test("listWorkflows returns empty array for empty dir", async () => {
	await withTempDir("wf-test", async (dir) => {
		const list = await listWorkflows(dir);
		assert.deepEqual(list, []);
	});
});

test("throws if orchestration-critical output is marked as optional", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "critical-opt.yml"),
			`
name: Critical Optional Test
steps:
  - id: producer
    task: Produce a file
    outputs:
      - path: data/critical.txt
        optional: true
  - id: consumer
    for_each: data/critical.txt
    steps:
      - id: inner
        task: Consume it
`,
		);
		await assert.rejects(
			() => loadWorkflow("critical-opt", dir),
			/cannot be optional because it is used for flow control/,
		);
	});
});

test("accepts complete_when: handoff_or_outputs", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "handoff.yml"),
			`
name: Handoff Mode
steps:
  - id: handoff-step
    task: Complete via handoff
    complete_when: handoff_or_outputs
`,
		);

		const wf = await loadWorkflow("handoff", dir);
		assert.equal(wf.steps[0].complete_when, "handoff_or_outputs");
		assert.equal(wf.steps[0].signaling, "auto");
	});
});

test("defaults signaling to off for non-handoff completion modes", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "signaling-default.yml"),
			`
name: Signaling Default
steps:
  - id: s1
    task: Do work
    complete_when: session
`,
		);

		const wf = await loadWorkflow("signaling-default", dir);
		assert.equal(wf.steps[0].signaling, "off");
	});
});

test("allows explicit signaling override", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "signaling-override.yml"),
			`
name: Signaling Override
steps:
  - id: s1
    task: Do work
    complete_when: handoff_or_outputs
    signaling: off
`,
		);

		const wf = await loadWorkflow("signaling-override", dir);
		assert.equal(wf.steps[0].signaling, "off");
	});
});

test("throws on invalid signaling mode", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "bad-signaling.yml"),
			`
name: Bad Signaling
steps:
  - id: s1
    task: Do work
    signaling: manual
`,
		);

		await assert.rejects(
			() => loadWorkflow("bad-signaling", dir),
			/invalid signaling/,
		);
	});
});

test("normalizes reuse_outputs block", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "reuse.yml"),
			`
name: Reuse
steps:
  - id: reuse-step
    task: Reuse if possible
    reuse_outputs:
      enabled: true
      when: config.force_refresh == false
      require: declared_outputs
      accept_decisions: [pass, blocked]
      on_invalid: run_step
`,
		);

		const wf = await loadWorkflow("reuse", dir);
		assert.equal(wf.steps[0].reuse_outputs.enabled, true);
		assert.deepEqual(wf.steps[0].reuse_outputs.accept_decisions, [
			"pass",
			"blocked",
		]);
		assert.equal(wf.steps[0].reuse_outputs.require, "declared_outputs");
		assert.equal(wf.steps[0].reuse_outputs.require_signature, true);
		assert.equal(wf.steps[0].reuse_outputs.legacy_unsigned_cache, "stale");
		assert.ok(Array.isArray(wf.steps[0].reuse_outputs.freshness.include));
	});
});

test("throws on invalid reuse_outputs.accept_decisions", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "bad-reuse.yml"),
			`
name: Bad Reuse
steps:
  - id: bad
    task: bad
    reuse_outputs:
      enabled: true
      accept_decisions: [banana]
`,
		);

		await assert.rejects(
			() => loadWorkflow("bad-reuse", dir),
			/reuse_outputs.accept_decisions contains invalid decision/,
		);
	});
});

test("accepts logical id-only outputs", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "id-outputs.yml"),
			`
name: ID Outputs
steps:
  - id: collect
    task: collect
    outputs:
      - id: alerts_raw
        validate: linkedin_alerts_raw
`,
		);

		const wf = await loadWorkflow("id-outputs", dir);
		assert.equal(wf.steps[0].outputs.length, 1);
		assert.equal(wf.steps[0].outputs[0].id, "alerts_raw");
		assert.equal(wf.steps[0].outputs[0].path, undefined);
	});
});

test("parses semantic state contracts and step state_contract", async () => {
	await withTempDir("wf-test", async (dir) => {
		await writeFile(
			join(dir, "state-contract.yml"),
			`
name: State Contract
state:
  backend: auto
  contracts:
    linkedin_alert_collection:
      kind: collection
      entity: alert
      item_key: alert_key
      source_output: alerts_manifest
steps:
  - id: collect
    task: collect alerts
    state_contract: linkedin_alert_collection
    outputs:
      - id: alerts_manifest
`,
		);

		const wf = await loadWorkflow("state-contract", dir);
		assert.equal(wf.steps[0].state_contract, "linkedin_alert_collection");
		assert.equal(
			wf.state.contracts.linkedin_alert_collection.kind,
			"collection",
		);
		assert.equal(
			wf.state.contracts.linkedin_alert_collection.source_output,
			"alerts_manifest",
		);
	});
});
