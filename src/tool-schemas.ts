import { Type } from "@sinclair/typebox";

export const WorkflowRunParameters = Type.Object(
	{
		name: Type.String({
			description:
				'Workflow file stem, for example "seo-pipeline" for seo-pipeline.yml',
		}),
		dry_run: Type.Optional(
			Type.Boolean({
				description:
					"Validate and show the execution plan without running the workflow.",
				default: false,
			}),
		),
		resume: Type.Optional(
			Type.Boolean({
				description:
					'Resume from the most recent run, skipping steps that already completed with status "ok".',
				default: false,
			}),
		),
	},
	{ additionalProperties: false },
);

export const WorkflowStatusParameters = Type.Object(
	{
		run_id: Type.Optional(
			Type.String({
				description: "Specific run ID to look up.",
			}),
		),
		name: Type.Optional(
			Type.String({
				description:
					"Workflow name. Returns the status of the most recent run for this workflow.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const WorkflowListParameters = Type.Object(
	{},
	{ additionalProperties: false },
);

export const WorkflowCancelParameters = Type.Object(
	{
		run_id: Type.String({
			description: "The run ID to cancel.",
		}),
	},
	{ additionalProperties: false },
);

export const WorkflowStepUpdateParameters = Type.Object(
	{
		run_id: Type.String({
			description: "The active workflow run ID.",
		}),
		step_id: Type.String({
			description: "The running step ID to update.",
		}),
		status: Type.Optional(
			Type.Union([
				Type.Literal("progress"),
				Type.Literal("ready"),
				Type.Literal("blocked"),
				Type.Literal("failed"),
			]),
		),
		message: Type.Optional(Type.String()),
		counters: Type.Optional(Type.Record(Type.String(), Type.Number())),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const WorkflowStepCompleteParameters = Type.Object(
	{
		run_id: Type.String({
			description: "The active workflow run ID.",
		}),
		step_id: Type.String({
			description: "The running step ID requesting completion.",
		}),
		reason: Type.Optional(
			Type.Union([
				Type.Literal("generated"),
				Type.Literal("cache_hit"),
				Type.Literal("cache_repaired"),
				Type.Literal("empty_result"),
				Type.Literal("blocked_result"),
				Type.Literal("external_result"),
				Type.Literal("manual_adoption"),
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
	},
	{ additionalProperties: false },
);

export const WorkflowWriteOutputParameters = Type.Object(
	{
		run_id: Type.String({
			description: "The active workflow run ID.",
		}),
		step_id: Type.String({
			description: "The running step ID that owns this declared output.",
		}),
		path: Type.Optional(
			Type.String({
				description: "Legacy path of a declared output for this step.",
			}),
		),
		output_id: Type.Optional(
			Type.String({
				description: "Logical output id of a declared output for this step.",
			}),
		),
		data: Type.Optional(
			Type.Unknown({
				description:
					"Structured JSON value to write when validator type is json.",
			}),
		),
		text: Type.Optional(
			Type.String({
				description: "Text content to write when validator type is text.",
			}),
		),
		attempt: Type.Optional(Type.Number({ minimum: 0 })),
		session_key: Type.Optional(Type.String()),
		subagent_run_id: Type.Optional(Type.String()),
		handoff_token: Type.Optional(Type.String()),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const WorkflowReadOutputParameters = Type.Object(
	{
		run_id: Type.String({ description: "The active workflow run ID." }),
		step_id: Type.String({ description: "The producing step ID." }),
		output_id: Type.String({ description: "Declared output id." }),
		limit: Type.Optional(Type.Number({ minimum: 1 })),
		fields: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

export const WorkflowObservationReadParameters = Type.Object(
	{
		run_id: Type.String(),
		step_id: Type.String(),
		observation_id: Type.String(),
		mode: Type.Optional(
			Type.Union([
				Type.Literal("head"),
				Type.Literal("tail"),
				Type.Literal("page"),
			]),
		),
		page: Type.Optional(Type.Number({ minimum: 1 })),
		max_bytes: Type.Optional(Type.Number({ minimum: 1, maximum: 32768 })),
	},
	{ additionalProperties: false },
);

export const WorkflowObservationSearchParameters = Type.Object(
	{
		run_id: Type.String(),
		step_id: Type.String(),
		observation_id: Type.String(),
		query: Type.String(),
		max_matches: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
		context_bytes: Type.Optional(Type.Number({ minimum: 16, maximum: 2048 })),
	},
	{ additionalProperties: false },
);

export const WorkflowObservationJsonPathParameters = Type.Object(
	{
		run_id: Type.String(),
		step_id: Type.String(),
		observation_id: Type.String(),
		path: Type.String(),
		max_items: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
		max_bytes: Type.Optional(Type.Number({ minimum: 128, maximum: 32768 })),
	},
	{ additionalProperties: false },
);

export const WorkflowListOutputsParameters = Type.Object(
	{
		run_id: Type.String({ description: "The workflow run ID." }),
		step_id: Type.Optional(
			Type.String({ description: "Optional step filter." }),
		),
	},
	{ additionalProperties: false },
);

export const WorkflowMaterializeOutputParameters = Type.Object(
	{
		run_id: Type.String({ description: "The workflow run ID." }),
		step_id: Type.String({ description: "The producing step ID." }),
		output_id: Type.String({ description: "Declared output id." }),
		path: Type.Optional(
			Type.String({
				description: "Optional target path to materialize artifact to.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const WorkflowStateGetParameters = Type.Object(
	{
		run_id: Type.String({ description: "Workflow run ID." }),
		include_steps: Type.Optional(
			Type.Boolean({
				description: "Include full per-step state in the response.",
				default: true,
			}),
		),
	},
	{ additionalProperties: false },
);

export const toolSchemas = {
	workflow_run: WorkflowRunParameters,
	workflow_status: WorkflowStatusParameters,
	workflow_list: WorkflowListParameters,
	workflow_cancel: WorkflowCancelParameters,
	workflow_step_update: WorkflowStepUpdateParameters,
	workflow_step_complete: WorkflowStepCompleteParameters,
	write_output: WorkflowWriteOutputParameters,
	read_output: WorkflowReadOutputParameters,
	workflow_observation_read: WorkflowObservationReadParameters,
	workflow_observation_search: WorkflowObservationSearchParameters,
	workflow_observation_json_path: WorkflowObservationJsonPathParameters,
	list_outputs: WorkflowListOutputsParameters,
	materialize_output: WorkflowMaterializeOutputParameters,
	workflow_state_get: WorkflowStateGetParameters,
};
