/**
 * @module workflow-loader
 * @description Parses, validates, and normalizes workflow definition files.
 *
 * Supports both YAML (.yml, .yaml) and JSON (.json) formats. After parsing,
 * normalizes the definition to a canonical internal form (filling defaults,
 * validating required fields) so the executor can work with a consistent schema.
 *
 * Why support both YAML and JSON?
 *   - YAML is more ergonomic for humans writing workflow definitions (comments,
 *     multi-line strings for long task prompts, cleaner array syntax).
 *   - JSON is easier for programmatic generation (scripts, other tools).
 *   - Accepting both lowers the barrier to adoption.
 *
 * Validation philosophy: fail fast and loud. A misconfigured workflow that
 * runs partially is worse than one that is rejected upfront with a clear error.
 *
 * Dependencies: node:fs/promises, node:path, js-yaml
 *
 * @example
 * import { loadWorkflow, listWorkflows } from './workflow-loader.js';
 *
 * // Load a specific workflow by name
 * const wf = await loadWorkflow('seo-pipeline', '/home/user/.openclaw/workflows');
 *
 * // List all available workflows
 * const list = await listWorkflows('/home/user/.openclaw/workflows');
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import yaml from "js-yaml";
import { normalizeSealedSpec } from "./sealed-policy.js";
import { validateWorkflowTemplates } from "./template-schema-validator.js";
import {
	type ReuseOutputsSpec,
	WorkflowDefinition,
	WorkflowStep,
} from "./types.js";

/**
 * @typedef {import('./types.js').WorkflowStep} WorkflowStep
 */

/**
 * @typedef {import('./types.js').WorkflowDefinition} WorkflowDefinition
 */

/**
 * @typedef {Object} WorkflowListEntry
 * @property {string}      name          - Workflow file stem (used as ID)
 * @property {string}      filePath      - Absolute path to the definition file
 * @property {string|null} displayName   - `name` field from the workflow, if parseable
 * @property {string|null} description   - `description` field from the workflow, if parseable
 */

/**
 * Load and validate a workflow definition by name.
 * Searches for `{name}.yml`, `{name}.yaml`, and `{name}.json` in that order.
 *
 * @param {string} name         - Workflow file stem (e.g. 'seo-pipeline')
 * @param {string} workflowsDir - Directory to search in
 * @returns {Promise<WorkflowDefinition>} Validated and normalized workflow definition
 * @throws {Error} If the file is not found, cannot be parsed, or fails validation
 *
 * @example
 * const wf = await loadWorkflow('seo-pipeline', '/home/user/.openclaw/workflows');
 * console.log(wf.steps.length); // 3
 */
