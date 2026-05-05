import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { compileAuthoringWorkflow } from "./authoring-compiler.js";
import type { AuthoringWorkflow } from "./authoring-types.js";

export function isAuthoringWorkflow(raw: unknown): boolean {
	if (!raw || typeof raw !== "object") return false;
	const value = raw as Record<string, unknown>;
	return value.schema === "authoring" || value.format === "authoring";
}

export async function loadAuthoringWorkflowFromFile(filePath: string) {
	const raw = await readFile(filePath, "utf8");
	const parsed = parseAuthoringWorkflowFile(raw, filePath);

	return compileAuthoringWorkflow(parsed, {
		workflowDir: dirname(filePath),
		strict: true,
	});
}

export function parseAuthoringWorkflowFile(
	content: string,
	filePath: string,
): AuthoringWorkflow {
	const parsed = yaml.load(content);

	if (!parsed || typeof parsed !== "object") {
		throw new Error(
			`Authoring workflow at ${filePath} must parse to an object`,
		);
	}

	if (!isAuthoringWorkflow(parsed)) {
		throw new Error(
			`Authoring workflow at ${filePath} must set schema: authoring`,
		);
	}

	return parsed as AuthoringWorkflow;
}
