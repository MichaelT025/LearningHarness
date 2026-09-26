import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A quota window returned to the browser. */
export interface SubscriptionWindow {
	label: string;
	windowSeconds: number;
	usedPercent: number;
	resetsAt: string | null;
}

export interface SubscriptionCredit {
	label: string;
	remaining: number;
	unit: "credits" | "USD";
}

export interface SubscriptionProvider {
	providerId: string;
	displayName: string;
	state: "ok" | "unavailable" | "unconfigured";
	windows: SubscriptionWindow[];
	plan?: string;
	credits?: SubscriptionCredit[];
	fetchedAt: string | null;
	checkedAt: string;
	error?: string;
	retryAt?: string;
	stale?: boolean;
}

export interface SubscriptionSnapshot {
	status: "ready" | "disabled" | "unavailable";
	providers: SubscriptionProvider[];
	refreshAfterMs: number;
}

/** The small part of ModelRuntime used by the CLI usage extension. */
export interface SubscriptionModelRuntime {
	getAuth(providerId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
	getProvider?(providerId: string): unknown;
	getRegisteredNativeProvider?(providerId: string): unknown;
}

type ProviderDefinition = {
	id: string;
	displayName: string;
	load: (context: { token: string; signal: AbortSignal; fetch: typeof globalThis.fetch }) => Promise<unknown>;
};

type UsageResult = {
	providerId?: unknown;
	displayName?: unknown;
	state?: unknown;
	windows?: unknown;
	plan?: unknown;
	credits?: unknown;
	fetchedAt?: unknown;
	checkedAt?: unknown;
	error?: unknown;
	retryAt?: unknown;
	stale?: unknown;
	retryAfterMs?: unknown;
	accountKey?: unknown;
};

type UsageService = {
	refresh(): Promise<unknown>;
	getSnapshot(): unknown[];
	dispose(): void;
};

type UsageModules = {
	createUsageService: (options: {
		providers: ProviderDefinition[];
		fetchProvider: (provider: ProviderDefinition, options: { signal: AbortSignal }) => Promise<unknown>;
		onUpdate?: (snapshot: unknown[]) => void;
	}) => UsageService;
	createAuthResolver: (registry: {
		getProviderAuth: (providerId: string) => Promise<unknown>;
		getProvider?: (providerId: string) => unknown;
	}) => (providerId: string) => Promise<unknown>;
	fetchProvider: (
		provider: ProviderDefinition,
		options: { resolveAuth: (providerId: string) => Promise<unknown>; signal: AbortSignal },
	) => Promise<unknown>;
	codexProvider: ProviderDefinition;
	goProvider: ProviderDefinition;
	commandProvider: ProviderDefinition;
};

/** Injectable only to make the bridge unit-testable without network or CLI files. */
export type SubscriptionUsageModuleLoader = () => Promise<UsageModules | undefined>;

const STALE_AFTER_MS = 180_000;
const REFRESH_AFTER_MS = 180_000;
const AUTH_TIMEOUT_MS = 12_000;
const ENTRY_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 48;
const ERROR_CODES = new Set(["AUTH", "NOT_CONFIGURED", "NOT_ENTITLED", "RATE_LIMITED", "NETWORK", "PARSE", "HTTP"]);

const here = dirname(fileURLToPath(import.meta.url));
let modulePromise: Promise<UsageModules | undefined> | undefined;
let injectedLoader: SubscriptionUsageModuleLoader | undefined;

function moduleFile(root: string, name: string): string {
	return pathToFileURL(join(root, name)).href;
}

function rootFromOverride(value: string): string | undefined {
	try {
		const path = value.startsWith("file:") ? fileURLToPath(value) : value;
		const stat = statSync(path);
		if (stat.isDirectory()) return path;
		if (stat.isFile()) return dirname(path);
	} catch {
		// A nonexistent override is simply an unavailable installation.
	}
	return undefined;
}

function usageRoots(): string[] {
	const roots: string[] = [];
	const explicit = process.env.DISPATCH_PI_USAGE_ROOT?.trim();
	if (explicit) {
		const root = rootFromOverride(explicit);
		if (root) roots.push(root);
		return roots;
	}

	// A published Dispatch package may put this file in either server/ or
	// dist/server/. Walk package ancestors rather than depending on an install
	// location (in particular, never assume a developer's global npm path).
	let cursor = here;
	for (let i = 0; i < 6; i++) {
		roots.push(join(cursor, "extensions", "pi-usage"));
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}

	// The extension is also published by the Dispatch package. Resolve it by
	// package name so global, local, and bundled installs all work.
	try {
		const require = createRequire(import.meta.url);
		let entry: string;
		try {
			entry = require.resolve("@michaelt025/dispatch/package.json");
		} catch {
			entry = require.resolve("@michaelt025/dispatch");
		}
		cursor = dirname(entry);
		if (!entry.endsWith("package.json")) {
			for (let i = 0; i < 6; i++) {
				if (existsSync(join(cursor, "package.json"))) break;
				const parent = dirname(cursor);
				if (parent === cursor) break;
				cursor = parent;
			}
		}
		roots.push(join(cursor, "extensions", "pi-usage"));
	} catch {
		// Dispatch is an optional peer of the web package.
	}
	return [...new Set(roots)];
}

async function importUsageModules(): Promise<UsageModules | undefined> {
	for (const root of usageRoots()) {
		if (!existsSync(join(root, "service.mjs"))) continue;
		try {
			const [service, auth, adapter, codex, go, command] = await Promise.all([
				import(moduleFile(root, "service.mjs")),
				import(moduleFile(root, "auth.mjs")),
				import(moduleFile(root, "adapter.mjs")),
				import(moduleFile(root, "codex.mjs")),
				import(moduleFile(root, "go.mjs")),
				import(moduleFile(root, "command.mjs")),
			]);
			if (
				typeof service.createUsageService !== "function" ||
				typeof auth.createAuthResolver !== "function" ||
				typeof adapter.fetchProvider !== "function" ||
				!codex.codexProvider ||
				!go.goProvider ||
				!command.commandProvider
			)
				continue;
			return {
				createUsageService: service.createUsageService,
				createAuthResolver: auth.createAuthResolver,
				fetchProvider: adapter.fetchProvider,
				codexProvider: codex.codexProvider,
				goProvider: go.goProvider,
				commandProvider: command.commandProvider,
			};
		} catch {
			// Try the next package-relative candidate; an incomplete package is
			// indistinguishable from a missing optional extension to the web UI.
		}
	}
	return undefined;
}

function loadModules(): Promise<UsageModules | undefined> {
	if (!modulePromise) modulePromise = (injectedLoader ? injectedLoader() : importUsageModules()).catch(() => undefined);
	return modulePromise;
}

function tokenFingerprint(providerId: string, token: string): string {
	return createHash("sha256").update(`${providerId}\0${token}`).digest("hex");
}

function authToken(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const auth = (value as { apiKey?: unknown }).apiKey;
	return typeof auth === "string" && auth.trim() ? auth : undefined;
}

function timestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
	return value;
}

