// @ts-nocheck
/**
 * @module workflow-executor
 * @description The core workflow execution engine. Orchestrates step scheduling,
 * dependency resolution, parallel execution, retry logic, and state management
 * for a complete workflow run.
 *
 * ## Architecture Overview
 *
 * The executor implements a **dependency-driven scheduler**:
 *
 * 1. On each tick (loop iteration), it scans all pending steps and determines
 *    which ones are now "ready" — meaning all their dependencies are in `ok`
 *    status (or `skipped` for optional deps, or OK for optional failed deps).
 *
 * 2. Ready steps that fit within the concurrency limit are launched immediately.
 *    Launched steps run in background (Promises); the loop doesn't await them.
 *
 * 3. The loop uses a simple poll-sleep approach rather than event-driven callbacks.
 *    This is intentional: it's simpler to reason about, tolerates step-runner
 *    failures gracefully, and the `TICK_INTERVAL` (500ms) is imperceptible.
 *
 * 4. When a step completes (via `stepPromises` resolution), the scheduler loop
 *    picks it up on the next tick and re-evaluates readiness.
 *
 * ## Dependency Resolution Rules
 *   - A step is ready when all `depends_on` steps have reached terminal state
 *   - Terminal states: `ok`, `failed` (only if optional), `skipped`
 *   - If a non-optional dependency fails, all transitively-dependent steps are
 *     marked `skipped` (not failed) — this prevents false failure counts
 *
 * ## Retry Logic
 *   - On failure, if `step.retry > 0` and `attempts < retry + 1`, re-queue the step
 *   - Wait `step.retry_delay` seconds before re-queuing
 *   - After all retries exhausted, mark as `failed`
 *
 * Dependencies: node:timers/promises, ./workflow-state.js, ./variable-substitution.js
 *
 * @example
 * import { executeWorkflow } from './workflow-executor.js';
 * const finalState = await executeWorkflow(workflowDef, runId, api, config, stepRunner);
 */

import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateWorkflowTemplates } from './template-schema-validator.js';
import {
  createRunState, updateRunState, updateStepState, saveRunState,
} from './workflow-state.js';
import { buildContext, substituteDeep, assertSafeOutputPath } from './variable-substitution.js';
import { resolveList, resolvePathToList, validateLoopItems } from './list-resolver.js';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

async function logSkipDebug(msg: string) {
  try {
    await appendFile(join(process.cwd(), 'skip-debug.log'), `${new Date().toISOString()} [executor] ${msg}\n`);
  } catch {}
}

/** Scheduler tick interval in milliseconds. Lower = more responsive but more CPU. */
const TICK_INTERVAL_MS = 500;

/**
 * @typedef {Object} ExecutorConfig
 * @property {string}   runsDir        - Directory for state files
 * @property {string}   baseDir        - Base directory for output path resolution
 * @property {number}   concurrency    - Max parallel steps (from workflow or config)
 * @property {string}   [notifyChannel]  - Channel to send notifications to
 * @property {number}   [pollIntervalMs] - Poll interval for step runners
 * @property {string}   [defaultModel]   - Default model for steps without a model
 * @property {Function} [notify]         - Function(message) for sending notifications
 * @property {'none'|'announce'} [cronDeliveryMode] - Delivery mode for cron jobs
 * @property {string}   [cronDeliveryChannel] - Delivery channel for cron jobs
 * @property {string}   [cronDeliveryTo] - Delivery target for cron jobs
 * @property {number}   [cliTimeoutMs] - General CLI timeout (ms)
 * @property {number}   [cronAddTimeoutMs] - Timeout for cron add (ms)
 * @property {number}   [cronRunTimeoutMs] - Timeout for cron run (ms)
 * @property {number}   [cronPollTimeoutMs] - Timeout for cron poll (ms)
 */

