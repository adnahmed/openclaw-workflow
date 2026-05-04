import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/**
 * @module variable-substitution
 * @description Performs template variable substitution on workflow task prompts,
 * output file paths, and any other string fields in a workflow definition.
 *
 * Supported variables:
 *   {date}          → Current date in YYYY-MM-DD format (Workflow timezone)
 *   {datetime}      → Current datetime as ISO-ish string (Workflow timezone)
 *   {utc_date}      → Current date in YYYY-MM-DD format (UTC)
 *   {utc_datetime}  → Current datetime as full ISO 8601 string (UTC)
 *   {run_id}        → The unique run identifier for this workflow execution
 *   {config.X}      → Value of variable X from the workflow's config block
 *   {env.X}         → Value of environment variable X
 *
 * Escaping:
 *   Use `\{variable}` to write the literal text of a variable without substituting it.
 *   Example: `\{config.redis_prefix}` renders as `{config.redis_prefix}`.
 *
 * Why UTC? Workflows often run on servers without a specific timezone configuration.
 * Using UTC ensures consistent, reproducible filenames and logs regardless of the
 * server's locale. If local time is needed, that's a future extension point.
 *
 * Dependencies: none (pure Node.js)
 *
 * @example
 * import { substituteVars, buildContext } from './variable-substitution.js';
 * const ctx = buildContext('my-pipeline-20260309T082000');
 * const path = substituteVars('data/output-{date}.json', ctx);
 * // → 'data/output-2026-03-09.json'
 */

/**
 * @typedef {Object} SubstitutionContext
 * @property {string} date          - Current date as YYYY-MM-DD (Workflow timezone)
 * @property {string} datetime      - Current datetime as ISO-ish string (Workflow timezone)
 * @property {string} utc_date      - Current date as YYYY-MM-DD (UTC)
 * @property {string} utc_datetime  - Current datetime as ISO 8601 string (UTC)
 * @property {string} run_id        - The workflow run identifier
 * @property {Object} [config]      - Workflow-specific configuration variables
 * @property {Object} [env]         - Process environment variables
 * @property {Object.<string, any>} [vars] - Additional workflow variables
 */

/**
 * Build a substitution context object for a given run.
 * Snapshot the current time once so all substitutions within a run are consistent.
 *
 * @param {string} runId - The workflow run ID
 * @param {Object} [workflowConfig={}] - Configuration block from the workflow definition
 * @param {Date} [now=new Date()] - Optional fixed timestamp (useful for testing)
 * @param {string} [timezone='UTC'] - Workflow timezone (e.g. 'Asia/Karachi')
 * @returns {SubstitutionContext}
 */
export function buildContext(
	runId,
	workflowConfig = {},
	now = new Date(),
	timezone = "UTC",
	runsDir = null,
	workflowName = null,
) {
	const utcIsoString = now.toISOString();
	const utcDate = utcIsoString.slice(0, 10);

	const tzDate = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);

	const tzFormatter = new Intl.DateTimeFormat("sv-SE", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const tzDatetime = tzFormatter.format(now).replace(" ", "T");

	return {
		date: tzDate,
		datetime: tzDatetime,
		utc_date: utcDate,
		utc_datetime: utcIsoString,
		run_id: runId,
		config: workflowConfig,
		env: {
			...process.env,
			HOME: process.env.HOME || process.env.USERPROFILE || homedir(),
			USERPROFILE: process.env.USERPROFILE || process.env.HOME || homedir(),
		},
		run_state_path: runsDir ? path.join(runsDir, `${runId}.json`) : null,
		workflow_name: workflowName,
		workflow_run_id: runId,
	};
}

export class TemplateSubstitutionError extends Error {
	constructor(
		public token: string,
		public value: unknown,
		public hint?: string,
	) {
		super(
			`Invalid template token ${token}: resolved to ${Object.prototype.toString.call(value)}. ` +
				(hint || "Use a scalar path such as {item.alert_key}."),
		);

		this.name = "TemplateSubstitutionError";
	}
}

const ANY_BRACED_TOKEN_RE = /(?<!\\)\{([\w.]+)\}/g;