export async function loadWorkflow(name, workflowsDir) {
	const candidates = [
		join(workflowsDir, `${name}.yml`),
		join(workflowsDir, `${name}.yaml`),
		join(workflowsDir, `${name}.json`),
	];

	let raw = null;
	let filePath = null;
	for (const candidate of candidates) {
		try {
			raw = await readFile(candidate, "utf8");
			filePath = candidate;
			break;
		} catch {
			// File not found — try next extension
		}
	}

	if (raw === null) {
		throw new Error(
			`Workflow "${name}" not found. Searched:\n${candidates.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	const parsed = parseWorkflowFile(raw, filePath);
	return normalizeAndValidate(parsed, filePath);
}

/**
 * Load a workflow definition from a specific file path (any supported extension).
 *
 * @param {string} filePath - Absolute or relative path to the workflow file
 * @returns {Promise<WorkflowDefinition>} Validated and normalized workflow definition
 * @throws {Error} If the file cannot be read, parsed, or fails validation
 *
 * @example
 * const wf = await loadWorkflowFromFile('/tmp/test-workflow.yml');
 */
export async function loadWorkflowFromFile(filePath) {
	const raw = await readFile(filePath, "utf8");
	const parsed = parseWorkflowFile(raw, filePath);
	return normalizeAndValidate(parsed, filePath);
}

/**
 * Parse raw file content into a plain object based on file extension.
 *
 * @param {string} content  - Raw file text
 * @param {string} filePath - Path (used only to determine format)
 * @returns {Object} Parsed object
 * @throws {Error} If parsing fails
 */
function parseWorkflowFile(content, filePath) {
	const ext = extname(filePath).toLowerCase();

	if (ext === ".json") {
		try {
			return JSON.parse(content);
		} catch (e) {
			throw new Error(
				`Failed to parse JSON workflow at ${filePath}: ${e.message}`,
			);
		}
	}

	if (ext === ".yml" || ext === ".yaml") {
		try {
			const result = yaml.load(content);
			if (result === null || typeof result !== "object") {
				throw new Error("YAML file parsed to null or non-object");
			}
			return result;
		} catch (e) {
			throw new Error(
				`Failed to parse YAML workflow at ${filePath}: ${e.message}`,
			);
		}
	}

	throw new Error(
		`Unsupported workflow file format: "${ext}". Use .yml, .yaml, or .json`,
	);
}

/**
 * Validate a parsed workflow object and fill in defaults to produce a
 * normalized WorkflowDefinition. Throws descriptive errors on invalid input.
 *
 * Validation checks:
 *   1. Top-level required fields (name, steps array)
 *   2. Each step has a unique non-empty id and a task string
 *   3. depends_on references only IDs that exist in the workflow
 *   4. No circular dependencies (via cycle detection)
 *
 * @param {Object} raw      - Raw parsed workflow object
 * @param {string} filePath - Source file path (for error messages)
 * @returns {WorkflowDefinition} Normalized workflow definition
 * @throws {Error} With descriptive message on any validation failure
 */
function validateValidators(rawValidators = {}) {
	const validUnknownPolicies = new Set(["fail", "blocked", "pass"]);
	const validTypes = new Set(["json", "text"]);

	for (const [id, validatorRaw] of Object.entries(rawValidators)) {
		const validator = validatorRaw as any;
		if (!validator || typeof validator !== "object") {
			throw new Error(`Validator "${id}" must be an object`);
		}

		if (!validTypes.has(validator.type)) {
			throw new Error(
				`Validator "${id}" has invalid type "${validator.type}". ` +
					`Expected "json" or "text".`,
			);
		}

		if (
			validator.unknown_policy !== undefined &&
			!validUnknownPolicies.has(validator.unknown_policy)
		) {
			throw new Error(
				`Validator "${id}" has invalid unknown_policy ` +
					`"${validator.unknown_policy}". Expected fail, blocked, or pass.`,
			);
		}
	}
}

function normalizeAndValidate(raw, filePath) {
	// ── Top-level required fields ──────────────────────────────────────────────
	if (!raw.name || typeof raw.name !== "string") {
		throw new Error(
			`Workflow at ${filePath} is missing required field "name" (string)`,
		);
	}
	if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
		throw new Error(
			`Workflow "${raw.name}" at ${filePath} must have a non-empty "steps" array`,
		);
	}

	const validateSteps = (stepsList, parentName = raw.name, isInner = false) => {
		const validReuseDecisions = new Set([
			"pass",
			"blocked",
			"retry",
			"fail",
			"unknown",
		]);

		const validStepSignalingModes = new Set(["auto", "off"]);

		const validFreshnessIncludes = new Set([
			"output_contract_version",
			"step_task",
			"validators",
			"schemas",
			"selected_config",
			"input_signature",
		]);

		const normalizeReuseOutputs = (
			stepId,
			reuseRaw,
		): ReuseOutputsSpec | undefined => {
			if (reuseRaw === undefined || reuseRaw === null) return undefined;
			if (typeof reuseRaw !== "object") {
				throw new Error(
					`Step "${stepId}" has invalid reuse_outputs. Expected an object.`,
				);
			}

			const reuse = reuseRaw as any;
			if (reuse.enabled !== undefined && typeof reuse.enabled !== "boolean") {
				throw new Error(
					`Step "${stepId}" reuse_outputs.enabled must be boolean.`,
				);
			}
			if (reuse.when !== undefined && typeof reuse.when !== "string") {
				throw new Error(
					`Step "${stepId}" reuse_outputs.when must be a string expression.`,
				);
			}
			if (reuse.require !== undefined && reuse.require !== "declared_outputs") {
				throw new Error(
					`Step "${stepId}" reuse_outputs.require must be "declared_outputs" when provided.`,
				);
			}

			const acceptDecisions = Array.isArray(reuse.accept_decisions)
				? reuse.accept_decisions
				: undefined;

			if (acceptDecisions) {
				for (const decision of acceptDecisions) {
					if (!validReuseDecisions.has(decision)) {
						throw new Error(
							`Step "${stepId}" reuse_outputs.accept_decisions contains invalid decision "${decision}".`,
						);
					}
				}
			}

			if (
				reuse.on_invalid !== undefined &&
				reuse.on_invalid !== "run_step" &&
				reuse.on_invalid !== "fail_step"
			) {
				throw new Error(
					`Step "${stepId}" reuse_outputs.on_invalid must be "run_step" or "fail_step".`,
				);
			}

			if (reuse.on_hit !== undefined && typeof reuse.on_hit !== "object") {
				throw new Error(
					`Step "${stepId}" reuse_outputs.on_hit must be an object when provided.`,
				);
			}

			if (
				reuse.require_signature !== undefined &&
				typeof reuse.require_signature !== "boolean"
			) {
				throw new Error(
					`Step "${stepId}" reuse_outputs.require_signature must be boolean when provided.`,
				);
			}

			if (
				reuse.legacy_unsigned_cache !== undefined &&
				reuse.legacy_unsigned_cache !== "stale" &&
				reuse.legacy_unsigned_cache !== "allow_if_valid"
			) {
				throw new Error(
					`Step "${stepId}" reuse_outputs.legacy_unsigned_cache must be "stale" or "allow_if_valid".`,
				);
			}

			if (
				reuse.freshness !== undefined &&
				(typeof reuse.freshness !== "object" || reuse.freshness === null)
			) {
				throw new Error(
					`Step "${stepId}" reuse_outputs.freshness must be an object when provided.`,
				);
			}

			const include = Array.isArray(reuse.freshness?.include)
				? reuse.freshness.include
				: undefined;

			if (include) {
				for (const item of include) {
					if (!validFreshnessIncludes.has(item)) {
						throw new Error(
							`Step "${stepId}" reuse_outputs.freshness.include contains invalid token "${item}".`,
						);
					}
				}
			}

			return {
				enabled: reuse.enabled === true,
				when: reuse.when,
				require: reuse.require || "declared_outputs",
				require_signature: reuse.require_signature !== false,
				legacy_unsigned_cache: reuse.legacy_unsigned_cache || "stale",
				freshness: {
					include: include || [
						"output_contract_version",
						"step_task",
						"validators",
						"schemas",
						"selected_config",
						"input_signature",
					],
				},
				accept_decisions: acceptDecisions,
				on_hit: reuse.on_hit,
				on_invalid: reuse.on_invalid || "run_step",
			};
		};

		const seenIds = new Set();
		return stepsList.map((step, index) => {
			if (
				!step.id ||
				typeof step.id !== "string" ||
				!/^[a-zA-Z0-9_-]+$/.test(step.id)
			) {
				throw new Error(
					`Step at index ${index} in ${isInner ? "loop" : "workflow"} "${parentName}" has invalid or missing "id". ` +
						`IDs must be non-empty strings containing only letters, numbers, hyphens, and underscores.`,
				);
			}
			if (seenIds.has(step.id)) {
				throw new Error(
					`Duplicate step ID "${step.id}" in ${isInner ? "loop" : "workflow"} "${parentName}"`,
				);
			}
			seenIds.add(step.id);

			// Validate kind
			const validKinds = new Set([
				"subagent",
				"loop_subagent",
				"plugin",
				"state_drain",
				"sealed",
			]);
			const stepKind =
				step.kind ||
				(step.for_each
					? "loop_subagent"
					: step.drain
						? "state_drain"
						: "subagent");
			if (step.kind !== undefined && !validKinds.has(step.kind)) {
				throw new Error(
					`Step "${step.id}" in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
						`has invalid kind "${step.kind}". Expected: subagent, loop_subagent, plugin, state_drain, sealed.`,
				);
			}

			if (stepKind === "plugin") {
				if (!step.uses || typeof step.uses !== "string") {
					throw new Error(
						`Step "${step.id}" (kind: plugin) in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
							`is missing required field "uses" (e.g. "workflow.cache_json_document").`,
					);
				}
				if (step.for_each) {
					throw new Error(
						`Step "${step.id}" (kind: plugin) in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
							`cannot use "for_each". Loop expansion is only supported for subagent steps.`,
					);
				}
			} else if (stepKind === "state_drain") {
				const drain = step.drain;
				if (!drain || typeof drain !== "object") {
					throw new Error(
						`Step "${step.id}" (kind: state_drain) in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
							`must define "drain" as an object.`,
					);
				}
				if (
					typeof drain.worker_group !== "string" ||
					drain.worker_group.trim().length === 0
				) {
					throw new Error(
						`Step "${step.id}" (kind: state_drain) in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
							`must define drain.worker_group as a non-empty string.`,
					);
				}
				if (
					drain.max_empty_claims !== undefined &&
					(!Number.isInteger(drain.max_empty_claims) ||
						drain.max_empty_claims < 1)
				) {
					throw new Error(
						`Step "${step.id}" (kind: state_drain) in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
							`has invalid drain.max_empty_claims. Expected integer >= 1.`,
					);
				}
				if (
					drain.max_iterations !== undefined &&
					drain.max_iterations !== null &&
					(!Number.isInteger(drain.max_iterations) || drain.max_iterations < 1)
				) {
					throw new Error(
						`Step "${step.id}" (kind: state_drain) in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
							`has invalid drain.max_iterations. Expected integer >= 1 or null.`,
					);
				}
				if (!Array.isArray(step.steps) || step.steps.length === 0) {
					throw new Error(
						`Step "${step.id}" (kind: state_drain) in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
							`must define a non-empty nested "steps" array.`,
					);
				}
			} else if (stepKind === "sealed") {
				if (!step.sealed || typeof step.sealed !== "object") {
					throw new Error(
						`Step "${step.id}" kind: sealed must define sealed: { ... }`,
					);
				}

				const mode = step.sealed.mode || "tool_worker";

				if (mode === "command") {
					const command = step.sealed.command;
					if (!command) {
						throw new Error(
							`Sealed command step "${step.id}" must define sealed.command`,
						);
					}
				}

				if (
					mode !== "command" &&
					(!step.task || typeof step.task !== "string")
				) {
					throw new Error(`Sealed worker step "${step.id}" must define task`);
				}
			} else if (!step.task || typeof step.task !== "string") {
				if (!step.for_each) {
					throw new Error(
						`Step "${step.id}" in ${isInner ? "loop" : "workflow"} "${parentName}" is missing required field "task" (string)`,
					);
				}
			}

			// Recursively validate inner steps for loop steps
			let normalizedInnerSteps = Array.isArray(step.steps) ? step.steps : [];
			if (step.for_each) {
				const hasTask =
					typeof step.task === "string" && step.task.trim().length > 0;
				const hasSteps = Array.isArray(step.steps) && step.steps.length > 0;
				if (!hasTask && !hasSteps) {
					throw new Error(
						`Loop step "${step.id}" in workflow "${parentName}" must have either a "task" or a non-empty "steps" array`,
					);
				}
				if (hasSteps) {
					normalizedInnerSteps = validateSteps(step.steps, step.id, true);
				}
			}

			const validCompleteWhen = new Set([
				"session",
				"outputs",
				"session_then_outputs",
				"handoff",
				"handoff_or_outputs",
			]);
			const completeWhen = step.complete_when || "session";
			if (!validCompleteWhen.has(completeWhen)) {
				throw new Error(
					`Step "${step.id}" in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
						`has invalid complete_when "${completeWhen}". ` +
						`Expected one of: ${[...validCompleteWhen].join(", ")}.`,
				);
			}

			let signalingMode = step.signaling;
			if (
				signalingMode === undefined ||
				signalingMode === null ||
				signalingMode === ""
			) {
				signalingMode =
					completeWhen === "handoff" || completeWhen === "handoff_or_outputs"
						? "auto"
						: "off";
			}

			if (!validStepSignalingModes.has(signalingMode)) {
				throw new Error(
					`Step "${step.id}" in ${isInner ? "loop" : "workflow"} "${parentName}" ` +
						`has invalid signaling "${signalingMode}". Expected one of: ${[
							...validStepSignalingModes,
						].join(", ")}.`,
				);
			}

			const normalizeOutputs = (stepId, outputsRaw) => {
				if (!Array.isArray(outputsRaw)) return [];

				return outputsRaw.map((out, outIndex) => {
					if (typeof out === "string") {
						return out;
					}

					if (!out || typeof out !== "object") {
						throw new Error(
							`Step "${stepId}" output at index ${outIndex} must be a string or object.`,
						);
					}

					const hasPath =
						typeof out.path === "string" && out.path.trim().length > 0;
					const hasId = typeof out.id === "string" && out.id.trim().length > 0;
					if (!hasPath && !hasId) {
						throw new Error(
							`Step "${stepId}" output at index ${outIndex} must declare at least one of: path or id.`,
						);
					}

					return {
						id: hasId ? out.id : undefined,
						path: hasPath ? out.path : undefined,
						validate:
							typeof out.validate === "string" ? out.validate : undefined,
						optional: out.optional === true,
						materialize:
							out.materialize && typeof out.materialize === "object"
								? {
										path:
											typeof out.materialize.path === "string"
												? out.materialize.path
												: undefined,
										mode:
											typeof out.materialize.mode === "string"
												? out.materialize.mode
												: undefined,
									}
								: undefined,
					};
				});
			};

			// Normalize with defaults
			return {
				id: step.id,
				name: step.name || step.id,
				kind: (step.kind ||
					(step.for_each
						? "loop_subagent"
						: step.drain
							? "state_drain"
							: "subagent")) as
					| "subagent"
					| "loop_subagent"
					| "plugin"
					| "state_drain"
					| "sealed",
				uses: typeof step.uses === "string" ? step.uses : undefined,
				with:
					step.with &&
					typeof step.with === "object" &&
					!Array.isArray(step.with)
						? (step.with as Record<string, unknown>)
						: undefined,
				task: step.task || null,
				depends_on: Array.isArray(step.depends_on) ? step.depends_on : [],
				outputs: normalizeOutputs(step.id, step.outputs),
				for_each: step.for_each || null,
				skip_if_empty: step.skip_if_empty || null,
				parser: step.parser || "auto",
				item_schema: step.item_schema || null,
				steps: normalizedInnerSteps,
				model: step.model || null,
				concurrency:
					typeof step.concurrency === "number"
						? Math.max(1, step.concurrency)
						: null,
				timeout: typeof step.timeout === "number" ? step.timeout : 300,
				retry: typeof step.retry === "number" ? Math.max(0, step.retry) : 0,
				retry_delay:
					typeof step.retry_delay === "number" ? step.retry_delay : 30,
				retry_on: Array.isArray(step.retry_on) ? step.retry_on : [],
				retry_except: Array.isArray(step.retry_except) ? step.retry_except : [],
				optional: step.optional === true,
				output_contract_version:
					typeof step.output_contract_version === "number"
						? step.output_contract_version
						: null,

				always_run: step.always_run === true,
				on_block: step.on_block || "block_run",
				reuse_outputs: normalizeReuseOutputs(step.id, step.reuse_outputs),
				required_skills: Array.isArray(step.required_skills)
					? step.required_skills
					: [],
				required_mcp_servers: Array.isArray(step.required_mcp_servers)
					? step.required_mcp_servers
					: [],
				state_contract: Array.isArray(step.state_contract)
					? step.state_contract
					: typeof step.state_contract === "string"
						? step.state_contract
						: undefined,
				state_publish: Array.isArray(step.state_publish)
					? step.state_publish
					: step.state_publish && typeof step.state_publish === "object"
						? step.state_publish
						: undefined,
				state_consume:
					step.state_consume && typeof step.state_consume === "object"
						? step.state_consume
						: undefined,
				state_reclaim:
					step.state_reclaim && typeof step.state_reclaim === "object"
						? step.state_reclaim
						: undefined,
				state_complete: Array.isArray(step.state_complete)
					? step.state_complete
					: step.state_complete && typeof step.state_complete === "object"
						? step.state_complete
						: undefined,
				sealed:
					step.sealed && typeof step.sealed === "object"
						? normalizeSealedSpec(step.sealed)
						: step.kind === "sealed"
							? normalizeSealedSpec({})
							: undefined,
				drain:
					step.drain && typeof step.drain === "object"
						? {
								worker_group: String(step.drain.worker_group || ""),
								max_empty_claims:
									typeof step.drain.max_empty_claims === "number"
										? step.drain.max_empty_claims
										: undefined,
								max_iterations:
									step.drain.max_iterations === null
										? null
										: typeof step.drain.max_iterations === "number"
											? step.drain.max_iterations
											: undefined,
							}
						: undefined,
				complete_when: completeWhen,
				signaling: signalingMode,
			};
		});
	};

	const steps = validateSteps(raw.steps);
	const seenIds = new Set(steps.map((s) => s.id));

	validateValidators(raw.validators || {});

	// ── Validate dependency references ─────────────────────────────────────────

	for (const step of steps) {
		for (const depId of step.depends_on) {
			if (!seenIds.has(depId)) {
				throw new Error(
					`Step "${step.id}" in workflow "${raw.name}" depends on unknown step ID "${depId}". ` +
						`Available IDs: ${[...seenIds].join(", ")}`,
				);
			}
		}
	}

	// ── Cycle detection via DFS ─────────────────────────────────────────────────
	// Build adjacency map: stepId → [stepIds it depends on]
	const depMap = new Map(steps.map((s) => [s.id, s.depends_on]));
	detectCycles(depMap, raw.name);

	// ── Validate orchestration-critical outputs ──────────────────────────────────

	const criticalOutputs = new Set();
	for (const step of steps) {
		if (step.for_each) criticalOutputs.add(step.for_each);
		if (step.skip_if_empty) criticalOutputs.add(step.skip_if_empty);
	}

	for (const criticalPath of criticalOutputs) {
		for (const step of steps) {
			for (const output of step.outputs) {
				const path = typeof output === "string" ? output : output.path;
				// Simple match: check if critical path is exactly the output path
				// or if the output path is a pattern that matches (ignoring placeholders)
				if (path === criticalPath) {
					if (typeof output === "object" && output.optional) {
						throw new Error(
							`Orchestration-critical output "${criticalPath}" in step "${step.id}" cannot be optional ` +
								`because it is used for flow control (for_each or skip_if_empty).`,
						);
					}
				}
			}
		}
	}

	// ── Normalize top-level fields ─────────────────────────────────────────────
	const normalizedWorkflow = {
		name: raw.name.trim(),
		version: raw.version ? String(raw.version) : "1.0",
		description: raw.description || "",
		config: raw.config || {},
		state:
			raw.state && typeof raw.state === "object"
				? {
						backend: raw.state.backend || "filesystem",
						key: raw.state.key,
						fallback: raw.state.fallback || "filesystem",
						ttl: raw.state.ttl,
						materialize_outputs: raw.state.materialize_outputs || "on_demand",
						redis:
							raw.state.redis && typeof raw.state.redis === "object"
								? {
										provider: (raw.state.redis.provider === "native"
											? "native"
											: raw.state.redis.provider === "mcp"
												? "mcp"
												: "auto") as "auto" | "native" | "mcp",
										tool_prefix: raw.state.redis.tool_prefix || undefined,
									}
								: undefined,
						contracts:
							raw.state.contracts && typeof raw.state.contracts === "object"
								? raw.state.contracts
								: undefined,
						collections:
							raw.state.collections && typeof raw.state.collections === "object"
								? raw.state.collections
								: undefined,
						queues:
							raw.state.queues && typeof raw.state.queues === "object"
								? raw.state.queues
								: undefined,
						worker_groups:
							raw.state.worker_groups &&
							typeof raw.state.worker_groups === "object"
								? raw.state.worker_groups
								: undefined,
					}
				: undefined,
		validators: raw.validators || {},
		required_skills: Array.isArray(raw.required_skills)
			? raw.required_skills
			: [],
		required_mcp_servers: Array.isArray(raw.required_mcp_servers)
			? raw.required_mcp_servers
			: [],
		steps,

		concurrency:
			typeof raw.concurrency === "number" ? Math.max(1, raw.concurrency) : 3,
		__dir: dirname(filePath),
	};

	validateWorkflowTemplates(normalizedWorkflow);

	return normalizedWorkflow;
}

