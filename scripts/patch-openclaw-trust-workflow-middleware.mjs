#!/usr/bin/env node
/**
 * Patch OpenClaw so one trusted external plugin can register
 * agentToolResultMiddleware, and so Pi tool-result middleware receives
 * stable workflow/subagent identity.
 *
 * v6:
 *   - targeted by default: patches known OpenClaw 2026.4.29 chunks only
 *   - no broad dist scan unless --discover is passed
 *   - idempotent: upgrades stale prior openclaw-workflow patches in-place
 *   - no restore required before repatching
 *   - patches trust guard for one external plugin
 *   - patches PI middleware context factory
 *   - patches buildEmbeddedExtensionFactories callsites to pass:
 *       runId: params.runId
 *       sessionId: params.sessionId
 *       sessionKey: params.sessionKey
 *   - fixes previous sessionKey fallback bug caused by false ?? fallback
 *
 * Usage:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --plugin openclaw-workflow
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --plugin openclaw-workflow --dry-run
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --plugin openclaw-workflow --all
 *
 * Discovery fallback for future OpenClaw builds:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --plugin openclaw-workflow --discover --dry-run
 *
 * Restore latest backup for targeted files:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --restore
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_PLUGIN_ID = "openclaw-workflow";

const TRUST_PATCH_MARKER =
  "openclaw-workflow trusted external agentToolResultMiddleware patch";

const PI_CONTEXT_PATCH_MARKER = "openclaw-workflow pi middleware context patch";
const PI_CONTEXT_PATCH_VERSION = 6;
const PI_CONTEXT_PATCH_VERSION_MARKER =
  `${PI_CONTEXT_PATCH_MARKER} v${PI_CONTEXT_PATCH_VERSION}`;

const FUNCTION_NAME = "registerAgentToolResultMiddleware";

const DIAGNOSTIC =
  "only bundled plugins can register agent tool result middleware";

const MAX_CANDIDATE_BYTES = 80 * 1024 * 1024;

/**
 * Known target chunks from your OpenClaw 2026.4.29 dry run.
 * These are exact default targets. Broad discovery is opt-in via --discover.
 */
const KNOWN_TARGET_RELATIVE_FILES = [
  "dist/compact-D7fdm3i4.js",
  "dist/selection-CwAy0mf2.js",
  "dist/compaction-successor-transcript-DQe2lN3x.js",
  "dist/loader-CLyHx60E.js",
];

const args = parseArgs(process.argv.slice(2));

const pluginId = String(args.plugin ?? DEFAULT_PLUGIN_ID);
const dryRun = Boolean(args["dry-run"]);
const restore = Boolean(args.restore);
const all = Boolean(args.all);
const discover = Boolean(args.discover);
const verbose = Boolean(args.verbose);
const printTargets = Boolean(args["print-targets"]);
const exactFile = args.file ? path.resolve(String(args.file)) : null;
const explicitRoot = args.root ? path.resolve(String(args.root)) : null;
const requirePiContext = args["require-pi-context"] !== "false";
const requirePiCallsite = args["require-pi-callsite"] !== "false";

if (isDirectExecution(import.meta.url)) {
  main();
}

function main() {
  assertSafePluginId(pluginId);

  console.log(`Plugin allowed for middleware: ${pluginId}`);
  console.log(`Dry run: ${dryRun ? "yes" : "no"}`);
  console.log(`Restore: ${restore ? "yes" : "no"}`);
  console.log(`Patch all runtime deps: ${all ? "yes" : "no"}`);
  console.log(`Discover mode: ${discover ? "yes" : "no"}`);
  console.log(`Verbose scan: ${verbose ? "yes" : "no"}`);
  console.log(`Require Pi context patch: ${requirePiContext ? "yes" : "no"}`);
  console.log(`Require Pi callsite patch: ${requirePiCallsite ? "yes" : "no"}`);

  const targets = exactFile
    ? uniqueExistingFiles([exactFile])
    : findTargets({ explicitRoot, all, discover });

  if (targets.length === 0) {
    throw new Error(
      [
        "Could not find OpenClaw patch targets.",
        "",
        "Default mode only checks known OpenClaw 2026.4.29 target chunks:",
        ...KNOWN_TARGET_RELATIVE_FILES.map((value) => `  - ${value}`),
        "",
        "If your OpenClaw build changed chunk names, run discovery mode:",
        "  node scripts/patch-openclaw-trust-workflow-middleware.mjs --discover --dry-run",
        "",
        "Or exact-file mode:",
        '  node scripts/patch-openclaw-trust-workflow-middleware.mjs --file "C:\\path\\to\\openclaw\\dist\\some-chunk.js" --dry-run',
      ].join("\n"),
    );
  }

  console.log("\nTarget file(s):");
  for (const target of targets) {
    console.log(`  - ${target}`);
  }

  if (printTargets) {
    return;
  }

  if (restore) {
    for (const target of targets) {
      restoreLatestBackupForFile(target);
    }
    return;
  }

  const summary = {
    trust: { found: false, patchedOrAlreadyPresent: false, files: [] },
    piContext: { found: false, patchedOrAlreadyPresent: false, files: [] },
    piCallsite: { found: false, patchedOrAlreadyPresent: false, files: [] },
  };

  for (const target of targets) {
    const result = patchTargetFile(target, pluginId, { dryRun });

    if (result.trustTargetFound) {
      summary.trust.found = true;
    }
    if (result.trustPatched || result.trustAlreadyPatched) {
      summary.trust.patchedOrAlreadyPresent = true;
      summary.trust.files.push(target);
    }

    if (result.piContextTargetFound) {
      summary.piContext.found = true;
    }
    if (result.piContextPatched || result.piContextAlreadyPatched) {
      summary.piContext.patchedOrAlreadyPresent = true;
      summary.piContext.files.push(target);
    }

    if (result.piCallsiteTargetFound) {
      summary.piCallsite.found = true;
    }
    if (result.piCallsitePatched || result.piCallsiteAlreadyPatched) {
      summary.piCallsite.patchedOrAlreadyPresent = true;
      summary.piCallsite.files.push(target);
    }
  }

  printSummary(summary);

  if (!summary.trust.patchedOrAlreadyPresent) {
    throw new Error("OpenClaw trust guard was not patched or already present.");
  }

  if (requirePiContext && !summary.piContext.patchedOrAlreadyPresent) {
    throw new Error(
      "Pi middleware context patch was not applied. Browser tool-result sealing is not guaranteed.",
    );
  }

  if (requirePiCallsite && !summary.piCallsite.patchedOrAlreadyPresent) {
    throw new Error(
      "Pi callsite patch was not applied. buildEmbeddedExtensionFactories may still lack run/session identity. Try --discover --dry-run.",
    );
  }

  console.log("\nDone.");
  console.log(
    "Restart OpenClaw/gateway, run one browser tool call inside a workflow step, then check workflow_runtime_patch_status.",
  );
  console.log('Expected: "sealed" increases and "no_active_run" stays near 0.');
}