function checkedAt(value: unknown): number | undefined {
	const valueString = timestamp(value);
	return valueString === undefined ? undefined : Date.parse(valueString);
}

function publicProvider(
	value: unknown,
	definition: ProviderDefinition,
	fallbackCheckedAt: string,
): SubscriptionProvider {
	const result = (value && typeof value === "object" ? value : {}) as UsageResult;
	const state = result.state === "ok" || result.state === "unconfigured" ? result.state : "unavailable";
	const windows: SubscriptionWindow[] = [];
	if (Array.isArray(result.windows)) {
		for (const item of result.windows) {
			if (!item || typeof item !== "object") continue;
			const window = item as Record<string, unknown>;
			if (
				typeof window.label !== "string" ||
				typeof window.windowSeconds !== "number" ||
				!Number.isFinite(window.windowSeconds)
			)
				continue;
			if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
			const reset = window.resetsAt;
			windows.push({
				label: window.label,
				windowSeconds: window.windowSeconds,
				usedPercent: window.usedPercent,
				resetsAt: reset === null ? null : (timestamp(reset) ?? null),
			});
		}
	}
	const credits: SubscriptionCredit[] = [];
	if (Array.isArray(result.credits)) {
		for (const item of result.credits) {
			if (!item || typeof item !== "object") continue;
			const credit = item as Record<string, unknown>;
			if (
				typeof credit.label === "string" &&
				typeof credit.remaining === "number" &&
				Number.isFinite(credit.remaining) &&
				(credit.unit === "credits" || credit.unit === "USD")
			) {
				credits.push({ label: credit.label, remaining: credit.remaining, unit: credit.unit });
			}
		}
	}
	const output: SubscriptionProvider = {
		providerId: definition.id,
		displayName: definition.displayName,
		state,
		windows,
		fetchedAt: timestamp(result.fetchedAt) ?? null,
		checkedAt: timestamp(result.checkedAt) ?? fallbackCheckedAt,
	};
	if (typeof result.plan === "string" && result.plan) output.plan = result.plan;
	if (credits.length) output.credits = credits;
	if (typeof result.error === "string" && ERROR_CODES.has(result.error)) output.error = result.error;
	const retryAt = timestamp(result.retryAt);
	if (retryAt) output.retryAt = retryAt;
	if (result.stale === true) output.stale = true;
	return output;
}