/**
 * Detect circular dependencies in a dependency map using iterative DFS.
 * Throws an error with the cycle path if one is found.
 *
 * @param {Map<string, string[]>} depMap    - Map of step ID → dependency IDs
 * @param {string}                wfName   - Workflow name (for error messages)
 * @throws {Error} If a cycle is detected, with the cycle path in the message
 *
 * @example
 * // Detects: A → B → A
 * detectCycles(new Map([['A', ['B']], ['B', ['A']]]), 'my-workflow');
 * // throws Error: Circular dependency detected in workflow "my-workflow": A → B → A
 */
function detectCycles(depMap, wfName) {
	// Three-color DFS: white (unvisited), grey (in-stack), black (done)
	const WHITE = 0,
		GREY = 1,
		BLACK = 2;
	const color = new Map([...depMap.keys()].map((id) => [id, WHITE]));
	const parent = new Map();

	for (const startId of depMap.keys()) {
		if (color.get(startId) !== WHITE) continue;

		// Iterative DFS using an explicit stack of [nodeId, iteratorIndex] pairs
		const stack = [[startId, 0]];
		color.set(startId, GREY);

		while (stack.length > 0) {
			const [nodeId, childIndex] = stack[stack.length - 1];
			const deps = depMap.get(nodeId) || [];

			if (childIndex >= deps.length) {
				// All children processed — mark black and pop
				color.set(nodeId, BLACK);
				stack.pop();
				continue;
			}

			// Advance child pointer for this node on next visit
			stack[stack.length - 1][1]++;

			const childId = deps[childIndex];
			if (color.get(childId) === GREY) {
				// Found a back-edge — reconstruct cycle path
				const cycleNodes = [];
				for (let i = stack.length - 1; i >= 0; i--) {
					cycleNodes.unshift(stack[i][0]);
					if (stack[i][0] === childId) break;
				}
				cycleNodes.push(childId);
				throw new Error(
					`Circular dependency detected in workflow "${wfName}": ${cycleNodes.join(" → ")}`,
				);
			}

			if (color.get(childId) === WHITE) {
				color.set(childId, GREY);
				parent.set(childId, nodeId);
				stack.push([childId, 0]);
			}
		}
	}
}

