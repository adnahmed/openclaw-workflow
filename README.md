# openclaw-workflow

**YAML/JSON-driven workflow orchestration for OpenClaw agents.**

Compose multi-step agent pipelines with dependency management, parallel execution, retry logic, output gates, cache adoption with contract freshness signatures, explicit handoff completion, and partial resume — all in a declarative YAML file.

---

## The Problem

OpenClaw subagents are powerful — but fire-and-forget. There's no native way to:
- Run agent B only after agent A succeeds
- Run agents A and B in parallel, then agent C when both finish
- Retry a flaky step before failing the whole pipeline
- Resume a partially-completed pipeline after a crash
- Validate that a step actually produced the expected output files
- Reuse cached outputs safely when they still match the **current** contract

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
          "sessionAdapter": "auto",
          "pollIntervalMs": 5000,
          "stateBackend": "auto",
          "redisUrl": "redis://localhost:6379",
          "redisMcpToolPrefix": "MCP_DOCKER",
          "filesystemFallback": true,
          "materializeOutputs": "on_demand"
        }
      }
    }
  }
}
```

State/artifact backend config notes:
- `stateBackend`: `filesystem` \| `redis` \| `auto` \| `dual` (default `filesystem`)
- `redisUrl`: enables native Redis backend resolution when configured
- `redisMcpToolPrefix`: MCP Redis adapter prefix (default `MCP_DOCKER`)
- `filesystemFallback`: fallback to file-backed state/artifacts when Redis is unavailable
- `materializeOutputs`: `never` \| `on_demand` \| `always`

Redis notes:
- Native Redis mode uses `ioredis` at runtime (included in this package dependencies).
- MCP Redis mode expects commands exposed as `<PREFIX>__get`, `<PREFIX>__set`, `<PREFIX>__hset`, etc. (for example `MCP_DOCKER__get`).

Create your workflows directory and restart/verify the gateway:

```bash
mkdir -p ~/.openclaw/workflows
openclaw plugins list --verbose
openclaw plugins inspect openclaw-workflow --json
openclaw plugins doctor
```

On Windows/WSL-mounted directories, OpenClaw may block linked plugins when the source path is reported as world-writable (`mode=777`). Move or copy the plugin to a non-world-writable path if inspection says the plugin candidate was blocked.

---

## Session Adapter Selection
The plugin chooses how to spawn subagent sessions based on the available OpenClaw API surface.

**Precedence:**
1. `OPENCLAW_WORKFLOW_SESSION_ADAPTER` environment variable (override)
2. `sessionAdapter` plugin configuration
3. Default: `"auto"` (selects the best available)

**Available Adapters:**
- `runtime-subagent` (Preferred): Uses the modern `api.runtime.subagent` SDK.
- `legacy-api`: Uses the older `api.sessions` surface.
- `cli`: Fallback to `openclaw` CLI cron jobs.
- `auto`: Tries `runtime-subagent` $\rightarrow$ `legacy-api` $\rightarrow$ `cli`.

If a specific adapter is forced but the required API is missing, the plugin will fail fast with an error.

When a workflow contains sealed `tool_worker` steps with context firewall enforcement, adapter selection is capability-aware. The selected adapter must support:
- tool-result interception
- transcript firewall
- artifact sink

If those capabilities are unavailable, execution fails before worker spawn (rather than degrading to prompt-only sealing).

---

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

## Workflow YAML surfaces

OpenClaw Workflow supports two YAML surfaces:

1. **Authoring schema (public)**  
  Compact, human-friendly workflow format for writing pipelines.

2. **Execution schema (internal target)**  
  Low-level runtime format produced by the compiler.

Authoring workflows are compiled into execution workflows before validation and execution:

`authoring YAML -> authoring-loader -> authoring-compiler -> execution WorkflowDefinition -> workflow-loader normalize/validate -> template-schema-validator -> workflow-executor`

Raw execution-schema workflow files are disabled in the public load path. For migration-only workflows, use the internal migration loader (`loadLegacyExecutionWorkflowForMigrationOnly`) rather than normal `loadWorkflow` / `loadWorkflowFromFile`.

Security note: trust is based on in-memory compilation, not on YAML metadata. A hand-written `__compiled_from` field in input YAML is not treated as trusted compiler output.

Authoring example:

```yaml
schema: authoring
name: Example

collections:
  jobs:
    key: job_id
    queues: [pending, done]

pipeline:
  - collect_jobs:
      uses: browser
      writes: jobs.pending

  - classify_jobs:
      uses: model
      for_each: jobs_ready
      parser: json
      outputs:
        - id: classification_results

  - publish_state:
      uses: plugin
      operation: workflow.state_publish
      state_publish:
        from_step: collect_jobs
        output: jobs_pending
        collection: jobs
        queue: jobs_pending

  - classify_all_jobs:
      uses: drain
      worker_group: classification
      worker:
        uses: model
        task: Classify claimed jobs.
        outputs:
          - id: classified_jobs
```

Compiled execution outline (abridged):

```yaml
name: Example
state:
  collections: ...
  queues: ...
  worker_groups: ...
steps:
  - id: collect_jobs
    kind: sealed
    ...
  - id: __publish_jobs_pending_from_collect_jobs
    kind: plugin
    uses: workflow.state_publish
    ...
  - id: classify_jobs
    kind: loop_subagent
    ...
  - id: classify_all_jobs
    kind: state_drain
    ...

### Authoring-specific fields (public schema)

In addition to `resources`, `collections`, `profiles`, and `pipeline`, the authoring schema supports:

- top-level `state` (merged with compiler-generated collection state)
- top-level `required_skills` (public skills only; engine-native state backends remain internal)
- top-level `concurrency` and `version`
- `defaults.sealed` to set global sealed-worker policy overrides

Authoring step additions:

- `outputs` supports rich arrays:
  - string entries (`- jobs_ready`)
  - objects with `id`, `path`, `validate`, `optional`, and `materialize.{path,mode}`
- plugin op shorthand via top-level `operation` (preferred over `with.operation`, still backward-compatible)
- public sealed-loop authoring via `for_each` (+ `parser`, `item_schema`) for browser/model steps
- named drain controller authoring via `uses: drain` + `worker_group`, `claim`, `worker`, `complete`
- step-level `sealed` overrides merged over defaults/profile

Example rich output object:

```yaml
outputs:
  - id: jobs_ready
    path: data/linkedin/job-alerts/jobs-ready-{date}.json
    validate: jobs_array
    materialize:
      path: data/linkedin/job-alerts/jobs-ready-{date}.json
      mode: always
```
```

## Workflow YAML Schema Reference

### Top-level fields

| Field         | Type     | Required | Default | Description |
|---------------|----------|----------|---------|-------------|
| `name`        | string   | ✅       | —       | Human display name. Used in notifications and slugified for run IDs. |
| `version`     | string   | ❌       | `"1.0"` | Schema version for future compatibility. |
| `description` | string   | ❌       | `""`    | Human description shown in `workflow_list`. |
| `steps`       | array    | ✅       | —       | Ordered list of step definitions. |
| `concurrency` | number   | ❌       | `3`     | Max steps that run in parallel. |
| `state`       | object    | ❌       | —        | Storage backend declaration for state and artifacts. See [Artifact-Backed Declared Outputs](#artifact-backed-declared-outputs). |
| `config`       | object    | ❌       | `{}`     | Top-level configuration variables accessible via `{config.X}` substitution. |
| `validators`    | object    | ❌       | `{}`     | Custom validation rules for output checks, supporting schemas and conditional outcomes (`pass_when`, `retry_when`, `block_when`, `fail_when`). |
| `required_skills` | string[]  | ❌       | `[]`     | Skills required for the entire workflow. Steps without their own `required_skills` inherit these. Injected as instructions into step prompts and verified against agent config. |
| `required_mcp_servers` | string[] | ❌       | `[]`     | External capability servers required by worker steps. Do not list engine-native state backends here. |

`state.contracts` lets you define **semantic state contracts** (for example, collection lifecycle semantics) that the runtime projects to Redis/native state views after outputs validate.

`state.collections`, `state.queues`, and `state.worker_groups` let you define the same lifecycle as named semantic resources for explicit plugin-step state operations such as `workflow.state_publish`, `workflow.state_claim`, `workflow.state_complete`, `workflow.state_query`, `workflow.state_patch_outputs`, `workflow.state_partition`, and `workflow.state_report`.


### Step fields

| Field          | Type      | Required | Default | Description |
|----------------|-----------|----------|---------|-------------|
| `id`           | string    | ✅       | —       | Unique step identifier. Must match `[a-zA-Z0-9_-]+`. Used in `depends_on` references and state files. |
| `name`         | string    | ❌       | Same as `id` | Human display name for notifications. |
| `kind`         | string    | ❌       | inferred | Step execution kind: `subagent`, `loop_subagent`, `plugin`, `state_drain`, or `sealed`. If omitted, loop steps infer `loop_subagent`, drain-controller steps infer `state_drain`, otherwise `subagent`. |
| `task`         | string    | ✅*      | —       | The agent prompt / task description. Supports [variable substitution](#variable-substitution). (*Not required for `kind: plugin` steps or loop containers using `for_each`) |
| `uses`         | string    | ✅**     | —       | Plugin operation ID for `kind: plugin` steps (for example, `workflow.cache_json_document`). |
| `with`         | object    | ❌       | `{}`    | Parameter map passed to a `kind: plugin` operation. Supports [variable substitution](#variable-substitution). |
| `depends_on`   | string[]  | ❌       | `[]`    | IDs of steps that must complete (`ok`) before this step runs. |
| `outputs`      | array     | ❌       | `[]`    | Output validation rules. Supports simple file existence checks or detailed objects with custom validators and schemas. Supports [variable substitution](#variable-substitution). |
| `for_each`     | string    | ❌       | —       | Variable containing a list to iterate over (e.g., `"{songs}"`). |
| `parser`       | string    | ❌       | `"auto"` | Parser to use for the loop list (`"json"`, `"csv"`, `"newline"`, `"auto"`). |
| `item_schema`    | object    | ❌       | —       | Optional schema to validate each item in the loop list (type, required fields, patterns). |
| `steps`        | array     | ❌       | `[]`    | Steps to execute for each item in the `for_each` list. |
 | `model`        | string    | ❌       | Plugin default | LLM model override for this step's session (e.g. `"anthropic/claude-opus-4"`). |
 | `concurrency`   | number    | ❌       | Global limit | Max parallel instances of this specific step. Useful for avoiding rate limits on specific tools/APIs. |
 | `timeout`      | number    | ❌       | `300`   | Maximum execution time in **seconds**. Step is marked failed on timeout. |
| `retry`        | number    | ❌       | `0`     | Number of retry attempts after first failure. `retry: 2` = up to 3 total attempts. |
| `retry_delay`  | number    | ❌       | `30`    | Seconds to wait between retry attempts. |
| `retry_on`     | string[]  | ❌       | `[]`    | Specific failure kinds to retry on (e.g., `["missing_file", "timeout"]`). If empty, only retries when `retryable` is true. |
| `retry_except`  | string[]  | ❌       | `[]`    | Specific failure kinds that prevent retry, even if `retry > 0` or `retry_on` matches. |
| `optional`     | boolean   | ❌       | `false` | If `true`, step failure doesn't fail the pipeline or block dependent steps. |
| `always_run`   | boolean   | ❌       | `false` | If `true`, step runs regardless of dependency failure. |
| `on_block`     | string    | ❌       | `"block_run"` | Behavior when blocked: `"block_run"` (fails pipeline) or `"continue"`. |
| `required_skills` | string[]  | ❌       | `[]`     | Skills required for this specific step. Overrides workflow-level `required_skills`. Injected as instructions into the step prompt and verified against agent config. |
| `required_mcp_servers` | string[] | ❌       | `[]`     | External capability servers required by this worker step. Use `required_skills` (for example `browser-harness`) for skill-level capabilities. |
| `state_contract` | string\|string[] | ❌ | — | Semantic state contract name(s) to project after step outputs validate. The worker only produces outputs; runtime handles Redis/state materialization. |
| `state_publish` | object\|object[] | ❌ | — | Semantic publish specification for `kind: plugin` steps using `workflow.state_publish`. Reads a prior artifact and publishes items into a configured collection/queue. |
| `state_consume` | object | ❌ | — | Semantic consume/claim specification for `kind: plugin` steps using `workflow.state_claim`. Resolves a queue or worker group and emits a claim manifest artifact. |
| `state_reclaim` | object | ❌ | — | Semantic reclaim specification for `kind: plugin` steps using `workflow.state_reclaim_expired`. Requeues expired or orphaned in-flight claims before another worker pass. |
| `state_complete` | object\|object[] | ❌ | — | Semantic completion specification for `kind: plugin` steps using `workflow.state_complete`. Marks claimed items completed/failed using result artifacts from a prior step. |
| `state_query` | object | ❌ | — | Query specification for `kind: plugin` steps using `workflow.state_query`. Produces bounded artifacts from semantic Redis state. |
| `state_partition` | object | ❌ | — | Partition specification for `kind: plugin` steps using `workflow.state_partition`. Splits semantic items into bounded outputs and optional queues. |
| `state_patch_outputs` | object | ❌ | — | Patch specification for `kind: plugin` steps using `workflow.state_patch_outputs`. Merges result artifacts back into semantic Redis documents. |
| `state_report` | object | ❌ | — | Report specification for `kind: plugin` steps using `workflow.state_report`. Produces bounded JSON/Markdown reports from semantic state. |
| `drain` | object | ❌ | — | Scheduler/controller spec for `kind: state_drain`. Repeatedly expands nested steps until `workflow.state_claim` returns an empty batch. |
| `sealed` | object | ✅* | — | Configuration for `kind: sealed` execution boundary. Required for `kind: sealed`. Supports command-mode execution and worker-mode context-firewall policies. |
| `skip_if_empty` | string    | ❌       | —       | Path to a file that, if missing or containing no valid records (parsed as JSON/CSV/Newline), causes this step to be skipped and marked `ok`. Supports [variable substitution](#variable-substitution). |
| `complete_when` | string    | ❌       | `"session"` | Determines completion criteria: `"session"`, `"outputs"`, `"session_then_outputs"`, `"handoff"`, or `"handoff_or_outputs"`. |
| `signaling` | string | ❌ | auto for `handoff`/`handoff_or_outputs`, otherwise `off` | Controls plugin-injected signaling instructions. `"auto"` injects `workflow_step_update` + `workflow_step_complete` protocol into the runtime prompt so authors don't need to repeat this boilerplate in every step task. `"off"` disables injection for that step. |
| `output_contract_version` | number | ❌ | `null` | Optional explicit contract version for cache freshness signatures. Increment to invalidate older cache artifacts even when files are structurally valid. |
| `reuse_outputs` | object | ❌ | — | Structured cache adoption policy. Supports pre-launch reuse checks with validator + signature freshness gates. |

`**` `uses` is required when `kind: plugin`.

`*` `sealed` is required when `kind: sealed`.

Authoring-first note: in normal user workflows (`schema: authoring`), the compiler emits execution kinds such as `sealed`, `plugin`, and internal `state_drain` controllers. Raw `subagent` / `loop_subagent` execution-schema steps are legacy-only and rejected unless legacy execution loading is explicitly enabled.

### Sealed Steps (`kind: sealed`)

`sealed` is the generic worker primitive for enforcing a data-plane/control-plane split:
- **large/full results** are preserved in artifact storage
- **model context** receives only compact summaries/handles
- declared outputs remain the authoritative contract for step completion

Use `kind: sealed` instead of introducing many specialized worker kinds.

#### Sealed modes

- `tool_worker` (default): isolated worker session with policy hints for result/context handling
- `skill_worker`: same execution surface, authored for skill-centric worker tasks
- `adapter`: reserved adapter-directed worker mode
- `command`: bounded OS command execution with stdout/stderr spool + output-contract checks

`mode` defaults to:
- `command` when `sealed.command` is present
- otherwise `tool_worker`

#### Sealed spec fields

```yaml
sealed:
  mode: tool_worker | skill_worker | adapter | command
  no_model: false

  command:                      # required when mode: command
    argv: ["node", "scripts/transform.mjs"]
    cwd: "."
    env:
      NODE_ENV: production

  tools:
    allow: []
    deny: []

  result_visibility:
    mode: auto
    inline_when_safe: true
    preserve_full_results: true
    spool_when_large: true
    return_refs: true
    lazy_read: true
    expose_preview: true

  context_firewall:
    enabled: true
    strategy: adaptive
    on_context_pressure: spool_and_compact

  tool_result_policy:
    max_context_injection_bytes: auto
    max_single_result_bytes_before_spool: auto
    include_head_bytes: 512
    include_tail_bytes: 512
    preserve_full_result: true
    mode: auto

  stdout_policy:
    max_stdout_bytes: 2048
    max_stderr_bytes: 4096
    max_process_output_bytes: 104857600
    mode: spool_and_summarize

  watchdog:
    mode: progress_based
    require_declared_outputs: true
    detect_repeated_tool_calls: true
    detect_repeated_navigation: true
    repeated_tool_call_threshold: 3
    on_no_progress: fail

  return_contract:
    type: json
    max_context_bytes: auto
    schema: {}

  artifact_spool:
    enabled: true
    path: ".openclaw-workflow/sealed"