export async function compileWorkflow(workflow, runId, config) {
  validateWorkflowTemplates(workflow);
  const varCtx = buildContext(runId, workflow.config);
  const plannedSteps = [];

  for (const step of workflow.steps) {
    if (step.for_each) {
      plannedSteps.push({
        id: step.id,
        controller: step.id,
        dynamic: true,
        for_each: substituteDeep(step.for_each, varCtx),
        parser: step.parser || "auto",
        outputs: step.outputs || [],
      });

      continue;
    }

    const expanded = substituteDeep(step, varCtx);

    for (const output of expanded.outputs || []) {
      assertSafeOutputPath(output);
    }

    plannedSteps.push({
      id: step.id,
      outputs: expanded.outputs || [],
    });
  }

  return plannedSteps;
}

/**
 * Execute a workflow run to completion.

 *
 * This is the main entry point for the execution engine. It:
 *   1. Creates initial run state
 *   2. Runs the scheduling loop until all steps complete or the run is cancelled
 *   3. Marks the run as completed (ok, failed, or cancelled)
 *   4. Returns the final run state
 *
 * This function is intentionally async and long-running. The `workflow_run` tool
 * launches it in the background (not awaited) and returns immediately with the run_id.
 *
 * @param {import('./workflow-loader.js').WorkflowDefinition} workflow - Workflow definition
 * @param {string}         runId        - Pre-generated run ID
 * @param {Object}         api          - OpenClaw plugin api
 * @param {ExecutorConfig} config       - Executor configuration
 * @param {Function}       stepRunner   - Step runner function (injectable for testing)
 * @returns {Promise<import('./workflow-state.js').RunState>} Final run state
 *
 * @example
 * const finalState = await executeWorkflow(
 *   workflow,
 *   'seo-pipeline-20260309T082000',
 *   api,
 *   { runsDir, baseDir, concurrency: 3, notify: (msg) => console.log(msg) },
 *   runStep
 * );
 */
