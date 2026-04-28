/**
 * @module variable-substitution
 * @description Performs template variable substitution on workflow task prompts,
 * output file paths, and any other string fields in a workflow definition.
 *
 * Supported variables:
 *   {date}     → Current date in YYYY-MM-DD format (UTC)
 *   {datetime} → Current datetime as full ISO 8601 string (e.g. 2026-03-09T14:22:00.000Z)
 *   {run_id}   → The unique run identifier for this workflow execution
 *   {config.X} → Value of variable X from the workflow's config block
 *
 * Escaping:
 *   Use `\{variable}` to write the literal text of a variable without substituting it.
 *   Example: `\{config.redis_prefix}` renders as `{config.redis_prefix}`.
 *
 * Why UTC? Workflows often run on servers without a specific timezone configuration.
 * Using UTC ensures consistent, reproducible filenames and logs regardless of the
 * server's locale. If local time is needed, that's a future extension point.
 *
 * Dependencies: none (pure Node.js)
 *
 * @example
 * import { substituteVars, buildContext } from './variable-substitution.js';
 * const ctx = buildContext('my-pipeline-20260309T082000');
 * const path = substituteVars('data/output-{date}.json', ctx);
 * // → 'data/output-2026-03-09.json'
 */

/**
 * @typedef {Object} SubstitutionContext
 * @property {string} date     - Current date as YYYY-MM-DD (UTC)
 * @property {string} datetime - Current datetime as ISO 8601 string
 * @property {string} run_id   - The workflow run identifier
 * @property {Object} [config] - Workflow-specific configuration variables
 * @property {Object.<string, any>} [vars] - Additional workflow variables
 */

/**
 * Build a substitution context object for a given run.
 * Snapshot the current time once so all substitutions within a run are consistent.
 *
 * @param {string} runId - The workflow run ID
 * @param {Object} [workflowConfig={}] - Configuration block from the workflow definition
 * @param {Date} [now=new Date()] - Optional fixed timestamp (useful for testing)
 * @returns {SubstitutionContext}
 */
export function buildContext(runId, workflowConfig = {}, now = new Date()) {
  const isoString = now.toISOString();
  // Extract YYYY-MM-DD from the ISO string prefix
  const date = isoString.slice(0, 10);

  return {
    date,
    datetime: isoString,
    run_id: runId,
    config: workflowConfig,
  };
}

export class TemplateSubstitutionError extends Error {
  constructor(
    public token: string,
    public value: unknown,
    public hint?: string,
  ) {
    super(
      `Invalid template token ${token}: resolved to ${Object.prototype.toString.call(value)}. ` +
        (hint || "Use a scalar path such as {item.alert_key}."),
    );

    this.name = "TemplateSubstitutionError";
  }
}

const ANY_BRACED_TOKEN_RE = /(?<!\\)\{([\w.]+)\}/g;

// Only these are engine tokens:
// {date}, {datetime}, {run_id}, {config.X}, {config.X.Y}, {item}, {item.X}, {item.X.Y}
const ENGINE_TOKEN_RE =
  /(?<!\\)\{(date|datetime|run_id|config(?:\.[A-Za-z_]\w*)+|item(?:\.[A-Za-z_]\w*)*)\}/g;

type UnknownTokenMode = "preserve" | "throw";

type SubstituteOptions = {
  unknown?: UnknownTokenMode;
};

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function resolvePath(ctx: unknown, path: string): { found: true; value: unknown } | { found: false } {
  let current: unknown = ctx;

  for (const part of path.split(".")) {
    if (
      current !== null &&
      typeof current === "object" &&
      hasOwn(current, part)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return { found: false };
    }
  }

  return { found: true, value: current };
}

function isDeferredItemToken(path: string, ctx: unknown): boolean {
  return (
    (path === "item" || path.startsWith("item.")) &&
    !(
      ctx !== null &&
      typeof ctx === "object" &&
      hasOwn(ctx, "item")
    )
  );
}

export function substituteVars(
  template: unknown,
  ctx: Record<string, unknown>,
  options: SubstituteOptions = {},
): unknown {
  if (typeof template !== "string") return template;

  const unknownMode = options.unknown ?? "preserve";
  const tokenRe = unknownMode === "throw" ? ANY_BRACED_TOKEN_RE : ENGINE_TOKEN_RE;

  const rendered = template.replace(tokenRe, (match, path) => {
    const resolved = resolvePath(ctx, path);

    if (!resolved.found) {
      // Allows top-level compilation to leave {item.X} alone until loop expansion.
      if (isDeferredItemToken(path, ctx)) return match;

      throw new TemplateSubstitutionError(
        match,
        undefined,
        `Unknown token path: ${path}`,
      );
    }

    if (!isScalar(resolved.value)) {
      throw new TemplateSubstitutionError(
        match,
        resolved.value,
        `Token "${match}" is not scalar. Use a scalar path such as "{${path}.alert_key}".`,
      );
    }

    return String(resolved.value);
  });

  return rendered.replace(/\\\{/g, "{").replace(/\\\}/g, "}");
}

export function substituteDeep(
  value: unknown,
  ctx: Record<string, unknown>,
  options: SubstituteOptions = {},
): unknown {
  if (typeof value === "string") return substituteVars(value, ctx, options);

  if (Array.isArray(value)) {
    return value.map((item) => substituteDeep(item, ctx, options));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteDeep(v, ctx, options);
    }
    return result;
  }

  return value;
}

const BAD_PATH_FRAGMENTS = [
  "[object Object]",
  "undefined",
  "null",
  "NaN",
];

export function assertSafeOutputPath(outputPath: string) {
  for (const bad of BAD_PATH_FRAGMENTS) {
    if (outputPath.includes(bad)) {
      throw new Error(`Unsafe output path "${outputPath}" contains "${bad}"`);
    }
  }

  if (outputPath.includes("..")) {
    throw new Error(`Unsafe output path "${outputPath}" contains path traversal`);
  }

  if (/[<>:"|?*]/.test(outputPath)) {
    throw new Error(`Unsafe output path "${outputPath}" contains forbidden filename characters`);
  }
}
