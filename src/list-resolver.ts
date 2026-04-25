import { readFile } from 'node:fs/promises';
import { join, isAbsolute as pathIsAbsolute } from 'node:path';
import yaml from 'js-yaml';


/**
 * Resolves a specific file path into a list of items.
 * 
 * @param {string} filePath - Absolute or relative path to the file
 * @param {string} baseDir   - Base directory for resolving relative paths
 * @param {string} [parser='auto'] - Parser to use ('json', 'csv', 'newline', 'auto')
 * @returns {Promise<any[]>} The resolved list of items
 */
export async function resolvePathToList(filePath, baseDir, parser = 'auto') {
  const fullPath = pathIsAbsolute(filePath) ? filePath : join(baseDir, filePath);
  try {
 
    const content = await readFile(fullPath, 'utf8');
    
    let effectiveParser = parser;
    if (parser === 'auto') {
      if (fullPath.endsWith('.json')) effectiveParser = 'json';
      else if (fullPath.endsWith('.jsonl')) effectiveParser = 'jsonl';
      else if (fullPath.endsWith('.yaml') || fullPath.endsWith('.yml')) effectiveParser = 'yaml';
      else if (fullPath.endsWith('.csv')) effectiveParser = 'csv';
      else if (fullPath.endsWith('.txt')) effectiveParser = 'newline';
    }
 
    return parseValue(content, effectiveParser);
  } catch {
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
  // 1. Check if 'token' is actually an explicit file path (not {variable})
  if (!token.startsWith('{') || !token.endsWith('}')) {
    return resolvePathToList(token, baseDir, parser);
  }

  // 2. Extract key from {key}
  const match = token.match(/\{(\w+)\}/);
  if (!match) return [];
  const key = match[1];


  // 2. Check static context first
  if (Object.prototype.hasOwnProperty.call(ctx, key)) {
    const val = ctx[key];
    return parseValue(val, parser);
  }

  // 3. Attempt to find a file named `key.json`, `key.txt`, etc.
  const candidates = [
    join(baseDir, `${key}.json`),
    join(baseDir, `${key}.txt`),
    join(baseDir, `${key}.csv`),
  ];

  for (const path of candidates) {
    try {
      const content = await readFile(path, 'utf8');
      
      // If parser is 'auto', we guess based on extension
      let effectiveParser = parser;
      if (parser === 'auto') {
        if (path.endsWith('.json')) effectiveParser = 'json';
        else if (path.endsWith('.csv')) effectiveParser = 'csv';
        else if (path.endsWith('.txt')) effectiveParser = 'newline';
      }

      return parseValue(content, effectiveParser);
    } catch {
      // File not found or unparseable, try next candidate
    }
  }

  return [];
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
    case 'json':
      try {
        const parsed = typeof val === 'string' ? JSON.parse(val) : val;
        return normalizeToList(parsed);
      } catch (e) {
        return [];
      }
    case 'jsonl':
      if (typeof val !== 'string') return [];
      return val.split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
    case 'yaml':
      try {
        const parsed = typeof val === 'string' ? yaml.load(val) : val;
        return normalizeToList(parsed);
      } catch (e) {
        return [];
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
