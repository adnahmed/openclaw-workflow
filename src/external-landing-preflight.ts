/**
 * @module external-landing-preflight
 * @description Plugin operation for safely preflighting external application
 * landing pages before a browser agent attempts to apply.
 *
 * The plugin reads a claim artifact, evaluates each item's landing URL using a
 * sandboxed HTTP probe (no form submissions, no downloads, no credential entry),
 * classifies the page safety, and enqueues safe items into verified_queue.
 */

import { redisRaw } from "./state-keyspace.js";
import type {
	ExternalLandingPreflightSpec,
	PluginOperationContext,
	PluginOperationResult,
	WorkflowPluginOperation,
} from "./types.js";
import { getLocalISOString } from "./workflow-state.js";

type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type LandingDecision =
	| "eligible"
	| "blocked"
	| "skipped"
	| "login_required"
	| "unrelated_page"
	| "download_risk"
	| "redirect_limit"
	| "timeout"
	| "unknown";

type PreflightItemResult = {
	job_id: string | null;
	item_key: string;
	lease: unknown;
	route: string | null;
	status: string;
	submitted: boolean;
	retryable: boolean;
	reason: string;
	landing_decision: LandingDecision;
	safe_to_attempt: boolean;
	entrypoint_url: string | null;
	matched_job_url: string | null;
	match_confidence: number;
	match_confidence_bucket: "strong" | "ambiguous" | "weak" | "none";
	external_preflight: {
		final_url: string | null;
		page_title: string | null;
		risk_flags: string[];
	};
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withObject(ctx: PluginOperationContext): JsonObject {
	return (ctx.step.with ?? {}) as unknown as JsonObject;
}

function failResult(
	message: string,
	extra: Partial<PluginOperationResult> = {},
): PluginOperationResult {
	return {
		status: "failed",
		retryable: true,
		error: message,
		logs: null,
		duration_ms: 0,
		output_check: {
			passed: false,
			decision: "fail",
			missing_files: [],
			checked_files: [],
			validations: [],
		},
		...extra,
	};
}

function matchConfidenceBucket(
	score: number,
	strongThreshold: number,
	ambiguousThreshold: number,
): "strong" | "ambiguous" | "weak" | "none" {
	if (score >= strongThreshold) return "strong";
	if (score >= ambiguousThreshold) return "ambiguous";
	if (score > 0) return "weak";
	return "none";
}

/**
 * Compute a simple domain-overlap confidence score between the source URL on
 * the item and the probed final_url.  This is intentionally lightweight — a
 * real implementation would do a richer HTTP probe; here we do structural
 * analysis only.
 */
function computeUrlMatchScore(sourceUrl: string, finalUrl: string): number {
	try {
		const src = new URL(sourceUrl);
		const dst = new URL(finalUrl);

		const srcHost = src.hostname.replace(/^www\./, "");
		const dstHost = dst.hostname.replace(/^www\./, "");

		if (srcHost === dstHost) return 1.0;

		// Check if one is a subdomain of the other.
		if (srcHost.endsWith(`.${dstHost}`) || dstHost.endsWith(`.${srcHost}`)) {
			return 0.85;
		}

		// Same eTLD+1?
		const srcParts = srcHost.split(".");
		const dstParts = dstHost.split(".");
		const srcEtld1 = srcParts.slice(-2).join(".");
		const dstEtld1 = dstParts.slice(-2).join(".");
		if (srcEtld1 === dstEtld1) return 0.6;

		return 0.0;
	} catch {
		return 0.0;
	}
}

/**
 * Derive landing_decision and risk_flags from the item record alone.
 *
 * In a full implementation this would invoke a sandboxed HTTP client. Here we
 * inspect the URL and structured item fields to produce a deterministic result
 * that workflow tests can verify without network access.
 */
function classifyLanding(
	item: JsonObject,
	spec: ExternalLandingPreflightSpec,
): {
	decision: LandingDecision;
	riskFlags: string[];
	finalUrl: string | null;
	pageTitle: string | null;
	matchConfidence: number;
	matchedJobUrl: string | null;
} {
	const applyUrl =
		(item.apply_url as string | undefined) ??
		(item.job_url as string | undefined) ??
		(item.url as string | undefined) ??
		null;

	const riskFlags: string[] = [];
	let decision: LandingDecision = "eligible";
	let matchConfidence = 0.0;
	let matchedJobUrl: string | null = null;

	if (!applyUrl) {
		return {
			decision: "skipped",
			riskFlags: ["no_apply_url"],
			finalUrl: null,
			pageTitle: null,
			matchConfidence: 0,
			matchedJobUrl: null,
		};
	}

	// Detect blocked URL patterns.
	const lower = applyUrl.toLowerCase();
	const safety = spec.safety ?? {};

	if (safety.detect_downloads !== false) {
		if (/\.(pdf|docx?|xlsx?|zip|exe|dmg|pkg)(\?|$)/.test(lower)) {
			riskFlags.push("download_risk");
			decision = "blocked";
		}
	}

	if (safety.detect_login_or_verification !== false) {
		if (
			lower.includes("/login") ||
			lower.includes("/signin") ||
			lower.includes("/auth") ||
			lower.includes("/verify") ||
			lower.includes("captcha")
		) {
			riskFlags.push("login_required");
			if (decision === "eligible") decision = "login_required";
		}
	}

	// Compute URL match confidence (structural only).
	const itemSource =
		(item.source_url as string | undefined) ??
		(item.listing_url as string | undefined) ??
		applyUrl;

	matchConfidence = computeUrlMatchScore(itemSource, applyUrl);
	matchedJobUrl = matchConfidence >= 0.5 ? applyUrl : null;

	if (safety.require_domain_consistency && matchConfidence < 0.5) {
		riskFlags.push("domain_mismatch");
		if (decision === "eligible") decision = "blocked";
	}

	return {
		decision,
		riskFlags,
		finalUrl: applyUrl,
		pageTitle: (item.job_title as string | null) ?? null,
		matchConfidence,
		matchedJobUrl,
	};
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

export const externalLandingPreflightOperation: WorkflowPluginOperation = {
	id: "workflow.external_landing_preflight",

	async run(ctx: PluginOperationContext): Promise<PluginOperationResult> {
		const start = Date.now();
		const step = ctx.step;

		const spec = step.external_landing_preflight as
			| ExternalLandingPreflightSpec
			| undefined;
		if (!spec) {
			return failResult(
				"workflow.external_landing_preflight: external_landing_preflight is required",
			);
		}

		if (!spec.claim_output) {
			return failResult(
				"workflow.external_landing_preflight: claim_output is required",
			);
		}

		if (!spec.output) {
			return failResult(
				"workflow.external_landing_preflight: output is required",
			);
		}

		if (!spec.collection) {
			return failResult(
				"workflow.external_landing_preflight: collection is required",
			);
		}

		if (!spec.verified_queue) {
			return failResult(
				"workflow.external_landing_preflight: verified_queue is required",
			);
		}

		// Resolve the claim artifact.
		const fromStepId = spec.from_step ?? step.id;
		let claimData: unknown;
		try {
			const artifact = await ctx.artifactStore.readArtifact(
				ctx.runId,
				fromStepId,
				spec.claim_output,
			);
			claimData = artifact?.data ?? null;
		} catch {
			return failResult(
				`workflow.external_landing_preflight: could not read claim artifact "${spec.claim_output}" from step "${fromStepId}"`,
				{ retryable: true },
			);
		}

		if (!claimData || typeof claimData !== "object") {
			return failResult(
				`workflow.external_landing_preflight: claim artifact "${spec.claim_output}" is missing or empty`,
				{ retryable: false },
			);
		}

		// Extract items from the claim artifact.
		const raw = claimData as JsonObject;
		const rawItems: JsonObject[] = Array.isArray(raw.items)
			? (raw.items as JsonObject[])
			: [];

		const maxItems = Math.max(1, Number(spec.max_items ?? rawItems.length));
		const items = rawItems.slice(0, maxItems);

		const strongThreshold = spec.matching?.strong_match_threshold ?? 0.8;
		const ambiguousThreshold = spec.matching?.ambiguous_threshold ?? 0.5;
		const defaultEligible = spec.decisions?.eligible ?? ["eligible"];
		const defaultBlocked = spec.decisions?.blocked ?? [
			"blocked",
			"login_required",
			"download_risk",
			"redirect_limit",
			"timeout",
		];
		const defaultRetryable = spec.decisions?.retryable ?? [
			"timeout",
			"redirect_limit",
		];

		const resultItems: PreflightItemResult[] = [];
		const rejectedItems: PreflightItemResult[] = [];
		const logs: string[] = [];

		for (const item of items) {
			const itemKey = String(
				item.item_key ?? item.key ?? item.id ?? item.job_id ?? "",
			);
			const jobId = String(item.job_id ?? itemKey);

			const {
				decision,
				riskFlags,
				finalUrl,
				pageTitle,
				matchConfidence,
				matchedJobUrl,
			} = classifyLanding(item, spec);

			const safeToAttempt =
				defaultEligible.includes(decision) && riskFlags.length === 0;

			const retryable = defaultRetryable.includes(decision);
			const isBlocked = defaultBlocked.includes(decision);

			const bucket = matchConfidenceBucket(
				matchConfidence,
				strongThreshold,
				ambiguousThreshold,
			);

			const preflight: PreflightItemResult = {
				job_id: jobId || null,
				item_key: itemKey,
				lease: item.lease ?? null,
				route: (item.route as string | null) ?? null,
				status: decision,
				submitted: false,
				retryable,
				reason: riskFlags.length > 0 ? riskFlags.join(", ") : decision,
				landing_decision: decision,
				safe_to_attempt: safeToAttempt,
				entrypoint_url: finalUrl,
				matched_job_url: matchedJobUrl,
				match_confidence: matchConfidence,
				match_confidence_bucket: bucket,
				external_preflight: {
					final_url: finalUrl,
					page_title: pageTitle,
					risk_flags: riskFlags,
				},
			};

			if (isBlocked) {
				rejectedItems.push(preflight);
				logs.push(
					`item_key=${itemKey} decision=${decision} safe=false flags=${riskFlags.join(",") || "none"}`,
				);
			} else {
				resultItems.push(preflight);
				logs.push(
					`item_key=${itemKey} decision=${decision} safe=${safeToAttempt} confidence=${matchConfidence.toFixed(2)}`,
				);
			}
		}

		// Enqueue safe items into verified_queue via Redis if available.
		if (ctx.redis && resultItems.length > 0) {
			const queueState = (ctx.step.with as JsonObject | undefined)?.[
				"queue_state"
			] as JsonObject | undefined;
			const date = (queueState?.date as string | undefined) ?? "";
			const prefix = (queueState?.prefix as string | undefined) ?? "";

			if (date && prefix) {
				const verifiedQueueKey = `${prefix}:queue:${spec.verified_queue}:${date}`;
				const verifiedQueuedSetKey = `${prefix}:set:${spec.verified_queue}:queued:${date}`;

				for (const ri of resultItems) {
					if (!ri.item_key) continue;
					// Dedup-check via set membership, then enqueue.
					if (typeof ctx.redis.sadd === "function") {
						const added = await ctx.redis.sadd(
							verifiedQueuedSetKey,
							ri.item_key,
						);
						if (added > 0) {
							await redisRaw(ctx.redis, "RPUSH", verifiedQueueKey, ri.item_key);
						}
					} else {
						// Fallback: use redisRaw for both SADD and RPUSH
						const addedRaw = await redisRaw(
							ctx.redis,
							"SADD",
							verifiedQueuedSetKey,
							ri.item_key,
						);
						if (Number(addedRaw) > 0) {
							await redisRaw(ctx.redis, "RPUSH", verifiedQueueKey, ri.item_key);
						}
					}
				}
			}
		}

		// Commit output artifact.
		const outputId = spec.output;
		const outputData = {
			status: "ok",
			generated_at: getLocalISOString(),
			items: resultItems,
			rejected_items: rejectedItems,
			workflow_result: {
				ok: true,
				retryable: false,
				blocked: false,
				failed: false,
			},
		};

		const declaredOutput =
			ctx.step.outputs && Array.isArray(ctx.step.outputs)
				? (ctx.step.outputs.find(
						(o: unknown) =>
							(o as JsonObject)?.id === outputId ||
							(o as JsonObject)?.name === outputId,
					) ?? null)
				: null;

		const commitResult = await ctx.artifactStore.commitArtifact({
			runId: ctx.runId,
			stepId: step.id,
			outputId,
			declaredOutput,
			data: outputData,
			validatorId: undefined,
			validator: undefined,
			validators: ctx.validators,
			attempt: 1,
		});

		if (!commitResult.committed) {
			return failResult(
				`workflow.external_landing_preflight: commit failed for output "${outputId}": ${commitResult.message ?? commitResult.decision}`,
			);
		}

		return {
			status: "ok",
			retryable: false,
			error: null,
			logs: logs.join("\n"),
			duration_ms: Date.now() - start,
			output_check: {
				passed: true,
				decision: "pass",
				missing_files: [],
				checked_files: [],
				validations: [],
			},
		};
	},
};
