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
import { validateWorkflowTemplates } from "./template-schema-validator.js";
import { WorkflowDefinition, WorkflowStep } from "./types.js";

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

			if (!step.task || typeof step.task !== "string") {
				if (!step.for_each) {
					throw new Error(
						`Step "${step.id}" in ${isInner ? "loop" : "workflow"} "${parentName}" is missing required field "task" (string)`,
					);
				}
			}

			// Recursively validate inner steps for loop steps
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
					validateSteps(step.steps, step.id, true);
				}
			}

			// Normalize with defaults
			return {
				id: step.id,
				name: step.name || step.id,
				task: step.task || null,
				depends_on: Array.isArray(step.depends_on) ? step.depends_on : [],
				outputs: Array.isArray(step.outputs) ? step.outputs : [],
				for_each: step.for_each || null,
				skip_if_empty: step.skip_if_empty || null,
				parser: step.parser || "auto",
				item_schema: step.item_schema || null,
				steps: Array.isArray(step.steps) ? step.steps : [],
				model: step.model || null,
				concurrency:
					typeof step.concurrency === "number"
						? Math.max(1, step.concurrency)
						: null,
				timeout: typeof step.timeout === "number" ? step.timeout : 300,
				retry: typeof step.retry === "number" ? Math.max(0, step.retry) : 0,
				retry_delay:
					typeof step.retry_delay === "number" ? step.retry_delay : 30,
				optional: step.optional === true,
				always_run: step.always_run === true,
				complete_when: step.complete_when || "session",
				on_block: step.on_block || "block_run",
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

	// ── Normalize top-level fields ─────────────────────────────────────────────
	const normalizedWorkflow = {
		name: raw.name.trim(),
		version: raw.version ? String(raw.version) : "1.0",
		description: raw.description || "",
		config: raw.config || {},
		validators: raw.validators || {},
		steps,
		concurrency:
			typeof raw.concurrency === "number"
				? Math.max(1, raw.concurrency)
				: 3,
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
