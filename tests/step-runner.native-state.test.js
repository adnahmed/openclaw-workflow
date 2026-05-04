import assert from "node:assert/strict";
import { test } from "node:test";

import { runStep } from "../dist/step-runner.js";

function makeApi(calls) {
	return {
		config: {
			mcp: {
				servers: {
					MCP_DOCKER: { command: "mcp-docker" },
				},
			},
		},
		sessions: {
			async spawn(prompt) {
				calls.push(prompt);
				return { sessionId: "sess-1", sessionKey: "session-key-1" };
			},
			async getStatus() {
				return { status: "done" };
			},
		},
	};
}

function baseStep(overrides = {}) {
	return {
		id: "collect",
		name: "Collect",
		task: "Produce declared outputs.",
		depends_on: [],
		outputs: [],
		timeout: 1,
		retry: 0,
		retry_delay: 1,
		optional: false,
		model: null,
		...overrides,
	};
}

test("native state filters backend MCP from isolated prompt and injects isolated boundary", async () => {
	const calls = [];
	const api = makeApi(calls);

	const workflow = {
		required_mcp_servers: ["MCP_DOCKER"],
		state: {
			backend: "auto",
			redis: {
				provider: "auto",
				tool_prefix: "MCP_DOCKER",
			},
		},
	};

	const result = await runStep(baseStep(), "run-native-1", api, {
		pollIntervalMs: 1,
		baseDir: process.cwd(),
		workflow,
		validators: {},
		workflowDir: process.cwd(),
	});

	assert.equal(result.status, "ok");
	const prompt = calls[0] || "";
	assert.equal(prompt.includes("MCP_DOCKER"), false);
	assert.equal(/redis/i.test(prompt), false);
	assert.match(prompt, /IMPORTANT — Isolated step boundary/);
});

test("native state with browser skill keeps skill visible without backend MCP exposure", async () => {
	const calls = [];
	const api = makeApi(calls);

	const workflow = {
		required_mcp_servers: ["MCP_DOCKER"],
		state: {
			backend: "auto",
			redis: {
				provider: "auto",
				tool_prefix: "MCP_DOCKER",
			},
		},
	};

	const result = await runStep(
		baseStep({ required_skills: ["browser-harness"] }),
		"run-native-2",
		api,
		{
			pollIntervalMs: 1,
			baseDir: process.cwd(),
			workflow,
			validators: {},
			workflowDir: process.cwd(),
		},
	);

	assert.equal(result.status, "ok");
	const prompt = calls[0] || "";
	assert.match(prompt, /browser-harness/);
	assert.equal(prompt.includes("MCP_DOCKER"), false);
});

test("non-native workflow still injects external-tools contract without backend examples", async () => {
	const calls = [];
	const api = makeApi(calls);

	const workflow = {
		required_mcp_servers: ["MCP_DOCKER"],
	};

	const result = await runStep(baseStep(), "run-legacy-1", api, {
		pollIntervalMs: 1,
		baseDir: process.cwd(),
		workflow,
		validators: {},
		workflowDir: process.cwd(),
	});

	assert.equal(result.status, "ok");
	const prompt = calls[0] || "";
	assert.match(prompt, /External tools required for this step are available/);
	assert.equal(prompt.includes("MCP_DOCKER.hset"), false);
	assert.equal(prompt.includes("MCP_DOCKER.browser_snapshot"), false);
});