```

#### Sealed command example

```yaml
- id: normalize_manifest
  kind: sealed
  sealed:
    mode: command
    command:
      argv: ["node", "scripts/normalize-manifest.mjs", "--date", "{date}"]
    return_contract:
      type: json
      schema:
        type: object
        required: [status]
        properties:
          status:
            type: string
  outputs:
    - id: normalized_manifest
      validate: manifest_schema
```

#### Sealed worker example

```yaml
- id: collect_jobs
  kind: sealed
  task: |
    Collect jobs and commit declared outputs.
  sealed:
    mode: tool_worker
    context_firewall:
      enabled: true
  outputs:
    - id: jobs_manifest
```

#### Capability boundary note

Sealed `tool_worker` steps with context firewall require adapter-enforced runtime capabilities. If the chosen adapter cannot enforce tool-result interception, transcript firewall, and artifact sink, the run fails before spawning the worker.

This prevents silent downgrade from sealed runtime enforcement to prompt-only behavior.

### Plugin Steps (`kind: plugin`)

Plugin steps execute built-in workflow operations directly in the orchestrator (no spawned subagent session).

Rules:
- must declare `kind: plugin`
- must include `uses: <operation_id>`
- may include `with: { ... }` operation arguments
- cannot use `for_each`
- may still use `depends_on`, `outputs`, retry policy, and variable substitution

Built-in operation IDs:
- `workflow.cache_json_document`
- `workflow.state_init`
- `workflow.redis_run_initializer`
- `workflow.state_publish`
- `workflow.state_claim`
- `workflow.state_reclaim_expired`
- `workflow.state_complete`
- `workflow.state_query`
- `workflow.state_patch_outputs`
- `workflow.state_partition`
- `workflow.state_report`

#### `workflow.cache_json_document`

Reads a JSON file, commits it as a declared artifact output, and (when Redis is available) mirrors it into Redis.

`with` fields:
- required: `source_path`, `json_key`
- conditionally required: `hash_key` (required when Redis is configured)
- optional: `allowed_hash_fields`, `ttl_seconds`, `base_dir`, `output_id`

Example:

```yaml
- id: cache_profile
  kind: plugin
  uses: workflow.cache_json_document
  with:
    source_path: data/profile-{date}.json
    json_key: cache:profile:{run_id}
    hash_key: cache:profile_hash:{run_id}
    allowed_hash_fields: [profile_id, status]
    output_id: profile_cache
  outputs:
    - id: profile_cache
      validate: profile_schema
```

#### `workflow.state_init`

Initializes run metadata/counters/stream-group idempotently, and commits an initialization artifact even when Redis is unavailable.

`workflow.redis_run_initializer` remains supported as a backward-compatible alias.

`with` fields:
- required: `run_key`
- optional: `stream_key`, `stream_group` (default `workers`), `counter_keys`, `metadata`, `ttl_seconds`, `output_id`

Example:

```yaml
- id: init_run_state
  kind: plugin
  uses: workflow.state_init
  with:
    run_key: runs:{run_id}
    stream_key: events:{run_id}
    stream_group: workers
    counter_keys:
      processed:{run_id}: 0
      failed:{run_id}: 0
    metadata:
      workflow: "{workflow_name}"
      run_id: "{run_id}"
    output_id: run_config
  outputs:
    - id: run_config
