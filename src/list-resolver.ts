import { readFile, appendFile } from 'node:fs/promises';
import { join, isAbsolute as pathIsAbsolute } from 'node:path';
import yaml from 'js-yaml';
import { substituteVars } from './variable-substitution.js';

async function logSkipDebug(msg: string) {
  try {
    await appendFile(join(process.cwd(), 'skip-debug.log'), `${new Date().toISOString()} [list-resolver] ${msg}\n`);
  } catch {}
}


/**
 * Validates each item in a resolved list against an optional schema.
 * 
 * @param {any} step - The workflow step definition containing the schema
 * @param {any[]} list - The resolved list of items to validate
 * @throws {Error} If an item fails validation
 */
export function validateLoopItems(step: any, list: any[]) {
  if (!step.item_schema) return;

  for (const [index, item] of list.entries()) {
    if (step.item_schema.type === "object" && (item === null || typeof item !== "object" || Array.isArray(item))) {
      throw new Error(`${step.id}[${index}] expected object, got ${typeof item}`);
    }

    for (const field of step.item_schema.required || []) {
      if (!(field in item)) {
        throw new Error(`${step.id}[${index}] missing required field: ${field}`);
      }
    }

    for (const [field, rule] of Object.entries(step.item_schema.properties || {})) {
      if (!(field in item)) continue;

      const value = (item as any)[field];
      const r = rule as any;

      if (r.type === "string" && typeof value !== "string") {
        throw new Error(`${step.id}[${index}].${field} expected string`);
      }

      if (r.pattern && !new RegExp(r.pattern).test(value)) {
        throw new Error(`${step.id}[${index}].${field} failed pattern: ${value}`);
      }
    }
  }
}

/**
 * Resolves a specific file path into a list of items.
 * 
 * @param {string} filePath - Absolute or relative path to the file
 * @param {string} baseDir   - Base directory for resolving relative paths
 * @param {string} [parser='auto'] - Parser to use ('json', 'csv', 'newline', 'auto')
 * @returns {Promise<any[]>} The resolved list of items
 */
export async function resolvePathToList(filePath, baseDir, parser = 'auto', strict = false) {
  const fullPath = pathIsAbsolute(filePath) ? filePath : join(baseDir, filePath);
  try {
    await logSkipDebug(`Resolving path: ${fullPath} (parser: ${parser})`);
    const content = await readFile(fullPath, 'utf8');
    await logSkipDebug(`Raw content length: ${content.length} | Content: ${JSON.stringify(content)}`);
    
    let effectiveParser = parser;
    if (parser === 'auto') {
      if (fullPath.endsWith('.json')) effectiveParser = 'json';
      else if (fullPath.endsWith('.jsonl')) effectiveParser = 'jsonl';
      else if (fullPath.endsWith('.yaml') || fullPath.endsWith('.yml')) effectiveParser = 'yaml';
      else if (fullPath.endsWith('.csv')) effectiveParser = 'csv';
      else if (fullPath.endsWith('.txt')) effectiveParser = 'newline';
    }
    await logSkipDebug(`Effective parser: ${effectiveParser}`);

    const result = parseValue(content, effectiveParser);
    await logSkipDebug(`Parse result length: ${result.length} | Result: ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    await logSkipDebug(`Error resolving path ${fullPath}: ${e.message}`);
    if (strict) throw e;
    return [];
  }
}

/**
 * Resolves a variable token (e.g. "{songs}") into a list of items.
 *
 * @param {string} token - The variable token to resolve (e.g. "{songs}")
 * @param {Object} ctx - The current substitution context
 * @param {string} baseDir - The base directory for resolving output files
 * @param {string} [parser='auto'] - Parser to use ('json', 'csv', 'newline', 'auto')
 * @returns {Promise<any[]>} The resolved list of items
 */
export async function resolveList(token, ctx, baseDir, parser = 'auto') {
  const isWholeTokenRef = /^\{[\w.]+\}$/.test(token);

  // Path template case:
  // e.g. data/linkedin/job-alerts/alerts-execution-manifest-{date}.json
  // This must be strict. If {date} is missing, fail loudly.
  if (!isWholeTokenRef) {
    const substitutedPath = substituteVars(token, ctx, { unknown: "throw" });

    if (typeof substitutedPath !== 'string') {
      throw new Error(`for_each path did not resolve to a string: ${token}`);
    }

    return resolvePathToList(substitutedPath, baseDir, parser, true);

  }

  // Whole-token case:
  // e.g. {songs}
  // Keep old behavior: first check ctx, then file fallback.
  const match = token.match(/^\{([\w.]+)\}$/);
  if (!match) return [];

  const key = match[1];

  let current = ctx;
  for (const part of key.split('.')) {
    if (current !== null && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      current = undefined;
      break;
    }
  }

  if (Array.isArray(current)) {
    return current;
  }

  if (typeof current === 'string') {
    return resolvePathToList(current, baseDir, parser);
  }

  return resolvePathToList(`${key}.json`, baseDir, parser);
}

/**
 * Strategy-based parsing of raw content into a list.
 * @param {any} val - The raw content to parse
 * @param {string} parser - The parser strategy
 * @returns {any[]}
 */
function parseValue(val, parser) {
  if (val === null || val === undefined) return [];

  switch (parser) {
    case 'json': {
      const parsed = typeof val === 'string' ? JSON.parse(val) : val;
      return normalizeToList(parsed);
    }

    case 'jsonl':
      if (typeof val !== 'string') return [];
      return val.split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(Boolean);

    case 'yaml': {
      const parsed = typeof val === 'string' ? yaml.load(val) : val;
      return normalizeToList(parsed);
    }

    case 'csv':
      if (typeof val !== 'string') return [val];
      // Simple CSV split (comma). Future: handle quoted commas.
      return val.split(',').map(s => s.trim()).filter(Boolean);
    case 'newline':
      if (typeof val !== 'string') return [val];
      return val.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    case 'auto':
    default:
      // Fallback: if it's already an array, return it. Otherwise, treat as single item.
      return normalizeToList(val);
  }
}

/**
 * Ensures the value is returned as an array.
 * @param {any} val 
 * @returns {any[]}
 */
function normalizeToList(val) {
  if (Array.isArray(val)) return val;
  if (val === null || val === undefined) return [];
  if (typeof val === 'string' && val.trim() === '') return [];
  if (typeof val === 'object' && Object.keys(val).length === 0) return [];
  return [val];
}
