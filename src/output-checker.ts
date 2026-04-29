/**
 * @module output-checker
 * @description Validates that expected output files exist after a workflow step completes.
 *
 * Output gates serve as a contract: if a step claims to produce certain files,
 * we verify those files actually exist before marking the step as successful.
 * This prevents silent failures where a step appears to succeed but produced
 * no usable artifacts for downstream steps.
 *
 * Why file-based checks? Workflow steps are typically AI agents that write
 * files (reports, JSON handoffs, content drafts). Checking file existence is
 * a lightweight, universal signal of step completion that works without any
 * special instrumentation inside the step itself.
 *
 * Future extension points:
 *   - File size minimums (avoid empty-file false positives)
 *   - Content validation via JSON schema
 *   - Glob pattern support for dynamic file names
 *
 * Dependencies: node:fs/promises, node:path
 *
 * @example
 * import { checkOutputs } from './output-checker.js';
 * const result = await checkOutputs(
 *   ['data/seo-state/ta-handoff-2026-03-09.json'],
 *   '/home/user/project'
 * );
 * // result.passed === true  (if file exists)
 * // result.missing_files === []
 */

import { resolve, isAbsolute } from 'node:path';
import { 
  OutputSpec, 
  OutputCheckResult, 
  OutputValidationResult, 
  ValidationDecision, 
  ValidatorSpec 
} from './types.js';
import { validateOutput } from './output-validator.js';

/**
 * Check that all expected output files exist and satisfy their validation rules.
 * 
 * @param {OutputSpec[]} expectedOutputs - List of output specifications
 * @param {string} baseDir - Base directory for resolving relative paths
 * @param {Record<string, ValidatorSpec>} validators - Map of validator IDs to specs
 * @param {string} [workflowDir] - Optional workflow directory
 * @returns {Promise<OutputCheckResult>}
 */
export async function checkOutputs(
  expectedOutputs, 
  baseDir, 
  validators = {}, 
  workflowDir = ''
) {
  if (!expectedOutputs || expectedOutputs.length === 0) {
    return { 
      passed: true, 
      decision: 'pass', 
      missing_files: [], 
      checked_files: [], 
      validations: [] 
    };
  }

  const validations = [];

  for (const output of expectedOutputs) {
    validations.push(
      await validateOutput(output, baseDir, validators, workflowDir)
    );
  }

  const decision = mergeOutputDecisions(validations);

  return {
    passed: decision === 'pass',
    decision,
    missing_files: validations.filter(v => !v.exists).map(v => v.path),
    checked_files: validations.map(v => v.path),
    validations,
  };
}

/**
 * Merges multiple output validation decisions into a single outcome.
 * Priority: fail > blocked > retry > unknown > pass
 * 
 * @param {OutputValidationResult[]} results
 * @returns {ValidationDecision}
 */
function mergeOutputDecisions(results) {
  if (results.some(r => r.decision === 'fail')) return 'fail';
  if (results.some(r => r.decision === 'blocked')) return 'blocked';
  if (results.some(r => r.decision === 'retry')) return 'retry';
  if (results.some(r => r.decision === 'unknown')) return 'unknown';
  return 'pass';
}
