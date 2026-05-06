#!/usr/bin/env node

/**
 * Patch OpenClaw so one trusted external plugin can register
 * agentToolResultMiddleware.
 *
 * Intended use after each OpenClaw update:
 *
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --plugin openclaw-workflow
 *
 * Optional:
 *
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --root /path/to/openclaw --plugin openclaw-workflow
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --dry-run
 *   node scripts/patch-openclaw-trust-workflow-middleware.mjs --restore --root /path/to/openclaw
 *
 * What it patches:
 *   The guard that rejects non-bundled plugins from registering
 *   agentToolResultMiddleware, changing:
 *
 *     if (record.origin !== "bundled") { ... reject ... }
 *
 *   into:
 *
 *     if (record.origin !== "bundled" && record.id !== "openclaw-workflow") { ... reject ... }
 *
 * It only patches files containing both:
 *   - registerAgentToolResultMiddleware
 *   - only bundled plugins can register agent tool result middleware
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PATCH_MARKER =
	"openclaw-workflow trusted external agentToolResultMiddleware patch";

const DEFAULT_PLUGIN_ID = "openclaw-workflow";

const args = parseArgs(process.argv.slice(2));

const pluginId = args.plugin ?? DEFAULT_PLUGIN_ID;
const dryRun = Boolean(args["dry-run"]);
const restore = Boolean(args.restore);
const verbose = Boolean(args.verbose);

main().catch((err) => {
	console.error(`\nERROR: ${err?.stack || err?.message || String(err)}`);
	process.exit(1);
});

async function main() {
	if (!/^[a-zA-Z0-9._@/-]+$/.test(pluginId)) {
		throw new Error(`Unsafe plugin id: ${pluginId}`);
	}

	const roots = getCandidateRoots(args.root);

	if (roots.length === 0) {
		throw new Error(
			[
				"Could not discover OpenClaw install root.",
				"Pass --root explicitly, for example:",
				'  node scripts/patch-openclaw-trust-workflow-middleware.mjs --root "C:\\Users\\Adnan\\AppData\\Roaming\\npm\\node_modules\\openclaw"',
				"or:",
				"  OPENCLAW_ROOT=/path/to/openclaw node scripts/patch-openclaw-trust-workflow-middleware.mjs",
			].join("\n"),
		);
	}

	log(`Plugin allowed for middleware: ${pluginId}`);
	log(`Dry run: ${dryRun ? "yes" : "no"}`);
	log(`Restore: ${restore ? "yes" : "no"}`);
	log("Candidate roots:");
	for (const root of roots) log(`  - ${root}`);

	if (restore) {
		const restored = restoreLatestBackups(roots);
		if (restored.length === 0) {
			throw new Error("No backups found to restore.");
		}

		log("\nRestored:");
		for (const file of restored) log(`  - ${file}`);
		return;
	}

	const candidates = [];

	for (const root of roots) {
		for (const file of walkFiles(root)) {
			if (!isPatchCandidateFile(file)) continue;

			const text = safeRead(file);
			if (!text) continue;

			if (
				text.includes("registerAgentToolResultMiddleware") &&
				text.includes(
					"only bundled plugins can register agent tool result middleware",
				)
			) {
				candidates.push(file);
			}
		}
	}

	if (candidates.length === 0) {
		throw new Error(
			[
				"Could not find the OpenClaw registry file containing the middleware bundled-plugin guard.",
				"This can mean one of:",
				"  1. Your OpenClaw version already changed the guard text.",
				"  2. You pointed --root at the wrong directory.",
				"  3. Your installed OpenClaw build does not include agentToolResultMiddleware.",
				"",
				"Try locating it manually:",
				'  rg "only bundled plugins can register agent tool result middleware" <openclaw-root>',
				'  rg "registerAgentToolResultMiddleware" <openclaw-root>',
			].join("\n"),
		);
	}

	log("\nFound candidate files:");
	for (const file of candidates) log(`  - ${file}`);

	const patched = [];

	for (const file of candidates) {
		const before = fs.readFileSync(file, "utf8");

		if (before.includes(PATCH_MARKER) && before.includes(pluginId)) {
			log(`\nAlready patched: ${file}`);
			patched.push({ file, status: "already_patched" });
			continue;
		}

		const after = patchRegistrySource(before, pluginId);

		if (after === before) {
			log(`\nNo patch applied to: ${file}`);
			continue;
		}

		verifyPatchedSource(after, pluginId, file);

		if (!dryRun) {
			const backup = `${file}.bak-openclaw-workflow-${timestamp()}`;
			fs.copyFileSync(file, backup);
			fs.writeFileSync(file, after, "utf8");
			log(`\nPatched: ${file}`);
			log(`Backup:  ${backup}`);
		} else {
			log(`\nWould patch: ${file}`);
		}

		patched.push({ file, status: dryRun ? "dry_run" : "patched" });
	}

	if (patched.length === 0) {
		throw new Error(
			"Found candidate files, but none matched a known patch pattern. Open the candidate file and patch the guard manually.",
		);
	}

	log("\nDone.");
	log(
		[
			"Next steps:",
			"  1. Restart OpenClaw/gateway.",
			"  2. Ensure your plugin manifest declares contracts.agentToolResultMiddleware.",
			"  3. Confirm your plugin's middleware registers successfully.",
			"  4. Run your workflow_runtime_patch_status / middleware status tool.",
		].join("\n"),
	);
}

function patchRegistrySource(source, pluginId) {
	const markerComment = `/* ${PATCH_MARKER}: allow ${pluginId} */`;

	// Patch only a local window around the exact diagnostic message, so we do not
	// accidentally relax unrelated bundled-only restrictions.
	const diagnostic =
		"only bundled plugins can register agent tool result middleware";

	let cursor = 0;
	let output = source;
	let patchedAny = false;

	while (true) {
		const diagnosticIndex = output.indexOf(diagnostic, cursor);
		if (diagnosticIndex < 0) break;

		const windowStart = Math.max(0, diagnosticIndex - 2500);
		const windowEnd = Math.min(output.length, diagnosticIndex + 2500);
		const window = output.slice(windowStart, windowEnd);

		const patchedWindow = patchOriginGuardWindow(
			window,
			pluginId,
			markerComment,
		);

		if (patchedWindow !== window) {
			output =
				output.slice(0, windowStart) + patchedWindow + output.slice(windowEnd);
			patchedAny = true;
			cursor = windowStart + patchedWindow.length;
		} else {
			cursor = diagnosticIndex + diagnostic.length;
		}
	}

	if (patchedAny) {
		return output;
	}

	// Fallback for minified or rearranged code: patch a larger area near
	// registerAgentToolResultMiddleware if it also contains the diagnostic.
	const methodIndex = output.indexOf("registerAgentToolResultMiddleware");
	if (methodIndex >= 0) {
		const windowStart = Math.max(0, methodIndex - 5000);
		const windowEnd = Math.min(output.length, methodIndex + 8000);
		const window = output.slice(windowStart, windowEnd);

		if (window.includes(diagnostic)) {
			const patchedWindow = patchOriginGuardWindow(
				window,
				pluginId,
				markerComment,
			);

			if (patchedWindow !== window) {
				return (
					output.slice(0, windowStart) + patchedWindow + output.slice(windowEnd)
				);
			}
		}
	}

	return source;
}

function patchOriginGuardWindow(window, pluginId, markerComment) {
	if (window.includes(PATCH_MARKER)) return window;

	const escapedPluginId = JSON.stringify(pluginId);

	// Most likely source:
	//   if (record.origin !== "bundled") {
	//
	// We keep the original variable name and only add a plugin-id exception.
	const patterns = [
		/if\s*\(\s*([A-Za-z_$][\w$]*)\.origin\s*!==\s*(['"])bundled\2\s*\)\s*\{/g,
		/if\s*\(\s*(['"])bundled\1\s*!==\s*([A-Za-z_$][\w$]*)\.origin\s*\)\s*\{/g,
	];

	for (const pattern of patterns) {
		let match;
		let lastMatch = null;

		while ((match = pattern.exec(window))) {
			lastMatch = match;
		}

		if (!lastMatch) continue;

		if (pattern === patterns[0]) {
			const variable = lastMatch[1];
			const quote = lastMatch[2];

			const original = lastMatch[0];
			const replacement =
				`${markerComment}\n` +
				`if (${variable}.origin !== ${quote}bundled${quote} && ${variable}.id !== ${escapedPluginId}) {`;

			return (
				window.slice(0, lastMatch.index) +
				replacement +
				window.slice(lastMatch.index + original.length)
			);
		}

		if (pattern === patterns[1]) {
			const quote = lastMatch[1];
			const variable = lastMatch[2];

			const original = lastMatch[0];
			const replacement =
				`${markerComment}\n` +
				`if (${quote}bundled${quote} !== ${variable}.origin && ${variable}.id !== ${escapedPluginId}) {`;

			return (
				window.slice(0, lastMatch.index) +
				replacement +
				window.slice(lastMatch.index + original.length)
			);
		}
	}

	// More generic fallback:
	// Patch just the first origin !== bundled expression in the window.
	const generic = /([A-Za-z_$][\w$]*)\.origin\s*!==\s*(['"])bundled\2/;

	const match = generic.exec(window);

	if (match) {
		const variable = match[1];
		const quote = match[2];
		const original = match[0];
		const replacement = `(${variable}.origin !== ${quote}bundled${quote} && ${variable}.id !== ${escapedPluginId})`;

		return (
			markerComment +
			"\n" +
			window.slice(0, match.index) +
			replacement +
			window.slice(match.index + original.length)
		);
	}

	return window;
}

function verifyPatchedSource(source, pluginId, file) {
	if (!source.includes(PATCH_MARKER)) {
		throw new Error(`Patch verification failed for ${file}: missing marker.`);
	}

	if (!source.includes(pluginId)) {
		throw new Error(
			`Patch verification failed for ${file}: missing plugin id.`,
		);
	}

	if (!source.includes("registerAgentToolResultMiddleware")) {
		throw new Error(
			`Patch verification failed for ${file}: missing middleware symbol.`,
		);
	}

	if (
		!source.includes(
			"only bundled plugins can register agent tool result middleware",
		)
	) {
		throw new Error(
			`Patch verification failed for ${file}: missing expected diagnostic text.`,
		);
	}
}

function restoreLatestBackups(roots) {
	const backups = [];

	for (const root of roots) {
		for (const file of walkFiles(root)) {
			if (file.includes(".bak-openclaw-workflow-")) {
				backups.push(file);
			}
		}
	}

	const groups = new Map();

	for (const backup of backups) {
		const original = backup.replace(
			/\.bak-openclaw-workflow-\d{8}T\d{6}Z$/,
			"",
		);
		if (!groups.has(original)) groups.set(original, []);
		groups.get(original).push(backup);
	}

	const restored = [];

	for (const [original, files] of groups.entries()) {
		files.sort();
		const latest = files[files.length - 1];

		if (!dryRun) {
			fs.copyFileSync(latest, original);
		}

		restored.push(original);
	}

	return restored;
}

function getCandidateRoots(explicitRoot) {
	const roots = new Set();

	const add = (value) => {
		if (!value) return;

		const resolved = path.resolve(String(value));

		try {
			const real = fs.realpathSync(resolved);
			if (fs.existsSync(real)) roots.add(real);
		} catch {
			// Ignore.
		}
	};

	add(explicitRoot);
	add(process.env.OPENCLAW_ROOT);

	// Global package roots.
	for (const cmd of ["npm", "pnpm"]) {
		try {
			const root = execFileSync(cmd, ["root", "-g"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();

			add(path.join(root, "openclaw"));
			add(path.join(root, "@openclaw", "openclaw"));
		} catch {
			// Ignore.
		}
	}

	// Resolve openclaw command path if available.
	for (const cmd of process.platform === "win32" ? ["where"] : ["which"]) {
		try {
			const output = execFileSync(cmd, ["openclaw"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			})
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);

			for (const cliPath of output) {
				add(path.dirname(cliPath));
				add(path.dirname(path.dirname(cliPath)));

				// Common npm shim target layout:
				//   .../npm/openclaw.cmd -> .../npm/node_modules/openclaw/...
				const parent = path.dirname(cliPath);
				add(path.join(parent, "node_modules", "openclaw"));
				add(path.join(path.dirname(parent), "node_modules", "openclaw"));
			}
		} catch {
			// Ignore.
		}
	}

	// Common user-level OpenClaw/runtime locations.
	const home = os.homedir();
	add(path.join(home, ".openclaw"));
	add(path.join(home, ".openclaw", "plugin-runtime-deps"));

	if (process.platform === "win32") {
		add(
			process.env.APPDATA &&
				path.join(process.env.APPDATA, "npm", "node_modules", "openclaw"),
		);
		add(
			process.env.LOCALAPPDATA &&
				path.join(process.env.LOCALAPPDATA, "openclaw"),
		);
		add(
			process.env.LOCALAPPDATA &&
				path.join(process.env.LOCALAPPDATA, "Programs", "openclaw"),
		);
	} else {
		add("/usr/local/lib/node_modules/openclaw");
		add("/opt/homebrew/lib/node_modules/openclaw");
	}

	// Keep only directories.
	return [...roots].filter((root) => {
		try {
			return fs.statSync(root).isDirectory();
		} catch {
			return false;
		}
	});
}

function* walkFiles(root) {
	const stack = [root];
	let seen = 0;
	const maxFiles = 80_000;

	while (stack.length) {
		const current = stack.pop();

		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const full = path.join(current, entry.name);

			if (entry.isDirectory()) {
				if (shouldSkipDir(entry.name, full)) continue;
				stack.push(full);
				continue;
			}

			if (!entry.isFile()) continue;

			seen += 1;
			if (seen > maxFiles) {
				if (verbose) {
					console.warn(
						`Stopped scanning ${root}: file limit ${maxFiles} reached.`,
					);
				}
				return;
			}

			yield full;
		}
	}
}

function shouldSkipDir(name, fullPath) {
	if (
		name === ".git" ||
		name === ".hg" ||
		name === ".svn" ||
		name === "coverage" ||
		name === ".cache" ||
		name === ".next" ||
		name === "tmp" ||
		name === "temp"
	) {
		return true;
	}

	// Do not skip node_modules globally, because npm-installed OpenClaw lives in
	// node_modules. But avoid nested dependency forests unless they look relevant.
	if (name === "node_modules" && !/openclaw/i.test(fullPath)) {
		return true;
	}

	return false;
}

function isPatchCandidateFile(file) {
	const ext = path.extname(file).toLowerCase();
	if (![".js", ".mjs", ".cjs", ".ts", ".tsx"].includes(ext)) return false;

	const base = path.basename(file).toLowerCase();
	const full = file.toLowerCase();

	if (
		base.includes("registry") ||
		base.includes("plugin") ||
		base.includes("middleware") ||
		full.includes(`${path.sep}plugins${path.sep}`) ||
		full.includes(`${path.sep}dist${path.sep}`)
	) {
		try {
			const stat = fs.statSync(file);
			return stat.size <= 5 * 1024 * 1024;
		} catch {
			return false;
		}
	}

	return false;
}

function safeRead(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function parseArgs(argv) {
	const out = {};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];

		if (!arg.startsWith("--")) {
			continue;
		}

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

function timestamp() {
	return new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

function log(message) {
	console.log(message);
}
