
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliAdapter } from '../step-runner.js';

test('CliAdapter.spawn passes complex prompt safely as one argument', async () => {
  const capturedArgs = [];
  const mockExecutor = async (args) => {
    capturedArgs.push(args);
    // Return a valid JSON response for cron add
    return { stdout: JSON.stringify({ id: 'job-123' }), stderr: '' };
  };

  const adapter = new CliAdapter(mockExecutor);
  const complexPrompt = `This is a "complex" prompt\nwith newlines\nand (parentheses) or <brackets>.`;
  
  await adapter.spawn(complexPrompt, {
    model: 'gpt-4',
    label: 'test-label'
  });

  // The first call should be 'cron add'
  const addCall = capturedArgs[0];
  assert.equal(addCall[0], 'cron');
  assert.equal(addCall[1], 'add');
  
  // Verify prompt is passed as a single argument
  const messageIdx = addCall.indexOf('--message');
  assert.ok(messageIdx !== -1, 'Should have --message flag');
  assert.equal(addCall[messageIdx + 1], complexPrompt, 'Prompt should be passed intact as one argument');

  // Verify optional flags
  const modelIdx = addCall.indexOf('--model');
  assert.ok(modelIdx !== -1, 'Should have --model flag');
  assert.equal(addCall[modelIdx + 1], 'gpt-4');

  const nameIdx = addCall.indexOf('--name');
  assert.ok(nameIdx !== -1, 'Should have --name flag');
  assert.equal(addCall[nameIdx + 1], 'test-label');

  // Verify trigger call 'cron run'
  assert.equal(capturedArgs[1][0], 'cron');
  assert.equal(capturedArgs[1][1], 'run');
  assert.equal(capturedArgs[1][2], 'job-123');
});

test('CliAdapter.spawn handles different JSON output formats', async () => {
  const formats = [
    { stdout: JSON.stringify({ id: 'id1' }) },
    { stdout: JSON.stringify({ job: { id: 'id2' } }) }
  ];

  for (const format of formats) {
    const mockExecutor = async (args) => {
      if (args[1] === 'add') return format;
      return { stdout: '', stderr: '' };
    };
    const adapter = new CliAdapter(mockExecutor);
    const result = await adapter.spawn('hello', {});
    assert.ok(result.sessionId, `Should resolve sessionId for ${format.stdout}`);
  }
});

test('CliAdapter.getStatus handles JSONL polling correctly', async () => {
  const mockExecutor = async (args) => {
    if (args[1] === 'runs') {
      // Simulate JSONL output
      return { 
        stdout: JSON.stringify({ action: 'started', status: 'running' }) + '\n' + 
                JSON.stringify({ action: 'finished', status: 'ok' }), 
        stderr: '' 
      };
    }
    return { stdout: '', stderr: '' };
  };

  const adapter = new CliAdapter(mockExecutor);
  const status = await adapter.getStatus('job-123');
  assert.equal(status.status, 'done');
});

test('CliAdapter.getStatus handles error in JSONL', async () => {
  const mockExecutor = async (args) => {
    if (args[1] === 'runs') {
      return { 
        stdout: JSON.stringify({ action: 'finished', status: 'error', error: 'failed intentionally' }), 
        stderr: '' 
      };
    }
    return { stdout: '', stderr: '' };
  };

  const adapter = new CliAdapter(mockExecutor);
  const status = await adapter.getStatus('job-123');
  assert.equal(status.status, 'error');
  assert.equal(status.error, 'failed intentionally');
});

test('CliAdapter.getStatus returns running for empty output', async () => {
  const mockExecutor = async (args) => {
    return { stdout: '   ', stderr: '' };
  };

  const adapter = new CliAdapter(mockExecutor);
  const status = await adapter.getStatus('job-123');
  assert.equal(status.status, 'running');
});