```

#### Semantic state resources for explicit plugin steps

Use these top-level blocks when you want workflow YAML to describe *what* state exists while the plugin decides *how* it maps to Redis-backed views.

```yaml
state:
  backend: auto
  collections:
    task_alerts:
      entity: alert
      item_key: alert_key
      default_queue: task_alerts_pending
      indexes: [route, status, submitted]
      views:
        document: true
        metadata_hash: true
        seen_index: true
        pending_queue: true
        event_stream: true
      counters:
        published: task_alerts_published
        completed: task_alerts_completed
        failed: task_alerts_failed
  queues:
    task_alerts_pending:
      collection: task_alerts
      batch_size: 25
      visibility_timeout_s: 900
  worker_groups:
    task_alert_classifier:
      queue: task_alerts_pending
      batch_size: 10
      lease_seconds: 900
```

Semantic resource notes:
- `collections.<name>` defines the entity model and keying rules.
- `queues.<name>` defines batching / pending-work semantics for a collection.
- `worker_groups.<name>` defines how claimers resolve a queue plus lease behavior.
- `collections.<name>.indexes` defines secondary index fields maintained as sets (`{prefix}:set:{collection}:idx:{field}:{value}:{date}`).

#### `workflow.state_publish`

Publishes items from a prior step artifact into a semantic collection and queue, then writes a summary artifact.

Use when:
- a worker step already produced a manifest artifact
- you want the orchestrator/plugin to materialize queue/state views
- you do **not** want subagents hand-writing Redis commands

`state_publish` fields:
- required: `from_step`, `output`
- recommended: `collection`
- optional: `queue`, `select`, `item_key`, `summary_output`

Example:

```yaml
- id: publish_task_alert_state
  kind: plugin
  uses: workflow.state_publish
  state_publish:
    from_step: collect_task_alerts
    output: alerts_manifest
    collection: task_alerts
    queue: task_alerts_pending
    item_key: alert_key
    summary_output: state_publish_summary
  depends_on: [collect_task_alerts]
  outputs:
    - id: state_publish_summary
```

Behavior:
- reads the declared artifact from `from_step` / `output`
- selects items from the artifact payload (default root item list)
- publishes documents / hashes / queue entries / stream events according to the collection config
- first-seen items increment `published_count`; previously-seen items increment `updated_count`
- queue enqueue remains idempotent (no duplicate pending entries for the same item key)
- increments configured counters when present
- commits a summary artifact for downstream auditing

Important:
- artifact-only fallback is only safe for non-queue projections. If the publish writes to a queue, Redis is required because there is no filesystem-backed queue consumer yet.

#### `workflow.state_claim`

Claims work from a semantic queue or worker group and writes a claim manifest artifact for downstream worker steps.

`state_consume` fields:
- required: one of `queue` or `worker_group`
- required: `output`
- optional: `batch_size`, `lease_seconds`

Example:

```yaml
- id: claim_task_alert_batch
  kind: plugin
  uses: workflow.state_claim
  state_consume:
    worker_group: task_alert_classifier
    output: claim_manifest
  depends_on: [publish_task_alert_state]
  outputs:
    - id: claim_manifest

- id: classify_claimed_alerts
  depends_on: [claim_task_alert_batch]
  task: |
    Read the claimed alert batch from the claim_manifest artifact and classify each item.
  outputs:
    - id: classification_results
```

Behavior:
- resolves the queue from `state_consume.queue` or the declared worker group
- reclaims expired leases back to pending before new claims
- also reclaims orphaned processing entries that have no active lease record (for example, after a crash between queue move and lease bookkeeping)
- claims up to the configured batch size using atomic pending → processing movement
- writes active leases during claim; when Lua/eval is available this happens in the same Redis operation as the queue move
- appends claim events when event streams are enabled
- commits a manifest artifact containing flattened claimed items (plus `item_key` and `lease`) for downstream steps
- includes deterministic summary fields such as `claimed_count`, `reclaimed_expired_count`, and `reclaimed_orphaned_count`

Important:
- `workflow.state_claim` requires Redis. There is currently no filesystem-backed queue implementation, so artifact-only mode is intentionally rejected for queue claims.

#### `workflow.state_reclaim_expired`

Requeues expired leases — and orphaned processing entries without a matching lease record — without claiming new work.

Use when:
- you want an explicit recovery/repair step in the workflow graph
- you want lease cleanup to run on a schedule or before a specific worker wave

`state_reclaim` fields:
- required: one of `queue` or `worker_group`
- optional: `output`

Example:

```yaml
- id: reclaim_task_alert_batch
  kind: plugin
  uses: workflow.state_reclaim_expired
  state_reclaim:
    worker_group: task_alert_classifier
    output: reclaim_summary
  outputs:
    - id: reclaim_summary
```

Behavior:
- scans the queue's processing list and active lease hash
- requeues expired active leases back to pending
- requeues orphaned processing entries that have no active lease record
- writes a recovery summary artifact with `reclaimed_expired_count`, `reclaimed_orphaned_count`, and `reclaimed_count`

#### `workflow.state_complete`

Marks claimed items as completed or failed based on a result artifact written by a downstream worker step.

`state_complete` fields:
- required: `from_step`, `output`
- required: one of `collection`, `queue`, or `worker_group`
- optional: `select`, `item_key`, `status_field`, `summary_output`, `merge_document`, `merge_fields`, `indexes`

Example:

```yaml
- id: complete_task_alert_batch
  kind: plugin
  uses: workflow.state_complete
  state_complete:
    from_step: classify_claimed_alerts
    output: classification_results
    worker_group: task_alert_classifier
    collection: task_alerts
    select: $.items
    item_key: alert_key
    status_field: status
    summary_output: state_complete_summary
  depends_on: [classify_claimed_alerts]
  outputs:
    - id: state_complete_summary
```

Behavior:
- reads result items from the upstream artifact
- verifies lease identity when lease metadata is present
- skips stale lease completions (records `stale_count`) rather than incorrectly completing newer claims
- removes matching active leases and processing-queue entries for accepted completions
- places items into semantic completed/failed membership sets
- optionally merges completion/result fields back into Redis document/hash state (`merge_document` / `merge_fields`)
- maintains configured secondary indexes during merge (`collections.<name>.indexes` plus per-step `indexes`)
- appends lifecycle events to the collection stream when configured
- increments completion/failure counters and writes a summary artifact

#### `workflow.state_query`

Queries a semantic collection from Redis and writes bounded query results as an artifact.

`state_query` fields:
- required: `collection`, `output`
- optional: `where`, `projection`, `limit`, `offset`, `summary_output`

Example:

```yaml
- id: query_ready_alerts
  kind: plugin
  uses: workflow.state_query
  state_query:
    collection: task_alerts
    where:
      all:
        status: ready
    projection: [item_key, status, route]
    limit: 500
    output: ready_alerts
    summary_output: state_query_summary
  outputs:
    - id: ready_alerts
    - id: state_query_summary
