# [Discussion] Feature proposal: `openclaw-workflow` — agent pipeline orchestration plugin

**Category:** Ideas / Feature Proposals

---

## What problem does this solve?

OpenClaw's subagent system is great for isolated, single-shot tasks. But real pipelines are multi-step, where each agent depends on the *output* of the previous one:

1. A tech auditor runs scripts and writes a JSON handoff file
2. A content creator reads that handoff and writes drafts
3. A standup agent reads both outputs and synthesizes a briefing

Today, orchestrating this requires multiple timed cron jobs with hardcoded gaps between them. There's no guarantee step 2 waited for step 1's output. No retry if step 2 fails. No visibility into which step failed and why. And any failure means starting over from scratch.

## How is this different from Lobster?

Lobster orchestrates **shell commands** — it's a typed pipe engine for executables. It's great at data shaping and shell automation.

This plugin orchestrates **agents** — each step is a full LLM subagent with a long-form task prompt, a timeout measured in minutes, and output files it's expected to produce. Lobster's `openclaw.invoke` can call one LLM tool from a shell step, but it can't spawn a 600-second subagent, poll it to completion, check whether it produced the expected output files, and conditionally retry it. These are complementary tools.

## What I built

`openclaw-workflow` — a plugin that adds 4 tools:

**`workflow_run`** — run a YAML/JSON workflow definition
```js
workflow_run({ name: "seo-pipeline" })
workflow_run({ name: "seo-pipeline", dry_run: true })   // validate without running
workflow_run({ name: "seo-pipeline", resume: true })    // skip already-passed steps
```

**`workflow_status`** / **`workflow_list`** / **`workflow_cancel`**

### Workflow format

```yaml
name: SEO Daily Pipeline
version: "1.0"
concurrency: 2

steps:
  - id: tech-auditor
    task: "Run technical SEO audit and write handoff..."
    model: "anthropic/claude-sonnet-4-6"
    timeout: 420
    outputs:
      - "data/seo-state/ta-handoff-{date}.json"  # step fails if this doesn't exist after run

  - id: content-creator
    depends_on: [tech-auditor]    # waits for tech-auditor output gate to pass
    task: "Draft SEO content based on handoff..."
    timeout: 600
    retry: 1
    retry_delay: 60

  - id: standup
    depends_on: [tech-auditor, content-creator]
    optional: true               # pipeline succeeds even if this step fails
    task: "Synthesize memos into a briefing..."
```

### Features
- **Dependency graph** — `depends_on` builds an execution DAG; steps start only when parents pass
- **Parallel execution** — independent steps run concurrently up to `concurrency` limit
- **Output gates** — step only marked `ok` if expected files exist after completion
- **Retry with backoff** — configurable per step
- **Partial resume** — `resume: true` skips steps with status `ok` from previous run
- **Variable substitution** — `{date}`, `{datetime}`, `{run_id}` in task text and output paths
- **State persistence** — JSON state files in `.openclaw/workflow-runs/`
- **Zero external runtime deps** — only `js-yaml`; tests use `node:test`

### Current state
- 2,186 lines of source across 7 modules
- 81 tests, all passing (`node --test tests/*.test.js`)
- 507-line README
- 3 example workflows (seo-pipeline, deploy-pipeline, data-pipeline)
- Running in production on my own OpenClaw instance

## Questions for maintainers

1. Is there appetite for agent pipeline orchestration as a first-party plugin? Or is the intent to extend Lobster to cover this use case?
2. If yes — is `openclaw/openclaw` the right target, or would this live in its own repo / as a skill on ClawHub?
3. Any feedback on the architecture before I open a formal PR?

Code is at: https://github.com/jerednel/openclaw-workflow *(will push before posting this)*

Happy to share the full session log — this was built AI-assisted (OpenClaw + Claude Sonnet) with a human reviewing every module.