export async function executeWorkflow(workflow, runId, api, config, stepRunner = runStep, initialState = null) {
	try {
		await fs.mkdir(config.runsDir, { recursive: true });
		const plan = await compileWorkflow(workflow, runId, config);
		await fs.writeFile(join(config.runsDir, `${runId}.plan.json`), JSON.stringify(plan, null, 2));
	} catch (err) {
		const state = initialState ?? createRunState(workflow.name, workflow.steps.map(s => s.id), runId);
		return await updateRunState(state, {
			status: 'failed',
			phase: 'compile',
			error: err instanceof Error ? err.message : String(err),
			completed_at: new Date().toISOString(),
			spawned_sessions: 0,
		}, config.runsDir);
	}


	const {
		runsDir,
		baseDir,
		concurrency,
		notify = () => {},
		pollIntervalMs = 5000,
		defaultModel,
		sessionAdapter = 'auto',
		cronDeliveryMode = 'none',
		cronDeliveryChannel,
		cronDeliveryTo,
		cliTimeoutMs,
		cronAddTimeoutMs,
		cronRunTimeoutMs,
		cronPollTimeoutMs,
	} = config;



  // Build substitution context once for the entire run
  const varCtx = buildContext(runId, workflow.config);

   // Apply variable substitution to all top-level steps.
   // Loop steps are preserved as-is (their inner steps will be substituted during expansion).
   const steps = workflow.steps.map(step =>
     step.for_each ? { ...step } : substituteDeep(step, varCtx)
   );


  // Initialize run state — either use a provided initial state (for resume) or create fresh.

  // When resuming, the initialState already has 'ok' steps pre-populated so they are skipped.
  let state = initialState
    ? { ...initialState, run_id: runId }
    : createRunState(workflow.name, steps.map(s => s.id), runId);

  // Transition run to 'running' immediately (overwrites 'pending' from fresh create,
  // or re-sets 'failed'/'cancelled' to 'running' for a resume scenario)
  state = await updateRunState(state, { status: 'running', completed_at: null }, runsDir);

  // Map of step ID → Promise (for in-flight steps)
  /** @type {Map<string, Promise<void>>} */
  const inFlight = new Map();

  let cancelled = state.status === 'cancelled';

  // Map of step ID -> retry waiter. Resolving the waiter lets cancellation
  // drain in-flight promises without waiting for a long retry_delay.
  const retryWaiters = new Map();

  // Step definitions keyed by ID for O(1) lookup
   const stepMap = new Map(steps.map(s => [s.id, s]));
   /** @type {Map<string, number>} */
   const runningCounts = new Map();
   let stateWriteQueue = Promise.resolve();

  async function mutateState(mutator) {
    let nextState;
    stateWriteQueue = stateWriteQueue.then(async () => {
      try {
        nextState = await mutator(state);
        state = nextState;
      } catch (err) {
        api?.logger?.error?.(`[workflow:${runId}] state mutation failed`, err);
      }
    }).catch(err => {
      api?.logger?.error?.(`[workflow:${runId}] state queue error`, err);
    });
    await stateWriteQueue;
    return nextState;
  }

  /**
   * Determine if a step's dependencies are all satisfied.
   * A dependency is satisfied if:
   *   - It is 'ok', OR
   *   - It is 'skipped' (downstream of a failure), OR
   *   - It is 'failed' and marked optional
   *
   * @param {import('./workflow-loader.js').WorkflowStep} step
   * @returns {{ ready: boolean, blocked: boolean }}
   *   ready: true if all deps are satisfied (step can run)
   *   blocked: true if a non-optional dependency failed (step should be skipped)
   */
  function evalDependencies(step) {
    for (const depId of step.depends_on) {
      const depState = state.steps[depId];
      if (!depState) continue; // Shouldn't happen after validation, but be safe

      const depDef = stepMap.get(depId);
      const isOptional = depDef?.optional === true;

      if (depState.status === 'ok') continue;
      if (depState.status === 'skipped') continue;
      if (depState.status === 'failed' && isOptional) continue;
      if (depState.status === 'failed' && !isOptional) {
        return { ready: false, blocked: true };
      }
      // 'pending' or 'running' — not ready yet
      return { ready: false, blocked: false };
    }
    return { ready: true, blocked: false };
  }

  /**
   * Mark a step and all steps transitively depending on it as 'skipped'.
   * Called when a non-optional dependency fails.
   * State is saved after marking all skipped steps in one pass.
   *
   * @param {string} failedStepId - The step that failed
   */
  async function cascadeSkip(failedStepId) {
    const toSkip = [];
    // BFS to find all downstream steps
    const queue = [failedStepId];
    const visited = new Set();

    while (queue.length > 0) {
      const current = queue.shift();
      for (const step of steps) {
        if (step.depends_on.includes(current) && !visited.has(step.id)) {
          const currentStatus = state.steps[step.id]?.status;
          if (currentStatus === 'pending') {
            visited.add(step.id);
            toSkip.push(step.id);
            queue.push(step.id);
          }
        }
      }
    }

    for (const stepId of toSkip) {
      await mutateState(current => updateStepState(current, stepId, { status: 'skipped' }, runsDir));
    }
  }

  function clearRetryWaiters() {
    cancelled = true;
    for (const waiter of retryWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    retryWaiters.clear();
  }

  async function waitForRetry(stepId, retryDelaySeconds) {
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        retryWaiters.delete(stepId);
        resolve();
      }, retryDelaySeconds * 1000);
      retryWaiters.set(stepId, { timer, resolve });
    });
  }

  /**
   * Launch a single step as a background Promise.
   * Updates state to 'running', runs the step, then handles the result.
   *
   * @param {import('./workflow-loader.js').WorkflowStep} step
   */
   function launchStep(step) {
     if (cancelled) return;

     const trackingId = step.original_id || step.id;
     runningCounts.set(trackingId, (runningCounts.get(trackingId) || 0) + 1);

     // Increment attempts before launch
    const attempts = (state.steps[step.id]?.attempts || 0) + 1;

    // Mark as running immediately (synchronously update our local state snapshot)
    // We save this in the background — don't await here to avoid blocking the scheduler
    mutateState(current => updateStepState(current, step.id, {
      status: 'running',
      started_at: new Date().toISOString(),
      attempts,
    }, runsDir)).catch(err => {
      api?.logger?.error?.(`[workflow:${runId}] failed to mark step running`, err);
    });

    const promise = (async () => {
      try {
        // Path safety gate: ensure substituted output paths are safe before execution
        if (step.outputs) {
          for (const outPath of step.outputs) {
            assertSafeOutputPath(outPath);
          }
        }

        let result;
		try {
			result = await stepRunner(step, runId, api, {
				pollIntervalMs,
				baseDir,
				defaultModel,
				cronDeliveryMode,
				cronDeliveryChannel,
				cronDeliveryTo,
				cliTimeoutMs,
				cronAddTimeoutMs,
				cronRunTimeoutMs,
				cronPollTimeoutMs,
				sessionAdapter,
			});
		} catch (err) {

          result = {
            status: 'failed',
            session_key: null,
            output_check: { passed: false, missing_files: [], checked_files: [] },
            error: err.message,
            duration_ms: 0,
          };
        }

        const completedAt = new Date().toISOString();
        const startedAt = state.steps[step.id]?.started_at;
        const durationMs = result.duration_ms ||
          (startedAt ? Date.now() - new Date(startedAt).getTime() : 0);

         if (result.status === 'ok') {
          // Success path
          await mutateState(current => updateStepState(current, step.id, {
            status: 'ok',
            completed_at: completedAt,
            duration_ms: durationMs,
            session_key: result.session_key,
            output_check: result.output_check,
            error: null,
            logs: result.logs,
            attempts,
          }, runsDir));
          
          const durationSec = Math.round(durationMs / 1000);
          await notify(`✅ ${step.name} complete (${durationSec}s)`);

        } else {
          // Failure path — check for retry
           const maxAttempts = (step.retry || 0) + 1;
          const shouldRetry = attempts < maxAttempts;

          if (shouldRetry) {
            // Notify retry, schedule re-launch after retry_delay
            const nextAttempt = attempts + 1;
            await notify(`❌ ${step.name} failed — retrying (attempt ${nextAttempt}/${maxAttempts})`);

            // Mark as pending again so the scheduler will re-launch
             await mutateState(current => updateStepState(current, step.id, {
              status: 'pending',
              error: result.error,
              logs: result.logs,
              attempts, // keep the attempt count so we know we've retried
            }, runsDir));

            await waitForRetry(step.id, step.retry_delay);
            if (cancelled) return;

          } else {
            // All retries exhausted — mark as failed
            await mutateState(current => updateStepState(current, step.id, {
              status: 'failed',
              completed_at: completedAt,
              duration_ms: durationMs,
              session_key: result.session_key,
              output_check: result.output_check,
              error: result.error,
              logs: result.logs,
              attempts,
            }, runsDir));

            const wasRetried = step.retry > 0;
            if (wasRetried) {
              await notify(`❌ ${step.name} failed after ${attempts} attempt(s): ${result.error}`);
            } else {
              await notify(`❌ ${step.name} failed: ${result.error}`);
            }

            // If not optional, cascade skip to dependent steps
            if (!step.optional) {
              await cascadeSkip(step.id);
            } else {
              // Optional failure — log it but don't cascade
              await notify(`⚠️  ${step.name} failed (optional — continuing pipeline)`);
            }
          }
        }
       } finally {
         // Remove from in-flight map when done (whether ok, failed, or retrying)
         inFlight.delete(step.id);
         const trackingId = step.original_id || step.id;
         runningCounts.set(trackingId, Math.max(0, (runningCounts.get(trackingId) || 1) - 1));
       }
     })();

    inFlight.set(step.id, promise);
  }

  // ── Main scheduling loop ───────────────────────────────────────────────────
  // Runs until all steps reach a terminal state or the run is cancelled.
  let iterationGuard = 0;
  const MAX_ITERATIONS = 100000; // Safety valve against infinite loops

    while (iterationGuard++ < MAX_ITERATIONS) {
      // ── Loop Controller Status Update ────────────────────────────────────────
      // Check if any running loop-controllers have all their iterations finished.
      for (const step of steps) {
        if (step.for_each && state.steps[step.id]?.status === 'running') {
           const childrenIds = Object.keys(state.steps).filter(id => id.startsWith(`${step.id}:`));
           const childStates = childrenIds.map(id => state.steps[id]?.status);

           if (childrenIds.length > 0 && childStates.every(s => ['ok', 'failed', 'skipped'].includes(s))) {
             const anyFailed = childStates.includes('failed');
             const startedAt = state.steps[step.id]?.started_at;
             const completedAt = new Date().toISOString();
             const durationMs = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;

             await mutateState(current => updateStepState(current, step.id, { 
               status: anyFailed && !step.optional ? 'failed' : 'ok', 
               completed_at: completedAt,
               duration_ms: durationMs
             }, runsDir));

             if (anyFailed && !step.optional) {
               await cascadeSkip(step.id);
             }
             await notify(`${anyFailed && !step.optional ? '❌' : '✅'} Loop "${step.id}" complete`);
           }
        }
      }

      // Re-read state from disk to pick up external cancellation signals

    // (Do this every ~10 ticks to avoid excessive I/O; in-flight updates
    //  are already applied to our local `state` variable.)
    if (iterationGuard % 10 === 0) {
      try {
        const { readRunState } = await import('./workflow-state.js');
        const diskState = await readRunState(runId, runsDir);
        if (diskState.status === 'cancelled') {
          // External cancel: unblock retry waits, drain active promises, and exit.
          clearRetryWaiters();
          await Promise.allSettled([...inFlight.values()]);
          return diskState;
        }
      } catch {
        // If we can't read the state file, continue with in-memory state
      }
    }

    // Check if all steps have reached terminal status
    const allTerminal = steps.every(s => {
      const status = state.steps[s.id]?.status;
      return ['ok', 'failed', 'skipped'].includes(status);
    });

    if (allTerminal) break;

    // Launch ready steps up to concurrency limit
    const slotsAvailable = concurrency - inFlight.size;

     if (slotsAvailable > 0) {
       // Find all pending steps that could be launched
       for (const step of steps) {
         if (inFlight.size >= concurrency) break;
         if (state.steps[step.id]?.status !== 'pending') continue;
         if (inFlight.has(step.id)) continue; // Already tracked

         if (step.concurrency) {
           const trackingId = step.original_id || step.id;
           const currentRunning = runningCounts.get(trackingId) || 0;
           if (currentRunning >= step.concurrency) continue;
         }

         const { ready, blocked } = evalDependencies(step);

        if (blocked) {
          // Dep failed and not optional — skip this step
          await mutateState(current => updateStepState(current, step.id, { status: 'skipped' }, runsDir));
          continue;
        }

    if (ready) {
      if (step.for_each) {
        // ── Dynamic Loop Expansion ─────────────────────────────────────────────
        
        // 1. Resolve the list for this iteration
        let list: any[];

        try {
          list = await resolveList(step.for_each, varCtx, baseDir, step.parser);
          validateLoopItems(step, list);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);

          await mutateState(current =>
            updateStepState(current, step.id, {
              status: 'failed',
              completed_at: new Date().toISOString(),
              error: message,
              attempts: state.steps[step.id]?.attempts || 0,
              output_check: {
                passed: false,
                missing_files: [],
                checked_files: [],
              },
            }, runsDir)
          );

          if (!step.optional) {
            await cascadeSkip(step.id);
          }

          await notify(`❌ Loop "${step.id}" failed before expansion: ${message}`);
          continue;
        }
        const expandedChildren = [];
        
        if (list.length > 0) {
          let innerStepsDef = step.steps || [];
          if (innerStepsDef.length === 0 && step.task) {
            innerStepsDef = [{
              id: 'task',
              name: step.name,
              task: step.task,
              concurrency: step.concurrency,
              timeout: step.timeout,
              retry: step.retry,
              retry_delay: step.retry_delay,
              optional: step.optional,
              outputs: step.outputs,
              depends_on: [],
            }];
          }
          const lastInnerId = innerStepsDef.length > 0 ? innerStepsDef[innerStepsDef.length - 1].id : null;
           for (let i = 0; i < list.length; i++) {
            const item = list[i];
            const prefix = `${step.id}:${i}:`;
            const itemCtx = { ...varCtx, item };

            // Expand and substitute inner steps
            for (const innerDef of innerStepsDef) {
              const substitutedInner = substituteDeep(innerDef, itemCtx);
              
               // Assign unique expanded ID and update its internal dependencies
               substitutedInner.id = prefix + substitutedInner.id;
               substitutedInner.original_id = `${step.id}:${substitutedInner.id.split(':').pop()}`;
               substitutedInner.depends_on = (substitutedInner.depends_on || []).map(depId => {
                if (innerStepsDef.some(s => s.id === depId)) {
                  return prefix + depId;
                }
                return depId;
              });

              expandedChildren.push(substitutedInner);
            }
          }

          // 2. Inject new steps into the active workflow list and state
          for (const child of expandedChildren) {
            steps.push(child);
            await mutateState(current => updateStepState(current, child.id, { status: 'pending' }, runsDir));
          }

          // 3. Rewire downstream dependencies
          // Any step that depends on this loop step should now depend on the last step of every iteration.
          if (lastInnerId) {
            for (const s of steps) {
              if (s.depends_on.includes(step.id)) {
                const newDeps = s.depends_on.filter(d => d !== step.id);
                const lastSteps = expandedChildren
                  .filter(c => c.id.endsWith(`:${lastInnerId}`))
                  .map(c => c.id);
                s.depends_on = [...newDeps, ...lastSteps];
              }
            }
          }
        }

        // Mark the loop-controller step as 'running' if there are iterations, otherwise 'ok'
        if (expandedChildren.length > 0) {
          await mutateState(current => updateStepState(current, step.id, { 
            status: 'running', 
            started_at: new Date().toISOString(),
          }, runsDir));
        } else {
          await mutateState(current => updateStepState(current, step.id, { 
            status: 'ok', 
            completed_at: new Date().toISOString(),
            duration_ms: 0 
          }, runsDir));
        }
        
        if (list.length > 0) {
          await notify(`🔄 Expanded loop "${step.id}" into ${list.length} iterations`);
        }
        continue; // Move to next tick to pick up new steps
      }
      
      if (step.skip_if_empty) {
        const checkPath = substituteDeep(step.skip_if_empty, varCtx);
        await notify(`🔍 Checking skip_if_empty for ${step.id}: ${checkPath}`);
        await logSkipDebug(`Checking skip_if_empty for ${step.id}. Raw: ${step.skip_if_empty}, Resolved: ${checkPath}`);
        
        const list = await resolvePathToList(checkPath, baseDir);
        await notify(`📊 List length for ${step.id}: ${list.length}`);
        await logSkipDebug(`Resolved list for ${step.id}. Length: ${list.length}, Value: ${JSON.stringify(list)}`);
        
        if (list.length === 0) {
          await logSkipDebug(`Decision: SKIP ${step.id} (list length is 0)`);
          await mutateState(current => updateStepState(current, step.id, { 
            status: 'ok', 
            completed_at: new Date().toISOString(),
            duration_ms: 0 
          }, runsDir));
          await notify(`⏩ Skipped ${step.name} (input data empty)`);
          continue;
        }
        await logSkipDebug(`Decision: PROCEED ${step.id} (list length is ${list.length})`);
      }
      launchStep(step);
    }

      }
    }

    // Wait before next tick
    await sleep(TICK_INTERVAL_MS);
  }

  // Wait for any remaining in-flight promises to settle
  await Promise.allSettled([...inFlight.values()]);

  // ── Determine final run status ─────────────────────────────────────────────
  // Only non-optional step failures cause the pipeline to fail.
  // Optional step failures are expected and don't block dependents or
  // count against the overall pipeline result.
  const finalStepStatuses = Object.values(state.steps).map(s => s.status);
  const anyNonOptionalFailed = steps.some(s => {
    const stepState = state.steps[s.id];
    return !s.optional && stepState?.status === 'failed';
  });
  const finalStatus = anyNonOptionalFailed ? 'failed' : 'ok';

  state = await updateRunState(state, {
    status: finalStatus,
    completed_at: new Date().toISOString(),
  }, runsDir);

  // ── Final notification ─────────────────────────────────────────────────────
  const okCount = finalStepStatuses.filter(s => s === 'ok').length;
  const totalCount = steps.length;

  if (finalStatus === 'ok') {
    await notify(`🏁 Pipeline "${workflow.name}" complete — ${okCount}/${totalCount} steps passed`);
  } else {
    const failedCount = finalStepStatuses.filter(s => s === 'failed').length;
    await notify(
      `💥 Pipeline "${workflow.name}" failed — ${failedCount} step(s) failed, ${okCount}/${totalCount} passed`
    );
  }

  return state;
}

