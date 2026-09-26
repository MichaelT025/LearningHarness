/**
 * Per-cwd extension module cache patch for @earendil-works/pi-coding-agent.
 *
 * The SDK memoizes loaded extension factories (jiti-compiled TypeScript) in
 * ONE global map that remembers a single cwd: `useExtensionCacheCwd` wipes
 * the whole map the moment a runtime boots for a different directory. That
 * is fine for the CLI (one process, one cwd) but this server keeps several
 * projects open at once, so every cross-project new chat, history open or
 * worktree chat recompiles every extension from scratch — ~3 s with the
 * PiAstra extension set — while a same-cwd boot takes ~60 ms.
 *
 * The rewrite keys the cache by the extension's absolute path alone: the map
 * is still cleared by `clearExtensionCache()` (explicit `/reload`), but a
 * cwd change no longer evicts anything, and the global extensions under
 * `~/.pi/agent/extensions` compile once per process instead of once per
 * project. Factories are module-level exports that receive their cwd through
 * the extension API at activation time, so a factory compiled for one
 * directory is the same value for every other — the SDK's own same-cwd
 * reuse already relies on that.
 *
 * Same pattern as patch-remote-catalog.ts: idempotent, best-effort (an SDK
 * version whose source no longer matches leaves the default behaviour — a
 * slower switch, never a crash). MUST be imported before the SDK modules are
 * first loaded (agent-service.ts imports it next to the catalog patch).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Every fragment must match exactly once; replacements applied together. */
const REWRITES: ReadonlyArray<readonly [old: string, replacement: string]> = [
	[
		`function useExtensionCacheCwd(cwd) {
    const resolvedCwd = resolvePath(cwd);
    if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
        clearExtensionCache();
    }
    extensionCacheCwd = resolvedCwd;
    return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}`,
		`function useExtensionCacheCwd(cwd) {
    const resolvedCwd = resolvePath(cwd);
    // pi-web-ui: the cache is keyed by extension path only (extensionCacheKey);
    // a cwd change must not evict the other open projects' factories.
    extensionCacheCwd = resolvedCwd;
    return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}
function extensionCacheKey(cacheToken, extensionPath) {
    return extensionPath;
}`,
	],
	[
		`    return (cacheToken !== undefined &&
        extensionCacheCwd === cacheToken.cwd &&
        extensionCacheGeneration === cacheToken.generation);`,
		`    return (cacheToken !== undefined &&
        extensionCacheGeneration === cacheToken.generation);`,
	],
	[
		`        const cachedFactory = extensionCache.get(extensionPath);`,
		`        const cachedFactory = extensionCache.get(extensionCacheKey(cacheToken, extensionPath));`,
	],
	[
		`        extensionCache.set(extensionPath, factory);`,
		`        extensionCache.set(extensionCacheKey(cacheToken, extensionPath), factory);`,
	],
];

/** Absolute path of the installed extensions/loader.js, or null. */
function loaderFile(): string | null {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		return join(dirname(entry), "core", "extensions", "loader.js");
	} catch {
		return null;
	}
}

/** Apply the rewrites to `src`; null when already patched or unrecognised. */
export function patchExtensionCacheSource(src: string): string | null {
	if (src.includes("function extensionCacheKey(")) return null; // already patched
	let out = src;
	for (const [old, replacement] of REWRITES) {
		const first = out.indexOf(old);
		if (first < 0 || out.indexOf(old, first + 1) >= 0) return null; // unexpected SDK content
		out = out.replace(old, replacement);
	}
	return out;
}

function applyPatch(): void {
	try {
		const file = loaderFile();
		if (!file || !existsSync(file)) return;
		const patched = patchExtensionCacheSource(readFileSync(file, "utf8"));
		if (patched !== null) writeFileSync(file, patched, "utf8");
	} catch {
		// best-effort — without the patch cross-project switches just recompile
	}
}

applyPatch();
