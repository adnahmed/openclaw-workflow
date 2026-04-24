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

export const toolSchemas = {
  workflow_run: WorkflowRunParameters,
  workflow_status: WorkflowStatusParameters,
  workflow_list: WorkflowListParameters,
  workflow_cancel: WorkflowCancelParameters,
};