```

Behavior:
- uses collection secondary indexes for simple equality where possible
- falls back to collection seen-set scan + predicate matching when needed
- commits query output and optional summary artifact

#### `workflow.state_patch_outputs`

Merges rows from one or more artifacts into semantic Redis documents/hashes without exposing those rows to model context.

`state_patch_outputs` fields:
- required: `collection`, `output`
- required in practice: `from_step` (or plugin step dependency)
- optional: `select`, `item_key`, `merge_fields`, `status_field`, `indexes`, `summary_output`

Example:

```yaml
- id: patch_classification_back
  kind: plugin
  uses: workflow.state_patch_outputs
  state_patch_outputs:
    from_step: classify_claimed_alerts
    output: classification_results
    collection: task_alerts
    item_key: alert_key
    merge_fields: [route, status, submitted]
    indexes: [route, status, submitted]
    summary_output: state_patch_outputs_summary
  outputs:
    - id: state_patch_outputs_summary
```

Behavior:
- reads matching artifacts from `from_step` (including loop child artifacts)
- merges selected fields into Redis document + hash records
- updates secondary indexes for merged fields
- commits a summary artifact with patched/skipped counts

#### `workflow.state_partition`

Partitions collection items into named bounded outputs and can optionally enqueue each partition into a semantic queue.

`state_partition` fields:
- required: `collection`, `partitions`
- optional: `projection`, `limit_per_partition`, `item_key`, `summary_output`

Example:

```yaml
- id: partition_alerts
  kind: plugin
  uses: workflow.state_partition
  state_partition:
    collection: task_alerts
    projection: [item_key, status, route]
    partitions:
      ready:
        where: { status: ready }
        output: alerts_ready
        queue: task_alerts_pending
      blocked:
        where: { status: blocked }
        output: alerts_blocked
    summary_output: state_partition_summary
  outputs:
    - id: alerts_ready
    - id: alerts_blocked
    - id: state_partition_summary
```

Behavior:
- resolves each partition independently via semantic query filters
- commits one output artifact per partition
- optionally enqueues each partitioned item and writes partition events to stream
- commits aggregate partition summary

#### `workflow.state_report`

Generates bounded final reporting artifacts directly from semantic Redis state.

`state_report` fields:
- required: `json_output`
- optional: `collections`, `counters`, `include_samples`, `markdown_output`

Example:

```yaml
- id: final_state_report
  kind: plugin
  uses: workflow.state_report
  state_report:
    collections: [task_alerts]
    counters: [task_alerts_published, task_alerts_completed, task_alerts_failed]
    include_samples: 25
    json_output: final_report_json
    markdown_output: final_report_md
  outputs:
    - id: final_report_json
    - id: final_report_md
```

Behavior:
- reports seen/completed/failed totals by collection
- optionally includes bounded sample items per collection
- optionally resolves configured counters
- emits JSON report and optional Markdown report artifacts

#### Explicit plugin flow vs. `state_contract`

There are now two complementary semantic patterns:

- `state_contract`: best when a normal worker step should produce outputs and the runtime should project state automatically after validation.
- `workflow.state_publish` / `workflow.state_claim` / `workflow.state_complete`: best when you want the workflow graph to model publish/claim/complete as explicit orchestration steps.

Both keep Redis details out of worker prompts and YAML-level imperative scripts.

Current limitation:
- `state_contract` and the explicit plugin-step state operations do **not** currently share the same key naming convention. `state_contract` projects keys using the contract `entity` (for example `queue:alerts:pending`), while explicit plugin steps key by collection/queue names. Until those namespaces are unified, do not mix both approaches for the same records if you need a single canonical queue/state view.

### State Drain Controller (`kind: state_drain`)

Use `state_drain` when you want the orchestrator itself to act as a queue-drain scheduler/controller.

What it does:
- starts an iteration
- runs nested steps (which should include a `workflow.state_claim` plugin step)
- inspects the claim artifact (`claimed_count`, `valid_count`, or `items.length`)
- if claimed count is `0`, treats the queue as empty for that iteration
- stops after `max_empty_claims` consecutive empty claims
- otherwise expands the next iteration and continues

`drain` fields:
- required: `worker_group`
- optional: `max_empty_claims` (default `1`)
- optional: `max_iterations` (`null`/unset = no explicit cap)

Example:

```yaml
- id: classifier_drain
  kind: state_drain
  name: Drain classifier queue
  depends_on: [publish_task_alert_state]
  drain:
    worker_group: task_alert_classifier
    max_empty_claims: 1
    max_iterations: 100
  steps:
    - id: claim
      kind: plugin
      uses: workflow.state_claim
      state_consume:
        # worker_group can be omitted here; controller injects drain.worker_group if missing
        output: claim_manifest
      outputs:
        - id: claim_manifest

    - id: classify
      depends_on: [claim]
      task: |
        Read claim_manifest and classify claimed items.
      outputs:
        - id: classification_results

    - id: complete
      kind: plugin
      uses: workflow.state_complete
      depends_on: [classify]
      state_complete:
        from_step: classify
        output: classification_results
        worker_group: task_alert_classifier
        collection: task_alerts
        summary_output: state_complete_summary
      outputs:
        - id: state_complete_summary
```

Notes:
- `state_drain` is a scheduler/controller step, not a plugin operation ID.
- nested step instances are expanded dynamically as `<drain_step_id>:<iteration>:<child_id>`.
- non-optional child `failed`/`blocked` statuses fail the controller.
- on empty claim, pending downstream children in that iteration are marked `skipped`.

### Automatic Step Signaling (Prompt Injection)

When signaling is enabled for a step, the plugin injects a runtime protocol into the spawned step prompt so workflow authors do **not** need to embed signaling boilerplate in every `task`.

Injected guidance includes:
- periodic `workflow_step_update` progress updates
- final `workflow_step_complete` handoff request
- current `run_id` and `step_id`
- current `attempt` and `handoff_token` when available
- declared-output contracts derived from `outputs[].validate` and `workflow.validators`
- `write_output` commit instructions for declared outputs
- repair-and-retry behavior when completion is rejected due to invalid outputs

Default behavior:
- `complete_when: handoff` or `complete_when: handoff_or_outputs` → `signaling: auto`
- all other completion modes → `signaling: off`

You can override per-step:

```yaml
- id: produce_manifest
  complete_when: handoff_or_outputs
  signaling: auto   # optional, auto by default for this complete_when
  task: |
    Build and validate manifest JSON outputs.

