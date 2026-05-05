/**
 * @module types
 * @description Shared type definitions for the OpenClaw workflow engine.
 */

export type RunStatus =
	| "pending"
	| "running"
	| "ok"
	| "failed"
	| "blocked"
	| "cancelled";
export type StepStatus =
	| "pending"
	| "running"
	| "ok"
	| "failed"
	| "blocked"
	| "skipped";

export type CompletionReason =
	| "generated"
	| "cache_hit"
	| "cache_repaired"
	| "empty_result"
	| "blocked_result"
	| "external_result"
	| "manual_adoption";

export type CompletionMode =
	| "outputs"
	| "session"
	| "session_then_outputs"
	| "handoff"
	| "handoff_or_outputs";

export type StepSignalingMode = "auto" | "off";

export type OutputWriteProvenance = {
	path?: string;
	abs_path?: string;
	output_id?: string;
	artifact_key?: string;
	materialized_path?: string | null;
	storage_backend?: string;
	validator?: string;
	decision: ValidationDecision;
	failure_kind?: StepFailureKind;
	run_id: string;
	step_id: string;
	attempt: number;
	session_key?: string | null;
	subagent_run_id?: string | null;
	handoff_token?: string | null;
	bytes: number;
	sha256: string;
	committed_at: string;
};

export type StateBackendKind =
	| "filesystem"
	| "redis"
	| "redis-native"
	| "redis-mcp"
	| "auto"
	| "dual";

export type MaterializeOutputsMode = "never" | "on_demand" | "always";

export type WorkflowStateConfig = {
	backend?: StateBackendKind;
	key?: string;
	fallback?: "filesystem" | "none";
	ttl?: string;
	materialize_outputs?: MaterializeOutputsMode;
	redis?: {
		provider?: "auto" | "native" | "mcp";
		server?: string;
		tool_prefix?: string;
	};
	contracts?: Record<string, StateContractSpec>;
	collections?: Record<string, StateCollectionSpec>;
	queues?: Record<string, StateQueueSpec>;
	worker_groups?: Record<string, StateWorkerGroupSpec>;
};

export type StateCollectionSpec = {
	/** Singular entity name. Example: collection "alerts" -> entity "alert". */
	entity?: string;
	/** Field on each item containing the durable id. */
	item_key?: string;
	/** Default lifecycle used for event stream entries. */
	lifecycle?: string;
	/** Optional default queue for newly published items. */
	default_queue?: string;
	views?: {
		document?: boolean;
		metadata_hash?: boolean;
		seen_index?: boolean;
		event_stream?: boolean;
		pending_queue?: boolean;
	};
	counters?: {
		published?: string;
		rejected?: string;
		completed?: string;
		failed?: string;
	};
	on_no_redis?: "artifact_only" | "fail";
};

export type StateQueueSpec = {
	collection: string;
	lifecycle?: string;
	batch_size?: number;
	visibility_timeout_s?: number;
	/**
	 * Optional stable key suffix. Example:
	 * suffix: jobs:needs_classification
	 */
	suffix?: string;
};

export type StateWorkerGroupSpec = {
	queue: string;
	batch_size?: number;
	lease_seconds?: number;
	drain_after?: string | string[];
	caps?: string[];
};

export type StatePublishSpec = {
	from_step?: string;
	output: string;
	select?: string;
	collection: string;
	queue?: string;
	item_key?: string;
	lifecycle?: string;
	summary_output?: string;
	on_no_redis?: "artifact_only" | "fail";
};

export type StateConsumeSpec = {
	queue?: string;
	worker_group?: string;
	collection?: string;
	batch_size?: number;
	lease_seconds?: number;
	output?: string;
	on_empty?: "pass" | "fail";
};

export type StateReclaimSpec = {
	queue?: string;
	worker_group?: string;
	collection?: string;
	output?: string;
	on_no_redis?: "fail";
};

export type StateCompleteSpec = {
	from_step?: string;
	output: string;
	select?: string;
	queue?: string;
	worker_group?: string;
	collection?: string;
	item_key?: string;
	status_field?: string;
	summary_output?: string;
};

