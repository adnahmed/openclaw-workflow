import { readFile, access } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import Ajv from 'ajv';
import { parse, run } from '@bufbuild/cel';
import { OutputSpec, ValidatorSpec, ValidationDecision, OutputValidationResult } from './types.js';

const ajv = new (Ajv as any)();

/**
 * Validates a single output based on its specification and the workflow's validator definitions.
 * 
 * @param {OutputSpec} spec - The output specification for this specific output
 * @param {string} baseDir - Base directory for resolving relative paths
 * @param {Record<string, ValidatorSpec>} validators - Map of validator IDs to their specifications
 * @param {string} [workflowDir] - Optional workflow directory for reference
 * @returns {Promise<OutputValidationResult>}
 */
export async function validateOutput(
  spec,
  baseDir,
  validators = {},
  workflowDir = ''
): Promise<OutputValidationResult> {
  const outputSpec = typeof spec === 'string' ? { path: spec } : spec;
  const { path: rawPath, validate: validatorId } = outputSpec;
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
  const result: OutputValidationResult = {
    path: absPath,
    exists: false,
    decision: 'unknown',
    errors: [],
  };

  try {
    await access(absPath);
    result.exists = true;
  } catch {
    result.decision = 'fail';
    result.errors.push('File does not exist');
    return result;
  }

  try {
    const content = await readFile(absPath);
    result.bytes = content.length;

    if (!validatorId || !validators[validatorId]) {
      result.decision = 'pass';
      return result;
    }

    const validator = validators[validatorId];
    
    // 1. Min Bytes Check
    if (validator.min_bytes && result.bytes < validator.min_bytes) {
      result.decision = 'fail';
      result.errors.push(`File size ${result.bytes} is less than minimum ${validator.min_bytes}`);
      return result;
    }

    let doc = null;
    if (validator.type === 'json') {
      try {
        const text = content.toString();
        doc = JSON.parse(text);
        
        // 2. JSON Schema Validation
        if (validator.schema) {
          const schema = typeof validator.schema === 'string' 
            ? JSON.parse(validator.schema) 
            : validator.schema;
          
          const validateSchema = ajv.compile(schema);
          const valid = validateSchema(doc);
          if (!valid) {
            result.decision = 'fail';
            result.errors.push(...(validateSchema.errors?.map(e => `${e.instancePath} ${e.message}`) || ['Schema validation failed']));
            return result;
          }
        }
      } catch (e) {
        result.decision = 'fail';
        result.errors.push(`Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`);
        return result;
      }
    } else {
      doc = content.toString();
    }

    result.doc = doc;

    // 3. CEL Evaluation
    const celContext = {
      doc,
      path: absPath,
      bytes: result.bytes,
      exists: result.exists,
    };

    const rules = [
      { rule: validator.fail_when, decision: 'fail' },
      { rule: validator.block_when, decision: 'blocked' },
      { rule: validator.retry_when, decision: 'retry' },
      { rule: validator.pass_when, decision: 'pass' },
    ];

    for (const { rule, decision } of rules) {
      if (!rule) continue;
      try {
        const isMatch = await evaluateCel(rule, celContext);
        if (isMatch) {
          result.decision = decision as ValidationDecision;
          return result;
        }
      } catch (e) {
        result.errors.push(`CEL evaluation error in ${decision}_when: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 4. Final Decision based on unknown_policy
    if (result.decision === 'unknown') {
      result.decision = (validator.unknown_policy || 'fail') as ValidationDecision;
    }
  } catch (e) {
    result.decision = 'fail';
    result.errors.push(`Unexpected error during validation: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}

/**
 * Evaluates a CEL expression against a given context.
 * 
 * @param {string} expression - The CEL expression to evaluate
 * @param {Record<string, any>} context - The context data
 * @returns {Promise<boolean>}
 */
async function evaluateCel(expression, context) {
  try {
    const result = run(expression, context);
    return !!result;
  } catch (e) {
    throw e;
  }
}