- id: custom_controller
  complete_when: handoff
  signaling: off    # disable auto-injection if you need fully custom behavior
  task: |
    Run custom orchestration logic.
```

Migration note:
- Existing workflows that already include manual “Workflow signaling protocol” text in `task` will continue to work.
- You can safely remove most of that repeated text and rely on `signaling: auto` for cleaner workflow files.

### Semantic State Contracts (runtime-projected)

Use semantic contracts when a step output should be interpreted as operational state (for example, a pending queue of alerts) without exposing Redis commands in YAML or prompts.

How it works:
1. Worker writes declared outputs (`write_output` / normal output contract path).
2. Orchestrator validates outputs.
3. If `state_contract` is declared, runtime projects the validated artifact to state views.
4. If Redis is unavailable and policy is `artifact_only`, outputs still pass and remain usable.

Example:

```yaml
state:
  backend: auto
  fallback: filesystem
  materialize_outputs: on_demand
  redis:
    provider: auto
    tool_prefix: MCP_DOCKER
  contracts:
    task_alert_collection:
      kind: collection
      entity: alert
      item_key: alert_key
      source_output: alerts_manifest
      raw_output: alerts_raw
      metadata_output: alerts_metadata
      summary_output: alerts_summary
      lifecycle: pending
      dedupe:
        by: [saved_search_id, href, query]
      state_views:
        document: true
        metadata_hash: true
        seen_index: true
        pending_queue: true
        event_stream: true
      counters:
        collected: alerts_collected
        rejected: alerts_rejected
      on_no_redis: artifact_only

steps:
  - id: collect_task_alerts
    task: Collect task alert notifications.
    state_contract: task_alert_collection
    outputs:
      - id: alerts_raw
      - id: alerts_metadata
      - id: alerts_manifest
      - id: alerts_summary
```

Notes:
- `state_contract` is semantic metadata, not an imperative Redis script.
- Worker prompts are isolated to declared inputs/outputs and avoid backend implementation details.
- Current runtime projector supports `kind: collection` and safely scalarizes hash fields.

### Automatic Declared Output Handling

If a step has declared `outputs`, the plugin now injects a second runtime contract automatically.
You do **not** need any new YAML fields for this behavior.

What the injected contract tells the worker:
- declared outputs are owned by the workflow plugin
- declared output files must be committed with `write_output`
- the prompt includes the **resolved validator contract**, not just a validator name
- when a validator has a useful schema shape, the prompt includes the expected object/array structure and examples

That means a step like this:

```yaml
- id: build_manifest
  complete_when: outputs
  task: Build today's alert manifest.
  outputs:
    - path: data/alerts-execution-manifest-{date}.json
      validate: alert_manifest_array
```

causes the runtime prompt to include guidance such as:
- exact declared output path
- validator ID (`alert_manifest_array`)
- resolved schema shape (for example, `JSON array` with item fields)
- semantic rules (`pass_when`, `retry_when`, `block_when`, `fail_when`, `unknown_policy`)
- an example item or blocked artifact when the validator shape makes that useful

### Safe Output Commit and Provenance

The new `write_output` tool is the authoritative path for declared outputs.

For declared outputs it performs all of the following:
- resolves the declared output path and confirms it belongs to the current step
- resolves the validator from the existing `workflow.validators` map
- validates the candidate value with the same validator engine used by output gating
- writes through a same-directory temp file
- re-validates the staged file from disk
- atomically renames the staged file into place
- records provenance in run state, including `run_id`, `step_id`, `attempt`, path, bytes, decision, and SHA-256

Important consequences:
- malformed JSON from an older attempt no longer poisons a still-running retry forever; the worker can repair it and commit a fresh artifact atomically
- manual/direct writes to declared output files are still visible to final validation, but they do **not** cause early completion while the session is still running
- early `pass`, `blocked`, or `retry` output decisions now require matching current-attempt provenance
- once the session itself ends, the orchestrator still performs the normal final output validation before accepting completion

This keeps YAML stable while making runtime behavior much stricter and safer.

### `reuse_outputs` fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `enabled` | boolean | ❌ | `false` | Enables pre-launch cache adoption checks for this step. |
| `when` | string | ❌ | — | CEL expression to decide if cache reuse is allowed (permission gate). |
| `require` | string | ❌ | `"declared_outputs"` | Currently must be `"declared_outputs"`. |
| `accept_decisions` | string[] | ❌ | `["pass"]` | Which merged validator decisions are adoptable (e.g., include `"blocked"` if desired). |
| `require_signature` | boolean | ❌ | `true` | Requires cache manifest/signature match before adoption. |
| `legacy_unsigned_cache` | string | ❌ | `"stale"` | Policy for old artifacts without signatures: `"stale"` or `"allow_if_valid"`. |
| `freshness.include` | string[] | ❌ | all supported | Signature components to include: `output_contract_version`, `step_task`, `validators`, `schemas`, `selected_config`, `input_signature`. |
| `on_hit.reason` | string | ❌ | `"cache_hit"` | Audit reason persisted when cache is adopted. |
| `on_invalid` | string | ❌ | `"run_step"` | Behavior when cache is invalid/stale: `"run_step"` or `"fail_step"`. |

**Retry Policy Notes:**
`retry_on` and `retry_except` use **Failure Kinds**. Available kinds: `timeout`, `timeout_stop_confirmed`, `timeout_stop_unconfirmed`, `missing_file`, `schema`, `fail_when`, `parse`, `other`.

**Example Pattern: Conditional Execution**
Use `skip_if_empty` to avoid launching expensive agents when there is no data to process:
```yaml
- id: generate_report
  name: "Generate Daily Report"
  depends_on: [collect_data]
  skip_if_empty: "data/daily_metrics.json" # Skip if no metrics were collected
  task: "Analyze metrics in data/daily_metrics.json and write a report..."