export type StateContractSpec = {
	kind: "collection" | "document" | "counter" | "queue";
	/**
	 * Canonical semantic collection name. If omitted, collection defaults to
	 * pluralized entity, e.g. entity: "alert" -> collection: "alerts".
	 */
	collection?: string;
	entity: string;
	item_key?: string;
	/**
	 * Optional semantic queue name. If omitted and pending_queue is enabled,
	 * the canonical queue key uses "<collection>:pending".
	 */
	queue?: string;
	/**
	 * Optional queue suffix override. Mirrors state.queues.<queue>.suffix.
	 */
	queue_suffix?: string;

	source_output?: string;
	raw_output?: string;
	metadata_output?: string;
	summary_output?: string;

	lifecycle?: "pending" | "ready" | "classified" | "submitted" | "failed";

	dedupe?: {
		by: string[];
	};

	state_views?: {
		document?: boolean;
		metadata_hash?: boolean;
		seen_index?: boolean;
		pending_queue?: boolean;
		event_stream?: boolean;
	};

	counters?: Record<string, string>;

	on_no_redis?: "artifact_only" | "fail";
};

export type StateBackendResolution = {
	requested: StateBackendKind;
	resolved: "filesystem" | "redis-native" | "redis-mcp";
	provider?: string;
	reason: string;
	checked_at: string;
	fallback?: "filesystem" | "none";
};

export type ReuseOutputsSpec = {
	enabled?: boolean;
	when?: string;
	require?: "declared_outputs";
	require_signature?: boolean;
	legacy_unsigned_cache?: "stale" | "allow_if_valid";
	freshness?: {
		include?: Array<
			| "output_contract_version"
			| "step_task"
			| "validators"
			| "schemas"
			| "selected_config"
			| "input_signature"
		>;
	};
	accept_decisions?: ValidationDecision[];
	on_hit?: {
		reason?: CompletionReason;
	};
	on_invalid?: "run_step" | "fail_step";
};

/**
 * Current execution state of a single workflow step.
 */
export type StepState = {
	status: StepStatus;
	started_at: string | null;
	spawned_at?: string | null;
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
	declared_outputs: OutputSpec[] | null;
	handoff: {
		requested_at?: string;
		completed_at?: string;
		reason?: CompletionReason | string;
		message?: string;
		outputs?: string[];
		token?: string;
		metadata?: Record<string, unknown>;
		attempt?: number;
		session_key?: string;
		subagent_run_id?: string;
	} | null;
	cache: {
		checked_at?: string;
		hit?: boolean;
		adopted?: boolean;
		decision?: ValidationDecision;
		reason?: string;
		producer_run_id?: string;
		contract_signature?: string;
		previous_contract_signature?: string;
		current_contract_signature?: string;
		validator_hash?: string;
	} | null;
	output_writes: Record<string, OutputWriteProvenance> | null;
	counters: Record<string, number> | null;
	reported_status: string | null;
	last_update_at: string | null;
	last_message: string | null;
	handoff_token: string | null;
	error: string | null;
	logs: string | null;
	attempts: number;
	/** Unix ms timestamp of the first time this step was launched in this run (set on attempt 1, preserved across retries). */
	first_started_at_ms?: number;
	/**
	 * A stale-attempt handoff whose declared outputs already validated.
	 * Stored by workflow_step_complete when the attempt token is stale but outputs pass.
	 * The executor adopts this before spawning the next retry.
	 */
	late_success_candidate?: {
		attempt: number;
		handoff_token?: string | null;
		checked_at: string;
		output_check: OutputCheckResult;
		reason: string;
	} | null;
};

/**
 * Overall state of a workflow run.
 */