/**
 * Resume a previously failed or partial workflow run.
 * Resets steps that previously failed (or were skipped due to failures)
 * back to 'pending' so they can be retried, while keeping 'ok' steps intact.
 *
 * @param {import('./workflow-state.js').RunState} previousState - State from previous run
 * @param {import('./workflow-loader.js').WorkflowDefinition} workflow - Workflow definition
 * @param {string} newRunId - New run ID for this resume attempt
 * @param {Object} api - OpenClaw plugin api
 * @param {ExecutorConfig} config - Executor configuration
 * @param {Function} stepRunner - Step runner function
 * @returns {Promise<import('./workflow-state.js').RunState>}
 *
 * @example
 * // Resume after a partial failure:
 * const finalState = await resumeWorkflow(failedState, workflow, newRunId, api, config, stepRunner);
 */
export async function resumeWorkflow(previousState, workflow, newRunId, api, config, stepRunner) {
  const { runsDir } = config;

  // Build a new state based on the previous one, resetting non-ok steps.
  // Steps that were 'ok' in the previous run are preserved — they'll be
  // skipped by the executor's scheduler loop (which only launches 'pending' steps).
  let state = createRunState(
    workflow.name,
    workflow.steps.map(s => s.id),
    newRunId,
  );

  // Copy over 'ok' steps from previous run (preserve their results)
  for (const [stepId, stepState] of Object.entries(previousState.steps)) {
    if (stepState.status === 'ok') {
      state.steps[stepId] = { ...stepState };
    }
    // All other statuses (failed, skipped, running) remain as 'pending' (reset to retry)
  }

  // Save the bootstrapped state before running so it's on disk for status checks
  await saveRunState(state, runsDir);

  // Pass initialState so executeWorkflow doesn't overwrite our pre-seeded ok steps
  return executeWorkflow(workflow, newRunId, api, config, stepRunner, state);
}

