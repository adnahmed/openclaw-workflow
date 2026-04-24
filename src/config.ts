import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export const DEFAULT_WORKFLOWS_DIR = '~/.openclaw/workflows';
export const DEFAULT_RUNS_DIR = '~/.openclaw/workflow-runs';
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_POLL_INTERVAL_MS = 5000;

type RawPluginConfig = {
  workflowsDir?: string;
  runsDir?: string;
  baseDir?: string;
  concurrency?: number;
  notifyChannel?: string;
  sessionModel?: string;
  pollIntervalMs?: number;
};

type RuntimeConfig = {
  cwd?: string;
};

export function expandHome(input) {
  if (!input || typeof input !== 'string') return input;
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return input;
}

export function resolveConfigPath(value, fallback, cwd = process.cwd()) {
  const raw = value || fallback;
  const expanded = expandHome(raw);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(cwd, expanded);
}

export function normalizePluginConfig(rawConfig: RawPluginConfig = {}, runtime: RuntimeConfig = {}) {
  const cwd = typeof runtime.cwd === 'string' ? runtime.cwd : process.cwd();
  const concurrency = Number.isInteger(rawConfig.concurrency)
    ? Math.min(Math.max(rawConfig.concurrency, 1), 10)
    : DEFAULT_CONCURRENCY;
  const pollIntervalMs = Number.isInteger(rawConfig.pollIntervalMs)
    ? Math.max(rawConfig.pollIntervalMs, 250)
    : DEFAULT_POLL_INTERVAL_MS;

  return {
    workflowsDir: resolveConfigPath(rawConfig.workflowsDir, DEFAULT_WORKFLOWS_DIR, cwd),
    runsDir: resolveConfigPath(rawConfig.runsDir, DEFAULT_RUNS_DIR, cwd),
    baseDir: resolveConfigPath(rawConfig.baseDir, cwd, cwd),
    concurrency,
    notifyChannel: rawConfig.notifyChannel || null,
    defaultModel: rawConfig.sessionModel || null,
    pollIntervalMs,
  };
}
