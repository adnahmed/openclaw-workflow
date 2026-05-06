import assert from "node:assert/strict";
import { test } from "node:test";

import {
	isRelevantPiExtensionsFile,
	patchPiExtensionsFile,
	patchRuntimeFile,
} from "../scripts/patch-openclaw-trust-workflow-middleware.mjs";

test("patchRuntimeFile narrows middleware trust guard for configured plugin", () => {
	const source = `
const registerAgentToolResultMiddleware = (record, middleware) => {
                if (record.origin !== "bundled") {
                  throw new Error("only bundled plugins can register agent tool result middleware");
                }
};
`;

	const patched = patchRuntimeFile(source, "openclaw-workflow");

	assert.match(
		patched,
		/openclaw-workflow trusted external agentToolResultMiddleware patch/,
	);
	assert.match(
		patched,
		/record\.origin !== "bundled" && record\.id !== "openclaw-workflow"/,
	);
});

test("patchPiExtensionsFile injects sessionManager middleware context and tracing", () => {
	const source =
		`
function buildAgentToolResultMiddlewareFactory(): ExtensionFactory {
  const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" });

  return (pi) => {
    pi.on("tool_result", async (rawEvent: unknown, ctx: { cwd?: string }) => {
      const event = recordFromUnknown(rawEvent) as PiToolResultEvent;

      if (!event.toolName) {
        return undefined;
      }

      const toolCallId =
        typeof event.toolCallId === "string" && event.toolCallId.trim()
          ? event.toolCallId
          : ` +
		"`pi-${randomUUID()}`" +
		`;

      const content = Array.isArray(event.content) ? event.content : [];

      const current = {
        content,
        details: event.details,
      } satisfies AgentToolResult;

      const result = await runner.applyToolResultMiddleware({
        threadId: event.threadId,
        turnId: event.turnId,
        toolCallId,
        toolName: event.toolName,
        args: recordFromUnknown(event.input),
        cwd: ctx.cwd,
        isError: event.isError,
        result: current,
      });

      return {
        content: result.content,
        details: result.details,
      };
    });
  };
}

factories.push(buildAgentToolResultMiddlewareFactory());
`;

	assert.equal(
		isRelevantPiExtensionsFile(
			"C:/repo/src/agents/pi-embedded-runner/extensions.ts",
			source,
		),
		true,
	);

	const patched = patchPiExtensionsFile(source);

	assert.match(patched, /openclaw-workflow pi middleware context patch/);
	assert.match(patched, /sessionManager: SessionManager;/);
	assert.match(patched, /const middlewareCtx = \{/);
	assert.match(
		patched,
		/const runner = createAgentToolResultMiddlewareRunner\(middlewareCtx\);/,
	);
	assert.match(
		patched,
		/\[openclaw-trace\] pi\.tool_result\.middleware_context/,
	);
	assert.ok(
		patched.indexOf("const toolCallId") <
			patched.indexOf("[openclaw-trace] pi.tool_result.middleware_context"),
		"trace log should appear after toolCallId is defined",
	);
	assert.ok(
		patched.indexOf("[openclaw-trace] pi.tool_result.middleware_context") <
			patched.indexOf(
				"const result = await runner.applyToolResultMiddleware({",
			),
		"trace log should appear immediately before applyToolResultMiddleware",
	);
	assert.match(patched, /sessionManager: params\.sessionManager,/);
});