export type RunState = {
	run_id: string;
	workflow: string;
	workflow_key: string;
	status: RunStatus;
	phase?: string | null;
	error?: string | null;
	resumed_as?: string | null;
	spawned_sessions?: number;
	state_backend?: StateBackendResolution;
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
	supportsResultPolicy?: boolean;
	spawn(
		prompt: string,
		options: SpawnOptions,
	): Promise<{ sessionId: string; sessionKey: string }>;
	getStatus(
		sessionId: string,
		options?: any,
	): Promise<{ status: string; error?: string; logs?: string }>;
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
	sealed?: SealedStepSpec;
	resultPolicy?: SealedToolResultPolicy;
	transcriptPolicy?: SealedContextFirewall;
	artifactSink?: {
		runId: string;
		stepId: string;
		spoolPrefix: string;
	};
};

/**
 * Specification for a step output.
 */
export type OutputSpec =
	| string
	| {
			id?: string;
			path?: string;
			validate?: string;
			optional?: boolean;
			materialize?: {
				path?: string;
				mode?: MaterializeOutputsMode;
			};
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

export type CompiledFromMetadata = {
	schema: "authoring";
	source_path?: string;
	source_step?: string;
	source_pointer?: string;
	generated?: boolean;
	generated_reason?: string;
};

/**
 * High-level workflow definition.
 */
export type WorkflowDefinition = {
	name: string;
	version: string;
	description: string;
	config: Record<string, unknown>;
	__compiled_from?: CompiledFromMetadata;
	state?: WorkflowStateConfig;
	validators?: Record<string, ValidatorSpec>;
	required_skills?: string[];
	/** MCP server names required by the workflow, e.g. MCP_DOCKER. Not OpenClaw skills. */
	required_mcp_servers?: string[];
	steps: WorkflowStep[];
	concurrency: number;
};

export type RunFilter = {
	workflow?: string;
	status?: RunStatus;
	limit?: number;
};

export type StoredArtifact = {
	run_id: string;
	step_id: string;
	output_id: string;
	validator?: string;
	decision: ValidationDecision;
	data: unknown;
	text?: string;
	bytes: number;
	sha256: string;
	attempt?: number;
	session_key?: string | null;
	subagent_run_id?: string | null;
	handoff_token?: string | null;
	storage_backend: string;
	materialized_path?: string | null;
	committed_at: string;
};

export type StoredArtifactMeta = Omit<StoredArtifact, "data" | "text">;

export type CommitArtifactArgs = {
	runId: string;
	stepId: string;
	outputId: string;
	declaredOutput: OutputSpec;
	data?: unknown;
	text?: string;
	validatorId?: string;
	validator?: ValidatorSpec;
	validators?: Record<string, ValidatorSpec>;
	attempt?: number;
	sessionKey?: string | null;
	subagentRunId?: string | null;
	handoffToken?: string | null;
	workflowDir?: string;
	baseDir?: string;
	materialize?: MaterializeOutputsMode;
};

export type ArtifactCommitResult = {
	ok: boolean;
	committed: boolean;
	decision: ValidationDecision;
	validation: OutputValidationResult;
	artifact?: StoredArtifact;
	message?: string;
};

export type ValidateArtifactArgs = {
	artifact: StoredArtifact;
	validatorId?: string;
	validator?: ValidatorSpec;
	validators?: Record<string, ValidatorSpec>;
	workflowDir?: string;
};

export type MaterializeArtifactArgs = {
	runId: string;
	stepId: string;
	outputId: string;
	targetPath?: string;
	baseDir?: string;
};

export interface WorkflowStateStore {
	loadRun(runId: string): Promise<RunState>;
	saveRun(state: RunState): Promise<void>;
	updateRun(runId: string, patch: Partial<RunState>): Promise<RunState>;
	updateStep(
		runId: string,
		stepId: string,
		patch: Partial<StepState>,
	): Promise<RunState>;
	listRuns(filter?: RunFilter): Promise<RunState[]>;
	acquireLock(runId: string, owner: string, ttlMs: number): Promise<boolean>;
}

export interface WorkflowArtifactStore {
	commitArtifact(args: CommitArtifactArgs): Promise<ArtifactCommitResult>;
	readArtifact(
		runId: string,
		stepId: string,
		outputId: string,
	): Promise<StoredArtifact | null>;
	validateArtifact(args: ValidateArtifactArgs): Promise<OutputValidationResult>;
	listArtifacts(runId: string, stepId?: string): Promise<StoredArtifactMeta[]>;
	materializeArtifact(args: MaterializeArtifactArgs): Promise<string>;
}

export type StepFailureKind =
	| "timeout"
	| "timeout_stop_confirmed"
	| "timeout_stop_unconfirmed"
	| "missing_file"
	| "schema"
	| "fail_when"
	| "parse"
	| "other";

export type StepExecutorKind =
	| "subagent"
	| "loop_subagent"
	| "plugin"
	| "state_drain"
	| "sealed";

export type SealedMode = "command" | "tool_worker" | "skill_worker" | "adapter";

export type SealedOverflowMode = "fail" | "truncate" | "spool_and_summarize";

export type SealedResultVisibility = {
	mode?: "auto";
	inline_when_safe?: boolean;
	preserve_full_results?: boolean;
	spool_when_large?: boolean;
	return_refs?: boolean;
	lazy_read?: boolean;
	expose_preview?: boolean;
};

export type SealedContextFirewall = {
	enabled?: boolean;
	strategy?: "adaptive";
	on_context_pressure?: "spool_and_compact" | "fail";
};

export type SealedStdStreamPolicy = {
	max_stdout_bytes?: number;
	max_stderr_bytes?: number;
	max_process_output_bytes?: number;
	mode?: SealedOverflowMode;
};

export type SealedToolResultPolicy = {
	max_context_injection_bytes?: number | "auto";
	max_single_result_bytes_before_spool?: number | "auto";
	include_head_bytes?: number;
	include_tail_bytes?: number;
	preserve_full_result?: boolean;
	mode?: "auto" | SealedOverflowMode;
};

export type SealedWatchdogPolicy = {
	mode?: "progress_based" | "limits";
	max_turns?: number;
	max_tool_calls?: number;
	max_wall_seconds?: number;
	max_idle_seconds?: number;
	repeated_tool_call_threshold?: number;
	require_declared_outputs?: boolean;
	detect_repeated_tool_calls?: boolean;
	detect_repeated_navigation?: boolean;
	on_no_progress?: "fail" | "blocked";
};

export type SealedCommandSpec = {
	argv?: string[];
	cwd?: string;
	env?: Record<string, string>;
};

export type SealedReturnContract = {
	max_context_bytes?: number | "auto";
	type?: "json";
	schema?: object;
};

export type SealedStepSpec = {
	mode?: SealedMode;
	command?: SealedCommandSpec | string;
	no_model?: boolean;

	tools?: {
		allow?: string[];
		deny?: string[];
	};

	result_visibility?: SealedResultVisibility;
	context_firewall?: SealedContextFirewall;
	tool_result_policy?: SealedToolResultPolicy;
	stdout_policy?: SealedStdStreamPolicy;
	watchdog?: SealedWatchdogPolicy;
	return_contract?: SealedReturnContract;

	artifact_spool?: {
		enabled?: boolean;
		path?: string;
	};
};

export type StateDrainSpec = {
	/**
	 * Worker group to drain. Usually maps to state.worker_groups.<name>.
	 */
	worker_group: string;

	/**
	 * How many consecutive empty claims are required before the drain controller
	 * finishes. Defaults to 1.
	 */
	max_empty_claims?: number;

	/**
	 * Safety valve for development/testing. null/undefined means no workflow cap;
	 * termination is queue emptiness.
	 */
	max_iterations?: number | null;
};

export type WorkflowStep = {
	id: string;
	name: string;
	task: string | null;
	kind?: StepExecutorKind;
	uses?: string;
	with?: Record<string, unknown>;
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
	output_contract_version?: number | null;
	always_run?: boolean;
	complete_when?: CompletionMode;
	on_block?: "block_run" | "fail_step" | "continue";
	reuse_outputs?: ReuseOutputsSpec;
	required_skills?: string[];
	/** MCP server names required by this step, e.g. MCP_DOCKER. Not OpenClaw skills. */
	required_mcp_servers?: string[];
	signaling?: StepSignalingMode;
	original_id?: string;
	state_contract?: string | string[];
	state_publish?: StatePublishSpec | StatePublishSpec[];
	state_consume?: StateConsumeSpec;
	state_reclaim?: StateReclaimSpec;
	state_complete?: StateCompleteSpec | StateCompleteSpec[];
	sealed?: SealedStepSpec;

	/**
	 * First-class scheduler controller. Repeatedly expands nested steps until
	 * the configured worker-group queue returns an empty claim.
	 */
	drain?: StateDrainSpec;
	__compiled_from?: CompiledFromMetadata;
};

/**
 * Context passed to a plugin operation when executing a kind:plugin step.
 */
export type PluginOperationContext = {
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	config: Record<string, unknown>;
	runId: string;
	date: string;
	substitutionContext?: Record<string, unknown> | null;
	stateStore: WorkflowStateStore;
	artifactStore: WorkflowArtifactStore;
	redis: RedisClient | null;
	validators: Record<string, ValidatorSpec>;
};

/**
 * Result returned by a plugin operation.
 * Maps to the same shape as StepRunResult for executor compatibility.
 */
export type PluginOperationResult = {
	status: "ok" | "failed" | "blocked";
	retryable?: boolean;
	failure_kind?: StepFailureKind | string | null;
	output_check: OutputCheckResult;
	error: string | null;
	logs: string | null;
	duration_ms: number;
	/** Optional provenance records keyed by output_id */
	output_writes?: Record<string, OutputWriteProvenance>;
};

/**
 * A registered plugin operation (workflow.xxx built-in or user-defined).
 */
export interface WorkflowPluginOperation {
	id: string;
	description?: string;
	run(ctx: PluginOperationContext): Promise<PluginOperationResult>;
}

/**
 * Minimal Redis client interface used by plugin operations.
 * Backed by ioredis natively or an MCP Redis adapter.
 */
export interface RedisClient {
	readonly kind: "native" | "mcp";
	get(key: string): Promise<string | null>;
	set(
		key: string,
		value: string,
		options?: { ex?: number; px?: number; nx?: boolean },
	): Promise<"OK" | null>;
	del(...keys: string[]): Promise<number>;
	hset(key: string, fields: Record<string, string>): Promise<number>;
	hgetall(key: string): Promise<Record<string, string> | null>;
	exists(...keys: string[]): Promise<number>;
	expire(key: string, seconds: number): Promise<number>;
	incr(key: string): Promise<number>;
	lrange?(key: string, start: number, stop: number): Promise<string[]>;
	xadd(
		key: string,
		id: string,
		fields: Record<string, string>,
	): Promise<string | null>;
	eval?(script: string, keys: string[], args: string[]): Promise<unknown>;
	xgroup(
		command: "CREATE",
		key: string,
		group: string,
		id: string,
		options?: { MKSTREAM?: boolean },
	): Promise<"OK">;
	/** Execute multiple commands atomically. Returns array of results. */
	multi(commands: Array<[string, ...unknown[]]>): Promise<unknown[]>;
	disconnect(): Promise<void>;
}

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
	modified_at_ms?: number;
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

export type WorkflowStepUpdateStatus =
	| "progress"
	| "ready"
	| "blocked"
	| "failed";

export type WorkflowStepUpdatePayload = {
	run_id: string;
	step_id: string;
	status?: WorkflowStepUpdateStatus;
	message?: string;
	counters?: Record<string, number>;
	metadata?: Record<string, unknown>;
};

export type WorkflowStepCompletePayload = {
	run_id: string;
	step_id: string;
	reason?: CompletionReason;
	outputs?: string[];
	message?: string;
	counters?: Record<string, number>;
	metadata?: Record<string, unknown>;
	attempt?: number;
	session_key?: string;
	subagent_run_id?: string;
	handoff_token?: string;
};
