import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveStateBackend } from "../dist/state-artifact-stores.js";

test("resolveStateBackend resolves redis-mcp from plugin config server", () => {
	const resolved = resolveStateBackend({
		workflowState: { backend: "redis" },
		pluginConfig: {
			stateBackend: "redis",
			redisMcpServer: "MCP_DOCKER",
			filesystemFallback: false,
		},
	});

	assert.equal(resolved.resolved, "redis-mcp");
	assert.equal(resolved.provider, "MCP_DOCKER");
});

test("resolveStateBackend respects workflow redis provider mcp and tool prefix override", () => {
	const resolved = resolveStateBackend({
		workflowState: {
			backend: "redis",
			redis: {
				provider: "mcp",
				tool_prefix: "CUSTOM_MCP",
			},
			fallback: "none",
		},
		pluginConfig: {
			stateBackend: "redis",
			filesystemFallback: false,
		},
	});

	assert.equal(resolved.resolved, "redis-mcp");
	assert.equal(resolved.provider, "CUSTOM_MCP");
	assert.equal(resolved.fallback, "none");
});

test("resolveStateBackend keeps redis-native from falling through to MCP", () => {
	assert.throws(
		() =>
			resolveStateBackend({
				workflowState: { backend: "redis-native", fallback: "none" },
				pluginConfig: {
					stateBackend: "redis-native",
					redisUrl: null,
					redisMcpServer: "MCP_DOCKER",
					filesystemFallback: false,
				},
			}),
		/no Redis URL was configured/i,
	);
});

test("resolveStateBackend keeps filesystem when explicitly requested", () => {
	const resolved = resolveStateBackend({
		workflowState: { backend: "filesystem" },
		pluginConfig: {
			stateBackend: "redis",
			redisMcpToolPrefix: "MCP_DOCKER",
			filesystemFallback: false,
		},
	});

	assert.equal(resolved.resolved, "filesystem");
});

test("resolveStateBackend throws when redis requested and no redis backend with fallback disabled", () => {
	assert.throws(
		() =>
			resolveStateBackend({
				workflowState: { backend: "redis", fallback: "none" },
				pluginConfig: {
					stateBackend: "redis",
					redisUrl: null,
					redisMcpServer: null,
					redisMcpToolPrefix: null,
					filesystemFallback: false,
				},
			}),
		/no Redis URL or MCP Redis server was configured/i,
	);
});
