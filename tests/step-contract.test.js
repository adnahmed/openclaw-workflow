import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  computeStepContractSignature,
  evaluateCacheFreshness,
  writeStepCacheManifest,
} from '../dist/step-contract.js';
import { withTempDir } from './temp-dir.js';

function buildWorkflow() {
  return {
    name: 'Signature Workflow',
    version: '1.0.0',
    description: '',
    config: { force_refresh: false },
    validators: {},
    steps: [],
    concurrency: 1,
    __dir: process.cwd(),
  };
}

function buildStep(overrides = {}) {
  return {
    id: 'some_step',
    name: 'Some Step',
    task: 'Generate complete output',
    depends_on: [],
    outputs: [{ path: 'out.json' }],
    timeout: 60,
    retry: 0,
    retry_delay: 1,
    optional: false,
    output_contract_version: 1,
    reuse_outputs: {
      enabled: true,
      require_signature: true,
      legacy_unsigned_cache: 'stale',
      freshness: {
        include: [
          'output_contract_version',
          'step_task',
          'validators',
          'schemas',
          'selected_config',
          'input_signature',
        ],
      },
    },
    ...overrides,
  };
}

test('evaluateCacheFreshness rejects unsigned cache by default', async () => {
  await withTempDir('step-contract-test', async (dir) => {
    await writeFile(join(dir, 'out.json'), JSON.stringify({ ok: true }), 'utf8');

    const result = await evaluateCacheFreshness({
      workflow: buildWorkflow(),
      step: buildStep(),
      baseDir: dir,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsigned_cache_stale');
  });
});

test('evaluateCacheFreshness allows legacy unsigned cache when configured', async () => {
  await withTempDir('step-contract-test', async (dir) => {
    await writeFile(join(dir, 'out.json'), JSON.stringify({ ok: true }), 'utf8');

    const result = await evaluateCacheFreshness({
      workflow: buildWorkflow(),
      step: buildStep({
        reuse_outputs: {
          enabled: true,
          require_signature: true,
          legacy_unsigned_cache: 'allow_if_valid',
        },
      }),
      baseDir: dir,
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, 'unsigned_cache_allowed');
  });
});

test('evaluateCacheFreshness marks old contract signatures stale', async () => {
  await withTempDir('step-contract-test', async (dir) => {
    await writeFile(join(dir, 'out.json'), JSON.stringify({ ok: true }), 'utf8');

    const workflow = buildWorkflow();
    const oldStep = buildStep({ task: 'Generate output v1' });
    const signature = await computeStepContractSignature({
      workflow,
      step: oldStep,
      baseDir: dir,
    });

    await writeStepCacheManifest({
      baseDir: dir,
      stepId: oldStep.id,
      outputs: ['out.json'],
      producerRunId: 'old-run',
      reason: 'generated',
      decision: 'pass',
      signature,
    });

    const newerStep = buildStep({ task: 'Generate output v2 with completeness checks' });
    const result = await evaluateCacheFreshness({
      workflow,
      step: newerStep,
      baseDir: dir,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale_contract');
    assert.ok(result.previous_signature);
    assert.ok(result.current_signature);
    assert.notEqual(result.previous_signature, result.current_signature);
  });
});