// Only these are engine tokens:
// {date}, {datetime}, {run_id}, {config.X}, {config.X.Y}, {env.X}, {item}, {item.X}, {item.X.Y}
const ENGINE_TOKEN_RE =
	/(?<!\\)\{(date|datetime|utc_date|utc_datetime|run_id|config(?:\.[A-Za-z_]\w*)+|env(?:\.[A-Za-z_]\w*)+|item(?:\.[A-Za-z_]\w*)*)\}/g;

type UnknownTokenMode = "preserve" | "throw";

type SubstituteOptions = {
	unknown?: UnknownTokenMode;
};

function hasOwn(obj: object, key: string): boolean {
	return Object.hasOwn(obj, key);
}

function isScalar(value: unknown): value is string | number | boolean {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function resolvePath(
	ctx: unknown,
	path: string,
): { found: true; value: unknown } | { found: false } {
	let current: unknown = ctx;

	for (const part of path.split(".")) {
		if (
			current !== null &&
			typeof current === "object" &&
			hasOwn(current, part)
		) {
			current = (current as Record<string, unknown>)[part];
		} else {
			return { found: false };
		}
	}

	return { found: true, value: current };
}

function isDeferredItemToken(path: string, ctx: unknown): boolean {
	return (
		(path === "item" || path.startsWith("item.")) &&
		!(ctx !== null && typeof ctx === "object" && hasOwn(ctx, "item"))
	);
}

export function substituteVars(
	template: unknown,
	ctx: Record<string, unknown>,
	options: SubstituteOptions = {},
): unknown {
	if (typeof template !== "string") return template;

	const unknownMode = options.unknown ?? "preserve";
	const tokenRe =
		unknownMode === "throw" ? ANY_BRACED_TOKEN_RE : ENGINE_TOKEN_RE;

	const rendered = template.replace(tokenRe, (match, path) => {
		const resolved = resolvePath(ctx, path);

		if (!resolved.found) {
			// Allows top-level compilation to leave {item.X} alone until loop expansion.
			if (isDeferredItemToken(path, ctx)) return match;

			throw new TemplateSubstitutionError(
				match,
				undefined,
				`Unknown token path: ${path}`,
			);
		}

		if (!isScalar(resolved.value)) {
			throw new TemplateSubstitutionError(
				match,
				resolved.value,
				`Token "${match}" is not scalar. Use a scalar path such as "{${path}.alert_key}".`,
			);
		}

		return String(resolved.value);
	});

	return rendered.replace(/\\\{/g, "{").replace(/\\\}/g, "}");
}

export function substituteDeep(
	value: unknown,
	ctx: Record<string, unknown>,
	options: SubstituteOptions = {},
): unknown {
	if (typeof value === "string") return substituteVars(value, ctx, options);

	if (Array.isArray(value)) {
		return value.map((item) => substituteDeep(item, ctx, options));
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			result[k] = substituteDeep(v, ctx, options);
		}
		return result;
	}

	return value;
}

const BAD_PATH_FRAGMENTS = ["[object Object]", "undefined", "null", "NaN"];

export function outputPathOf(output: any) {
	if (typeof output === "string") return output;
	return typeof output?.path === "string" ? output.path : "";
}

export function outputIdOf(output: any): string {
	if (typeof output?.id === "string" && output.id.trim().length > 0) {
		return output.id.trim();
	}

	const p = typeof output === "string" ? output : output?.path;
	if (typeof p === "string" && p.trim().length > 0) {
		return `path_${createHash("sha256")
			.update(p.trim())
			.digest("hex")
			.slice(0, 16)}`;
	}

	return "";
}

export function assertSafeOutputPath(outputPath: string) {
	for (const bad of BAD_PATH_FRAGMENTS) {
		if (outputPath.includes(bad)) {
			throw new Error(`Unsafe output path "${outputPath}" contains "${bad}"`);
		}
	}

	if (outputPath.includes("..")) {
		throw new Error(
			`Unsafe output path "${outputPath}" contains path traversal`,
		);
	}

	if (/[<>:"|?*]/.test(outputPath)) {
		throw new Error(
			`Unsafe output path "${outputPath}" contains forbidden filename characters`,
		);
	}
}