```

---

## Variable Substitution

The following `{variable}` tokens are substituted in `task` and `outputs` fields at run time:

| Variable      | Example value                   | Description |
|---------------|---------------------------------|-------------|
| `{date}`      | `2026-03-09`                    | Current date as `YYYY-MM-DD` (Workflow timezone) |
| `{datetime}`  | `2026-03-09T08:20:00`           | Current datetime as ISO-ish string (Workflow timezone) |
| `{utc_date}`  | `2026-03-09`                    | Current date as `YYYY-MM-DD` (UTC) |
| `{utc_datetime}` | `2026-03-09T08:20:00.000Z`   | Current datetime as ISO 8601 (UTC) |
| `{run_id}`    | `seo-pipeline-20260309T082000`  | The unique run identifier |
| `{workflow_name}` | `SEO Daily Pipeline`         | The name of the workflow |
| `{workflow_run_id}` | `seo-pipeline-20260309T082000` | The unique run identifier |
| `{run_state_path}` | `/home/user/.openclaw/workflow-runs/seo-pipeline-20260309T082000.json` | Path to the run state JSON file |
| `{item}`      | `Song-1.mp3`                    | Current loop iteration value (only available inside `for_each` steps) |
| `{config.X}`  | `my-custom-value`               | Value of variable `X` from the top-level `config` block |
| `{env.X}`     | `/home/user`                    | Value of environment variable `X` (for example `{env.HOME}`) |
| `\{variable}`  | `{date}`                       | Literal text (escaped). Prevents substitution. |
  
  Unknown `{variables}` are typically left as-is, except in `for_each` path templates where they cause an immediate error.

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

Cancel a running workflow. marks the run cancelled, prevents new steps from launching, and attempts to abort active worker sessions using the adapter cancellation path. Abort confirmation depends on the active OpenClaw runtime surface.

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
  "running_steps": 1,
  "abort_requested": 1,
  "abort_failed": 0,
  "results": [
    {
      "step_id": "content-creator",
      "requested": true,
      "confirmed": false,
      "method": "gateway.chat.abort"
    }
  ]
}
```

---

### `workflow_step_update`

Non-authoritative observability update from a running worker/step. This updates progress metadata only; it does **not** satisfy dependencies or complete the step.

**Input:**
```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "step_id": "content-creator",
  "status": "progress",
  "message": "Collected 12/30 items",
  "counters": { "processed": 12 }
}
```

---

### `workflow_step_complete`

Authoritative handoff request from a running worker/step. The orchestrator still validates the declared output contract (and cache freshness signature when relevant) before accepting completion.

**Input:**
```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "step_id": "content-creator",
  "reason": "generated",
  "message": "Outputs written and ready",
  "attempt": 1,
  "handoff_token": "..."
}
```

If validation fails, the response returns structured details (missing/invalid outputs) so the worker can repair and continue.

### `write_output`

Authoritative declared-output writer for running workers. Use this for any file listed under the step's `outputs` contract.

**Input:**
```json
{
  "run_id": "seo-pipeline-20260309T082000",
  "step_id": "content-creator",
  "path": "data/seo-state/cc-manifest-2026-03-09.json",
  "data": [{ "slug": "post-1", "status": "ready" }]
}
```

You may provide either:
- `data`: structured JSON value to serialize
- `text`: raw text content

Migration note:
- `write_output` accepts either `path` (legacy) or `output_id` (preferred).
- For new workflows, prefer `output_id` to keep contracts path-independent.

---

## Artifact-Backed Declared Outputs

Outputs can be declared with a logical `id` instead of (or in addition to) a filesystem `path`. Artifact-backed outputs are stored in the run artifact store and can be read, listed, and materialized via the `read_output`, `list_outputs`, and `materialize_output` tools.

### Declaring logical outputs in YAML

```yaml
name: My Pipeline
state:
  backend: filesystem          # filesystem | redis | auto | dual
  materialize_outputs: on_demand   # never | on_demand | always
  redis:
    provider: auto             # auto | mcp | native
    tool_prefix: MCP_DOCKER
steps:
  - id: build_report
    task: "Build and commit the daily report."
    outputs:
      # Path-only (legacy, unchanged):
      - path: data/report-{date}.json
        validate: report_schema

      # ID-only (artifact-backed, no filesystem path):
      - id: daily-summary
        validate: summary_schema

      # Both (artifact-backed + auto-materialized to path):
      - id: alert-manifest
        path: data/alerts-{date}.json
        materialize:
          mode: always
```

When a step output has only an `id`, workers use `write_output` with `output_id` instead of `path`:

```json
{
  "run_id": "my-pipeline-20260503T090000",
  "step_id": "build_report",
  "output_id": "daily-summary",
  "data": { "items": 42, "status": "ok" }
}
```

The artifact is stored in `{runsDir}/.artifacts/{runId}/{stepId}/{outputId}.json` and is accessible via `read_output` without materializing to disk.

Behavior:
- only allows writes to outputs declared for the current step
- reuses the existing validator layer; there are no extra YAML schema keys for writers
- rejects non-committable results such as validator `fail`
- allows committable non-pass results such as `blocked` or `retry` when that is what the validator contract declares
- persists provenance used by running-step early completion checks

If a worker manually writes a declared output instead of using `write_output`, the orchestrator may still validate it at final completion, but it will not trust that file for early completion while the worker session is still active.

### `read_output`

Read one declared artifact by `run_id`, `step_id`, and `output_id`.

| Parameter   | Type     | Required | Description |
|-------------|----------|----------|-------------|
| `run_id`    | string   | ✅       | Workflow run ID |
| `step_id`   | string   | ✅       | Producing step ID |
| `output_id` | string   | ✅       | Declared output `id` |
| `fields`    | string[] | ❌       | Restrict which keys are returned from the artifact (projection) |
| `limit`     | number   | ❌       | For array artifacts, return only the first N items |

### `list_outputs`

List committed declared artifacts for a run.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `run_id`  | string | ✅       | Workflow run ID |
| `step_id` | string | ❌       | Filter to a specific step |

### `materialize_output`

Materialize a stored artifact to the filesystem on demand.

