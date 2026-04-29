/**
 * @module types
 * @description Shared type definitions for the OpenClaw workflow engine.
 */

/**
 * Specification for a step output.
 * Can be a simple path string or a detailed object for validation.
 */
export type OutputSpec =
  | string
  | {
      path: string;
      validate?: string;
      optional?: boolean;
    };

/**
 * Specification for how to validate a step's output.
 */
export type ValidatorSpec = {
  type: "json" | "text";
  min_bytes?: number;
  schema?: string | object;

  pass_when?: string;
  retry_when?: string;
  block_when?: string;
  fail_when?: string;

  unknown_policy?: "fail" | "block" | "pass";
};

/**
 * High-level workflow definition.
 */
export type WorkflowDefinition = {
  name: string;
  version: string;
  description: string;
  config: Record<string, unknown>;
  validators?: Record<string, ValidatorSpec>;
  steps: WorkflowStep[];
  concurrency: number;
};

/**
 * A single step in a workflow.
 */
export type WorkflowStep = {
  id: string;
  name: string;
  task: string | null;
  depends_on: string[];
  outputs: OutputSpec[];
  for_each?: string;
  skip_if_empty?: string;
  parser?: string;
  item_schema?: any;
  steps?: WorkflowStep[];
  model?: string | null;
  concurrency?: number | null;
  timeout: number;
  retry: number;
  retry_delay: number;
  optional: boolean;
  always_run?: boolean;
  on_block?: "block_run" | "fail_step" | "continue";
};

/**
 * Decision returned by the output validator.
 */
export type ValidationDecision =
  | "pass"
  | "retry"
  | "blocked"
  | "fail"
  | "unknown";

/**
 * Detailed result of a single output validation.
 */
export type OutputValidationResult = {
  path: string;
  exists: boolean;
  bytes?: number;
  validator?: string;
  decision: ValidationDecision;
  errors: string[];
  doc?: unknown;
};

/**
 * Aggregated result of all output checks for a step.
 */
export type OutputCheckResult = {
  passed: boolean;
  decision: ValidationDecision;
  missing_files: string[];
  checked_files: string[];
  validations: OutputValidationResult[];
};

/**
 * Result of running a single step.
 */
export type StepRunResult = {
  status: "ok" | "failed" | "blocked";
  retryable?: boolean;
  session_key: string | null;
  output_check: OutputCheckResult;
  error: string | null;
  logs: string | null;
  duration_ms: number;
};
