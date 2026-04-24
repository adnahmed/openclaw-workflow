import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { normalizePluginConfig, expandHome } from '../dist/config.js';

test('expandHome handles bare home and home-prefixed paths', () => {
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('~/workflows'), resolve(homedir(), 'workflows'));
  assert.equal(expandHome('/tmp/workflows'), '/tmp/workflows');
});

test('normalizePluginConfig preserves documented defaults', () => {
  const config = normalizePluginConfig({}, { cwd: '/workspace/project' });

  assert.equal(config.workflowsDir, resolve(homedir(), '.openclaw/workflows'));
  assert.equal(config.runsDir, resolve(homedir(), '.openclaw/workflow-runs'));
  assert.equal(config.baseDir, '/workspace/project');
  assert.equal(config.concurrency, 3);
  assert.equal(config.pollIntervalMs, 5000);
  assert.equal(config.notifyChannel, null);
  assert.equal(config.defaultModel, null);
});

test('normalizePluginConfig clamps concurrency and poll interval', () => {
  const config = normalizePluginConfig({
    workflowsDir: './wf',
    runsDir: './runs',
    baseDir: './base',
    concurrency: 42,
    pollIntervalMs: 1,
    notifyChannel: 'telegram',
    sessionModel: 'model-x',
  }, { cwd: '/workspace/project' });

  assert.equal(config.workflowsDir, '/workspace/project/wf');
  assert.equal(config.runsDir, '/workspace/project/runs');
  assert.equal(config.baseDir, '/workspace/project/base');
  assert.equal(config.concurrency, 10);
  assert.equal(config.pollIntervalMs, 250);
  assert.equal(config.notifyChannel, 'telegram');
  assert.equal(config.defaultModel, 'model-x');
});
