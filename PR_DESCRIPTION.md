# PR: Add `openclaw-workflow` — Multi-step workflow orchestration plugin

## Summary

This PR adds a first-party plugin that brings workflow orchestration to OpenClaw. It lets you define multi-step agent pipelines in YAML/JSON and run them with dependency management, retry logic, parallel execution, and output gates — without shell scripts or manual cron timing.

## Problem

OpenClaw's subagent system is great for isolated, single-shot tasks. But real-world agent pipelines are multi-step:

1. A tech audit generates a JSON handoff
2. A content creator reads that handoff and writes drafts
3. A standup synthesizer reads both outputs

Today, orchestrating this requires:
- Multiple cron jobs with hardcoded time gaps between them
- No guarantee that step 2 actually waits for step 1's output
- No retry if step 2 fails
- No visibility into which step failed and why
- Starting over from scratch on any failure

`openclaw-workflow` solves all of this.

## What's included

### 4 new tools

**`workflow_run`** — Execute a workflow definition
```js
workflow_run({ name: "seo-pipeline" })                     // run it
workflow_run({ name: "seo-pipeline", dry_run: true })      // validate without running
workflow_run({ name: "seo-pipeline", resume: true })       // skip already-passed steps
```

**`workflow_status`** — Check progress of a running or completed run
```js
workflow_status({ name: "seo-pipeline" })  // most recent run
workflow_status({ run_id: "seo-pipeline-20260309T082000" })
```

**`workflow_list`** — List all workflow definitions and last run status

**`workflow_cancel`** — Cancel a running workflow (in-flight steps finish, no new steps start)

### Workflow definition format (YAML or JSON)

```yaml
name: SEO Daily Pipeline
version: "1.0"

steps:
  - id: tech-auditor
    task: "Run tech audit and write handoff..."
    timeout: 420
    outputs:
      - "data/seo-state/ta-handoff-{date}.json"  # must exist after step, or step fails

  - id: content-creator
    depends_on: [tech-auditor]   # waits for tech-auditor to pass
    task: "Draft SEO content..."
    timeout: 600
    retry: 1                     # retry once on failure
    retry_delay: 60

  - id: standup
    depends_on: [tech-auditor, content-creator]
    task: "Synthesize memos..."
    optional: true               # failure doesn't fail the pipeline
```

### Key features

- **Dependency resolution** — `depends_on` builds an execution graph; steps only start when their parents pass
- **Parallel execution** — independent steps (no shared dependencies) run concurrently up to `concurrency` limit
- **Output gates** — a step is only marked `ok` if its expected output files exist after it completes
- **Retry with delay** — configurable retry count and backoff per step
- **Partial resume** — `resume: true` skips steps with status `ok` from the last run
- **Variable substitution** — `{date}`, `{datetime}`, `{run_id}` in task text and output paths
- **State persistence** — each run writes a JSON state file to `.openclaw/workflow-runs/`
- **Delivery notifications** — optional step-level announcements to configured channel

### Plugin configuration

```json
{
  "openclaw-workflow": {
    "enabled": true,
    "config": {
      "workflowsDir": "~/.openclaw/workflows",
      "runsDir": "~/.openclaw/workflow-runs",
      "baseDir": "/path/to/project",
      "concurrency": 3,
      "notifyChannel": "telegram",
      "pollIntervalMs": 5000
    }
  }
}
```

## Architecture

```
openclaw-workflow/
├── openclaw.plugin.json     # manifest + configSchema
├── index.js                 # registers 4 tools
├── workflow-loader.js       # YAML/JSON parser + schema validator
├── workflow-executor.js     # dependency resolution, wave scheduling, parallel execution
├── workflow-state.js        # run state persistence (read/write JSON state files)
├── step-runner.js           # spawns a step as an isolated subagent, polls completion
├── output-checker.js        # validates expected output files exist after step
├── variable-substitution.js # {date}, {datetime}, {run_id} substitution
└── tests/
    ├── workflow-loader.test.js
    ├── workflow-executor.test.js
    ├── workflow-state.test.js
    ├── output-checker.test.js
    └── variable-substitution.test.js
```

**81 tests, all passing:**
```
node --test tests/*.test.js
# tests 81 | pass 81 | fail 0
```

## Example: replacing 3 timed cron jobs with one workflow

**Before:** 3 cron jobs timed 18 minutes apart. No guarantee of ordering. No retry. Silent failures.

**After:** One workflow definition. Tech auditor output gates content creator. Content creator output gates standup. Any step failure is visible, retryable, and resumable.

```yaml
# ~/.openclaw/workflows/seo-pipeline.yml
name: SEO Daily Pipeline
steps:
  - id: tech-auditor
    task: "..."
    outputs: ["data/seo-state/ta-handoff-{date}.json"]
  - id: content-creator
    depends_on: [tech-auditor]
    task: "..."
    retry: 1
  - id: standup
    depends_on: [tech-auditor, content-creator]
    optional: true
```

Then a single morning cron runs:
```
workflow_run({ name: "seo-pipeline" })
```

## Installation

```bash
# Install plugin
cp -r openclaw-workflow ~/.openclaw/extensions/

# Add to openclaw.json
{
  "plugins": {
    "allow": [..., "openclaw-workflow"],
    "entries": {
      "openclaw-workflow": {
        "enabled": true,
        "config": {
          "workflowsDir": "~/.openclaw/workflows",
          "runsDir": "~/.openclaw/workflow-runs"
        }
      }
    }
  }
}

# Restart OpenClaw
systemctl restart openclaw
```

## Notes for reviewers

- `step-runner.js` uses `sessions_spawn` internally via the OpenClaw plugin API. This requires the plugin API to expose a `spawnSession` method — currently accessed via `api.spawnSession` or equivalent. If the internal API surface differs, this is the only integration point that would need adjustment.
- Workflow state files are plain JSON in `~/.openclaw/workflow-runs/` — no new database dependency.
- The plugin has zero external runtime dependencies beyond `js-yaml` (for YAML parsing). Tests use Node.js built-in `node:test`.
- All paths are configurable; no hardcoded system paths anywhere in the codebase.

## Related

- Closes #[issue] — "Feature: multi-step agent pipelines"
- See `examples/` for seo-pipeline.yml, deploy-pipeline.yml, data-pipeline.yml