| Parameter   | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `run_id`    | string | ✅       | Workflow run ID |
| `step_id`   | string | ✅       | Producing step ID |
| `output_id` | string | ✅       | Declared output `id` |
| `path`      | string | ❌       | Target filesystem path (overrides the output's declared `materialize.path`) |

### `workflow_state_get`

Debug/admin tool that returns raw run state including backend resolution metadata.

| Parameter       | Type    | Required | Description |
|-----------------|---------|----------|-------------|
| `run_id`        | string  | ✅       | Workflow run ID |
| `include_steps` | boolean | ❌       | Include full per-step state (default `true`). Set `false` for a compact summary. |

---

## Cache Reuse and Contract Freshness

Cache adoption is a first-class orchestration feature and follows this order:

1. Evaluate `reuse_outputs.when`.
2. Validate declared outputs using the same validator engine as normal completion.
3. Compare cached artifact signature with the **current** contract signature.
4. Adopt only if decision is accepted and signature is fresh.

This distinguishes:
- **invalid cache**: fails current validators.
- **stale cache**: passes structure, but signature differs (task/validator/schema/config/input/contract version changed).

Cache manifests are stored under `baseDir/.openclaw-workflow-cache/` and include producer run ID and signature metadata for auditability.

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
      "handoff_token": "seo-pipeline-20260309T082000:tech-auditor:attempt:1",
      "output_check": {
        "passed": true,
        "missing_files": [],
        "checked_files": ["/home/user/project/data/seo-state/ta-handoff-2026-03-09.json"]
      },
      "cache": {
        "hit": true,
        "adopted": true,
        "reason": "cache_hit",
        "current_contract_signature": "sha256:..."
      },
      "handoff": {
        "requested_at": "2026-03-09T08:23:12.000Z",
        "completed_at": "2026-03-09T08:23:15.000Z",
        "reason": "generated"
      },
      "output_writes": {
        "data/seo-state/ta-handoff-2026-03-09.json": {
          "path": "data/seo-state/ta-handoff-2026-03-09.json",
          "abs_path": "/home/user/project/data/seo-state/ta-handoff-2026-03-09.json",
          "decision": "pass",
          "run_id": "seo-pipeline-20260309T082000",
          "step_id": "tech-auditor",
          "attempt": 1,
          "bytes": 824,
          "sha256": "sha256:...",
          "committed_at": "2026-03-09T08:23:11.000Z"
        }
      },
      "error": null,
      "attempts": 1
    }
  }
}
```

**Run status values:** `pending` | `running` | `ok` | `failed` | `blocked` | `cancelled`

**Step status values:** `pending` | `running` | `ok` | `failed` | `blocked` | `skipped`

- `skipped`: Step was never run because a non-optional dependency failed
- `failed`: Step ran but failed (either session error or output gate failed)
- `ok`: Step ran successfully and output gate passed (or no outputs defined)

`output_writes` is internal provenance recorded by `write_output`. It is used to verify that early output-based completion came from the **current attempt** rather than a stale artifact or a direct manual file write.

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

**How it works:**
The engine resolves the list based on the format of the `for_each` value:

1. **Whole-Token References** (e.g., `{songs}`):
   - First, it looks for the key in the current context.
   - If not found or not an array, it falls back to looking for a file named `songs.json` in the workspace.
2. **Path Templates** (e.g., `manifest-{date}.json`):
   - Variables are substituted strictly. If a variable (like `{date}`) is missing or invalid, the workflow fails immediately.
   - The resulting path is then resolved as a file.
3. **Explicit Paths** (e.g., `songs.txt`):
   - Resolved directly as a file.

- **Expansion**: A loop step is expanded into multiple unique step instances, one for each item in the list. An instance ID follows the pattern `loop_id:index:inner_step_id`.
- **Dynamic Tasks**: Use the `{item}` variable in `task` or `outputs` fields to refer to the current iteration's value.
- **Dependency Resolution**: If a step depends on a loop step, it will wait for all instances of the last step in that loop to complete before starting.
- **List Parsing**: The loop resolves the `for_each` value using a `parser`:
  - `json` (default/auto for `.json`): Parses a JSON array.
  - `csv` (auto for `.csv`): Splits content by commas.
  - `newline` (auto for `.txt`): Treats each line as a separate item.
- **Example:**
  ```yaml
  steps:
    - id: find_songs
      name: "Find Songs"
      task: "Find today's liked songs and write them to songs.txt (one per line)"
      outputs: ["songs.txt"]

    - id: process_songs
      name: "Process Songs"
      depends_on: [find_songs]
      for_each: "songs.txt" 
      parser: "newline"
      steps:
        - id: transcribe
          task: "Transcribe {item}..."
  ```

- **Example with Validation:**
  Use `item_schema` to ensure the resolved list contains the expected data before expanding the loop:
  ```yaml
  - id: process_alerts
    for_each: "data/alerts/alerts-execution-manifest-{date}.json"
    parser: "json"
    item_schema:
      type: object
      required: [alert_key]
      properties:
        alert_key:
          type: string
          pattern: "^alert_[a-z0-9_:-]+$"
    steps:
      - id: notify
        task: "Send notification for {item.alert_key}"
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
 
 ### Concurrency Demo (`examples/concurrency-demo.yml`)
 
 Demonstrates how to use per-step concurrency limits to avoid rate-limiting on specific tasks while maintaining high global parallelism.
 
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

  2. **Native sessions**: `src/step-runner.ts` prefers the modern `api.runtime.subagent` API (via `RuntimeSubagentAdapter`), with fallbacks to a legacy `api.sessions` surface and finally the OpenClaw CLI.


3. **Notifications**: The plugin uses `api.notifications.send` if available and otherwise writes progress through `api.logger`.

### What OpenClaw should expose for full functionality
The plugin is designed to use the `api.runtime.subagent` surface for isolated background runs:

```typescript
interface PluginApi {
  // Already present:
  registerTool(tool: ToolDefinition): void;
  pluginConfig: Record<string, unknown>;

  // Preferred surface:
  runtime: {
    subagent: {
      run(args: { 
        sessionKey: string; 
        message: string; 
        provider?: string; 
        model?: string; 
        deliver: boolean 
      }): Promise<{ runId: string }>;
      waitForRun(args: { 
        runId: string; 
        timeoutMs: number 
      }): Promise<{ status: string; logs?: string; error?: string }>;
    };
  };
}
```

### Files created

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry: registers workflow tools (`workflow_run`, `workflow_status`, `workflow_list`, `workflow_cancel`, `workflow_step_update`, `workflow_step_complete`) |
| `src/config.ts` | Plugin configuration normalization |
| `src/workflow-loader.ts` | YAML/JSON parsing, validation, cycle detection |
| `src/workflow-executor.ts` | Core execution engine: scheduling, deps, retry, resume, dry run |
| `src/workflow-state.ts` | Atomic state file R/W, run listing |
| `src/state-artifact-stores.ts` | Filesystem-backed `WorkflowStateStore` / `WorkflowArtifactStore` implementations + `resolveStateBackend()` resolver |
| `src/state-contract-projector.ts` | Semantic state contract projector that maps validated artifacts to runtime Redis/state views |
| `src/step-runner.ts` | Session lifecycle: spawn, poll, output check. Includes MockAdapter |
| `src/output-checker.ts` | File existence validation for output gates |
| `src/output-validator.ts` | Advanced output content validation |
| `src/sealed-policy.ts` | Sealed-mode policy normalization and defaults |
| `src/sealed-spool.ts` | Sealed data-plane spooling and compact envelope helpers |
| `src/sealed-command-runner.ts` | `kind: sealed` command-mode bounded execution |
| `src/sealed-step-runner.ts` | Sealed step dispatcher (command vs worker paths) |
| `src/return-contract.ts` | AJV-based validation for sealed control-plane returns |
| `src/step-contract.ts` | Shared contract validation, cache signature freshness, and cache manifest I/O |
| `src/variable-substitution.ts` | `{date}`, `{datetime}`, `{utc_date}`, `{utc_datetime}`, `{run_id}` substitution |
| `src/list-resolver.ts` | Resolves `for_each` sources (JSON, CSV, Newline) |
| `src/template-schema-validator.ts` | Validates variable templates in workflow definitions |
| `src/tool-schemas.ts` | Tool parameter definitions for OpenClaw SDK |
| `src/types.ts` | Shared TypeScript interfaces and types |
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
