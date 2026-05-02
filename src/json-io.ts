import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Atomically writes JSON to disk and verifies the serialized file parses before replace.
 *
 * Behavior mirrors:
 * - write temp file in target directory
 * - parse temp file back as JSON (self-validation)
 * - atomic replace into final destination
 * - best-effort temp cleanup on failure
 */
export async function writeJsonAtomic(
	path: string,
	obj: unknown,
): Promise<void> {
	const targetDir = dirname(path);
	await mkdir(targetDir, { recursive: true });

	const tempDir = await mkdtemp(join(targetDir, ".tmp-"));
	const tempPath = join(tempDir, ".tmp-output.json");

	try {
		const json = `${JSON.stringify(obj, null, 2)}\n`;
		await writeFile(tempPath, json, "utf8");

		// Self-validate serialization before replace.
		const verify = await readFile(tempPath, "utf8");
		JSON.parse(verify);

		await rename(tempPath, path);
	} catch (err) {
		try {
			await rm(tempPath, { force: true });
		} catch {
			// Best-effort cleanup only.
		}
		throw err;
	} finally {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup only.
		}
	}
}
