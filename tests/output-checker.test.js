/**
 * Tests for output-checker.js
 * Covers: empty paths, existing files, missing files, absolute paths, relative paths
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';

import { checkOutputs } from '../dist/output-checker.js';
import { checkStepContract } from '../dist/output-checker.js';
import { FilesystemArtifactStore } from '../dist/state-artifact-stores.js';
import { withTempDir } from './temp-dir.js';

// ── Empty / null paths ─────────────────────────────────────────────────────

test('passes trivially with empty path list', async () => {
  const result = await checkOutputs([], '/some/dir');
  assert.equal(result.passed, true);
  assert.deepEqual(result.missing_files, []);
  assert.deepEqual(result.checked_files, []);
});

test('passes trivially with null paths', async () => {
  const result = await checkOutputs(null, '/some/dir');
  assert.equal(result.passed, true);
});

test('passes trivially with undefined paths', async () => {
  const result = await checkOutputs(undefined, '/some/dir');
  assert.equal(result.passed, true);
});

// ── Existing files ─────────────────────────────────────────────────────────

test('passes when all files exist (relative paths)', async () => {
  await withTempDir('output-check', async (dir) => {
    await writeFile(join(dir, 'output.json'), '{}');
    await writeFile(join(dir, 'report.md'), '# Report');

    const result = await checkOutputs(['output.json', 'report.md'], dir);
    assert.equal(result.passed, true);
    assert.deepEqual(result.missing_files, []);
    assert.equal(result.checked_files.length, 2);
  });
});

test('passes when all files exist (absolute paths)', async () => {
  await withTempDir('output-check', async (dir) => {
    const absPath = join(dir, 'absolute.json');
    await writeFile(absPath, '{}');

    // Absolute paths should not be joined with baseDir
    const result = await checkOutputs([absPath], '/completely/different/dir');
    assert.equal(result.passed, true);
    assert.deepEqual(result.missing_files, []);
  });
});

test('resolves relative paths against baseDir', async () => {
  await withTempDir('output-check', async (dir) => {
    await mkdir(join(dir, 'data', 'seo'), { recursive: true });
    const filePath = join(dir, 'data', 'seo', 'handoff.json');
    await writeFile(filePath, '{}');

    const result = await checkOutputs(['data/seo/handoff.json'], dir);
    assert.equal(result.passed, true);
    // The checked_files list should contain the resolved absolute path
    assert.ok(result.checked_files[0].includes('handoff.json'));
  });
});

// ── Missing files ──────────────────────────────────────────────────────────

test('fails when a file is missing', async () => {
  await withTempDir('output-check', async (dir) => {
    const result = await checkOutputs(['missing-output.json'], dir);
    assert.equal(result.passed, false);
    assert.equal(result.missing_files.length, 1);
    assert.ok(result.missing_files[0].includes('missing-output.json'));
  });
});

test('fails when some files are missing (partial)', async () => {
  await withTempDir('output-check', async (dir) => {
    await writeFile(join(dir, 'exists.json'), '{}');
    // 'missing.json' is not created

    const result = await checkOutputs(['exists.json', 'missing.json'], dir);
    assert.equal(result.passed, false);
    assert.equal(result.missing_files.length, 1);
    assert.ok(result.missing_files[0].includes('missing.json'));
    // checked_files includes both
    assert.equal(result.checked_files.length, 2);
  });
});

test('all missing files are reported (not just first)', async () => {
  await withTempDir('output-check', async (dir) => {
    const result = await checkOutputs(['a.json', 'b.json', 'c.json'], dir);
    assert.equal(result.passed, false);
    assert.equal(result.missing_files.length, 3);
  });
});

// ── Mixed absolute + relative ──────────────────────────────────────────────

test('handles mix of absolute and relative paths', async () => {
  await withTempDir('output-check', async (dir) => {
    const absFile = join(dir, 'absolute.json');
    await writeFile(absFile, '{}');
    await writeFile(join(dir, 'relative.json'), '{}');

    const result = await checkOutputs([absFile, 'relative.json'], dir);
    assert.equal(result.passed, true);
  });
});

// ── Optional files ───────────────────────────────────────────────────────────

test('passes when optional file is missing', async () => {
  await withTempDir('output-check', async (dir) => {
    const result = await checkOutputs([{ path: 'optional-output.json', optional: true }], dir);
    assert.equal(result.passed, true);
    assert.equal(result.missing_files.length, 1);
  });
});

test('fails when required file is missing but optional one is also missing', async () => {
  await withTempDir('output-check', async (dir) => {
    const result = await checkOutputs([
      { path: 'required-output.json' },
      { path: 'optional-output.json', optional: true }
    ], dir);
    assert.equal(result.passed, false);
    assert.equal(result.missing_files.length, 2);
  });
});

test('checkStepContract validates path-only output from artifact store by outputId fallback', async () => {
  await withTempDir('output-check-artifact-first', async (dir) => {
    const artifactStore = new FilesystemArtifactStore(dir, dir, 'on_demand');

    const outputs = [
      { path: 'data/foo.json', validate: 'jsonDoc' }
    ];

    await artifactStore.commitArtifact({
      runId: 'run-artifact-first',
      stepId: 'step-a',
      outputId: 'data/foo.json',
      declaredOutput: outputs[0],
      data: { ok: true },
      validatorId: 'jsonDoc',
      validator: { type: 'json', pass_when: 'true' },
      validators: { jsonDoc: { type: 'json', pass_when: 'true' } },
      baseDir: dir,
      materialize: 'never',
    });

    const result = await checkStepContract({
      outputs,
      validators: { jsonDoc: { type: 'json', pass_when: 'true' } },
      artifactStore,
      runId: 'run-artifact-first',
      stepId: 'step-a',
      baseDir: dir,
      filesystemFallback: true,
    });

    assert.equal(result.passed, true);
    assert.equal(result.decision, 'pass');
  });
});

