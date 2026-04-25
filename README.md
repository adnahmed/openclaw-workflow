# openclaw-workflow

**YAML/JSON-driven workflow orchestration for OpenClaw agents.**

Compose multi-step agent pipelines with dependency management, parallel execution, retry logic, output gates, and partial resume — all in a declarative YAML file.

---

## The Problem

OpenClaw subagents are powerful — but fire-and-forget. There's no native way to:
- Run agent B only after agent A succeeds
- Run agents A and B in parallel, then agent C when both finish
- Retry a flaky step before failing the whole pipeline
- Resume a partially-completed pipeline after a crash
- Validate that a step actually produced the expected output files

Developers work around this with shell scripts, manual timing, and fragile cron chains. `openclaw-workflow` solves this at the platform level.

---

## Installation

```bash
# Local development
npm install
npm run build
openclaw plugins install -l . --dangerously-force-unsafe-install

# From npm once published
openclaw plugins install openclaw-workflow --dangerously-force-unsafe-install
```

`--dangerously-force-unsafe-install` is currently required because the plugin intentionally imports `node:child_process` for the CLI session fallback used when OpenClaw does not expose a stable native session API to plugins.

Configure the plugin in your OpenClaw settings:

```json
{
  "plugins": {
    "entries": {
      "openclaw-workflow": {
        "enabled": true,
        "config": {
          "workflowsDir": "~/.openclaw/workflows",
          "runsDir": "~/.openclaw/workflow-runs",
          "baseDir": "/home/user/myproject",
          "concurrency": 3,
          "notifyChannel": "telegram",
          "sessionModel": "anthropic/claude-sonnet-4-6",
          "pollIntervalMs": 5000
        }
      }
    }
  }
}
```

Create your workflows directory and restart/verify the gateway:

```bash
mkdir -p ~/.openclaw/workflows
openclaw plugins list --verbose
openclaw plugins inspect openclaw-workflow --json
openclaw plugins doctor
```

On Windows/WSL-mounted directories, OpenClaw may block linked plugins when the source path is reported as world-writable (`mode=777`). Move or copy the plugin to a non-world-writable path if inspection says the plugin candidate was blocked.

---

## Quick Start (10 minutes)

**1. Create a workflow file:**

```bash
cat > ~/.openclaw/workflows/hello.yml << 'EOF'
name: Hello Pipeline
version: "1.0"
steps:
  - id: greet
    name: "Greeter"
    task: "Write a friendly greeting to output/hello-{date}.txt"
    timeout: 60
    outputs:
      - "output/hello-{date}.txt"

  - id: followup
    name: "Follow-up"
    depends_on: [greet]
    task: "Read the greeting from output/hello-{date}.txt and write a response to output/response-{date}.txt"
    timeout: 60
EOF
```

**2. List available workflows:**

```
workflow_list()
```

**3. Dry run (validate without executing):**

```
workflow_run({ name: "hello", dry_run: true })
```

**4. Run the pipeline:**

```
workflow_run({ name: "hello" })
# → { run_id: "hello-pipeline-20260309T082000", status: "running", ... }
```

**5. Check status:**

```
workflow_status({ name: "hello" })
# → { status: "ok", steps_ok: 2, steps_total: 2, ... }
```

---

## Workflow YAML Schema Reference

### Top-level fields

| Field         | Type     | Required | Default | Description |
|---------------|----------|----------|---------|-------------|
| `name`        | string   | ✅       | —       | Human display name. Used in notifications and slugified for run IDs. |
| `version`     | string   | ❌       | `"1.0"` | Schema version for future compatibility. |
| `description` | string   | ❌       | `""`    | Human description shown in `workflow_list`. |
| `steps`       | array    | ✅       | —       | Ordered list of step definitions. |
| `concurrency` | number   | ❌       | `3`     | Max steps that run in parallel. Range: 1–10. |

### Step fields

