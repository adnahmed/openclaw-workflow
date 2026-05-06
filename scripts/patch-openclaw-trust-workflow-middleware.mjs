#!/usr/bin/env node
/**
 * Patch OpenClaw so one trusted external plugin can register
 * agentToolResultMiddleware, and so Pi tool-result middleware receives
 * stable session/run context.
 *
 * Default:
 *   - finds active global OpenClaw package via `where openclaw` / `which openclaw`
 *   - finds latest ~/.openclaw/plugin-runtime-deps/openclaw-*
 *   - patches the middleware trust guard in dist/loader-* / registry-* files
 *   - patches src/agents/pi-embedded-runner/extensions.ts when present
 *
 * Usage:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --dry-run
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs
 *
 * Exact file:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --file "C:\...\dist\loader-XXX.js" --dry-run
 *
 * Exact root:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --root "C:\...\openclaw" --dry-run
 *
 * Patch all discovered OpenClaw runtime deps:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --all
 *
 * Restore latest backup for targets:
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --restore
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_PLUGIN_ID = "openclaw-workflow";

const PATCH_MARKER =
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

	const targets = exactFile
		? [exactFile]
		: findTargets({
				explicitRoot,
				all,
			});

	if (targets.length === 0) {
		throw new Error(
			[
				"Could not find an OpenClaw loader containing registerAgentToolResultMiddleware.",
				"",
				"Expected one of:",
				`  ${path.join(os.homedir(), ".openclaw", "plugin-runtime-deps", "openclaw-*", "dist", "loader-*.js")}`,
				`  ${path.join(process.env.APPDATA ?? "%APPDATA%", "nvm", "node_modules", "openclaw", "dist", "loader-*.js")}`,
				"",
				"Debug commands:",
				`  where openclaw`,
				`  rg "${FUNCTION_NAME}" "${path.join(os.homedir(), ".openclaw", "plugin-runtime-deps")}" -g "loader-*.js" -n`,
				`  rg "${FUNCTION_NAME}" "${process.env.APPDATA ?? "%APPDATA%"}\\nvm\\node_modules\\openclaw" -g "loader-*.js" -n`,
			].join("\n"),
		);
	}

	console.log("Target file(s):");
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

	let trustPatchedOrPresent = false;
	let piContextPatchedOrPresent = false;
	const trustFiles = [];
	const piContextFiles = [];

	for (const target of targets) {
		const result = patchTargetFile(target, pluginId, { dryRun });

		if (result.trustPatched || result.trustAlreadyPatched) {
			trustPatchedOrPresent = true;
			trustFiles.push(target);
		}

		if (result.piContextPatched || result.piContextAlreadyPatched) {
			piContextPatchedOrPresent = true;
			piContextFiles.push(target);
		}
	}

	const piContextTargetFound =
		piContextPatchedOrPresent ||
		targets.some((t) => {
			try {
				const text = fs.readFileSync(t, "utf8");
				return (
					isRelevantPiExtensionsFile(t, text) ||
					isRelevantPiCompiledFile(t, text) ||
					isAlreadyPatchedPiCompiledFile(t, text)
				);
			} catch {
				return false;
			}
		});

	console.log("\nPatch summary:");
	console.log("  trust_guard:");
	console.log(`    found: ${trustPatchedOrPresent ? "yes" : "no"}`);
	console.log(
		`    patched_or_already_present: ${trustPatchedOrPresent ? "yes" : "no"}`,
	);
	if (trustFiles.length > 0) {
		console.log("    files:");
		for (const f of trustFiles) {
			console.log(`      - ${f}`);
		}
	}
	console.log("  pi_context:");
	console.log(`    found: ${piContextTargetFound ? "yes" : "no"}`);
	console.log(
		`    patched_or_already_present: ${piContextPatchedOrPresent ? "yes" : "no"}`,
	);
	if (piContextFiles.length > 0) {
		console.log("    files:");
		for (const f of piContextFiles) {
			console.log(`      - ${f}`);
		}
	}

	if (!trustPatchedOrPresent) {
		throw new Error("OpenClaw trust guard was not patched/found.");
	}

	if (requirePiContext && !piContextPatchedOrPresent) {
		if (!piContextTargetFound) {
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
		"Restart OpenClaw/gateway, then run workflow_runtime_patch_status and require ok=true.",
	);
}

function findTargets({ explicitRoot, all }) {
	if (explicitRoot) {
		return findRuntimeFilesInPackageRoot(explicitRoot);
	}

	const targets = [];

	// 1. Patch active global OpenClaw package, because gateway stack traces often
	// point here: AppData/Roaming/nvm/node_modules/openclaw/dist/loader-*.js
	for (const root of findGlobalOpenClawPackageRoots()) {
		targets.push(...findRuntimeFilesInPackageRoot(root));
	}

	// 2. Patch .openclaw/plugin-runtime-deps copy/copies.
	const runtimeDepRoots = findRuntimeDependencyRoots({ all });
	for (const root of runtimeDepRoots) {
		targets.push(...findRuntimeFilesInPackageRoot(root));
	}

	return uniqueExistingFiles(targets);
}

function findGlobalOpenClawPackageRoots() {
	const roots = [];

	// From `where openclaw` / `which openclaw`
	try {
		const cmd = process.platform === "win32" ? "where" : "which";
		const output = execFileSync(cmd, ["openclaw"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		});

		for (const cli of output
			.split(/\r?\n/)
			.map((x) => x.trim())
			.filter(Boolean)) {
			const cliDir = path.dirname(cli);

			// Windows nvm/global npm layout:
			//   C:\Users\Adnan\AppData\Roaming\nvm\openclaw.cmd
			//   C:\Users\Adnan\AppData\Roaming\nvm\node_modules\openclaw
			roots.push(path.join(cliDir, "node_modules", "openclaw"));
			roots.push(path.join(cliDir, "node_modules", "@openclaw", "openclaw"));

			// npm bin parent fallback:
			roots.push(path.join(path.dirname(cliDir), "node_modules", "openclaw"));
			roots.push(
				path.join(
					path.dirname(cliDir),
					"node_modules",
					"@openclaw",
					"openclaw",
				),
			);
		}
	} catch {
		// ignore
	}

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

	return uniqueExistingDirs(roots);
}

function findRuntimeDependencyRoots({ all }) {
	const runtimeDepsRoot = path.join(
		os.homedir(),
		".openclaw",
		"plugin-runtime-deps",
	);

	if (!fs.existsSync(runtimeDepsRoot)) {
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

	return selected.map((pkg) => pkg.full);
}

function findRuntimeFilesInPackageRoot(packageRoot) {
	const root = path.resolve(packageRoot);
	const dist = path.join(root, "dist");

	const candidates = [];

	const piExtensions = path.join(root, PI_EXTENSIONS_RELATIVE_PATH);
	candidates.push(piExtensions);

	// Source checkout fallback.
	candidates.push(path.join(root, "src", "plugins", "registry.ts"));
	candidates.push(path.join(root, "src", "plugins", "registry.js"));

	// Runtime/package layouts — scan all top-level dist JS for both trust guard and Pi compiled targets.
	if (fs.existsSync(dist) && fs.statSync(dist).isDirectory()) {
		for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
			candidates.push(path.join(dist, entry.name));
		}
	}

	const matches = [];

	for (const file of candidates) {
		if (!fs.existsSync(file)) continue;

		try {
			const text = fs.readFileSync(file, "utf8");
			if (
				isRelevantRuntimeFile(text) ||
				isRelevantPiExtensionsFile(file, text) ||
				isRelevantPiCompiledFile(file, text) ||
				isAlreadyPatchedPiCompiledFile(file, text)
			) {
				matches.push(file);
			}
		} catch {
			// ignore unreadable files
		}
	}

	// Prefer source boundary patch points first, then loader-* because active stack traces show implementation there.
	matches.sort((a, b) => {
		const aBase = path.basename(a);
		const bBase = path.basename(b);

		const aPi = a.endsWith(PI_EXTENSIONS_RELATIVE_PATH) ? 0 : 1;
		const bPi = b.endsWith(PI_EXTENSIONS_RELATIVE_PATH) ? 0 : 1;

		if (aPi !== bPi) return aPi - bPi;

		const aLoader = aBase.startsWith("loader-") ? 0 : 1;
		const bLoader = bBase.startsWith("loader-") ? 0 : 1;

		if (aLoader !== bLoader) return aLoader - bLoader;
		return a.localeCompare(b);
	});

	return matches;
}

function isRelevantRuntimeFile(source) {
	return (
		source.includes(FUNCTION_NAME) &&
		source.includes(DIAGNOSTIC) &&
		source.includes("record.origin")
	);
}

function isRelevantPiExtensionsFile(file, source) {
	const normalizedFile = file.replaceAll("\\", "/");
	const normalizedRelative = PI_EXTENSIONS_RELATIVE_PATH.replaceAll("\\", "/");

	if (!normalizedFile.endsWith(normalizedRelative)) {
		return false;
	}

	return (
		source.includes(
			'createAgentToolResultMiddlewareRunner({ runtime: "pi" })',
		) && source.includes('pi.on("tool_result"')
	);
}

function isRelevantPiCompiledFile(file, source) {
	const normalized = file.replaceAll("\\", "/");

	if (!normalized.includes("/dist/")) return false;
	if (!/\.(js|mjs|cjs)$/.test(file)) return false;

	return (
		source.includes("buildAgentToolResultMiddlewareFactory") &&
		source.includes(
			'createAgentToolResultMiddlewareRunner({ runtime: "pi" })',
		) &&
		source.includes('pi.on("tool_result"') &&
		source.includes("runner.applyToolResultMiddleware")
	);
}

function isAlreadyPatchedPiCompiledFile(file, source) {
	const normalized = file.replaceAll("\\", "/");

	if (!normalized.includes("/dist/")) return false;
	if (!/\.(js|mjs|cjs)$/.test(file)) return false;

	return (
		source.includes(PI_CONTEXT_PATCH_MARKER) &&
		source.includes("buildAgentToolResultMiddlewareFactory") &&
		source.includes("runner.applyToolResultMiddleware")
	);
}

function patchTargetFile(target, pluginId, options = {}) {
	const before = fs.readFileSync(target, "utf8");

	let after = before;
	let trustChanged = false;
	let piContextChanged = false;

	const isTrustTarget = isRelevantRuntimeFile(before);
	const isPiExtensionsTarget = isRelevantPiExtensionsFile(target, before);
	const isPiCompiledTarget =
		isRelevantPiCompiledFile(target, before) ||
		isAlreadyPatchedPiCompiledFile(target, before);
	const isPiTarget = isPiExtensionsTarget || isPiCompiledTarget;

	if (isTrustTarget) {
		const patchedRuntime = patchRuntimeFile(after, pluginId);
		if (patchedRuntime !== after) {
			after = patchedRuntime;
			trustChanged = true;
		}
	}

	if (isPiExtensionsTarget) {
		const patchedPi = patchPiExtensionsFile(after);
		if (patchedPi !== after) {
			after = patchedPi;
			piContextChanged = true;
		}
	}

	if (isRelevantPiCompiledFile(target, before)) {
		const patchedPiCompiled = patchPiCompiledFile(after);
		if (patchedPiCompiled !== after) {
			after = patchedPiCompiled;
			piContextChanged = true;
		}
	}

	const changed = trustChanged || piContextChanged;

	const trustAlreadyPatched =
		isTrustTarget && !trustChanged && before.includes(PATCH_MARKER);
	const piContextAlreadyPatched =
		isPiTarget && !piContextChanged && before.includes(PI_CONTEXT_PATCH_MARKER);

	if (!changed) {
		if (!isTrustTarget && !isPiTarget) {
			console.warn(`Skipping non-matching file: ${target}`);
		} else if (
			before.includes(PATCH_MARKER) ||
			before.includes(PI_CONTEXT_PATCH_MARKER)
		) {
			console.log(`\nAlready patched: ${target}`);
		} else {
			console.warn(`\nFound target file, but could not apply patch: ${target}`);
			printPatchDiagnosticSnippet(before, target);
		}

		return {
			patched: false,
			alreadyPatched:
				before.includes(PATCH_MARKER) ||
				before.includes(PI_CONTEXT_PATCH_MARKER),
			trustPatched: false,
			trustAlreadyPatched,
			piContextPatched: false,
			piContextAlreadyPatched,
			piContextTargetFound: isPiTarget,
		};
	}

	verifyPatched(after, target, pluginId, {
		trustPatchApplied: trustChanged,
		piContextPatchApplied: piContextChanged,
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
		patched: true,
		alreadyPatched: false,
		trustPatched: trustChanged,
		trustAlreadyPatched: false,
		piContextPatched: piContextChanged,
		piContextAlreadyPatched: false,
		piContextTargetFound: isPiTarget,
	};
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

	// Patch only local middleware guard; leave other bundled-only guards alone.
	const windowStart = Math.max(0, symbolIndex - 500);
	const windowEnd = Math.min(source.length, diagnosticIndex + 1200);
	const window = source.slice(windowStart, windowEnd);

	if (window.includes(PATCH_MARKER)) {
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
		`/* ${PATCH_MARKER}: allow ${pluginId} */\n` +
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

	const runnerInit =
		'  const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" });\n\n';
	if (out.includes(runnerInit)) {
		out = out.replace(runnerInit, "");
	}

	if (
		!out.includes(PI_CONTEXT_PATCH_MARKER) &&
		out.includes("      if (!event.toolName) {")
	) {
		out = out.replace(
			"      if (!event.toolName) {\n        return undefined;\n      }\n",
			[
				"      if (!event.toolName) {",
				"        return undefined;",
				"      }",
				"",
				`      /* ${PI_CONTEXT_PATCH_MARKER} */`,
				"      const sessionManagerAny = params.sessionManager as any;",
				"",
				"      const middlewareCtx = {",
				'        runtime: "pi" as const,',
				"        agentId:",
				"          sessionManagerAny.agentId ??",
				"          sessionManagerAny.agent?.id ??",
				"          undefined,",
				"        sessionId:",
				"          sessionManagerAny.sessionId ??",
				"          sessionManagerAny.session?.id ??",
				"          sessionManagerAny.currentSessionId ??",
				"          undefined,",
				"        sessionKey:",
				"          sessionManagerAny.sessionKey ??",
				"          sessionManagerAny.session?.key ??",
				"          sessionManagerAny.key ??",
				"          undefined,",
				"        runId:",
				"          sessionManagerAny.runId ??",
				"          sessionManagerAny.currentRunId ??",
				"          undefined,",
				"      };",
				"",
				"      const runner = createAgentToolResultMiddlewareRunner(middlewareCtx);",
			].join("\n"),
		);
	}

	if (
		out.includes("      const toolCallId =") &&
		!out.includes("[openclaw-trace] pi.tool_result.middleware_context")
	) {
		out = out.replace(
			"      const result = await runner.applyToolResultMiddleware({",
			[
				"      if (",
				'        process.env.OPENCLAW_WORKFLOW_TRACE === "1" ||',
				'        process.env.OPENCLAW_WORKFLOW_TRACE === "true"',
				"      ) {",
				'        console.warn("[openclaw-trace] pi.tool_result.middleware_context", {',
				"          toolName: event.toolName,",
				"          toolCallId,",
				"          rawEventKeys: Object.keys(recordFromUnknown(rawEvent)),",
				"          rawEventThreadId: event.threadId,",
				"          sessionManagerKeys: Object.keys(params.sessionManager as any),",
				"          middlewareCtx,",
				"        });",
				"      }",
				"",
				"      const result = await runner.applyToolResultMiddleware({",
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

	// 1. Patch function signature to accept params.
	const signaturePattern =
		/function buildAgentToolResultMiddlewareFactory\(\)\s*\{/;
	if (signaturePattern.test(out)) {
		out = out.replace(
			signaturePattern,
			"function buildAgentToolResultMiddlewareFactory(params = {}) {",
		);
	}

	// 2. Remove top-level runner init — it will be reconstructed with context inside the handler.
	const runnerInitPattern =
		/^[ \t]*const runner = createAgentToolResultMiddlewareRunner\(\{ runtime: "pi" \}\);[ \t]*\n/m;
	if (runnerInitPattern.test(out)) {
		out = out.replace(runnerInitPattern, "");
	}

	// 3. Insert middlewareCtx + runner + trace immediately before applyToolResultMiddleware.
	if (
		!out.includes(PI_CONTEXT_PATCH_MARKER) &&
		out.includes("runner.applyToolResultMiddleware(")
	) {
		out = out.replace(
			/^([ \t]*)const result = await runner\.applyToolResultMiddleware\(/m,
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

	// 4. Patch factory call site.
	const factoryCallPattern =
		/factories\.push\(buildAgentToolResultMiddlewareFactory\(\)\);/;
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
			PATCH_MARKER,
			pluginId,
			FUNCTION_NAME,
			DIAGNOSTIC,
			`record.id !== ${JSON.stringify(pluginId)}`,
		);
	}

	if (piContextPatchApplied) {
		const isTypescriptSource = file.endsWith(PI_EXTENSIONS_RELATIVE_PATH);
		required.push(
			PI_CONTEXT_PATCH_MARKER,
			"const middlewareCtx = {",
			"const runner = createAgentToolResultMiddlewareRunner(middlewareCtx);",
			"[openclaw-trace] pi.tool_result.middleware_context",
		);
		if (isTypescriptSource) {
			required.push("sessionManager: SessionManager;");
			required.push("sessionManager: params.sessionManager,");
		} else {
			required.push("params.sessionManager");
		}
	}
}

function restoreLatestBackupForFile(file) {
	const dir = path.dirname(file);
	const base = path.basename(file);
	const prefix = `${base}.bak-openclaw-workflow-`;

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

function printMiddlewareSnippet(source) {
	const index = source.indexOf(FUNCTION_NAME);
	const start = Math.max(0, index - 500);
	const end = Math.min(source.length, index + 2000);

	console.log("\nMiddleware snippet:");
	console.log(source.slice(start, end));
}

function printPatchDiagnosticSnippet(source, file) {
	if (file.endsWith(PI_EXTENSIONS_RELATIVE_PATH)) {
		const index = source.indexOf('pi.on("tool_result"');
		const start = Math.max(0, index - 500);
		const end = Math.min(source.length, index + 2500);

		console.log("\nPi middleware snippet:");
		console.log(source.slice(start, end));
		return;
	}

	printMiddlewareSnippet(source);
}

function printPatchSnippet(source) {
	const index = Math.max(
		source.indexOf(PATCH_MARKER),
		source.indexOf(PI_CONTEXT_PATCH_MARKER),
	);
	const start = Math.max(0, index - 500);
	const end = Math.min(source.length, index + 1200);

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
	findRuntimeFilesInPackageRoot,
	isAlreadyPatchedPiCompiledFile,
	isRelevantPiCompiledFile,
	isRelevantPiExtensionsFile,
	isRelevantRuntimeFile,
	patchPiCompiledFile,
	patchPiExtensionsFile,
	patchRuntimeFile,
};
