import assert from "node:assert/strict";
import { test } from "node:test";

import {
	activeSealedRuns,
	resolveActiveSealedRunForToolResult,
} from "../dist/step-runner.js";

test("resolveActiveSealedRunForToolResult resolves ctx.runId as runtime session aliases", () => {
	const activeRun = {
		artifactStore: { name: "fake-store" },
		runId: "workflow-run-123",
		stepId: "sealed-step",
		maxPreviewBytes: 2048,
	};

	activeSealedRuns.set("runtimeRunId:pi-run-456", activeRun);

	try {
		const resolved = resolveActiveSealedRunForToolResult(
			{ toolCallId: "tool-call-1" },
			{ runId: "pi-run-456" },
		);

		assert.strictEqual(resolved, activeRun);
	} finally {
		activeSealedRuns.delete("runtimeRunId:pi-run-456");
	}
});

test("resolveActiveSealedRunForToolResult resolves ctx.runId via sessionId alias", () => {
	const activeRun = {
		artifactStore: { name: "fake-store" },
		runId: "workflow-run-789",
		stepId: "sealed-step",
		maxPreviewBytes: 2048,
	};

	activeSealedRuns.set("sessionId:pi-run-789", activeRun);

	try {
		const resolved = resolveActiveSealedRunForToolResult(
			{ toolCallId: "tool-call-2" },
			{ runId: "pi-run-789" },
		);

		assert.strictEqual(resolved, activeRun);
	} finally {
		activeSealedRuns.delete("sessionId:pi-run-789");
	}
});
