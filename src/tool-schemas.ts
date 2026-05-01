import { Type } from '@sinclair/typebox';

export const WorkflowRunParameters = Type.Object({
  name: Type.String({
    description: 'Workflow file stem, for example "seo-pipeline" for seo-pipeline.yml',
  }),
  dry_run: Type.Optional(Type.Boolean({
    description: 'Validate and show the execution plan without running the workflow.',
    default: false,
  })),
  resume: Type.Optional(Type.Boolean({
    description: 'Resume from the most recent run, skipping steps that already completed with status "ok".',
    default: false,
  })),
}, { additionalProperties: false });

export const WorkflowStatusParameters = Type.Object({
  run_id: Type.Optional(Type.String({
    description: 'Specific run ID to look up.',
  })),
  name: Type.Optional(Type.String({
    description: 'Workflow name. Returns the status of the most recent run for this workflow.',
  })),
}, { additionalProperties: false });

export const WorkflowListParameters = Type.Object({}, { additionalProperties: false });

export const WorkflowCancelParameters = Type.Object({
  run_id: Type.String({
    description: 'The run ID to cancel.',
  }),
}, { additionalProperties: false });

export const WorkflowStepUpdateParameters = Type.Object({
  run_id: Type.String({
    description: 'The active workflow run ID.',
  }),
  step_id: Type.String({
    description: 'The running step ID to update.',
  }),
  status: Type.Optional(
    Type.Union([
      Type.Literal('progress'),
      Type.Literal('ready'),
      Type.Literal('blocked'),
      Type.Literal('failed'),
    ]),
  ),
  message: Type.Optional(Type.String()),
  counters: Type.Optional(Type.Record(Type.String(), Type.Number())),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

export const WorkflowStepCompleteParameters = Type.Object({
  run_id: Type.String({
    description: 'The active workflow run ID.',
  }),
  step_id: Type.String({
    description: 'The running step ID requesting completion.',
  }),
  reason: Type.Optional(
    Type.Union([
      Type.Literal('generated'),
      Type.Literal('cache_hit'),
      Type.Literal('cache_repaired'),
      Type.Literal('empty_result'),
      Type.Literal('blocked_result'),
      Type.Literal('external_result'),
      Type.Literal('manual_adoption'),
    ]),
  ),
  outputs: Type.Optional(Type.Array(Type.String())),
  message: Type.Optional(Type.String()),
  counters: Type.Optional(Type.Record(Type.String(), Type.Number())),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  attempt: Type.Optional(Type.Number({ minimum: 0 })),
  session_key: Type.Optional(Type.String()),
  subagent_run_id: Type.Optional(Type.String()),
  handoff_token: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const toolSchemas = {
  workflow_run: WorkflowRunParameters,
  workflow_status: WorkflowStatusParameters,
  workflow_list: WorkflowListParameters,
  workflow_cancel: WorkflowCancelParameters,
  workflow_step_update: WorkflowStepUpdateParameters,
  workflow_step_complete: WorkflowStepCompleteParameters,
};
