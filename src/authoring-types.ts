export type AuthoringWorkflow = {
	schema?: "authoring";
	format?: "authoring";

	name: string;
	description?: string;

	defaults?: AuthoringDefaults;
	vars?: Record<string, unknown>;
	config?: Record<string, unknown>;
	validators?: Record<string, unknown>;

	resources?: Record<string, AuthoringResource>;
	collections?: Record<string, AuthoringCollection>;
	profiles?: Record<string, AuthoringProfile>;

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

export type AuthoringUses = "browser" | "model" | "transform" | "plugin";

export type AuthoringPipelineItem = AuthoringNamedStep | AuthoringDrainStep;

export type AuthoringNamedStep = {
	[stepId: string]: AuthoringStepBody;
};

export type AuthoringStepBody = {
	uses?: AuthoringUses;
	profile?: string;

	reads?: string | string[];
	writes?: string | string[];

	outputs?: Record<string, string> | string[];
	task?: string;
	script?: string | string[];

	batch?: number;
	depends_on?: string[];

	with?: Record<string, unknown>;
	model?: string;
	timeout?: number;
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