/**
 * List all available workflow definition files in a directory.
 * Returns lightweight metadata without fully parsing each file,
 * so this is fast even with many workflows.
 *
 * @param {string} workflowsDir - Directory to scan
 * @returns {Promise<WorkflowListEntry[]>} List of workflow entries, sorted by name
 *
 * @example
 * const workflows = await listWorkflows('/home/user/.openclaw/workflows');
 * // [{ name: 'deploy-pipeline', filePath: '...', displayName: 'Deploy Pipeline', description: '...' }]
 */
export async function listWorkflows(workflowsDir) {
	try {
		await mkdir(workflowsDir, { recursive: true });
		const entries = await readdir(workflowsDir);
		const workflows = [];

		for (const entry of entries) {
			const ext = extname(entry).toLowerCase();
			if (![".yml", ".yaml", ".json"].includes(ext)) continue;

			const filePath = join(workflowsDir, entry);
			const name = basename(entry, ext);

			// Try to read display name and description without full validation
			let displayName = null;
			let description = null;
			try {
				const raw = await readFile(filePath, "utf8");
				const parsed = parseWorkflowFile(raw, filePath);
				displayName = parsed.name || null;
				description = parsed.description || null;
			} catch {
				// If parsing fails, still include the entry with null metadata
			}

			workflows.push({ name, filePath, displayName, description });
		}

		workflows.sort((a, b) => a.name.localeCompare(b.name));
		return workflows;
	} catch {
		return [];
	}
}
