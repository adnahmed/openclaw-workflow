import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { normalizePluginConfig, expandHome } from '../dist/config.js';

test('expandHome handles bare home and home-prefixed paths', () => {
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('~/workflows'), resolve(homedir(), 'workflows'));
  const tmpPath = resolve('/tmp/workflows');
  assert.equal(expandHome(tmpPath), tmpPath);
});

test('normalizePluginConfig preserves documented defaults', () => {
  const cwd = resolve('/workspace/project');
  const config = normalizePluginConfig({}, { cwd });

  assert.equal(config.workflowsDir, resolve(homedir(), '.openclaw/workflows'));
  assert.equal(config.runsDir, resolve(homedir(), '.openclaw/workflow-runs'));
  assert.equal(config.baseDir, cwd);
  assert.equal(config.concurrency, 3);
  assert.equal(config.pollIntervalMs, 5000);
  assert.equal(config.notifyChannel, null);
  assert.equal(config.defaultModel, null);
  assert.equal(config.sessionAdapter, 'auto');
});

test('normalizePluginConfig clamps concurrency and poll interval', () => {
  const cwd = resolve('/workspace/project');
  const config = normalizePluginConfig({
    workflowsDir: './wf',
    runsDir: './runs',
    baseDir: './base',
    concurrency: 42,
    pollIntervalMs: 1,
    notifyChannel: 'telegram',
    sessionModel: 'model-x',
  }, { cwd });

  assert.equal(config.workflowsDir, resolve(cwd, 'wf'));
  assert.equal(config.runsDir, resolve(cwd, 'runs'));
  assert.equal(config.baseDir, resolve(cwd, 'base'));
  assert.equal(config.concurrency, 42);
  assert.equal(config.pollIntervalMs, 250);
  assert.equal(config.notifyChannel, 'telegram');
  assert.equal(config.defaultModel, 'model-x');
});