| Field          | Type      | Required | Default | Description |
|----------------|-----------|----------|---------|-------------|
| `id`           | string    | ✅       | —       | Unique step identifier. Must match `[a-zA-Z0-9_-]+`. Used in `depends_on` references and state files. |
| `name`         | string    | ❌       | Same as `id` | Human display name for notifications. |
| `task`         | string    | ✅*      | —       | The agent prompt / task description. Supports [variable substitution](#variable-substitution). (*Not required if `for_each` is used) |
| `depends_on`   | string[]  | ❌       | `[]`    | IDs of steps that must complete (`ok`) before this step runs. |
| `outputs`      | string[]  | ❌       | `[]`    | File paths that must exist after the step completes. If any are missing, the step is marked `failed`. Supports [variable substitution](#variable-substitution). |
| `for_each`     | string    | ❌       | —       | Variable containing a list to iterate over (e.g., `"{songs}"`). |
| `parser`       | string    | ❌       | `"auto"` | Parser to use for the loop list (`"json"`, `"csv"`, `"newline"`, `"auto"`). |
| `steps`        | array     | ❌       | `[]`    | Steps to execute for each item in the `for_each` list. |
| `model`        | string    | ❌       | Plugin default | LLM model override for this step's session (e.g. `"anthropic/claude-opus-4"`). |
| `timeout`      | number    | ❌       | `300`   | Maximum execution time in **seconds**. Step is marked failed on timeout. |
| `retry`        | number    | ❌       | `0`     | Number of retry attempts after first failure. `retry: 2` = up to 3 total attempts. |
| `retry_delay`  | number    | ❌       | `30`    | Seconds to wait between retry attempts. |
| `optional`     | boolean   | ❌       | `false` | If `true`, step failure doesn't fail the pipeline or block dependent steps. |

---

## Variable Substitution

The following `{variable}` tokens are substituted in `task` and `outputs` fields at run time:

| Variable      | Example value                   | Description |
|---------------|---------------------------------|-------------|
| `{date}`      | `2026-03-09`                    | Current date as `YYYY-MM-DD` (UTC) |
| `{datetime}`  | `2026-03-09T08:20:00.000Z`      | Current datetime as ISO 8601 (UTC) |
| `{run_id}`    | `seo-pipeline-20260309T082000`  | The unique run identifier |
| `{item}`      | `Song-1.mp3`                    | Current loop iteration value (only available inside `for_each` steps) |

Unknown `{variables}` are left as-is (not an error).

**Example:**
```yaml
task: "Write audit to data/seo/{date}/report.json for run {run_id}"
outputs:
  - "data/seo/{date}/report.json"
```

---

## Tools Reference

### `workflow_run`

Start a workflow execution.

This is registered as an optional tool because it starts background agent work and writes run state. Enable optional tools in the OpenClaw tool UI/config when you want agents to launch workflows.

**Input:**
```json
{
  "name": "seo-pipeline",
  "dry_run": false,
  "resume": false
}
```

| Parameter  | Type    | Required | Description |
|------------|---------|----------|-------------|
| `name`     | string  | ✅       | Workflow file stem (e.g. `"seo-pipeline"` for `seo-pipeline.yml`) |
| `dry_run`  | boolean | ❌       | Validate and show execution plan without running. Default: `false` |
| `resume`   | boolean | ❌       | Skip steps that already completed in the last run. Default: `false` |

**Response (normal run):**
```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "workflow": "SEO Daily Pipeline",
  "status": "running",
  "total_steps": 3,
  "steps": {
    "tech-auditor": { "status": "pending", "depends_on": [] },
    "content-creator": { "status": "pending", "depends_on": ["tech-auditor"] },
    "standup": { "status": "pending", "depends_on": ["tech-auditor", "content-creator"] }
  },
  "message": "Workflow \"SEO Daily Pipeline\" started. Use workflow_status to track progress."
}
```

**Response (dry run):**
```json
{
  "dry_run": true,
  "run_id": "seo-pipeline-20260309T082000",
  "total_steps": 3,
  "execution_waves": [
    [{ "id": "tech-auditor", "timeout_s": 420, "retry": 0, "optional": false }],
    [{ "id": "content-creator", "timeout_s": 600, "retry": 1, "optional": false }],
    [{ "id": "standup", "timeout_s": 300, "retry": 0, "optional": true }]
  ],
  "estimated_min_duration_s": 1320
}
```

---

### `workflow_status`

Check the status of a run.

**Input (by run_id):**
```json
{ "run_id": "seo-pipeline-20260309T082000" }
```

**Input (by name — returns most recent):**
```json
{ "name": "seo-pipeline" }
```

**Response:**
```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "workflow": "SEO Daily Pipeline",
  "status": "running",
  "started_at": "2026-03-09T08:20:00.000Z",
  "completed_at": null,
  "elapsed_s": 210,
  "steps_ok": 1,
  "steps_failed": 0,
  "steps_total": 3,
  "steps": {
    "tech-auditor": {
      "status": "ok",
      "attempts": 1,
      "duration_s": 195,
      "error": null,
      "started_at": "2026-03-09T08:20:00.000Z",
      "completed_at": "2026-03-09T08:23:15.000Z"
    },
    "content-creator": {
      "status": "running",
      "attempts": 1,
      "duration_s": null,
      "error": null
    },
    "standup": {
      "status": "pending",
      "attempts": 0,
      "duration_s": null,
      "error": null
    }
  }
}
```

---

### `workflow_list`

List all available workflows and their last run status.

**Input:** (none required)

**Response:**
```json
{
  "workflows_dir": "/home/user/.openclaw/workflows",
  "count": 3,
  "workflows": [
    {
      "name": "data-pipeline",
      "display_name": "Data ETL Pipeline",
      "description": "Extract, Transform, Load pipeline...",
      "file": "/home/user/.openclaw/workflows/data-pipeline.yml",
      "last_run": {
        "run_id": "data-etl-pipeline-20260308T090000",
        "status": "ok",
        "started_at": "2026-03-08T09:00:00.000Z",
        "completed_at": "2026-03-08T09:14:22.000Z"
      }
    },
    {
      "name": "seo-pipeline",
      "display_name": "SEO Daily Pipeline",
      "description": "Daily SEO audit, content creation...",
      "file": "/home/user/.openclaw/workflows/seo-pipeline.yml",
      "last_run": null
    }
  ]
}
```

---

### `workflow_cancel`

Cancel a running workflow. In-flight steps finish; no new steps start.

This is registered as an optional tool because it modifies persisted run state.

**Input:**
```json
{ "run_id": "seo-pipeline-20260309T082000" }
```

**Response:**
```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "status": "cancelled",
  "message": "Run \"seo-pipeline-20260309T082000\" marked as cancelled. 1 step(s) currently in-flight will complete: content-creator"
}
```

---

## State File Format

Each workflow run writes state to `{runsDir}/{run_id}.json`:

```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "workflow": "SEO Daily Pipeline",
  "status": "ok",
  "started_at": "2026-03-09T08:20:00.000Z",
  "completed_at": "2026-03-09T08:47:12.000Z",
  "steps": {
    "tech-auditor": {
      "status": "ok",
      "started_at": "2026-03-09T08:20:00.000Z",
      "completed_at": "2026-03-09T08:23:15.000Z",
      "duration_ms": 195000,
      "session_key": "agent:main:subagent:abc123",
      "output_check": {
        "passed": true,
        "missing_files": [],
        "checked_files": ["/home/user/project/data/seo-state/ta-handoff-2026-03-09.json"]
      },
      "error": null,
      "attempts": 1
    }
  }
}
```

**Run status values:** `pending` | `running` | `ok` | `failed` | `cancelled`

**Step status values:** `pending` | `running` | `ok` | `failed` | `skipped`

- `skipped`: Step was never run because a non-optional dependency failed
- `failed`: Step ran but failed (either session error or output gate failed)
- `ok`: Step ran successfully and output gate passed (or no outputs defined)

---

## Notifications

When `notifyChannel` is configured, the plugin sends messages to that channel after each step:

```
✅ Technical Auditor complete (195s)
✅ Content Creator complete (462s)
✅ Standup Synthesis complete (88s)
🏁 Pipeline "SEO Daily Pipeline" complete — 3/3 steps passed
```

On failure:
```
❌ Content Creator failed — retrying (attempt 2/2)
❌ Content Creator failed after 2 attempt(s): Output gate failed — missing: data/seo-state/cc-memo-2026-03-09.md
⚠️  Standup Synthesis failed (optional — continuing pipeline)
💥 Pipeline "SEO Daily Pipeline" failed — 1 step(s) failed, 2/3 passed
```

---

## Execution Model

### Dependency Graph

Steps execute based on their `depends_on` graph. Steps with no dependencies (or all dependencies satisfied) are **ready** and launch immediately, up to the `concurrency` limit.

### Execution Waves Example

For this workflow:
```
A ──┐
    ├──→ C ──→ D
B ──┘
```

- **Wave 1**: A and B run in parallel
- **Wave 2**: C runs after both A and B finish
- **Wave 3**: D runs after C finishes

### Cascade Skip
 
When a non-optional step fails, all steps that depend on it (directly or transitively) are marked `skipped`. This prevents false failures and makes the status clear: the step didn't fail, it was never attempted.
 
### Loop Execution (`for_each`)
 
Workflows can iterate over a list of items using the `for_each` field. 
 
- **Expansion**: A loop step is expanded into multiple unique step instances, one for each item in the list. An instance ID follows the pattern `loop_id:index:inner_step_id`.
- **Dynamic Tasks**: Use the `{item}` variable in `task` or `outputs` fields to refer to the current iteration's value.
- **Dependency Resolution**: If a step depends on a loop step, it will wait for all instances of the last step in that loop to complete before starting.
- **List Parsing**: The loop resolves the `for_each` variable using a `parser`:
  - `json` (default/auto for `.json`): Parses a JSON array.
  - `csv` (auto for `.csv`): Splits content by commas.
  - `newline` (auto for `.txt`): Treats each line as a separate item.
- **Example**:
  ```yaml
  - id: process_songs
    for_each: "{songs}"
    parser: "newline"
    steps:
      - id: transcribe
        task: "Transcribe {item}..."
```

 
### Resume


`workflow_run({ name: "...", resume: true })` loads the most recent run, finds all steps with `status: "ok"`, marks them as already-completed in the new run, and only executes the rest. Use this to recover from partial failures without re-doing expensive work.

---

## Examples

### SEO Pipeline (`examples/seo-pipeline.yml`)

Three sequential agents: Technical Auditor → Content Creator → Standup Synthesis. The Content Creator only runs if the Auditor wrote its handoff file. Standup is optional.

### Deploy Pipeline (`examples/deploy-pipeline.yml`)

Four-stage gate: test → build → deploy → smoke-test. Uses `concurrency: 1` to enforce strict sequencing. Deploy has `retry: 1` for flaky network situations.

### Data ETL Pipeline (`examples/data-pipeline.yml`)
 
Parallel fetch (primary + reference), then validate, transform, load, report. Demonstrates parallel steps fanning in to a single gate step, with the optional reporting stage at the end.
 
### Music Processing Pipeline (`examples/music-pipeline.yml`)
 
Iterates over a list of audio files. For each file, it transcribes the audio and then generates a summary. Demonstrates loop expansion and the use of `{item}`.
 
---


## Development & Testing

```bash
npm install
npm run typecheck
npm run build
npm test
npm run check
```

Tests use Node.js built-in `node:test` and mock step runners. They do not require a real OpenClaw CLI install unless you are doing the optional local plugin install smoke test.

---

## Operations and Security Notes

- Workflows cause agents to perform real work. Review workflow YAML/JSON before enabling `workflow_run`.
- Relative output paths are resolved under `baseDir`; set it to the workspace you expect agents to write into.
- Each step can set its own `model` and `timeout`; otherwise the plugin-level `sessionModel` and default timeout are used.
- If no stable native session runtime exists in the plugin API, `CliAdapter` falls back to the `openclaw` CLI and requires it in `PATH`.
- The CLI fallback uses argument arrays and preserves the Windows `openclaw.ps1` wrapper case via PowerShell `-File`; workflow prompts are not shell-interpolated.

---

## Maintainer Notes

### Assumptions about OpenClaw internals

1. **Plugin API shape**: The entrypoint uses `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry` and registers tools from `register(api)`.

2. **Native sessions**: `src/step-runner.ts` still has an `ApiAdapter` for `api.sessions.spawn()` / `api.sessions.getStatus()` if OpenClaw exposes that surface. Until then, the CLI fallback remains isolated behind the adapter.

3. **Notifications**: The plugin uses `api.notifications.send` if available and otherwise writes progress through `api.logger`.

### What OpenClaw should expose for full functionality

```typescript
interface PluginApi {
  // Already present:
  registerTool(tool: ToolDefinition): void;
  pluginConfig: Record<string, unknown>;

  // Needed for openclaw-workflow:
  sessions?: {
    spawn(prompt: string, options: SessionSpawnOptions): Promise<{ sessionId: string; sessionKey: string }>;
    getStatus(sessionId: string): Promise<{ status: 'running' | 'done' | 'error'; error?: string }>;
  };
  notify?(channel: string, message: string): Promise<void>;
}
```

### Files created

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry: registers 4 tools |
| `src/workflow-loader.ts` | YAML/JSON parsing, validation, cycle detection |
| `src/workflow-executor.ts` | Core execution engine: scheduling, deps, retry, resume, dry run |
| `src/workflow-state.ts` | Atomic state file R/W, run listing |
| `src/step-runner.ts` | Session lifecycle: spawn, poll, output check. Includes MockAdapter |
| `src/output-checker.ts` | File existence validation for output gates |
| `src/variable-substitution.ts` | `{date}`, `{datetime}`, `{run_id}` substitution |
| `openclaw.plugin.json` | Plugin manifest + config schema |
| `package.json` | Package metadata |
| `tests/*.test.js` | Full test suite (Node built-in test runner) |
| `tests/fixtures/*.yml` | Fixture workflows for tests |
| `examples/*.yml` | SEO, deploy, and ETL example pipelines |

---

## Contributing

1. Fork the [openclaw/openclaw](https://github.com/openclaw/openclaw) repository
2. Copy this plugin to `plugins/openclaw-workflow/`
3. Run `npm install && npm run check` to verify tests pass
4. Submit a PR with the title: `feat: add openclaw-workflow orchestration plugin`

Please include test coverage for any new features or bug fixes.
