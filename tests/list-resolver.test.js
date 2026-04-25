import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveList } from '../dist/list-resolver.js';
import { withTempDir } from './temp-dir.js';

test('resolves list from static context', async () => {
  const ctx = { songs: ['song1', 'song2'] };
  const result = await resolveList('{songs}', ctx, '/tmp', 'auto');
  assert.deepEqual(result, ['song1', 'song2']);
});

test('resolves list from comma-separated string in context', async () => {
  const ctx = { songs: 'song1, song2, song3' };
  const result = await resolveList('{songs}', ctx, '/tmp', 'auto');
  assert.deepEqual(result, ['song1', 'song2', 'song3']);
});

test('resolves list from JSON file', async () => {
  await withTempDir('resolver-test', async (dir) => {
    await writeFile(join(dir, 'songs.json'), JSON.stringify(['song1', 'song2']));
    const result = await resolveList('{songs}', {}, dir, 'auto');
    assert.deepEqual(result, ['song1', 'song2']);
  });
});

test('resolves list from JSON file with explicit json parser', async () => {
  await withTempDir('resolver-test', async (dir) => {
    await writeFile(join(dir, 'songs.txt'), JSON.stringify(['song1', 'song2']));
    const result = await resolveList('{songs}', {}, dir, 'json');
    assert.deepEqual(result, ['song1', 'song2']);
  });
});

test('resolves list from newline-separated file', async () => {
  await withTempDir('resolver-test', async (dir) => {
    await writeFile(join(dir, 'songs.txt'), 'song1\\nsong2\\nsong3');
    const result = await resolveList('{songs}', {}, dir, 'newline');
    assert.deepEqual(result, ['song1', 'song2', 'song3']);
  });
});

test('resolves list from newline-separated file with auto parser', async () => {
  await withTempDir('resolver-test', async (dir) => {
    await writeFile(join(dir, 'songs.txt'), 'song1\\nsong2\\nsong3');
    const result = await resolveList('{songs}', {}, dir, 'auto');
    assert.deepEqual(result, ['song1', 'song2', 'song3']);
  });
});

test('resolves list from CSV file', async () => {
  await withTempDir('resolver-test', async (dir) => {
    await writeFile(join(dir, 'songs.csv'), 'song1, song2, song3');
    const result = await resolveList('{songs}', {}, dir, 'csv');
    assert.deepEqual(result, ['song1', 'song2', 'song3']);
  });
});

test('returns empty list for non-existent file', async () => {
  const result = await resolveList('{missing}', {}, '/tmp', 'auto');
  assert.deepEqual(result, []);
});

test('returns empty list for invalid token', async () => {
  const result = await resolveList('not-a-token', {}, '/tmp', 'auto');
  assert.deepEqual(result, []);
});