/**
 * Perform a dry run — validate the workflow and report what would execute.
 * Does not spawn any sessions or write any run state.
 *
 * @param {import('./workflow-loader.js').WorkflowDefinition} workflow - Workflow definition
 * @param {string} runId - The run ID that would be used
 * @returns {Object} Dry run report with execution plan
 *
 * @example
 * const report = dryRun(workflow, 'seo-pipeline-20260309T082000');
 * console.log(report.execution_plan);
 */
export function dryRun(workflow, runId) {
  const varCtx = buildContext(runId, workflow.config);
  const steps = workflow.steps.map(step => step.for_each ? { ...step } : substituteDeep(step, varCtx));

  // Build execution waves (steps with no unresolved deps execute together)
  const waves = [];
  const completed = new Set();
  let remaining = [...steps];

  while (remaining.length > 0) {
    const wave = remaining.filter(step => {
      if (step.for_each) return true; // Loops are always ready as they are controllers
      return step.depends_on.every(dep => completed.has(dep));
    });

    if (wave.length === 0) {
      break;
    }

    waves.push(wave.map(s => ({
      id: s.id,
      name: s.name,
      model: s.model,
      timeout_s: s.timeout,
      retry: s.retry,
      optional: s.optional,
      outputs: s.outputs,
      is_dynamic_loop: !!s.for_each,
    })));

    wave.forEach(s => completed.add(s.id));
    remaining = remaining.filter(s => !completed.has(s.id));
  }

  return {
    run_id: runId,
    workflow: workflow.name,
    description: workflow.description,
    total_steps: steps.length,
    concurrency: workflow.concurrency,
    execution_waves: waves,
    estimated_min_duration_s: waves.reduce((sum, wave) => {
      const maxTimeout = Math.max(...wave.map(s => s.timeout_s || 0));
      return sum + maxTimeout;
    }, 0),
    variable_context: varCtx,
  };
}

