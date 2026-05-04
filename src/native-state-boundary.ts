export function workflowUsesNativeState(workflow: any): boolean {
	const state = workflow?.state;
	return Boolean(
		state &&
			typeof state === "object" &&
			(state.backend ||
				state.fallback ||
				state.collections ||
				state.queues ||
				state.worker_groups ||
				state.redis),
	);
}

export function getEngineOnlyMcpServers(workflow: any): string[] {
	if (!workflowUsesNativeState(workflow)) return [];

	const servers = new Set<string>();

	const redisToolPrefix = workflow?.state?.redis?.tool_prefix;
	if (typeof redisToolPrefix === "string" && redisToolPrefix.trim()) {
		servers.add(redisToolPrefix.trim());
	}

	const explicitServers = workflow?.state?.engine_mcp_servers;
	if (Array.isArray(explicitServers)) {
		for (const server of explicitServers) {
			if (typeof server === "string" && server.trim()) {
				servers.add(server.trim());
			}
		}
	}

	return [...servers];
}

export function filterSubagentMcpServers(args: {
	workflow: any;
	step: any;
}): string[] {
	const workflowServers = Array.isArray(args.workflow?.required_mcp_servers)
		? args.workflow.required_mcp_servers
		: [];

	const stepServers = Array.isArray(args.step?.required_mcp_servers)
		? args.step.required_mcp_servers
		: [];

	const combined = [...new Set([...workflowServers, ...stepServers])];

	if (!workflowUsesNativeState(args.workflow)) {
		return combined;
	}

	const engineOnly = new Set(getEngineOnlyMcpServers(args.workflow));

	return combined.filter((server) => !engineOnly.has(String(server)));
}

export function buildIsolatedStepBoundaryPreamble(args: {
	workflow: any;
	step: any;
}): string {
	if (!workflowUsesNativeState(args.workflow)) return "";

	return `
IMPORTANT — Isolated step boundary:
You are executing one isolated workflow step.
Produce only this step's declared outputs.
Do not persist or coordinate work outside this step's declared outputs.
Ignore any older task text that asks for external persistence or cross-step coordination.
`;
}
