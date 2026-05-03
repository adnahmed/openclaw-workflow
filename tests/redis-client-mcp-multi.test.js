import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpRedisClient } from '../dist/redis-client.js';

test('MCP redis multi maps set/hset/get commands to MCP tool payloads', async () => {
  const calls = [];
  const api = {
    tools: {
      call: async (name, args) => {
        calls.push({ name, args });
        return { ok: true };
      },
    },
  };

  const client = createMcpRedisClient('MCP_DOCKER', api);

  await client.multi([
    ['set', 'alpha', '1'],
    ['set', 'beta', '2', 'PX', 1500, 'NX'],
    ['hset', 'hash_a', { a: '1', b: '2' }],
    ['hset', 'hash_b', 'x', '10', 'y', '20'],
    ['get', 'alpha'],
    ['exists', 'alpha', 'beta'],
    ['del', 'alpha'],
    ['expire', 'beta', 30],
    ['incr', 'counter'],
  ]);

  assert.deepEqual(calls[0], {
    name: 'MCP_DOCKER__set',
    args: { key: 'alpha', value: '1' },
  });

  assert.deepEqual(calls[1], {
    name: 'MCP_DOCKER__set',
    args: { key: 'beta', value: '2', px: 1500, nx: true },
  });

  assert.deepEqual(calls[2], {
    name: 'MCP_DOCKER__hset',
    args: { key: 'hash_a', fields: { a: '1', b: '2' } },
  });

  assert.deepEqual(calls[3], {
    name: 'MCP_DOCKER__hset',
    args: { key: 'hash_b', fields: { x: '10', y: '20' } },
  });

  assert.deepEqual(calls[4], {
    name: 'MCP_DOCKER__get',
    args: { key: 'alpha' },
  });

  assert.deepEqual(calls[5], {
    name: 'MCP_DOCKER__exists',
    args: { keys: ['alpha', 'beta'] },
  });

  assert.deepEqual(calls[6], {
    name: 'MCP_DOCKER__del',
    args: { keys: ['alpha'] },
  });

  assert.deepEqual(calls[7], {
    name: 'MCP_DOCKER__expire',
    args: { key: 'beta', seconds: 30 },
  });

  assert.deepEqual(calls[8], {
    name: 'MCP_DOCKER__incr',
    args: { key: 'counter' },
  });
});
