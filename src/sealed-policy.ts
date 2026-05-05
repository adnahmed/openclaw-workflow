import type {
	SealedContextFirewall,
	SealedMode,
	SealedResultVisibility,
	SealedStdStreamPolicy,
	SealedStepSpec,
	SealedToolResultPolicy,
	SealedWatchdogPolicy,
} from "./types.js";

export type RequiredishSealedSpec = SealedStepSpec & {
	mode: SealedMode;
	result_visibility: SealedResultVisibility;
	context_firewall: SealedContextFirewall;
	tool_result_policy: SealedToolResultPolicy;
	stdout_policy: SealedStdStreamPolicy;
	watchdog: SealedWatchdogPolicy;
};

export function normalizeSealedSpec(
	raw: SealedStepSpec = {},
): RequiredishSealedSpec {
	const mode: SealedMode =
		raw.mode ?? (raw.command ? "command" : "tool_worker");

	return {
		...raw,
		mode,
		result_visibility: {
			mode: "artifact_ref",
			inline_when_safe: false,
			preserve_full_results: true,
			spool_when_large: true,
			return_refs: true,
			lazy_read: true,
			expose_preview: false,
			...raw.result_visibility,
		},
		context_firewall: {
			enabled: true,
			strategy: "adaptive",
			on_context_pressure: "spool_and_compact",
			...raw.context_firewall,
		},
		tool_result_policy: {
			max_context_injection_bytes: 2048,
			max_single_result_bytes_before_spool: 2048,
			include_head_bytes: 0,
			include_tail_bytes: 0,
			preserve_full_result: true,
			mode: "spool_and_summarize",
			...raw.tool_result_policy,
		},
		stdout_policy: {
			max_stdout_bytes: 2048,
			max_stderr_bytes: 4096,
			max_process_output_bytes: 100 * 1024 * 1024,
			mode: "spool_and_summarize",
			...raw.stdout_policy,
		},
		watchdog: {
			mode: "progress_based",
			require_declared_outputs: true,
			detect_repeated_tool_calls: true,
			detect_repeated_navigation: true,
			repeated_tool_call_threshold: 3,
			on_no_progress: "fail",
			...raw.watchdog,
		},
	};
}
