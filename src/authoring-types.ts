import type {
	SealedStepSpec,
	StateCompleteSpec,
	StateConsumeSpec,
	StatePartitionSpec,
	StatePatchOutputsSpec,
	StatePublishSpec,
	StateQuerySpec,
	StateReclaimSpec,
	StateReportSpec,
	StepInputSpec,
	WorkflowStateConfig,
} from "./types.js";

export type AuthoringWorkflow = {
	schema?: "authoring";
	format?: "authoring";

	name: string;
	version?: string;
	description?: string;
	concurrency?: number;

	defaults?: AuthoringDefaults;
	vars?: Record<string, unknown>;
	config?: Record<string, unknown>;
	validators?: Record<string, unknown>;

	resources?: Record<string, AuthoringResource>;
	collections?: Record<string, AuthoringCollection>;
	profiles?: Record<string, AuthoringProfile>;

	/**
	 * Engine-owned state config.
	 * This is copied into compiled workflow.state, but never exposed to workers
	 * as required_mcp_servers.
	 */
	state?: WorkflowStateConfig;

	/**
	 * Public OpenClaw skills only.
	 * Native Redis/MCP state remains engine-owned.
	 */
	required_skills?: string[];

	pipeline: AuthoringPipelineItem[];
};

export type AuthoringDefaults = {
	mode?: "sealed";
	context?: "adaptive" | "none";
	output_mode?: "artifacts";
	retry?: "safe" | "none";
	materialize?: "always" | "on_demand" | "never";

	batch_size?: number;
	lease_seconds?: number;
	visibility_timeout_s?: number;

	layout?: {
		data?: string;
		report?: string;
		spool?: string;
	};

	/**
	 * Merged into every compiled sealed step.
	 */
	sealed?: Partial<SealedStepSpec>;
};

export type AuthoringCollection = {
	key: string;
	queue?: string;
	queues?: string[];
};

export type AuthoringResource = {
	type: "json" | "text" | "file";
	source: string;
	cache?: boolean;
	validate?: string;
};

export type AuthoringProfile = {
	uses?: AuthoringUses;
	tools?: string[];
	context?: "adaptive" | "none";
	retry?: "safe" | "none";
	output?: "artifacts";
	model?: string | "none";
	script?: string | string[];
};

export type AuthoringUses =
	| "browser"
	| "model"
	| "transform"
	| "plugin"
	| "drain";

export type AuthoringOutputSpec =
	| string
	| {
			id?: string;
			path?: string;
			validate?: string;
			optional?: boolean;
			materialize?: {
				path?: string;
				mode?: "always" | "on_demand" | "never";
			};
	  };

export type AuthoringPipelineItem = AuthoringNamedStep | AuthoringDrainStep;

export type AuthoringNamedStep = {
	[stepId: string]: AuthoringStepBody;
};

export type AuthoringStepBody = {
	uses?: AuthoringUses;
	profile?: string;

	name?: string;

	reads?: string | string[];
	writes?: string | string[];

	outputs?: Record<string, string> | AuthoringOutputSpec[] | string[];
	task?: string;
	script?: string | string[];

	batch?: number;
	depends_on?: string[];

	with?: Record<string, unknown>;
	model?: string;
	timeout?: number;
	concurrency?: number;

	retry?: number | "safe" | "none";
	retry_delay?: number;
	retry_on?: string[];
	retry_except?: string[];
	optional?: boolean;
	always_run?: boolean;
	on_block?: "block_run" | "continue";
	complete_when?:
		| "session"
		| "outputs"
		| "session_then_outputs"
		| "handoff"
		| "handoff_or_outputs";

	skip_if_empty?: string;
	output_contract_version?: number;
	reuse_outputs?: Record<string, unknown>;

	/**
	 * Public authoring form for sealed loops.
	 * Compiler lowers this into internal loop_subagent + sealed child worker.
	 */
	for_each?: string;
	parser?: "json" | "csv" | "newline" | "auto";
	item_schema?: Record<string, unknown>;
	loop?: "sealed_each";

	/**
	 * Public authoring form for plugin operations.
	 * Prefer this over with.operation.
	 */
	operation?: string;
	state_publish?: StatePublishSpec | StatePublishSpec[];
	state_consume?: StateConsumeSpec;
	state_complete?: StateCompleteSpec | StateCompleteSpec[];
	state_reclaim?: StateReclaimSpec;
	state_query?: StateQuerySpec;
	state_partition?: StatePartitionSpec;
	state_patch_outputs?: StatePatchOutputsSpec;
	state_report?: StateReportSpec;
	input?: StepInputSpec;
	input_context?: {
		from_claim?: string;
		mode?: "injected";
		max_items?: number;
		max_bytes?: number;
		include_fields?: string[];
		inject_as?: string;
		expose_artifact_path?: boolean;
		require_lease?: boolean;
	};

	/**
	 * Public authoring form for state-drain controllers.
	 * Compiler lowers this into internal state_drain.
	 */
	worker_group?: string;
	max_empty_claims?: number;
	max_iterations?: number | null;
	claim?: Partial<AuthoringStepBody> & {
		state_consume?: StateConsumeSpec;
	};
	worker?: AuthoringStepBody & {
		id?: string;
	};
	complete?: Partial<AuthoringStepBody> & {
		state_complete?: StateCompleteSpec | StateCompleteSpec[];
	};

	/**
	 * Per-step sealed override merged over defaults/profile.
	 */
	sealed?: Partial<SealedStepSpec>;
};

export type AuthoringDrainStep = {
	drain: string;
	batch?: number;
	do: AuthoringNamedStep;
};

export type AuthoringCompileOptions = {
	workflowDir?: string;
	strict?: boolean;
};