type CacheEntry = {
	key: string;
	provider: ProviderDefinition;
	auth: { apiKey: string } | undefined;
	authError?: string;
	service: UsageService;
	lastUsed: number;
	active: number;
	/** A short manual-click guard, separate from the CLI's provider rate-limit cooldown. */
	manualRefreshUntil: number;
};

class SubscriptionUsageBridge {
	private readonly entries = new Map<string, CacheEntry>();

	private async unavailable(): Promise<SubscriptionSnapshot> {
		return { status: "unavailable", providers: [], refreshAfterMs: REFRESH_AFTER_MS };
	}

	private registry(runtime: SubscriptionModelRuntime, signal: AbortSignal) {
		return {
			// ModelRuntime 0.85.1 accepts AuthOperationOptions, including signal.
			// The CLI resolver may also read command-code's auth file; the outer
			// race below covers that path, which cannot itself accept a signal.
			getProviderAuth: (providerId: string) => runtime.getAuth(providerId, { signal }),
			getProvider: (providerId: string) =>
				runtime.getProvider?.(providerId) ?? runtime.getRegisteredNativeProvider?.(providerId),
		};
	}

	private async resolveAuth(
		runtime: SubscriptionModelRuntime,
		modules: UsageModules,
		providerId: string,
	): Promise<{ auth?: { apiKey: string }; error?: string }> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			const resolver = modules.createAuthResolver(this.registry(runtime, controller.signal));
			const resolution = Promise.resolve().then(() => resolver(providerId));
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
					reject(new Error("AUTH_TIMEOUT"));
				}, AUTH_TIMEOUT_MS);
			});
			const resolved = await Promise.race([resolution, timeout]);
			const token = authToken(resolved);
			return token ? { auth: { apiKey: token } } : {};
		} catch {
			return { error: "AUTH" };
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (timedOut) controller.abort();
		}
	}

	private async contexts(runtime: SubscriptionModelRuntime, modules: UsageModules): Promise<Map<string, CacheEntry>> {
		const definitions = [modules.codexProvider, modules.goProvider, modules.commandProvider];
		const resolved = await Promise.all(
			definitions.map(async (provider) => ({ provider, ...(await this.resolveAuth(runtime, modules, provider.id)) })),
		);
		const contexts = new Map<string, CacheEntry>();
		for (const { provider, auth, error: authError } of resolved) {
			const account = auth ? tokenFingerprint(provider.id, auth.apiKey) : authError ? "auth-error" : "none";
			const key = `${provider.id}\0${account}`;
			let entry = this.entries.get(key);
			if (!entry) {
				// The adapter remains the owner of credential handling, response
				// classification, and provider state. This closure only supplies the
				// already-resolved credential for this cache entry.
				const fixedAuth = () => Promise.resolve(auth);
				const fetchOne = (definition: ProviderDefinition, options: { signal: AbortSignal }) => {
					if (authError) {
						return Promise.resolve({
							providerId: definition.id,
							displayName: definition.displayName,
							state: "unavailable",
							windows: [],
							fetchedAt: null,
							checkedAt: new Date().toISOString(),
							error: authError,
						});
					}
					return modules.fetchProvider(definition, { resolveAuth: fixedAuth, signal: options.signal });
				};
				const service = modules.createUsageService({
					providers: [provider],
					fetchProvider: fetchOne,
					onUpdate: () => {},
				});
				entry = { key, provider, auth, authError, service, lastUsed: Date.now(), active: 0, manualRefreshUntil: 0 };
				this.entries.set(key, entry);
			} else {
				entry.auth = auth;
				entry.authError = authError;
				entry.lastUsed = Date.now();
			}
			contexts.set(provider.id, entry);
		}
		return contexts;
	}

	private stale(entry: CacheEntry): boolean {
		const current = entry.service.getSnapshot()[0] as UsageResult | undefined;
		if (!current) return true;
		const at = checkedAt(current.checkedAt);
		return at === undefined || Date.now() - at > STALE_AFTER_MS;
	}

	private async refreshEntry(entry: CacheEntry, manual = false): Promise<void> {
		entry.active++;
		if (manual) entry.manualRefreshUntil = Date.now() + 10_000;
		try {
			await entry.service.refresh();
		} catch {
			// createUsageService normally classifies failures. Do not leak a raw
			// provider/service exception if an injected implementation does not.
		} finally {
			entry.active--;
			entry.lastUsed = Date.now();
			if (manual) entry.manualRefreshUntil = Date.now() + 10_000;
		}
	}

	private cleanup(): void {
		const cutoff = Date.now() - ENTRY_TTL_MS;
		for (const [key, entry] of this.entries) {
			if (entry.active === 0 && entry.lastUsed < cutoff) {
				entry.service.dispose();
				this.entries.delete(key);
			}
		}
		if (this.entries.size <= MAX_ENTRIES) return;
		const candidates = [...this.entries.values()]
			.filter((entry) => entry.active === 0)
			.sort((a, b) => a.lastUsed - b.lastUsed);
		for (const entry of candidates) {
			if (this.entries.size <= MAX_ENTRIES) break;
			entry.service.dispose();
			this.entries.delete(entry.key);
		}
	}

	async read(runtime: SubscriptionModelRuntime, providerId?: string, force = false): Promise<SubscriptionSnapshot> {
		if (process.env.DISPATCH_USAGE_DISABLED === "1")
			return { status: "disabled", providers: [], refreshAfterMs: REFRESH_AFTER_MS };
		const modules = await loadModules();
		if (!modules) return this.unavailable();
		let contexts: Map<string, CacheEntry>;
		try {
			contexts = await this.contexts(runtime, modules);
		} catch {
			return this.unavailable();
		}
		const refreshes: Promise<void>[] = [];
		for (const [id, entry] of contexts) {
			if (providerId && id !== providerId) continue;
			if (force && Date.now() < entry.manualRefreshUntil && entry.active === 0) continue;
			if (force || this.stale(entry)) refreshes.push(this.refreshEntry(entry, force));
		}
		await Promise.all(refreshes);
		const now = new Date().toISOString();
		const providers = [...contexts.values()].map((entry) => {
			const result = entry.service.getSnapshot()[0];
			if (result) {
				const provider = publicProvider(result, entry.provider, now);
				const retryUntil = Math.max(Date.parse(provider.retryAt ?? "") || 0, entry.manualRefreshUntil);
				if (retryUntil > Date.now()) provider.retryAt = new Date(retryUntil).toISOString();
				return provider;
			}
			return {
				providerId: entry.provider.id,
				displayName: entry.provider.displayName,
				state: entry.auth || entry.authError ? "unavailable" : "unconfigured",
				windows: [],
				fetchedAt: null,
				checkedAt: now,
				...(entry.authError ? { error: "AUTH" } : {}),
			} satisfies SubscriptionProvider;
		});
		this.cleanup();
		return { status: "ready", providers, refreshAfterMs: REFRESH_AFTER_MS };
	}

	async refresh(runtime: SubscriptionModelRuntime, providerId: string): Promise<SubscriptionSnapshot> {
		return this.read(runtime, providerId, true);
	}

	dispose(): void {
		for (const entry of this.entries.values()) entry.service.dispose();
		this.entries.clear();
		modulePromise = undefined;
	}
}

export const subscriptionUsage = new SubscriptionUsageBridge();

/** Test seam; production callers should use subscriptionUsage only. */
export function setSubscriptionUsageModuleLoaderForTests(loader?: SubscriptionUsageModuleLoader): void {
	injectedLoader = loader;
	subscriptionUsage.dispose();
	modulePromise = undefined;
}
