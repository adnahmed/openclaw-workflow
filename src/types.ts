/**
 * @module types
 * @description Shared type definitions for the OpenClaw workflow engine.
 */

export type RunStatus = 'pending' | 'running' | 'ok' | 'failed' | 'blocked' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'blocked' | 'skipped';

/**
 * Current execution state of a single workflow step.
 */
export type StepState = {
  status: StepStatus;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  session_key: string | null;
  session_id: string | null;
  subagent_run_id: string | null;
  session_adapter: string | null;
  cancel_requested_at: string | null;
  cancel_confirmed_at: string | null;
  cancel_method: string | null;
  cancel_error: string | null;
  cancellation_reason: string | null;
  retry_not_before: string | null;
  output_check: OutputCheckResult | null;
  error: string | null;
  logs: string | null;
  attempts: number;
};

/**
 * Overall state of a workflow run.
 */
export type RunState = {
  run_id: string;
  workflow: string;
  workflow_key: string;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  cancel_requested_at: string | null;
  cancelled_at: string | null;
  steps: Record<string, StepState>;
};

export type CancelResult = {
  requested: boolean;
  confirmed?: boolean;
  method?: string;
  error?: string;
};

export interface SessionAdapter {
  spawn(prompt: string, options: SpawnOptions): Promise<{ sessionId: string; sessionKey: string }>;
  getStatus(sessionId: string, options?: any): Promise<{ status: string; error?: string; logs?: string }>;
  cancel?(sessionId: string, options?: any): Promise<CancelResult>;
}

export type MockAdapterOptions = {
  resolveIn?: number;
  shouldFail?: boolean;
  failMessage?: string;
};

export type SpawnOptions = {
  model?: string;
  timeout?: number;
  sessionTarget?: string;
  label?: string;
  cronDeliveryMode?: string;
  cronDeliveryChannel?: string;
  cronDeliveryTo?: string;
  cliTimeoutMs?: number;
  cronAddTimeoutMs?: number;
  cronRunTimeoutMs?: number;
  cronPollTimeoutMs?: number;
  sessionKey?: string;
};

/**
 * Specification for a step output.
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

   unknown_policy?: "fail" | "blocked" | "pass";
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
   required_skills?: string[];
   /** MCP server names required by the workflow, e.g. MCP_DOCKER. Not OpenClaw skills. */
   required_mcp_servers?: string[];
   steps: WorkflowStep[];
  concurrency: number;
};

export type StepFailureKind =
  | "timeout"
  | "timeout_stop_confirmed"
  | "timeout_stop_unconfirmed"
  | "missing_file"
  | "schema"
  | "fail_when"
  | "parse"
  | "other";

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
  retry_on?: string[];
  retry_except?: string[];
  optional: boolean;
  always_run?: boolean;
    complete_when?: "outputs" | "session" | "session_then_outputs";
    on_block?: "block_run" | "fail_step" | "continue";
    required_skills?: string[];
    /** MCP server names required by this step, e.g. MCP_DOCKER. Not OpenClaw skills. */
    required_mcp_servers?: string[];
    original_id?: string;

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
  failure_kind?: StepFailureKind;
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
  failure_kind?: StepFailureKind | string | null;
  session_key: string | null;
  output_check: OutputCheckResult;
  error: string | null;
  logs: string | null;
  duration_ms: number;
  cancel_result?: CancelResult | null;
};
