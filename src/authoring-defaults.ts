export const AUTHORING_DEFAULTS = {
	mode: "sealed",
	context: "adaptive",
	output_mode: "artifacts",
	retry: "safe",
	materialize: "always",

	batch_size: 25,
	lease_seconds: 900,
	visibility_timeout_s: 900,

	layout: {
		data: "data/{workflow_slug}/{date}/{output_id}.json",
		report: "output/{workflow_slug}/{date}/{output_id}.md",
		spool: "data/{workflow_slug}/{date}/spool/{step_id}/{artifact_id}",
	},
} as const;