function findTargets({ explicitRoot, all, discover }) {
  console.log("\n[patch] target discovery started");

  if (explicitRoot) {
    console.log(`[patch] using explicit root: ${explicitRoot}`);
    return findRuntimeFilesInPackageRoot(explicitRoot, { discover });
  }

  const roots = [
    ...knownGlobalOpenClawPackageRoots(),
    ...runtimeDependencyRoots({ all }),
  ];

  const uniqueRoots = uniqueExistingDirs(roots);

  console.log(`[patch] package roots found: ${uniqueRoots.length}`);
  for (const root of uniqueRoots) {
    console.log(`  - ${root}`);
  }

  const targets = [];

  for (const root of uniqueRoots) {
    console.log(`[patch] checking root: ${root}`);
    targets.push(...findRuntimeFilesInPackageRoot(root, { discover }));
  }

  const uniqueTargets = uniqueExistingFiles(targets);

  console.log(
    `[patch] target discovery finished: ${uniqueTargets.length} file(s)`,
  );

  return uniqueTargets;
}

function knownGlobalOpenClawPackageRoots() {
  const roots = [];

  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      roots.push(path.join(process.env.APPDATA, "nvm", "node_modules", "openclaw"));
      roots.push(path.join(process.env.APPDATA, "npm", "node_modules", "openclaw"));
      roots.push(
        path.join(
          process.env.APPDATA,
          "npm",
          "node_modules",
          "@openclaw",
          "openclaw",
        ),
      );
    }
  } else {
    roots.push("/usr/local/lib/node_modules/openclaw");
    roots.push("/opt/homebrew/lib/node_modules/openclaw");
    roots.push("/usr/local/lib/node_modules/@openclaw/openclaw");
    roots.push("/opt/homebrew/lib/node_modules/@openclaw/openclaw");
  }

  return roots;
}

