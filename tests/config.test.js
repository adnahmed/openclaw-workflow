import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { expandHome, normalizePluginConfig } from "../dist/config.js";

test("expandHome handles bare home and home-prefixed paths", () => {
	assert.equal(expandHome("~"), homedir());
	assert.equal(expandHome("~/workflows"), resolve(homedir(), "workflows"));
	const tmpPath = resolve("/tmp/workflows");
	assert.equal(expandHome(tmpPath), tmpPath);
});

test("normalizePluginConfig preserves documented defaults", () => {
	const cwd = resolve("/workspace/project");
	const config = normalizePluginConfig({}, { cwd });

	assert.equal(config.workflowsDir, resolve(homedir(), ".openclaw/workflows"));
	assert.equal(config.runsDir, resolve(homedir(), ".openclaw/workflow-runs"));
	assert.equal(config.baseDir, cwd);
	assert.equal(config.concurrency, 3);
	assert.equal(config.pollIntervalMs, 5000);
	assert.equal(config.notifyChannel, null);
	assert.equal(config.defaultModel, null);
	assert.equal(config.sessionAdapter, "auto");
	assert.equal(config.stateBackend, "filesystem");
	assert.equal(config.redisUrl, null);
	assert.equal(config.redisPrefix, "openclaw:workflow");
	assert.equal(config.redisPrefer, "auto");
	assert.equal(config.redisMcpToolPrefix, null);
	assert.equal(config.redisMcpServer, null);
	assert.equal(config.redisMcpConfigPath, null);
	assert.equal(config.redisMcpRootDir, null);
	assert.equal(config.redisMcpCallTimeoutMs, 30000);
	assert.equal(config.redisMcpServerDefinition, null);
	assert.equal(config.filesystemFallback, true);
	assert.equal(config.materializeOutputs, "on_demand");
});

test("normalizePluginConfig clamps concurrency and poll interval", () => {
	const cwd = resolve("/workspace/project");
	const config = normalizePluginConfig(
		{
			workflowsDir: "./wf",
			runsDir: "./runs",
			baseDir: "./base",
			concurrency: 42,
			pollIntervalMs: 1,
			notifyChannel: "telegram",
			sessionModel: "model-x",
		},
		{ cwd },
	);

	assert.equal(config.workflowsDir, resolve(cwd, "wf"));
	assert.equal(config.runsDir, resolve(cwd, "runs"));
	assert.equal(config.baseDir, resolve(cwd, "base"));
	assert.equal(config.concurrency, 42);
	assert.equal(config.pollIntervalMs, 250);
	assert.equal(config.notifyChannel, "telegram");
	assert.equal(config.defaultModel, "model-x");
	assert.equal(config.stateBackend, "filesystem");
});

test("normalizePluginConfig supports state backend overrides", () => {
	const cwd = resolve("/workspace/project");
	const config = normalizePluginConfig(
		{
			stateBackend: "redis-mcp",
			redisUrl: "redis://localhost:6379",
			redisPrefix: "openclaw:workflow:test",
			redisMcpToolPrefix: "MCP_DOCKER",
			redisMcpConfigPath: "~/.mcporter/mcporter.json",
			redisMcpRootDir: "./mcporter-root",
			redisMcpCallTimeoutMs: 12345,
			redisMcpServerDefinition: { command: "docker", args: ["mcp"] },
			redisPrefer: "mcp",
			filesystemFallback: false,
			materializeOutputs: "always",
		},
		{ cwd },
	);

	assert.equal(config.stateBackend, "redis-mcp");
	assert.equal(config.redisUrl, "redis://localhost:6379");
	assert.equal(config.redisPrefix, "openclaw:workflow:test");
	assert.equal(config.redisPrefer, "mcp");
	assert.equal(config.redisMcpToolPrefix, "MCP_DOCKER");
	assert.equal(config.redisMcpServer, "MCP_DOCKER");
	assert.equal(config.redisMcpConfigPath, "~/.mcporter/mcporter.json");
	assert.equal(config.redisMcpRootDir, "./mcporter-root");
	assert.equal(config.redisMcpCallTimeoutMs, 12345);
	assert.deepEqual(config.redisMcpServerDefinition, {
		command: "docker",
		args: ["mcp"],
	});
	assert.equal(config.filesystemFallback, false);
	assert.equal(config.materializeOutputs, "always");
});

test("normalizePluginConfig does not implicitly enable MCP when unset", () => {
	const config = normalizePluginConfig(
		{ stateBackend: "auto" },
		{ cwd: resolve("/workspace/project") },
	);

	assert.equal(config.redisMcpToolPrefix, null);
	assert.equal(config.redisMcpServer, null);
});
