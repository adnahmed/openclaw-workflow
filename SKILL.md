---
name: workflow-orchestrator
description: Use this skill when the user wants to list, validate, run, resume, cancel, or inspect YAML/JSON workflows managed by the openclaw-workflow plugin. Triggers on requests like "list workflows", "run the hello workflow", "dry run this pipeline", "resume the failed workflow", or "check workflow status".
---

# Workflow Orchestrator

Use the `openclaw-workflow` plugin tools to manage declarative agent workflows.

## When to use

Use this skill when the user asks to:

- list available workflows
- run a workflow by name
- validate a workflow without running it
- resume a previous workflow run
- check workflow status
- cancel a running workflow

Do not use this skill for:
- one-off shell pipelines
- generic task planning without an existing workflow file
- editing unrelated OpenClaw config unless needed for workflow setup

## Available tools

Use these tools directly when appropriate:

- `workflow_list()` — show available workflows
- `workflow_run({ name: "<workflow>", dry_run: true })` — validate and preview execution
- `workflow_run({ name: "<workflow>" })` — start execution
- `workflow_run({ name: "<workflow>", resume: true })` — resume a prior run
- `workflow_status({ name: "<workflow>" })` — inspect current/latest status
- `workflow_cancel({ run_id: "<run-id>" })` — stop a running workflow

## Preferred behavior

1. If the user says “what workflows do I have?”, call `workflow_list()`.
2. If the user asks to run a workflow and seems unsure, prefer a dry run first.
3. If the user names a workflow explicitly, use that exact name.
4. If the user asks for help debugging a workflow, first inspect with `workflow_list()` or `workflow_status(...)` before suggesting changes.
5. When relevant, remind the user that workflow files usually live in the configured workflows directory.

## Examples

User: "List my workflows"
Assistant: call `workflow_list()`

User: "Dry run the hello workflow"
Assistant: call `workflow_run({ name: "hello", dry_run: true })`

User: "Run hello"
Assistant: call `workflow_run({ name: "hello" })`

User: "Resume the deploy pipeline"
Assistant: call `workflow_run({ name: "deploy-pipeline", resume: true })`

User: "Check status of hello"
Assistant: call `workflow_status({ name: "hello" })`

## Available tools

IMPORTANT: These are OpenClaw plugin tools, not shell commands.

Never execute `workflow`, `workflow run`, or `openclaw workflow` in a terminal for normal workflow requests.

Use these tools directly:

- `workflow_list()` — show available workflows
- `workflow_run({ name: "<workflow>", dry_run: true })` — validate and preview execution
- `workflow_run({ name: "<workflow>" })` — start execution
- `workflow_run({ name: "<workflow>", resume: true })` — resume a prior run
- `workflow_status({ name: "<workflow>" })` — inspect latest status by workflow name
- `workflow_status({ run_id: "<run-id>" })` — inspect a specific run
- `workflow_cancel({ run_id: "<run-id>" })` — cancel a running workflow

If these tools are unavailable, report that the workflow plugin tools are not loaded. Do not invent a CLI fallback.