function runtimeDependencyRoots({ all }) {
  const runtimeDepsRoot = path.join(
    os.homedir(),
    ".openclaw",
    "plugin-runtime-deps",
  );

  if (!fs.existsSync(runtimeDepsRoot)) {
    console.log(`[patch] runtime deps root missing: ${runtimeDepsRoot}`);
    return [];
  }

  const packages = fs
    .readdirSync(runtimeDepsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => entry.name.startsWith("openclaw-"))
    .map((entry) => {
      const full = path.join(runtimeDepsRoot, entry.name);
      const stat = fs.statSync(full);
      return {
        full,
        name: entry.name,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const selected = all ? packages : packages.slice(0, 1);

  console.log(
    `[patch] runtime dep packages selected: ${selected.length}/${packages.length}`,
  );

  return selected.map((pkg) => pkg.full);
}

function findRuntimeFilesInPackageRoot(packageRoot, { discover }) {
  const root = path.resolve(packageRoot);

  const knownTargets = knownTargetFilesForPackageRoot(root);
  const existingKnownTargets = uniqueExistingFiles(knownTargets);

  console.log(
    `[patch] known target files under ${root}: ${existingKnownTargets.length}/${knownTargets.length}`,
  );

  if (existingKnownTargets.length > 0) {
    for (const file of existingKnownTargets) {
      console.log(`[patch] known target: ${file}`);
    }
  }

  const missingKnownTargets = knownTargets.filter((file) => !fs.existsSync(file));
  if (missingKnownTargets.length > 0) {
    console.log(`[patch] missing known targets under ${root}:`);
    for (const file of missingKnownTargets) {
      console.log(`  - ${file}`);
    }
  }

  if (!discover) {
    return existingKnownTargets;
  }

  console.log(`[patch] discover mode enabled for ${root}`);

  const discovered = discoverCandidateFilesForPackageRoot(root);

  return uniqueExistingFiles([...existingKnownTargets, ...discovered]);
}

function knownTargetFilesForPackageRoot(root) {
  return KNOWN_TARGET_RELATIVE_FILES.map((relative) =>
    path.join(root, ...relative.split("/")),
  );
}

function discoverCandidateFilesForPackageRoot(root) {
  const candidates = candidateFilesForPackageRoot(root);

  console.log(`[patch] discovery candidates under ${root}: ${candidates.length}`);

  const matches = [];
  const scanStats = {
    skippedByNeedle: 0,
    inspected: 0,
  };

  for (const file of candidates) {
    const kind = inspectCandidateFile(file, scanStats);
    if (!kind.match) {
      continue;
    }

    console.log(`[patch] discovered ${kind.reason}: ${file}`);
    matches.push(file);
  }

  console.log(
    `[patch] discovery summary under ${root}: inspected=${scanStats.inspected}, skipped_by_prefilter=${scanStats.skippedByNeedle}, matches=${matches.length}`,
  );

  return uniqueExistingFiles(matches);
}

function candidateFilesForPackageRoot(root) {
  const out = [];

  out.push(path.join(root, "src", "agents", "pi-embedded-runner", "extensions.ts"));
  out.push(path.join(root, "src", "agents", "pi-embedded-runner", "run", "attempt.ts"));
  out.push(path.join(root, "src", "plugins", "registry.ts"));
  out.push(path.join(root, "src", "plugins", "registry.js"));

  const dist = path.join(root, "dist");

  if (fs.existsSync(dist) && fs.statSync(dist).isDirectory()) {
    const entries = fs
      .readdirSync(dist, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .filter((entry) => /\.(js|mjs|cjs)$/.test(entry.name))
      .map((entry) => path.join(dist, entry.name))
      .sort();

    out.push(...entries);
  }

  out.push(
    path.join(root, "dist", "agents", "pi-embedded-runner", "extensions.js"),
    path.join(root, "dist", "agents", "pi-embedded-runner", "extensions.mjs"),
    path.join(root, "dist", "agents", "pi-embedded-runner", "extensions.cjs"),
    path.join(root, "dist", "agents", "pi-embedded-runner", "run", "attempt.js"),
    path.join(root, "dist", "agents", "pi-embedded-runner", "run", "attempt.mjs"),
    path.join(root, "dist", "agents", "pi-embedded-runner", "run", "attempt.cjs"),
  );

  return uniqueExistingFiles(out);
}

function inspectCandidateFile(file, scanStats = undefined) {
  if (!fs.existsSync(file)) return { match: false, reason: "missing" };

  const stat = fs.statSync(file);
  if (!stat.isFile()) return { match: false, reason: "not-file" };

  if (stat.size > MAX_CANDIDATE_BYTES) {
    console.warn(`[patch] skipping large candidate (${stat.size} bytes): ${file}`);
    return { match: false, reason: "too-large" };
  }

  const text = fs.readFileSync(file, "utf8");

  if (!hasAnyPatchNeedle(text)) {
    if (scanStats) scanStats.skippedByNeedle += 1;
    return { match: false, reason: "prefilter" };
  }

  if (scanStats) scanStats.inspected += 1;
  if (verbose) console.log(`[patch] inspecting: ${file}`);

  if (isRelevantRuntimeFile(text) || isAlreadyPatchedTrustFile(text)) {
    return { match: true, reason: "trust_guard" };
  }

  if (isRelevantPiContextFile(file, text)) {
    return { match: true, reason: "pi_context" };
  }

  const callsite = getPiCallsitePatchInfo(text);
  if (callsite.found) {
    return {
      match: true,
      reason: callsite.current ? "pi_callsite_current" : "pi_callsite",
    };
  }

  return { match: false, reason: "not-relevant" };
}

function hasAnyPatchNeedle(source) {
  return (
    source.includes(FUNCTION_NAME) ||
    source.includes(DIAGNOSTIC) ||
    source.includes(TRUST_PATCH_MARKER) ||
    source.includes(PI_CONTEXT_PATCH_MARKER) ||
    source.includes("buildAgentToolResultMiddlewareFactory") ||
    source.includes("createAgentToolResultMiddlewareRunner") ||
    source.includes("buildEmbeddedExtensionFactories")
  );
}

function patchTargetFile(target, pluginId, options = {}) {
  const before = fs.readFileSync(target, "utf8");

  const trustTargetFound =
    isRelevantRuntimeFile(before) || isAlreadyPatchedTrustFile(before);

  const piContextTargetFound = isRelevantPiContextFile(target, before);
  const piCallsiteTargetFound = getPiCallsitePatchInfo(before).found;

  let after = before;
  let trustPatched = false;
  let piContextPatched = false;
  let piCallsitePatched = false;

  if (isRelevantRuntimeFile(after)) {
    const next = patchRuntimeFile(after, pluginId);
    if (next !== after) {
      after = next;
      trustPatched = true;
    }
  }

  if (isRelevantPiContextFile(target, after)) {
    const next = patchPiContextFile(after, target);
    if (next !== after) {
      after = next;
      piContextPatched = true;
    }
  }

  if (getPiCallsitePatchInfo(after).found) {
    const next = patchPiCallsiteFile(after);
    if (next !== after) {
      after = next;
      piCallsitePatched = true;
    }
  }

  const changed = after !== before;

  const trustAlreadyPatched =
    trustTargetFound && !trustPatched && after.includes(TRUST_PATCH_MARKER);

  const piContextAlreadyPatched =
    piContextTargetFound && !piContextPatched && isCurrentPiContextPatched(after);

  const piCallsiteAlreadyPatched =
    piCallsiteTargetFound &&
    !piCallsitePatched &&
    getPiCallsitePatchInfo(after).current;

  if (!changed) {
    if (trustAlreadyPatched || piContextAlreadyPatched || piCallsiteAlreadyPatched) {
      console.log(`\nAlready patched/current: ${target}`);
    } else if (trustTargetFound || piContextTargetFound || piCallsiteTargetFound) {
      console.warn(`\nFound target but could not apply patch: ${target}`);
      printPatchDiagnosticSnippet(after, target);
    } else {
      console.log(`\nNo patch needed: ${target}`);
    }

    return {
      trustTargetFound,
      trustPatched: false,
      trustAlreadyPatched,
      piContextTargetFound,
      piContextPatched: false,
      piContextAlreadyPatched,
      piCallsiteTargetFound,
      piCallsitePatched: false,
      piCallsiteAlreadyPatched,
    };
  }

  verifyPatched(after, target, pluginId, {
    trustPatchApplied: trustPatched || trustAlreadyPatched,
    piContextPatchApplied: piContextPatched || piContextAlreadyPatched,
    piCallsitePatchApplied: piCallsitePatched || piCallsiteAlreadyPatched,
  });

  if (options.dryRun) {
    console.log(`\nWould patch: ${target}`);
    printPatchSnippet(after, {
      trustPatched,
      piContextPatched,
      piCallsitePatched,
    });
  } else {
    const backup = `${target}.bak-openclaw-workflow-${timestamp()}`;
    fs.copyFileSync(target, backup);
    fs.writeFileSync(target, after, "utf8");

    console.log(`\nPatched: ${target}`);
    console.log(`Backup:  ${backup}`);
  }

  return {
    trustTargetFound,
    trustPatched,
    trustAlreadyPatched: false,
    piContextTargetFound,
    piContextPatched,
    piContextAlreadyPatched: false,
    piCallsiteTargetFound,
    piCallsitePatched,
    piCallsiteAlreadyPatched: false,
  };
}

function isRelevantRuntimeFile(source) {
  return (
    source.includes(FUNCTION_NAME) &&
    source.includes(DIAGNOSTIC) &&
    source.includes("record.origin")
  );
}

function isAlreadyPatchedTrustFile(source) {
  return (
    source.includes(TRUST_PATCH_MARKER) &&
    source.includes(FUNCTION_NAME) &&
    source.includes(DIAGNOSTIC)
  );
}

function isRelevantPiContextFile(file, source) {
  if (!/\.(ts|js|mjs|cjs)$/.test(file)) return false;

  const hasFactory = /function\s+buildAgentToolResultMiddlewareFactory\s*\(/.test(source);
  const hasRunner = /createAgentToolResultMiddlewareRunner\s*\(/.test(source);
  const hasPiToolResult = /pi\.on\s*\(\s*["']tool_result["']/.test(source);
  const hasApply = /applyToolResultMiddleware\s*\(/.test(source);

  return hasFactory && hasRunner && hasPiToolResult && hasApply;
}

function getPiCallsitePatchInfo(source) {
  const calls = findBuildEmbeddedExtensionFactoryCalls(source);
  const patchable = calls.filter((call) => /\bsessionManager\b/.test(call.body));

  if (patchable.length === 0) {
    return { found: false, current: false, count: 0, currentCount: 0 };
  }

  const currentCount = patchable.filter((call) =>
    callHasIdentityParams(call.body),
  ).length;

  return {
    found: true,
    current: currentCount === patchable.length,
    count: patchable.length,
    currentCount,
  };
}

function callHasIdentityParams(body) {
  return (
    /runId\s*:\s*params\.runId/.test(body) &&
    /sessionId\s*:\s*params\.sessionId/.test(body) &&
    /sessionKey\s*:\s*params\.sessionKey/.test(body)
  );
}

function isCurrentPiContextPatched(source) {
  return (
    source.includes(PI_CONTEXT_PATCH_VERSION_MARKER) &&
    source.includes("params.runId") &&
    source.includes("params.sessionId") &&
    source.includes("params.sessionKey") &&
    source.includes("normalizedThreadId") &&
    source.includes("createAgentToolResultMiddlewareRunner(middlewareCtx)")
  );
}

function patchRuntimeFile(source, pluginId) {
  if (source.includes(TRUST_PATCH_MARKER)) return source;

  const functionIndex = source.indexOf(`const ${FUNCTION_NAME}`);
  const symbolIndex =
    functionIndex >= 0 ? functionIndex : source.indexOf(FUNCTION_NAME);

  if (symbolIndex < 0) return source;

  const diagnosticIndex = source.indexOf(DIAGNOSTIC, symbolIndex);
  if (diagnosticIndex < 0) return source;

  const windowStart = Math.max(0, symbolIndex - 700);
  const windowEnd = Math.min(source.length, diagnosticIndex + 1600);
  const window = source.slice(windowStart, windowEnd);

  const patchedWindow = patchMiddlewareWindow(window, pluginId);
  if (patchedWindow === window) return source;

  return source.slice(0, windowStart) + patchedWindow + source.slice(windowEnd);
}

function patchMiddlewareWindow(window, pluginId) {
  const pluginLiteral = JSON.stringify(pluginId);

  const functionMatch = new RegExp(
    String.raw`${FUNCTION_NAME}\s*=\s*\(\s*([A-Za-z_$][\w$]*)\s*,`,
  ).exec(window);

  const recordVar = functionMatch?.[1] ?? "record";

  const patterns = [
    new RegExp(
      String.raw`if\s*\(\s*${escapeRegExp(recordVar)}\.origin\s*!==\s*(["'])bundled\1\s*\)\s*\{`,
      "g",
    ),
    /if\s*\(\s*([A-Za-z_$][\w$]*)\.origin\s*!==\s*(["'])bundled\2\s*\)\s*\{/g,
  ];

  const matches = [];

  for (const pattern of patterns) {
    for (const match of window.matchAll(pattern)) {
      matches.push({ pattern, match });
    }
  }

  if (matches.length === 0) return window;

  const diagnosticIndex = window.indexOf(DIAGNOSTIC);

  matches.sort((a, b) => {
    const ai = a.match.index ?? 0;
    const bi = b.match.index ?? 0;
    return Math.abs(diagnosticIndex - ai) - Math.abs(diagnosticIndex - bi);
  });

  const selected = matches[0];
  const match = selected.match;
  const original = match[0];

  let variable = recordVar;
  let quote = '"';

  if (selected.pattern === patterns[1]) {
    variable = match[1];
    quote = match[2];
  } else {
    quote = match[1];
  }

  const allowExpression =
    `${variable}.id !== ${pluginLiteral} && ` +
    `${variable}.pluginId !== ${pluginLiteral} && ` +
    `${variable}.manifest?.id !== ${pluginLiteral}`;

  const replacement =
    `/* ${TRUST_PATCH_MARKER}: allow ${pluginId} */\n` +
    `                if (${variable}.origin !== ${quote}bundled${quote} && ${allowExpression}) {`;

  return (
    window.slice(0, match.index) +
    replacement +
    window.slice((match.index ?? 0) + original.length)
  );
}

function patchPiContextFile(source, file) {
  let out = source;

  out = patchPiFactorySignature(out, file);

  out = out.replace(
    /^[ \t]*const runner = createAgentToolResultMiddlewareRunner\s*\(\s*\{\s*runtime\s*:\s*["']pi["']\s*\}\s*\);[ \t]*\n/m,
    "",
  );

  out = replaceExistingPiContextPatch(out);

  if (!out.includes(PI_CONTEXT_PATCH_VERSION_MARKER)) {
    out = insertPiContextPatch(out);
  }

  out = patchPiFactoryCall(out);

  return out;
}

function patchPiFactorySignature(source, file) {
  const isTs = file.endsWith(".ts");

  if (isTs) {
    return source
      .replace(
        /function\s+buildAgentToolResultMiddlewareFactory\s*\(\s*\)\s*:\s*ExtensionFactory\s*\{/,
        [
          "function buildAgentToolResultMiddlewareFactory(params: {",
          "  sessionManager?: SessionManager;",
          "  runId?: string;",
          "  sessionId?: string;",
          "  sessionKey?: string;",
          "} = {}): ExtensionFactory {",
        ].join("\n"),
      )
      .replace(
        /function\s+buildAgentToolResultMiddlewareFactory\s*\(\s*params\s*:\s*\{[\s\S]*?\}\s*=\s*\{\}\s*\)\s*:\s*ExtensionFactory\s*\{/,
        [
          "function buildAgentToolResultMiddlewareFactory(params: {",
          "  sessionManager?: SessionManager;",
          "  runId?: string;",
          "  sessionId?: string;",
          "  sessionKey?: string;",
          "} = {}): ExtensionFactory {",
        ].join("\n"),
      );
  }

  return source
    .replace(
      /function\s+buildAgentToolResultMiddlewareFactory\s*\(\s*\)\s*\{/,
      "function buildAgentToolResultMiddlewareFactory(params = {}) {",
    )
    .replace(
      /function\s+buildAgentToolResultMiddlewareFactory\s*\(\s*params\s*\)\s*\{/,
      "function buildAgentToolResultMiddlewareFactory(params = {}) {",
    );
}

function replaceExistingPiContextPatch(source) {
  const markerIndex = source.indexOf(PI_CONTEXT_PATCH_MARKER);
  if (markerIndex < 0) return source;

  const start = findLineStart(source, markerIndex);
  const resultIndex = source.indexOf(
    "const result = await runner.applyToolResultMiddleware",
    markerIndex,
  );

  if (resultIndex < 0) return source;

  return source.slice(0, start) + source.slice(resultIndex);
}

function insertPiContextPatch(source) {
  return source.replace(
    /(^[ \t]*)const result = await runner\.applyToolResultMiddleware\s*\(/m,
    (_match, indent) =>
      `${buildPiContextPatchBlock(indent)}\n${indent}const result = await runner.applyToolResultMiddleware(`,
  );
}

function buildPiContextPatchBlock(indent) {
  return [
    `${indent}/* ${PI_CONTEXT_PATCH_VERSION_MARKER} */`,
    `${indent}const sessionManagerAny = params.sessionManager || {};`,
    `${indent}const rawEventAny = rawEvent && typeof rawEvent === "object" ? rawEvent : {};`,
    `${indent}const normalizeOpenClawWorkflowIdentity = (value) => {`,
    `${indent}  if (typeof value !== "string") return void 0;`,
    `${indent}  const trimmed = value.trim();`,
    `${indent}  return trimmed.length > 0 ? trimmed : void 0;`,
    `${indent}};`,
    `${indent}const normalizedThreadId = normalizeOpenClawWorkflowIdentity(event.threadId);`,
    `${indent}const embeddedRunId =`,
    `${indent}  normalizeOpenClawWorkflowIdentity(params.runId) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(event.runId) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(event.runtimeRunId) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(event.sessionId) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(rawEventAny.runId) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(rawEventAny.runtimeRunId) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(rawEventAny.sessionId) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(rawEventAny.subagentRunId) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(rawEventAny.subagent != null ? rawEventAny.subagent.runId : void 0) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(rawEventAny.details != null ? rawEventAny.details.runId : void 0) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(rawEventAny.details != null ? rawEventAny.details.runtimeRunId : void 0) ??`,
    `${indent}  normalizeOpenClawWorkflowIdentity(rawEventAny.details != null ? rawEventAny.details.sessionId : void 0);`,
    `${indent}const middlewareCtx = {`,
    `${indent}  runtime: "pi",`,
    `${indent}  agentId:`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.agentId) ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.agent != null ? sessionManagerAny.agent.id : void 0),`,
    `${indent}  sessionId:`,
    `${indent}    normalizeOpenClawWorkflowIdentity(params.runId) ??`,
    `${indent}    embeddedRunId ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(params.sessionId) ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.sessionId) ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.session != null ? sessionManagerAny.session.id : void 0) ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.currentSessionId),`,
    `${indent}  sessionKey:`,
    `${indent}    normalizedThreadId ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(params.sessionKey) ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.sessionKey) ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.session != null ? sessionManagerAny.session.key : void 0) ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.key),`,
    `${indent}  runId:`,
    `${indent}    normalizeOpenClawWorkflowIdentity(params.runId) ??`,
    `${indent}    embeddedRunId ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.runId) ??`,
    `${indent}    normalizeOpenClawWorkflowIdentity(sessionManagerAny.currentRunId),`,
    `${indent}};`,
    `${indent}const runner = createAgentToolResultMiddlewareRunner(middlewareCtx);`,
    `${indent}if (`,
    `${indent}  process.env.OPENCLAW_WORKFLOW_TRACE === "1" ||`,
    `${indent}  process.env.OPENCLAW_WORKFLOW_TRACE === "true"`,
    `${indent}) {`,
    `${indent}  console.warn("[openclaw-trace] pi.tool_result.middleware_context", {`,
    `${indent}    toolName: event.toolName,`,
    `${indent}    toolCallId,`,
    `${indent}    rawEventKeys: Object.keys(rawEventAny),`,
    `${indent}    rawEventThreadId: event.threadId,`,
    `${indent}    normalizedThreadId,`,
    `${indent}    embeddedRunId,`,
    `${indent}    paramsRunId: params.runId,`,
    `${indent}    paramsSessionId: params.sessionId,`,
    `${indent}    paramsSessionKey: params.sessionKey,`,
    `${indent}    sessionManagerKeys: Object.keys(sessionManagerAny),`,
    `${indent}    middlewareCtx,`,
    `${indent}  });`,
    `${indent}}`,
  ].join("\n");
}

function patchPiFactoryCall(source) {
  const replacement = [
    "factories.push(",
    "  buildAgentToolResultMiddlewareFactory({",
    "    sessionManager: params.sessionManager,",
    "    runId: params.runId,",
    "    sessionId: params.sessionId,",
    "    sessionKey: params.sessionKey,",
    "  }),",
    ");",
  ].join("\n");

  let out = source.replace(
    /factories\.push\s*\(\s*buildAgentToolResultMiddlewareFactory\s*\(\s*\)\s*\)\s*;/g,
    replacement,
  );

  out = out.replace(
    /factories\.push\s*\(\s*buildAgentToolResultMiddlewareFactory\s*\(\s*\{[\s\S]*?sessionManager\s*:\s*params\.sessionManager[\s\S]*?\}\s*\)\s*,?\s*\)\s*;/g,
    replacement,
  );

  return out;
}

function patchPiCallsiteFile(source) {
  const calls = findBuildEmbeddedExtensionFactoryCalls(source);
  if (calls.length === 0) return source;

  let out = "";
  let cursor = 0;
  let changed = false;

  for (const call of calls) {
    if (!/\bsessionManager\b/.test(call.body) || callHasIdentityParams(call.body)) {
      continue;
    }

    const patchedCall = patchBuildEmbeddedExtensionFactoryCall(call.text);
    if (patchedCall === call.text) continue;

    out += source.slice(cursor, call.start) + patchedCall;
    cursor = call.end;
    changed = true;
  }

  if (!changed) return source;

  out += source.slice(cursor);
  return out;
}

function findBuildEmbeddedExtensionFactoryCalls(source) {
  const calls = [];
  const needle = "buildEmbeddedExtensionFactories";
  let searchFrom = 0;

  while (true) {
    const nameIndex = source.indexOf(needle, searchFrom);
    if (nameIndex < 0) break;

    const openParen = skipWhitespace(source, nameIndex + needle.length);
    if (source[openParen] !== "(") {
      searchFrom = nameIndex + needle.length;
      continue;
    }

    const openObject = skipWhitespace(source, openParen + 1);
    if (source[openObject] !== "{") {
      searchFrom = openParen + 1;
      continue;
    }

    const closeObject = findMatchingBrace(source, openObject, "{", "}");
    if (closeObject < 0) {
      searchFrom = openObject + 1;
      continue;
    }

    const closeParen = skipWhitespace(source, closeObject + 1);
    if (source[closeParen] !== ")") {
      searchFrom = closeObject + 1;
      continue;
    }

    calls.push({
      start: nameIndex,
      end: closeParen + 1,
      text: source.slice(nameIndex, closeParen + 1),
      body: source.slice(openObject + 1, closeObject),
    });

    searchFrom = closeParen + 1;
  }

  return calls;
}

function patchBuildEmbeddedExtensionFactoryCall(callText) {
  const openObject = callText.indexOf("{");
  const closeObject = findMatchingBrace(callText, openObject, "{", "}");
  if (openObject < 0 || closeObject < 0) return callText;

  const body = callText.slice(openObject + 1, closeObject);
  if (callHasIdentityParams(body)) return callText;

  const sessionManagerMatch =
    /(^|\n)([ \t]*)(sessionManager\s*(?::\s*[^,\n}]+)?\s*,?)/m.exec(body);

  if (!sessionManagerMatch) return callText;

  const insertAt = (sessionManagerMatch.index ?? 0) + sessionManagerMatch[0].length;
  const indent = sessionManagerMatch[2] ?? "";
  const prefixNewline = sessionManagerMatch[0].endsWith("\n") ? "" : "\n";

  const addition = [
    `${prefixNewline}${indent}runId: params.runId,`,
    `${indent}sessionId: params.sessionId,`,
    `${indent}sessionKey: params.sessionKey,`,
  ].join("\n");

  const newBody = body.slice(0, insertAt) + addition + body.slice(insertAt);

  return callText.slice(0, openObject + 1) + newBody + callText.slice(closeObject);
}

function skipWhitespace(source, index) {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

function findMatchingBrace(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let templateExpressionDepth = 0;

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (quote === "`" && ch === "$" && next === "{") {
        templateExpressionDepth += 1;
        i += 1;
        continue;
      }

      if (quote === "`" && templateExpressionDepth > 0 && ch === "}") {
        templateExpressionDepth -= 1;
        continue;
      }

      if (ch === quote && templateExpressionDepth === 0) {
        quote = null;
      }

      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === openChar) depth += 1;

    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function verifyPatched(
  source,
  file,
  pluginId,
  { trustPatchApplied, piContextPatchApplied, piCallsitePatchApplied },
) {
  const required = [];

  if (trustPatchApplied) {
    required.push(TRUST_PATCH_MARKER, pluginId, FUNCTION_NAME, DIAGNOSTIC);
  }

  if (piContextPatchApplied) {
    required.push(
      PI_CONTEXT_PATCH_VERSION_MARKER,
      "const middlewareCtx = {",
      "const runner = createAgentToolResultMiddlewareRunner(middlewareCtx);",
      "normalizeOpenClawWorkflowIdentity",
      "normalizedThreadId",
      "params.runId",
      "params.sessionId",
      "params.sessionKey",
      "[openclaw-trace] pi.tool_result.middleware_context",
    );
  }

  if (piCallsitePatchApplied) {
    required.push(
      "runId: params.runId",
      "sessionId: params.sessionId",
      "sessionKey: params.sessionKey",
    );
  }

  for (const needle of required) {
    if (!source.includes(needle)) {
      throw new Error(`Patch verification failed for ${file}: missing ${needle}`);
    }
  }
}

function restoreLatestBackupForFile(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const prefix = `${base}.bak-openclaw-workflow-`;

  if (!fs.existsSync(dir)) {
    throw new Error(`Directory does not exist: ${dir}`);
  }

  const backups = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(dir, name))
    .sort();

  if (backups.length === 0) {
    throw new Error(`No backups found for ${file}`);
  }

  const latest = backups[backups.length - 1];

  if (dryRun) {
    console.log(`Would restore ${file}`);
    console.log(`From:          ${latest}`);
  } else {
    fs.copyFileSync(latest, file);
    console.log(`Restored ${file}`);
    console.log(`From:     ${latest}`);
  }
}

function printSummary(summary) {
  console.log("\nPatch summary:");
  printSummaryBlock("trust_guard", summary.trust);
  printSummaryBlock("pi_context", summary.piContext);
  printSummaryBlock("pi_callsite", summary.piCallsite);
}

function printSummaryBlock(name, block) {
  console.log(`  ${name}:`);
  console.log(`    found: ${block.found ? "yes" : "no"}`);
  console.log(
    `    patched_or_already_present: ${
      block.patchedOrAlreadyPresent ? "yes" : "no"
    }`,
  );

  if (block.files.length > 0) {
    console.log("    files:");
    for (const file of uniqueStrings(block.files)) {
      console.log(`      - ${file}`);
    }
  }
}

function printPatchDiagnosticSnippet(source, file) {
  const candidates = [
    source.indexOf(TRUST_PATCH_MARKER),
    source.indexOf(PI_CONTEXT_PATCH_MARKER),
    source.indexOf(FUNCTION_NAME),
    source.indexOf("buildAgentToolResultMiddlewareFactory"),
    source.indexOf("runner.applyToolResultMiddleware"),
    source.indexOf("buildEmbeddedExtensionFactories"),
    source.indexOf("pi.on"),
  ].filter((index) => index >= 0);

  const index = candidates.length > 0 ? Math.min(...candidates) : 0;
  const start = Math.max(0, index - 800);
  const end = Math.min(source.length, index + 2800);

  console.log(`\nDiagnostic snippet for ${file}:`);
  console.log(source.slice(start, end));
}

function printPatchSnippet(
  source,
  { trustPatched, piContextPatched, piCallsitePatched } = {},
) {
  let index = -1;

  if (piContextPatched) {
    index = source.indexOf(PI_CONTEXT_PATCH_VERSION_MARKER);
  }

  if (index < 0 && piCallsitePatched) {
    index = source.indexOf("buildEmbeddedExtensionFactories({");
  }

  if (index < 0 && trustPatched) {
    index = source.indexOf(TRUST_PATCH_MARKER);
  }

  if (index < 0) {
    index =
      [
        source.indexOf(TRUST_PATCH_MARKER),
        source.indexOf(PI_CONTEXT_PATCH_VERSION_MARKER),
        source.indexOf("buildEmbeddedExtensionFactories"),
      ].find((value) => value >= 0) ?? 0;
  }

  const start = Math.max(0, index - 500);
  const end = Math.min(source.length, index + 2400);

  console.log("\nPatched snippet:");
  console.log(source.slice(start, end));
}

function findLineStart(source, index) {
  const prev = source.lastIndexOf("\n", index);
  return prev < 0 ? 0 : prev + 1;
}

function uniqueExistingDirs(values) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    if (!value) continue;

    try {
      const real = fs.realpathSync(path.resolve(value));

      if (!fs.existsSync(real)) continue;
      if (!fs.statSync(real).isDirectory()) continue;
      if (seen.has(real)) continue;

      seen.add(real);
      out.push(real);
    } catch {
      // ignore
    }
  }

  return out;
}

function uniqueExistingFiles(values) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    if (!value) continue;

    try {
      const real = fs.realpathSync(path.resolve(value));

      if (!fs.existsSync(real)) continue;
      if (!fs.statSync(real).isFile()) continue;
      if (seen.has(real)) continue;

      seen.add(real);
      out.push(real);
    } catch {
      // ignore
    }
  }

  return out;
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function parseArgs(argv) {
  const out = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith("--")) continue;

    const eq = arg.indexOf("=");

    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }

  return out;
}

function assertSafePluginId(value) {
  if (!/^[a-zA-Z0-9._@/-]+$/.test(value)) {
    throw new Error(`Unsafe plugin id: ${value}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function isDirectExecution(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === moduleUrl;
}

export {
  candidateFilesForPackageRoot,
  discoverCandidateFilesForPackageRoot,
  findRuntimeFilesInPackageRoot,
  inspectCandidateFile,
  isRelevantPiContextFile,
  isRelevantRuntimeFile,
  patchPiCallsiteFile,
  patchPiContextFile,
  patchRuntimeFile,
};
