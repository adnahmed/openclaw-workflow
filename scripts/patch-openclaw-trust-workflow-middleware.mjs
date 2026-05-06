#!/usr/bin/env node
/**
 * Patch OpenClaw so one trusted external plugin can register
 * agentToolResultMiddleware, and so Pi tool-result middleware receives
 * stable session/run context.
 *
 * This script is intentionally bounded and noisy:
 *   - no `where openclaw`
 *   - no recursive node_modules crawl
 *   - no silent target discovery
 *   - checks only known OpenClaw package roots
 *   - scans only bounded candidate files under dist/
 *   - fails closed if the Pi context patch is required but not applied/found
 *
 * Usage:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --print-targets
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --dry-run
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs
 *
 * Exact file:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --file "C:\...\dist\loader-XXX.js" --dry-run
 *
 * Exact package root:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --root "C:\...\node_modules\openclaw" --dry-run
 *
 * Patch every ~/.openclaw/plugin-runtime-deps/openclaw-* runtime copy:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --all
 *
 * Restore latest backup for discovered targets:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --restore
 *
 * Disable required Pi-context patch check:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --require-pi-context=false
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

const FUNCTION_NAME = "registerAgentToolResultMiddleware";

const DIAGNOSTIC =
	"only bundled plugins can register agent tool result middleware";

const PI_EXTENSIONS_RELATIVE_PATH = path.join(
	"src",
	"agents",
	"pi-embedded-runner",
	"extensions.ts",
);

const MAX_CANDIDATE_BYTES = 80 * 1024 * 1024;

const args = parseArgs(process.argv.slice(2));

const pluginId = String(args.plugin ?? DEFAULT_PLUGIN_ID);
const dryRun = Boolean(args["dry-run"]);
const restore = Boolean(args.restore);
const all = Boolean(args.all);
const printTargets = Boolean(args["print-targets"]);
const exactFile = args.file ? path.resolve(String(args.file)) : null;
const explicitRoot = args.root ? path.resolve(String(args.root)) : null;
const requirePiContext = args["require-pi-context"] !== "false";

if (isDirectExecution(import.meta.url)) {
	main();
}

function main() {
	assertSafePluginId(pluginId);

	console.log(`Plugin allowed for middleware: ${pluginId}`);
	console.log(`Dry run: ${dryRun ? "yes" : "no"}`);
	console.log(`Restore: ${restore ? "yes" : "no"}`);
	console.log(`Patch all runtime deps: ${all ? "yes" : "no"}`);
	console.log(`Require Pi context patch: ${requirePiContext ? "yes" : "no"}`);

	const targets = exactFile
		? uniqueExistingFiles([exactFile])
		: findTargets({ explicitRoot, all });

	if (targets.length === 0) {
		throw new Error(
			[
				"Could not find any OpenClaw files containing the middleware trust guard or Pi middleware target.",
				"",
				"Expected locations include:",
				`  ${path.join(os.homedir(), ".openclaw", "plugin-runtime-deps", "openclaw-*", "dist", "*.js")}`,
				process.env.APPDATA
					? `  ${path.join(process.env.APPDATA, "nvm", "node_modules", "openclaw", "dist", "*.js")}`
					: "  %APPDATA%\\nvm\\node_modules\\openclaw\\dist\\*.js",
				"",
				"Try exact-file mode against the loader from your stack trace:",
				'  node scripts/patch-openclaw-trust-workflow-middleware.mjs --file "C:\\path\\to\\openclaw\\dist\\loader-XXX.js" --dry-run',
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
		trust: {
			found: false,
			patchedOrAlreadyPresent: false,
			files: [],
		},
		piContext: {
			found: false,
			patchedOrAlreadyPresent: false,
			files: [],
		},
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
	}

	printSummary(summary);

	if (!summary.trust.patchedOrAlreadyPresent) {
		throw new Error("OpenClaw trust guard was not patched or already present.");
	}

	if (requirePiContext && !summary.piContext.patchedOrAlreadyPresent) {
		if (!summary.piContext.found) {
			console.error(
				"\nERROR: Pi middleware context target was not found. Browser tool results will not be sealed.",
			);
		}

		throw new Error(
			"Pi middleware context patch was not applied. Sealed browser spooling is not guaranteed.",
		);
	}

	console.log("\nDone.");
	console.log(
		"Restart OpenClaw/gateway, then run workflow_runtime_patch_status and verify browser tool calls produce middleware.sealed traces.",
	);
}

function findTargets({ explicitRoot, all }) {
	console.log("\n[patch] target discovery started");

	if (explicitRoot) {
		console.log(`[patch] using explicit root: ${explicitRoot}`);
		return findRuntimeFilesInPackageRoot(explicitRoot);
	}

	const roots = [];

	for (const root of knownGlobalOpenClawPackageRoots()) {
		roots.push(root);
	}

	for (const root of runtimeDependencyRoots({ all })) {
		roots.push(root);
	}

	const uniqueRoots = uniqueExistingDirs(roots);

	console.log(`[patch] package roots found: ${uniqueRoots.length}`);
	for (const root of uniqueRoots) {
		console.log(`  - ${root}`);
	}

	const targets = [];

	for (const root of uniqueRoots) {
		console.log(`[patch] scanning root: ${root}`);
		targets.push(...findRuntimeFilesInPackageRoot(root));
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
			roots.push(
				path.join(process.env.APPDATA, "nvm", "node_modules", "openclaw"),
			);
			roots.push(
				path.join(process.env.APPDATA, "npm", "node_modules", "openclaw"),
			);
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

function findRuntimeFilesInPackageRoot(packageRoot) {
	const root = path.resolve(packageRoot);
	const candidates = candidateFilesForPackageRoot(root);

	console.log(`[patch] candidate files under ${root}: ${candidates.length}`);

	const matches = [];

	for (const file of candidates) {
		const kind = inspectCandidateFile(file);

		if (!kind.match) {
			continue;
		}

		console.log(`[patch] matched ${kind.reason}: ${file}`);
		matches.push(file);
	}

	return uniqueExistingFiles(matches);
}

function candidateFilesForPackageRoot(root) {
	const out = [];

	out.push(path.join(root, PI_EXTENSIONS_RELATIVE_PATH));
	out.push(path.join(root, "src", "plugins", "registry.ts"));
	out.push(path.join(root, "src", "plugins", "registry.js"));

	const dist = path.join(root, "dist");

	if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) {
		return out;
	}

	const entries = fs
		.readdirSync(dist, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.filter((entry) => {
			const name = entry.name;

			return (
				/^loader-[A-Za-z0-9_-]+\.(js|mjs|cjs)$/.test(name) ||
				/^registry-[A-Za-z0-9_-]+\.(js|mjs|cjs)$/.test(name) ||
				/^agent-tool-result-middleware.*\.(js|mjs|cjs)$/.test(name) ||
				/^compaction-successor-transcript-[A-Za-z0-9_-]+\.(js|mjs|cjs)$/.test(
					name,
				)
			);
		})
		.map((entry) => path.join(dist, entry.name))
		.sort();

	out.push(...entries);

	const knownNested = [
		path.join(dist, "agents", "pi-embedded-runner", "extensions.js"),
		path.join(dist, "agents", "pi-embedded-runner", "extensions.mjs"),
		path.join(dist, "agents", "pi-embedded-runner", "extensions.cjs"),
	];

	out.push(...knownNested);

	return uniqueExistingFiles(out);
}

function inspectCandidateFile(file) {
	if (!fs.existsSync(file)) {
		return { match: false, reason: "missing" };
	}

	const stat = fs.statSync(file);

	if (!stat.isFile()) {
		return { match: false, reason: "not-file" };
	}

	if (stat.size > MAX_CANDIDATE_BYTES) {
		console.warn(
			`[patch] skipping large candidate (${stat.size} bytes): ${file}`,
		);
		return { match: false, reason: "too-large" };
	}

	console.log(`[patch] inspecting: ${file}`);

	const text = fs.readFileSync(file, "utf8");

	if (isRelevantRuntimeFile(text) || isAlreadyPatchedTrustFile(text)) {
		return { match: true, reason: "trust_guard" };
	}

	if (isRelevantPiExtensionsFile(file, text)) {
		return { match: true, reason: "pi_context_source" };
	}

	if (isRelevantPiCompiledFile(file, text)) {
		return { match: true, reason: "pi_context_compiled" };
	}

	if (isAlreadyPatchedPiFile(file, text)) {
		return { match: true, reason: "pi_context_already_patched" };
	}

	return { match: false, reason: "not-relevant" };
}

function patchTargetFile(target, pluginId, options = {}) {
	const before = fs.readFileSync(target, "utf8");

	const trustTargetFound =
		isRelevantRuntimeFile(before) || isAlreadyPatchedTrustFile(before);

	const piContextTargetFound =
		isRelevantPiExtensionsFile(target, before) ||
		isRelevantPiCompiledFile(target, before) ||
		isAlreadyPatchedPiFile(target, before);

	let after = before;
	let trustPatched = false;
	let piContextPatched = false;

	if (isRelevantRuntimeFile(after) && !after.includes(TRUST_PATCH_MARKER)) {
		const next = patchRuntimeFile(after, pluginId);

		if (next !== after) {
			after = next;
			trustPatched = true;
		}
	}

	if (
		isRelevantPiExtensionsFile(target, after) &&
		!after.includes(PI_CONTEXT_PATCH_MARKER)
	) {
		const next = patchPiExtensionsFile(after);

		if (next !== after) {
			after = next;
			piContextPatched = true;
		}
	}

	if (
		isRelevantPiCompiledFile(target, after) &&
		!after.includes(PI_CONTEXT_PATCH_MARKER)
	) {
		const next = patchPiCompiledFile(after);

		if (next !== after) {
			after = next;
			piContextPatched = true;
		}
	}

	const changed = after !== before;

	const trustAlreadyPatched =
		trustTargetFound && !trustPatched && before.includes(TRUST_PATCH_MARKER);

	const piContextAlreadyPatched =
		piContextTargetFound &&
		!piContextPatched &&
		before.includes(PI_CONTEXT_PATCH_MARKER);

	if (!changed) {
		if (trustAlreadyPatched || piContextAlreadyPatched) {
			console.log(`\nAlready patched: ${target}`);
		} else if (trustTargetFound || piContextTargetFound) {
			console.warn(`\nFound target but could not apply patch: ${target}`);
			printPatchDiagnosticSnippet(before, target);
		} else {
			console.warn(`Skipping non-matching file: ${target}`);
		}

		return {
			trustTargetFound,
			trustPatched: false,
			trustAlreadyPatched,
			piContextTargetFound,
			piContextPatched: false,
			piContextAlreadyPatched,
		};
	}

	verifyPatched(after, target, pluginId, {
		trustPatchApplied: trustPatched,
		piContextPatchApplied: piContextPatched,
	});

	if (options.dryRun) {
		console.log(`\nWould patch: ${target}`);
		printPatchSnippet(after);
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

function isRelevantPiExtensionsFile(file, source) {
	const normalizedFile = file.replaceAll("\\", "/");
	const normalizedRelative = PI_EXTENSIONS_RELATIVE_PATH.replaceAll("\\", "/");

	if (!normalizedFile.endsWith(normalizedRelative)) {
		return false;
	}

	return (
		/buildAgentToolResultMiddlewareFactory\s*\(\s*\)\s*:\s*ExtensionFactory/.test(
			source,
		) &&
		/createAgentToolResultMiddlewareRunner\s*\(\s*\{\s*runtime:\s*["']pi["']\s*\}\s*\)/.test(
			source,
		) &&
		/pi\.on\s*\(\s*["']tool_result["']/.test(source)
	);
}

function isRelevantPiCompiledFile(file, source) {
	const normalized = file.replaceAll("\\", "/");

	if (!normalized.includes("/dist/")) return false;
	if (!/\.(js|mjs|cjs)$/.test(file)) return false;

	return (
		/buildAgentToolResultMiddlewareFactory\s*\(\s*\)\s*\{/.test(source) &&
		/createAgentToolResultMiddlewareRunner\s*\(\s*\{\s*runtime:\s*["']pi["']\s*\}\s*\)/.test(
			source,
		) &&
		/pi\.on\s*\(\s*["']tool_result["']/.test(source) &&
		/runner\.applyToolResultMiddleware\s*\(/.test(source)
	);
}

function isAlreadyPatchedPiFile(file, source) {
	const normalized = file.replaceAll("\\", "/");

	return (
		source.includes(PI_CONTEXT_PATCH_MARKER) &&
		(normalized.includes("/dist/") ||
			normalized.endsWith(PI_EXTENSIONS_RELATIVE_PATH.replaceAll("\\", "/"))) &&
		/buildAgentToolResultMiddlewareFactory/.test(source) &&
		/applyToolResultMiddleware/.test(source)
	);
}

function patchRuntimeFile(source, pluginId) {
	const functionIndex = source.indexOf(`const ${FUNCTION_NAME}`);

	const symbolIndex =
		functionIndex >= 0 ? functionIndex : source.indexOf(FUNCTION_NAME);

	if (symbolIndex < 0) {
		return source;
	}

	const diagnosticIndex = source.indexOf(DIAGNOSTIC, symbolIndex);

	if (diagnosticIndex < 0) {
		return source;
	}

	const windowStart = Math.max(0, symbolIndex - 500);
	const windowEnd = Math.min(source.length, diagnosticIndex + 1200);
	const window = source.slice(windowStart, windowEnd);

	if (window.includes(TRUST_PATCH_MARKER)) {
		return source;
	}

	const patchedWindow = patchMiddlewareWindow(window, pluginId);

	if (patchedWindow === window) {
		return source;
	}

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
		new RegExp(
			String.raw`if\s*\(\s*${escapeRegExp(recordVar)}\.origin!==(["'])bundled\1\s*\)\s*\{`,
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

	if (matches.length === 0) {
		return window;
	}

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

	if (selected.pattern === patterns[2]) {
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

function patchPiExtensionsFile(source) {
	let out = source;

	const signaturePattern =
		/function buildAgentToolResultMiddlewareFactory\(\): ExtensionFactory \{/;

	if (signaturePattern.test(out)) {
		out = out.replace(
			signaturePattern,
			[
				"function buildAgentToolResultMiddlewareFactory(params: {",
				"  sessionManager: SessionManager;",
				"}): ExtensionFactory {",
			].join("\n"),
		);
	}

	out = out.replace(
		/^[ \t]*const runner = createAgentToolResultMiddlewareRunner\s*\(\s*\{\s*runtime:\s*["']pi["']\s*\}\s*\);[ \t]*\n/m,
		"",
	);

	if (!out.includes(PI_CONTEXT_PATCH_MARKER)) {
		out = out.replace(
			/(^[ \t]*)const result = await runner\.applyToolResultMiddleware\s*\(/m,
			(match, indent) =>
				[
					`${indent}/* ${PI_CONTEXT_PATCH_MARKER} */`,
					`${indent}const sessionManagerAny = params.sessionManager as any;`,
					`${indent}const middlewareCtx = {`,
					`${indent}  runtime: "pi" as const,`,
					`${indent}  agentId:`,
					`${indent}    sessionManagerAny.agentId ??`,
					`${indent}    sessionManagerAny.agent?.id ??`,
					`${indent}    undefined,`,
					`${indent}  sessionId:`,
					`${indent}    sessionManagerAny.sessionId ??`,
					`${indent}    sessionManagerAny.session?.id ??`,
					`${indent}    sessionManagerAny.currentSessionId ??`,
					`${indent}    undefined,`,
					`${indent}  sessionKey:`,
					`${indent}    sessionManagerAny.sessionKey ??`,
					`${indent}    sessionManagerAny.session?.key ??`,
					`${indent}    sessionManagerAny.key ??`,
					`${indent}    undefined,`,
					`${indent}  runId:`,
					`${indent}    sessionManagerAny.runId ??`,
					`${indent}    sessionManagerAny.currentRunId ??`,
					`${indent}    undefined,`,
					`${indent}};`,
					`${indent}const runner = createAgentToolResultMiddlewareRunner(middlewareCtx);`,
					`${indent}if (`,
					`${indent}  process.env.OPENCLAW_WORKFLOW_TRACE === "1" ||`,
					`${indent}  process.env.OPENCLAW_WORKFLOW_TRACE === "true"`,
					`${indent}) {`,
					`${indent}  console.warn("[openclaw-trace] pi.tool_result.middleware_context", {`,
					`${indent}    toolName: event.toolName,`,
					`${indent}    toolCallId,`,
					`${indent}    rawEventKeys: Object.keys(recordFromUnknown(rawEvent)),`,
					`${indent}    rawEventThreadId: event.threadId,`,
					`${indent}    sessionManagerKeys: Object.keys(sessionManagerAny),`,
					`${indent}    middlewareCtx,`,
					`${indent}  });`,
					`${indent}}`,
					`${indent}const result = await runner.applyToolResultMiddleware(`,
				].join("\n"),
		);
	}

	const factoryCall =
		"factories.push(buildAgentToolResultMiddlewareFactory());";

	if (out.includes(factoryCall)) {
		out = out.replace(
			factoryCall,
			[
				"factories.push(",
				"  buildAgentToolResultMiddlewareFactory({",
				"    sessionManager: params.sessionManager,",
				"  }),",
				");",
			].join("\n"),
		);
	}

	return out;
}

function patchPiCompiledFile(source) {
	let out = source;

	if (out.includes(PI_CONTEXT_PATCH_MARKER)) {
		return out;
	}

	const signaturePattern =
		/function buildAgentToolResultMiddlewareFactory\(\)\s*\{/;

	if (signaturePattern.test(out)) {
		out = out.replace(
			signaturePattern,
			"function buildAgentToolResultMiddlewareFactory(params = {}) {",
		);
	}

	out = out.replace(
		/^[ \t]*const runner = createAgentToolResultMiddlewareRunner\s*\(\s*\{\s*runtime:\s*["']pi["']\s*\}\s*\);[ \t]*\n/m,
		"",
	);

	out = out.replace(
		/(^[ \t]*)const result = await runner\.applyToolResultMiddleware\s*\(/m,
		(match, indent) =>
			[
				`${indent}/* ${PI_CONTEXT_PATCH_MARKER} */`,
				`${indent}const sessionManagerAny = params.sessionManager || {};`,
				`${indent}const middlewareCtx = {`,
				`${indent}  runtime: "pi",`,
				`${indent}  agentId:`,
				`${indent}    sessionManagerAny.agentId ??`,
				`${indent}    (sessionManagerAny.agent != null ? sessionManagerAny.agent.id : undefined),`,
				`${indent}  sessionId:`,
				`${indent}    sessionManagerAny.sessionId ??`,
				`${indent}    (sessionManagerAny.session != null ? sessionManagerAny.session.id : undefined) ??`,
				`${indent}    sessionManagerAny.currentSessionId,`,
				`${indent}  sessionKey:`,
				`${indent}    sessionManagerAny.sessionKey ??`,
				`${indent}    (sessionManagerAny.session != null ? sessionManagerAny.session.key : undefined) ??`,
				`${indent}    sessionManagerAny.key,`,
				`${indent}  runId:`,
				`${indent}    sessionManagerAny.runId ??`,
				`${indent}    sessionManagerAny.currentRunId,`,
				`${indent}};`,
				`${indent}const runner = createAgentToolResultMiddlewareRunner(middlewareCtx);`,
				`${indent}if (`,
				`${indent}  process.env.OPENCLAW_WORKFLOW_TRACE === "1" ||`,
				`${indent}  process.env.OPENCLAW_WORKFLOW_TRACE === "true"`,
				`${indent}) {`,
				`${indent}  const rawEventObject = rawEvent && typeof rawEvent === "object" ? rawEvent : {};`,
				`${indent}  console.warn("[openclaw-trace] pi.tool_result.middleware_context", {`,
				`${indent}    toolName: event.toolName,`,
				`${indent}    toolCallId,`,
				`${indent}    rawEventKeys: Object.keys(rawEventObject),`,
				`${indent}    rawEventThreadId: event.threadId,`,
				`${indent}    sessionManagerKeys: Object.keys(sessionManagerAny),`,
				`${indent}    middlewareCtx,`,
				`${indent}  });`,
				`${indent}}`,
				`${indent}const result = await runner.applyToolResultMiddleware(`,
			].join("\n"),
	);

	const factoryCallPattern =
		/factories\.push\s*\(\s*buildAgentToolResultMiddlewareFactory\s*\(\s*\)\s*\)\s*;/;

	if (factoryCallPattern.test(out)) {
		out = out.replace(
			factoryCallPattern,
			[
				"factories.push(",
				"  buildAgentToolResultMiddlewareFactory({",
				"    sessionManager: params.sessionManager,",
				"  }),",
				");",
			].join("\n"),
		);
	}

	return out;
}

function verifyPatched(
	source,
	file,
	pluginId,
	{ trustPatchApplied, piContextPatchApplied },
) {
	const required = [];

	if (trustPatchApplied) {
		required.push(
			TRUST_PATCH_MARKER,
			pluginId,
			FUNCTION_NAME,
			DIAGNOSTIC,
			`record.id !== ${JSON.stringify(pluginId)}`,
		);
	}

	if (piContextPatchApplied) {
		required.push(
			PI_CONTEXT_PATCH_MARKER,
			"const middlewareCtx = {",
			"const runner = createAgentToolResultMiddlewareRunner(middlewareCtx);",
			"[openclaw-trace] pi.tool_result.middleware_context",
			"sessionManager",
		);

		const normalized = file.replaceAll("\\", "/");

		if (
			normalized.endsWith(PI_EXTENSIONS_RELATIVE_PATH.replaceAll("\\", "/"))
		) {
			required.push("sessionManager: SessionManager;");
			required.push("sessionManager: params.sessionManager");
		} else {
			required.push("params.sessionManager");
			required.push(
				"function buildAgentToolResultMiddlewareFactory(params = {})",
			);
		}
	}

	for (const needle of required) {
		if (!source.includes(needle)) {
			throw new Error(
				`Patch verification failed for ${file}: missing ${needle}`,
			);
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

	console.log("  trust_guard:");
	console.log(`    found: ${summary.trust.found ? "yes" : "no"}`);
	console.log(
		`    patched_or_already_present: ${
			summary.trust.patchedOrAlreadyPresent ? "yes" : "no"
		}`,
	);

	if (summary.trust.files.length > 0) {
		console.log("    files:");

		for (const file of uniqueStrings(summary.trust.files)) {
			console.log(`      - ${file}`);
		}
	}

	console.log("  pi_context:");
	console.log(`    found: ${summary.piContext.found ? "yes" : "no"}`);
	console.log(
		`    patched_or_already_present: ${
			summary.piContext.patchedOrAlreadyPresent ? "yes" : "no"
		}`,
	);

	if (summary.piContext.files.length > 0) {
		console.log("    files:");

		for (const file of uniqueStrings(summary.piContext.files)) {
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
		source.indexOf("pi.on"),
	].filter((index) => index >= 0);

	const index = candidates.length > 0 ? Math.min(...candidates) : 0;

	const start = Math.max(0, index - 600);
	const end = Math.min(source.length, index + 2400);

	console.log(`\nDiagnostic snippet for ${file}:`);
	console.log(source.slice(start, end));
}

function printPatchSnippet(source) {
	const candidates = [
		source.indexOf(TRUST_PATCH_MARKER),
		source.indexOf(PI_CONTEXT_PATCH_MARKER),
	].filter((index) => index >= 0);

	const index = candidates.length > 0 ? Math.min(...candidates) : 0;

	const start = Math.max(0, index - 500);
	const end = Math.min(source.length, index + 1800);

	console.log("\nPatched snippet:");
	console.log(source.slice(start, end));
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
	findRuntimeFilesInPackageRoot,
	inspectCandidateFile,
	isAlreadyPatchedPiFile,
	isAlreadyPatchedTrustFile,
	isRelevantPiCompiledFile,
	isRelevantPiExtensionsFile,
	isRelevantRuntimeFile,
	patchPiCompiledFile,
	patchPiExtensionsFile,
	patchRuntimeFile,
};
