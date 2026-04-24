import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function testTempRoot() {
  return join(process.cwd(), '.tmp-tests');
}

export async function withTempDir(prefix, fn) {
  const root = testTempRoot();
  const dir = join(root, `${prefix}-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
