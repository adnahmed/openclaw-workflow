import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createMcpRedisClient,
	resolveRedisClient,
} from "../dist/redis-client.js";

test("MCP redis multi maps commands to MCPorter runtime.callTool payloads", async () => {
	const calls = [];
	const closes = [];

	const client = createMcpRedisClient({
		server: "MCP_DOCKER",
		runtimeFactory: async () => ({
			callTool: async (server, toolName, options) => {
				calls.push({ server, toolName, options });
				return { ok: true };
			},
			close: async (server) => {
				closes.push(server);
			},
		}),
	});

	await client.multi([
		["set", "alpha", "1"],
		["set", "beta", "2", "PX", 1500, "NX"],
		["hset", "hash_a", { a: "1", b: "2" }],
		["hset", "hash_b", "x", "10", "y", "20"],
		["get", "alpha"],
		["exists", "alpha", "beta"],
		["del", "alpha"],
		["expire", "beta", 30],
		["incr", "counter"],
	]);

	assert.deepEqual(calls[0], {
		server: "MCP_DOCKER",
		toolName: "set",
		options: { args: { key: "alpha", value: "1" }, timeoutMs: undefined },
	});

	assert.deepEqual(calls[1], {
		server: "MCP_DOCKER",
		toolName: "set",
		options: {
			args: { key: "beta", value: "2", px: 1500, nx: true },
			timeoutMs: undefined,
		},
	});

	assert.deepEqual(calls[2], {
		server: "MCP_DOCKER",
		toolName: "hset",
		options: {
			args: { key: "hash_a", fields: { a: "1", b: "2" } },
			timeoutMs: undefined,
		},
	});

	assert.deepEqual(calls[3], {
		server: "MCP_DOCKER",
		toolName: "hset",
		options: {
			args: { key: "hash_b", fields: { x: "10", y: "20" } },
			timeoutMs: undefined,
		},
	});

	assert.deepEqual(calls[4], {
		server: "MCP_DOCKER",
		toolName: "get",
		options: { args: { key: "alpha" }, timeoutMs: undefined },
	});

	assert.deepEqual(calls[5], {
		server: "MCP_DOCKER",
		toolName: "exists",
		options: { args: { keys: ["alpha", "beta"] }, timeoutMs: undefined },
	});

	assert.deepEqual(calls[6], {
		server: "MCP_DOCKER",
		toolName: "del",
		options: { args: { keys: ["alpha"] }, timeoutMs: undefined },
	});

	assert.deepEqual(calls[7], {
		server: "MCP_DOCKER",
		toolName: "expire",
		options: { args: { key: "beta", seconds: 30 }, timeoutMs: undefined },
	});

	assert.deepEqual(calls[8], {
		server: "MCP_DOCKER",
		toolName: "incr",
		options: { args: { key: "counter" }, timeoutMs: undefined },
	});

	await client.disconnect();
	assert.deepEqual(closes, ["MCP_DOCKER"]);
});
