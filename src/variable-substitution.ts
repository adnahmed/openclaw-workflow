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

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function substituteVars(template: unknown, ctx: any): unknown {
  if (typeof template !== "string") return template;

  return template.replace(/\{([\w.]+)\}/g, (match, path) => {
    const parts = path.split(".");
    let current: any = ctx;

    for (const part of parts) {
      if (current !== null && typeof current === "object" && part in current) {
        current = current[part];
      } else {
        throw new TemplateSubstitutionError(
          match,
          undefined,
          `Unknown token path: ${path}`,
        );
      }
    }

    if (!isScalar(current)) {
      throw new TemplateSubstitutionError(
        match,
        current,
        `Token "${match}" is not scalar. Did you mean "{${path}.alert_key}"?`,
      );
    }

    return String(current);
  });
}

/**
 * Recursively apply substituteVars to all string values in an object or array.
 * This is used to substitute variables throughout an entire step definition
 * (task prompt, output paths, etc.) in one pass.
 *
 * Non-string primitives (numbers, booleans) and null/undefined are returned as-is.
 * Arrays are mapped. Plain objects are shallow-cloned with each value processed.
 *
 * @param {*} value - The value to process (string, array, object, or primitive)
 * @param {SubstitutionContext} ctx - Substitution context
 * @returns {*} A new value with all string leaves substituted
 *
 * @example
 * const step = {
 *   task: "Run audit for {date}",
 *   outputs: ["data/{date}/handoff.json"]
 * };
 * const result = substituteDeep(step, ctx);
 * // result.task === "Run audit for 2026-03-09"
 * // result.outputs === ["data/2026-03-09/handoff.json"]
 */
export function substituteDeep(value, ctx) {
  if (typeof value === 'string') {
    return substituteVars(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map(item => substituteDeep(item, ctx));
  }
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteDeep(v, ctx);
    }
    return result;
  }
  // Primitives (number, boolean, null, undefined) pass through unchanged
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
