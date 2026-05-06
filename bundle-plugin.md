make openclaw-workflow a bundled plugin in an OpenClaw source checkout
1. Clone OpenClaw and put your plugin under extensions/
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install

# Put your workflow plugin inside the bundled plugin workspace tree.
# Use copy or symlink. Symlink is nicer while developing.
mkdir -p extensions
ln -s /c/Users/Adnan/openclaw-workflow extensions/openclaw-workflow

On Windows PowerShell:

git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install

New-Item -ItemType SymbolicLink `
  -Path .\extensions\openclaw-workflow `
  -Target C:\Users\Adnan\openclaw-workflow

Source-checkout OpenClaw loads bundled plugins from extensions/*, so this makes your plugin appear as an in-repo/bundled workspace package rather than a normal external linked install.

2. Add the middleware contract to openclaw-workflow/openclaw.plugin.json

Make sure your plugin has this:

{
  "id": "openclaw-workflow",
  "name": "OpenClaw Workflow",
  "description": "Workflow orchestration with sealed observation spooling",
  "version": "0.1.0",
  "activation": {
    "onStartup": true
  },
  "contracts": {
    "agentToolResultMiddleware": ["pi", "codex"],
    "tools": [
      "workflow_run",
      "workflow_status",
      "workflow_list",
      "workflow_cancel",
      "workflow_step_update",
      "workflow_step_complete",
      "write_output",
      "read_output",
      "list_outputs",
      "materialize_output",
      "workflow_state_get",
      "workflow_observation_read",
      "workflow_observation_search",
      "workflow_observation_json_path",
      "workflow_runtime_patch_status"
    ]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "requireSealedToolResultMiddleware": {
        "type": "boolean",
        "default": true
      },
      "sealedMaxPreviewBytes": {
        "type": "number",
        "default": 2048
      }
    }
  }
}

The manifest docs say every native plugin must ship openclaw.plugin.json, and runtime-registered tools must be listed in contracts.tools so OpenClaw can discover the owning plugin without loading every runtime.

3. Register the tool-result middleware in src/index.ts

Add this during plugin registration:

import { registerWorkflowToolResultMiddleware } from "./tool-result-middleware.js";

export default {
  id: "openclaw-workflow",
  name: "OpenClaw Workflow",

  async register(api: any) {
    registerWorkflowToolResultMiddleware(api);

    // Existing tool registrations...
  },
};

Create src/tool-result-middleware.ts:

import { spoolValue } from "./sealed-spool.js";
import {
  getActiveSealedRunForMiddleware,
  markToolResultMiddlewareReady,
} from "./sealed-run-registry.js";

function resultToPlainValue(result: any): unknown {
  // Keep this generic. The raw OpenClaw result is what gets spooled.
  return result;
}

function envelopeToOpenClawToolResult(envelope: unknown, original: any) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(envelope),
      },
    ],
    details: {
      ...(original?.details && typeof original.details === "object"
        ? original.details
        : {}),
      openclaw_workflow_sealed: true,
    },
  };
}

export function registerWorkflowToolResultMiddleware(api: any) {
  if (typeof api.registerAgentToolResultMiddleware !== "function") {
    throw new Error(
      "openclaw-workflow requires api.registerAgentToolResultMiddleware; run as a bundled/trusted OpenClaw plugin.",
    );
  }

  api.registerAgentToolResultMiddleware(
    async (event: any, ctx: any) => {
      const active = getActiveSealedRunForMiddleware({
        sessionKey: ctx?.sessionKey,
        threadId: event?.threadId,
        runId: ctx?.runId,
        sessionId: ctx?.sessionId,
      });

      // Non-workflow or non-sealed runs pass through untouched.
      if (!active) {
        return;
      }

      const observationId = `observation_${event.toolCallId}`;

      const envelope = await spoolValue({
        artifactStore: active.artifactStore,
        runId: active.runId,
        stepId: active.stepId,
        outputId: observationId,
        value: resultToPlainValue(event.result),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        control: {
          ok: !event.isError,
          status: event.isError ? "failed" : "ok",
          extra: {
            runtime: ctx?.runtime,
            sessionKey: ctx?.sessionKey,
            threadId: event?.threadId,
          },
        },
        maxPreviewBytes: active.maxPreviewBytes ?? 2048,
      });

      return {
        result: envelopeToOpenClawToolResult(envelope, event.result),
      };
    },
    {
      runtimes: ["pi", "codex"],
    },
  );

  markToolResultMiddlewareReady(api);
}

The type surface confirms the middleware event includes threadId, turnId, toolCallId, toolName, args, error state, and the current OpenClaw tool result; the context includes runtime, session id/key, agent id, and run id.

4. Add an active sealed-run registry

Create src/sealed-run-registry.ts:

type ActiveSealedRun = {
  runId: string;
  stepId: string;
  sessionKey?: string;
  sessionId?: string;
  threadId?: string;
  artifactStore: any;
  maxPreviewBytes?: number;
};

const STORE_KEY = Symbol.for("openclaw-workflow.active-sealed-runs");
const READY_KEY = Symbol.for("openclaw-workflow.tool-result-middleware-ready");

function store(): Map<string, ActiveSealedRun> {
  const g = globalThis as any;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = new Map<string, ActiveSealedRun>();
  }
  return g[STORE_KEY];
}

function keysFor(run: Partial<ActiveSealedRun>): string[] {
  return [
    run.sessionKey ? `sessionKey:${run.sessionKey}` : null,
    run.sessionId ? `sessionId:${run.sessionId}` : null,
    run.threadId ? `threadId:${run.threadId}` : null,
    run.runId && run.stepId ? `runStep:${run.runId}:${run.stepId}` : null,
    run.runId ? `runId:${run.runId}` : null,
  ].filter(Boolean) as string[];
}

export function markToolResultMiddlewareReady(api?: any) {
  (globalThis as any)[READY_KEY] = true;

  // Expose an explicit capability for your own step-runner checks.
  if (api?.runtime?.subagent) {
    api.runtime.subagent.capabilities ??= {};
    api.runtime.subagent.capabilities.sealed ??= {};
    Object.assign(api.runtime.subagent.capabilities.sealed, {
      toolResultInterception: true,
      transcriptFirewall: true,
      artifactSink: true,
      recordObservationBeforeModel: true,
      source: "agentToolResultMiddleware",
    });
  }
}

export function isToolResultMiddlewareReady(): boolean {
  return Boolean((globalThis as any)[READY_KEY]);
}

export function registerActiveSealedRun(run: ActiveSealedRun): () => void {
  const s = store();
  const keys = keysFor(run);

  for (const key of keys) {
    s.set(key, run);
  }

  return () => {
    for (const key of keys) {
      if (s.get(key) === run) {
        s.delete(key);
      }
    }
  };
}

export function getActiveSealedRunForMiddleware(input: {
  sessionKey?: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
}): ActiveSealedRun | null {
  const s = store();

  const keys = [
    input.sessionKey ? `sessionKey:${input.sessionKey}` : null,
    input.threadId ? `threadId:${input.threadId}` : null,
    input.sessionId ? `sessionId:${input.sessionId}` : null,
    input.runId ? `runId:${input.runId}` : null,
  ].filter(Boolean) as string[];

  for (const key of keys) {
    const run = s.get(key);
    if (run) return run;
  }

  return null;
}
5. Wrap sealed subagent runs in src/step-runner.ts

Where you spawn sealed browser/model workers, register the active sealed run before adapter.spawn(...) / api.runtime.subagent.run(...).

import {
  isToolResultMiddlewareReady,
  registerActiveSealedRun,
} from "./sealed-run-registry.js";

function requireSealedMiddleware(step: any) {
  const needsSealed =
    step?.sealed ||
    step?.mode === "sealed" ||
    step?.uses === "browser" ||
    step?.uses === "model";

  if (!needsSealed) return;

  if (!isToolResultMiddlewareReady()) {
    throw new Error(
      `Cannot run sealed step "${step.id ?? step.name}": ` +
        "agent tool-result middleware is not registered. " +
        "Run openclaw-workflow as a bundled/trusted plugin with " +
        "contracts.agentToolResultMiddleware.",
    );
  }
}

Then around the spawn:

requireSealedMiddleware(step);

const unregister =
  sealed
    ? registerActiveSealedRun({
        runId: args.runId,
        stepId: step.id,
        sessionKey,
        sessionId,
        artifactStore: options.artifactStore,
        maxPreviewBytes:
          sealed?.tool_result_policy?.max_context_injection_bytes ?? 2048,
      })
    : () => {};

try {
  return await adapter.spawn({
    // existing spawn args
  });
} finally {
  unregister();
}

The key thing is correlation. If middleware context gives you ctx.sessionKey, use that. If it only gives threadId, you may need to confirm whether OpenClaw maps your subagent sessionKey to Pi threadId. The middleware type supports both threadId and sessionKey, so the lookup should try both.

6. Build from the OpenClaw source checkout

From the OpenClaw repo root:

pnpm install
pnpm --filter openclaw-workflow build
pnpm build

Then start the gateway from this source checkout using whatever script your checkout exposes, for example:

pnpm openclaw gateway

or use the repo’s documented dev/start script if named differently.

The important part: do not run the global packaged OpenClaw while testing this. Run the source checkout that sees extensions/openclaw-workflow as bundled.

7. Verify it is actually bundled and middleware-capable

Run:

openclaw plugins inspect openclaw-workflow --runtime --json

You want to see origin/source as bundled/in-repo, and no diagnostic like:

only bundled plugins can register agent tool result middleware

The registry source evidence shows OpenClaw rejects registerAgentToolResultMiddleware when record.origin !== "bundled" with the diagnostic “only bundled plugins can register agent tool result middleware.”

Add a tool:

api.registerTool({
  name: "workflow_runtime_patch_status",
  description: "Report sealed tool-result middleware status.",
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute() {
    const caps = api.runtime?.subagent?.capabilities?.sealed ?? null;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: Boolean(caps?.recordObservationBeforeModel),
              capabilities: caps,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});

Expected:

{
  "ok": true,
  "capabilities": {
    "toolResultInterception": true,
    "transcriptFirewall": true,
    "artifactSink": true,
    "recordObservationBeforeModel": true,
    "source": "agentToolResultMiddleware"
  }
}