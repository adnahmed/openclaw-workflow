import { normalizePluginConfig } from './src/config.js';
import assert from 'node:assert/strict';

const config = normalizePluginConfig({});
console.log('Config with empty rawConfig:', config);
assert.equal(config.sessionAdapter, 'auto');

const config2 = normalizePluginConfig({ sessionAdapter: 'cli' });
console.log('Config with cli adapter:', config2);
assert.equal(config2.sessionAdapter, 'cli');

console.log('Tests passed!');
