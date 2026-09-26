/**
 * model-admin — 模型/服务商配置管理，从 agent-service.ts 抽出。
 *
 * 职责：auth.json 的 provider api-key 存取（set/clear）、models.json 读写
 * （listModelsConfig/saveModelConfig/deleteModelConfig）、自定义服务商「自动获取
 * 模型列表」（fetch_models：服务端探测 OpenAI 兼容 /models 端点，绕开 CORS；
 * anthropic/google 鉴权头各不同；裸 /models 404 回退 /v1/models）与已保存供应商
 * 的一键刷新（refresh_provider_models，凭据不出浏览器）。改动后热更新 runtime
 * （refresh/setRuntimeApiKey）并推 models/models_config。
 *
 * 经 ModelAdminHost 与 ClientSession 解耦（同 settings/goal/slash 服务模式）。
 * UI 文案直接中文（服务端 notice 约定）。apiKey/headers 绝不下发浏览器。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, UiModelConfigEntry, UiProviderConfig, ProviderKeyInfo } from "./protocol.js";
import type { ServerLang } from "./i18n.js";

/** ClientSession 提供给本服务的宿主能力（窄接口）。 */
export interface ModelAdminHost {
	agentDir: string;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	/** 共享 ModelRuntime（所有对话共用），改动后需 refresh/热更新。 */
	modelRuntime: () => ModelRuntime;
	/** auth/models 变更后 pi 配置检测缓存失效（piConfigured 可能翻转）。 */
	invalidatePiConfig: () => void;
	/** 变更后重推顶栏模型下拉。 */
	pushModels: () => Promise<void>;
}

/** Strip // and /* *\/ comments without touching string literals (URLs contain //). */
function stripJsonComments(src: string): string {
	let out = "";
	let inString = false;
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (inString) {
			out += c;
			if (c === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			i++;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** Merge a UI-submitted provider config into the existing models.json entry.
 *
 * 表单（`UiProviderConfig`）只承载 UI 认识的字段：provider 级 name/api/baseUrl/
 * apiKey/authHeader，模型级 id/name/reasoning/input/contextWindow/maxTokens。
 * models.json 里还可能有 UI 不认识的字段——provider 级 headers（浏览器拿不到，
 * 见 listModelsConfig）、模型级 api/baseUrl/cost/compat/thinkingLevelMap（手写或
 * 脚本写入，pi-ai 靠它们决定请求地址与推理格式）。按表单整体重建条目会把这些字段
 * 静默抹掉，可能把可用的配置改坏：模型级 baseUrl 丢失后会回退到对该 api 适配器
 * 无效的地址（例如 opencode-go 的 anthropic baseUrl），请求直接打到不存在的路径。
 *
 * 所以这里以已有条目为底、表单字段覆盖：表单没提到的字段原样保留，表单清空的可选
 * 字段才真正删除；`models` 仍是「表单即全集」——表单里删掉的 id 会被移除。
 */
export function mergeProviderConfigEntry(
	prevEntry: Record<string, unknown> | undefined,
	config: UiProviderConfig,
	models: UiModelConfigEntry[],
): Record<string, unknown> {
	const prevModels = new Map<string, Record<string, unknown>>();
	if (Array.isArray(prevEntry?.models)) {
		for (const entry of prevEntry.models) {
			if (!entry || typeof entry !== "object") continue;
			const id = (entry as { id?: unknown }).id;
			if (typeof id === "string" && id.trim()) prevModels.set(id.trim(), entry as Record<string, unknown>);
		}
	}
	const mergedModels = models.map((model) => {
		// 旧条目同 id 的字段（api/baseUrl/cost/compat/…）先铺底，表单字段覆盖。
		const merged: Record<string, unknown> = { ...(prevModels.get(model.id) ?? {}), id: model.id };
		if (model.name?.trim()) merged.name = model.name.trim();
		else delete merged.name;
		if (model.reasoning) merged.reasoning = true;
		else delete merged.reasoning;
		if (model.input?.length) merged.input = model.input;
		else delete merged.input;
		if (model.contextWindow) merged.contextWindow = Number(model.contextWindow);
		else delete merged.contextWindow;
		if (model.maxTokens) merged.maxTokens = Number(model.maxTokens);
		else delete merged.maxTokens;
		// Model-level routing/metadata fields travel with the form for cloned
		// multi-api providers (opencode-go mixes anthropic-messages and
		// openai-* apis). Present → override; absent → keep the stored value
		// (hand-written overrides stay intact).
		if (model.api?.trim()) merged.api = model.api.trim();
		if (model.baseUrl?.trim()) merged.baseUrl = model.baseUrl.trim();
		if (model.compat) merged.compat = model.compat;
		if (model.cost) merged.cost = model.cost;
		if (model.thinkingLevelMap) merged.thinkingLevelMap = model.thinkingLevelMap;
		return merged;
	});

	const mergedEntry: Record<string, unknown> = { ...prevEntry };
	const apply = (key: string, value: unknown): void => {
		if (value === undefined) delete mergedEntry[key];
		else mergedEntry[key] = value;
	};
	apply("name", config.name?.trim() || undefined);
	apply("api", config.api?.trim() || undefined);
	apply("baseUrl", config.baseUrl?.trim() || undefined);
	apply("apiKey", config.apiKey?.trim() || undefined);
	apply("authHeader", config.authHeader ? true : undefined);
	mergedEntry.models = mergedModels;
	return mergedEntry;
}

/** Numeric metadata value (NaN/string "unknown" → undefined). */
function numMeta(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function boolMeta(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function strArrMeta(v: unknown): string[] | undefined {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

/** Best-effort extraction of model metadata from an OpenAI-compatible
 *  /models `data[]` item. Most endpoints only return `{ id }` — the extra
 *  fields (context_window / max_model_len / modalities / supports_vision /
 *  reasoning / display_name) come from vLLM and other extended
 *  implementations, and are filled into the form when present. */
function parseOpenAiModel(m: unknown): UiModelConfigEntry {
	const r = (m ?? {}) as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id : "";
	const name =
		(typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
		(typeof r.display_name === "string" && r.display_name.trim() ? r.display_name : undefined);
	const modalities = strArrMeta(r.modalities) ?? strArrMeta(r.input_modalities);
	const vision =
		modalities?.includes("image") === true ||
		boolMeta(r.supports_vision) === true ||
		boolMeta(r.vision) === true ||
		strArrMeta(r.input)?.includes("image") === true;
	const reasoning =
		boolMeta(r.reasoning) === true ||
		boolMeta(r.supports_reasoning) === true ||
		modalities?.includes("reasoning") === true;
	const contextWindow =
		numMeta(r.context_window) ?? numMeta(r.context_length) ?? numMeta(r.max_model_len) ?? numMeta(r.max_context_length);
	const maxTokens = numMeta(r.max_tokens) ?? numMeta(r.max_output_tokens) ?? numMeta(r.max_completion_tokens);
	return {
		id,
		...(name ? { name } : {}),
		...(reasoning ? { reasoning: true } : {}),
		...(vision ? { input: ["text", "image"] } : {}),
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
	};
}

/** google-generative-ai /models shape:
 *  { models: [{ name: "models/gemini-flash", displayName, inputTokenLimit,
 *               outputTokenLimit, supportedGenerationMethods }] } */
function parseGoogleModel(m: unknown): UiModelConfigEntry {
	const r = (m ?? {}) as Record<string, unknown>;
	const rawName = typeof r.name === "string" ? r.name : "";
	const id = rawName.replace(/^models\//, "");
	const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
	return {
		id,
		...(displayName && displayName !== id ? { name: displayName } : {}),
		...(numMeta(r.inputTokenLimit) ? { contextWindow: numMeta(r.inputTokenLimit) } : {}),
		...(numMeta(r.outputTokenLimit) ? { maxTokens: numMeta(r.outputTokenLimit) } : {}),
	};
}

/** Persisted shape of <agentDir>/provider-keys.json (one entry per provider). */
export interface ProviderKeysData {
	activeKeyName: string | null;
	keys: { name: string; apiKey: string }[];
}

export class ModelAdminService {
	constructor(private readonly host: ModelAdminHost) {}

	// ---------------------------------------------------------------------------
	// Built-in provider multiple key store (one provider, several API keys).
	// Persisted as <agentDir>/provider-keys.json:
	//   { "<providerId>": { activeKeyName: string|null, keys: [{name,apiKey}] } }
	// The frontend only ever sees NAMES (no value, no masked fragment). The key
	// value travels to the server ONCE on add and is stored (like auth.json); the
	// server resolves + switches the active key by NAME.
	// ---------------------------------------------------------------------------

	private providerKeysPath(): string {
		return join(this.host.agentDir, "provider-keys.json");
	}

	/** Read + parse provider-keys.json. */
	private readProviderKeys(): Record<string, ProviderKeysData> {
		try {
			const parsed = JSON.parse(readFileSync(this.providerKeysPath(), "utf8")) as Record<
				string,
				{ activeKeyName?: string | null; keys?: { name: string; apiKey: string }[] }
			>;
			const out: Record<string, ProviderKeysData> = {};
			for (const [pid, entry] of Object.entries(parsed)) {
				const keys = Array.isArray(entry?.keys) ? entry.keys.filter((k) => k?.name && k?.apiKey) : [];
				if (!pid || keys.length === 0) continue;
				const activeKeyName =
					entry.activeKeyName && keys.some((k) => k.name === entry.activeKeyName) ? entry.activeKeyName : keys[0].name;
				out[pid] = { activeKeyName, keys };
			}
			return out;
		} catch {
			return {};
		}
	}

	private writeProviderKeys(data: Record<string, ProviderKeysData>): void {
		mkdirSync(this.host.agentDir, { recursive: true });
		writeFileSync(this.providerKeysPath(), JSON.stringify(data, null, 2) + "\n");
	}

	/** Default name "密钥 N" for a provider's Nth key. */
	private defaultKeyName(keys: { name: string; apiKey: string }[]): string {
		return `密钥 ${keys.length + 1}`;
	}

	/** Resolve a user-supplied (or default) name into a UNIQUE one (append
	 *  " (2)", " (3)", … on collision) so a name is a reliable switch key. */
	private uniqueKeyName(entry: { keys: { name: string; apiKey: string }[] }, wanted: string | undefined): string {
		const base = (wanted?.trim() || this.defaultKeyName(entry.keys)).trim() || this.defaultKeyName(entry.keys);
		const taken = new Set(entry.keys.map((k) => k.name));
		let name = base;
		let n = 2;
		while (taken.has(name)) name = `${base} (${n++})`;
		return name;
	}

	/** Build the name-only ProviderKeyInfo list for a provider (no value/mask). */
	private providerKeysInfo(data: Record<string, ProviderKeysData>): { keys: Record<string, ProviderKeyInfo[]> } {
		const keys: Record<string, ProviderKeyInfo[]> = {};
		for (const [pid, entry] of Object.entries(data)) {
			keys[pid] = entry.keys.map((k) => ({ name: k.name, active: entry.activeKeyName === k.name }));
		}
		return { keys };
	}

	/** Get the currently active key name for a provider, or null. */
	getActiveKeyName(provider: string): string | null {
		const data = this.readProviderKeys();
		return data[provider]?.activeKeyName ?? null;
	}

	/** Whether a named key still exists for a provider (no side effects, no
	 *  notices). Restore paths use this to drop stale per-project references
	 *  silently instead of going through activate (which notifies). */
	hasProviderKey(provider: string, keyName: string): boolean {
		const pid = provider.trim();
		const targetName = keyName.trim();
		if (!pid || !targetName) return false;
		try {
			return this.readProviderKeys()[pid]?.keys.some((k) => k.name === targetName) ?? false;
		} catch {
			return false;
		}
	}

	/** Seed a provider's key list from an EXISTING auth.json credential (legacy
	 *  configs written before the multi-key store existed) so the store stays
	 *  authoritative and the UI shows the current active key immediately even
	 *  before the user adds a second key. Idempotent — does nothing if the
	 *  provider already has a store entry. */
	private seedProviderKeysFromAuth(pid: string, data: Record<string, ProviderKeysData>): void {
		if (data[pid]) return;
		try {
			const auth = JSON.parse(readFileSync(join(this.host.agentDir, "auth.json"), "utf8")) as Record<
				string,
				{ key?: string; type?: string; [k: string]: unknown }
			>;
			const cred = auth[pid];
			if (cred && typeof cred.key === "string" && cred.key.trim()) {
				data[pid] = {
					activeKeyName: "密钥 1",
					keys: [{ name: "密钥 1", apiKey: cred.key.trim() }],
				};
			}
		} catch {
			// no auth.json / unparsable — nothing to seed
		}
	}

	/** Push the masked provider-keys map to the client. Seeds the store from any
	 *  auth.json credentials so legacy single-key setups show up immediately. */
	listProviderKeys(): void {
		const data = this.readProviderKeys();
		const before = Object.keys(data).length;
		for (const pid of this.builtinProviderIds()) this.seedProviderKeysFromAuth(pid, data);
		// Only rewrite when seeding added a provider: an unconditional rewrite
		// truncates the file under concurrent readers for no reason.
		if (Object.keys(data).length !== before) this.writeProviderKeys(data);
		this.host.emit({ type: "provider_keys", ...this.providerKeysInfo(data) });
		this.host.flushSnapshot();
	}

	/** Candidate built-in provider ids whose keys we track: those with a store
	 *  entry plus every provider actually registered in the runtime (seed reads
	 *  auth.json per id, so only real providers with a credential get seeded —
	 *  unrelated auth.json entries like "main" are ignored). */
	private builtinProviderIds(): string[] {
		const data = this.readProviderKeys();
		const ids = new Set(Object.keys(data));
		try {
			for (const p of this.host.modelRuntime().getProviders()) ids.add(p.id);
		} catch {
			// runtime not ready
		}
		return [...ids];
	}

	/** Persist the ACTIVE key's apiKey into auth.json + runtime override + refresh. */
	private async applyActiveKey(pid: string, apiKey: string): Promise<void> {
		const authPath = join(this.host.agentDir, "auth.json");
		mkdirSync(this.host.agentDir, { recursive: true });
		let data: Record<string, unknown> = {};
		try {
			data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		} catch {
			// no file yet / unparsable — start fresh
		}
		data[pid] = { type: "api_key", key: apiKey };
		writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n");
		const mr = this.host.modelRuntime();
		await mr.setRuntimeApiKey(pid, apiKey);
		await mr.refresh({ allowNetwork: true, providers: [pid] });
		this.host.invalidatePiConfig();
	}

	/** Persist an api-key credential for a provider (auth.json) and apply it now.
	 *  Also records the key in provider-keys.json (as the active key), so it shows
	 *  in the multi-key list too. */
	async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		const pid = provider.trim();
		const key = apiKey.trim();
		if (!pid) {
			this.host.emit({ type: "notice", level: "error", text: "Enter a provider ID" });
			return;
		}
		if (!key) {
			this.host.emit({ type: "notice", level: "error", text: "Enter an API key" });
			return;
		}
		try {
			const data = this.readProviderKeys();
			// Preserve a legacy auth.json key as the first (active) entry so adding
			// a new key stacks alongside it instead of clobbering it.
			if (!data[pid]) this.seedProviderKeysFromAuth(pid, data);
			let entry = data[pid];
			if (!entry) entry = data[pid] = { activeKeyName: null, keys: [] };
			const existing = entry.keys.find((k) => k.apiKey === key);
			let name: string;
			if (existing) {
				// Same key value already in the list → just make it active.
				entry.activeKeyName = existing.name;
				name = existing.name;
			} else {
				name = this.uniqueKeyName(entry, undefined);
				entry.keys.push({ name, apiKey: key });
				entry.activeKeyName = name;
			}
			this.writeProviderKeys(data);
			await this.applyActiveKey(pid, key);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `✅ Saved key "${name}" for ${pid} and refreshed the model list`,
			});
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to save API key: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	/** Add a SECONDARY API key to a built-in provider's key list. `name` is the
	 *  only thing the frontend ever sees (auto-generated when blank, deduped on
	 *  collision). The added key stays INACTIVE unless it is the provider's first
	 *  key; the user switches to it by name or by clicking a model under it. */
	async addProviderKey(provider: string, apiKey: string, name?: string): Promise<void> {
		const pid = provider.trim();
		const key = apiKey.trim();
		if (!pid) {
			this.host.emit({ type: "notice", level: "error", text: "Enter a provider ID" });
			return;
		}
		if (!key) {
			this.host.emit({ type: "notice", level: "error", text: "Enter an API key" });
			return;
		}
		try {
			const data = this.readProviderKeys();
			// Preserve a legacy auth.json key (active) so the new key stacks as a
			// SECONDARY inactive key rather than replacing the current one.
			if (!data[pid]) this.seedProviderKeysFromAuth(pid, data);
			let entry = data[pid];
			if (!entry) entry = data[pid] = { activeKeyName: null, keys: [] };
			const dup = entry.keys.find((k) => k.apiKey === key);
			if (dup) {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `${pid} already has this key`,
				});
				return;
			}
			const keyName = this.uniqueKeyName(entry, name);
			entry.keys.push({ name: keyName, apiKey: key });
			// First key becomes active (provider had none usable yet).
			if (!entry.activeKeyName) entry.activeKeyName = keyName;
			this.writeProviderKeys(data);
			const isActive = entry.activeKeyName === keyName;
			if (isActive) {
				await this.applyActiveKey(pid, key);
				this.host.emit({
					type: "notice",
					level: "info",
					text: `🔑 Added key "${keyName}" for ${pid} and set it active`,
				});
			} else {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `🔑 Added key "${keyName}" for ${pid}; click a model to switch to it`,
				});
			}
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to add key: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	/** Make a stored API key the ACTIVE one for a built-in provider by NAME (the
	 *  server resolves the stored value from the name). Returns true when the
	 *  key is (now) active, false when it doesn't exist or the switch failed.
	 *  `silent` suppresses all notices — for automatic project restores, which
	 *  must self-heal stale references without spamming the user. */
	async activateProviderKey(provider: string, keyName: string, opts?: { silent?: boolean }): Promise<boolean> {
		const pid = provider.trim();
		const targetName = keyName.trim();
		const silent = opts?.silent === true;
		const notice = (msg: ServerMessage) => {
			if (!silent) this.host.emit(msg);
		};
		try {
			const data = this.readProviderKeys();
			const entry = data[pid];
			const target = entry?.keys.find((k) => k.name === targetName);
			if (!target) {
				notice({
					type: "notice",
					level: "error",
					text: `Key "${targetName}" for ${pid} does not exist`,
				});
				return false;
			}
			if (entry.activeKeyName === targetName) {
				notice({
					type: "notice",
					level: "info",
					text: `"${targetName}" is already the active key`,
				});
				return true;
			}
			entry.activeKeyName = targetName;
			this.writeProviderKeys(data);
			await this.applyActiveKey(pid, target.apiKey);
			notice({
				type: "notice",
				level: "info",
				text: `⚡ Switched to "${targetName}" for ${pid}`,
			});
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
			return true;
		} catch (err) {
			notice({
				type: "notice",
				level: "error",
				text: `Failed to switch key: ${(err as Error).message}`,
			});
			return false;
		} finally {
			if (!silent) this.host.flushSnapshot();
		}
	}

	/** Remove a stored API key by NAME. If it was active, the first remaining key
	 *  becomes active (or the provider returns to unconfigured when no key is left). */
	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		const pid = provider.trim();
		const targetName = keyName.trim();
		try {
			const data = this.readProviderKeys();
			const entry = data[pid];
			if (!entry || !entry.keys.some((k) => k.name === targetName)) {
				this.host.emit({
					type: "notice",
					level: "error",
					text: `Key "${targetName}" for ${pid} does not exist`,
				});
				return;
			}
			const wasActive = entry.activeKeyName === targetName;
			entry.keys = entry.keys.filter((k) => k.name !== targetName);
			if (entry.keys.length === 0) {
				delete data[pid];
				this.writeProviderKeys(data);
				// Drop auth.json entry + runtime override so the provider returns
				// to unconfigured (its stored keys are gone too).
				const authPath = join(this.host.agentDir, "auth.json");
				let auth: Record<string, unknown> = {};
				try {
					auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
				} catch {
					// no file yet — nothing to clean
				}
				delete auth[pid];
				writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n");
				const mr = this.host.modelRuntime();
				await mr.removeRuntimeApiKey(pid);
				await mr.refresh({ providers: [pid] });
				this.host.invalidatePiConfig();
				this.host.emit({
					type: "notice",
					level: "info",
					text: `🗑  Removed key "${targetName}" for ${pid}; provider is now unconfigured`,
				});
			} else {
				if (wasActive) {
					entry.activeKeyName = entry.keys[0].name;
					this.writeProviderKeys(data);
					await this.applyActiveKey(pid, entry.keys[0].apiKey);
				} else {
					this.writeProviderKeys(data);
				}
				this.host.emit({
					type: "notice",
					level: "info",
					text: wasActive
						? `🗑  Removed "${targetName}", switched to ${entry.keys[0].name}`
						: `🗑  Removed key "${targetName}" for ${pid}`,
				});
			}
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to remove key: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	/**
	 * Clear a built-in provider's stored API key (auth.json entry + runtime
	 * override) so it returns to the unconfigured state — its models disappear
	 * from the picker until a key is set again. Only meaningful for keys that
	 * were stored via set_provider_api_key (source "stored"); env-var sourced
	 * credentials can't be cleared from here.
	 */
	async clearProviderApiKey(provider: string): Promise<void> {
		const pid = provider.trim();
		if (!pid) {
			this.host.emit({ type: "notice", level: "error", text: "Enter a provider ID" });
			return;
		}
		try {
			// Remove from auth.json ({ <provider>: { type: "api_key", key } }).
			const authPath = join(this.host.agentDir, "auth.json");
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
			} catch {
				// no file yet / unparsable — nothing stored to clear
			}
			const keyData = this.readProviderKeys();
			const hasStoredKeys = (keyData[pid]?.keys.length ?? 0) > 0;
			if (!(pid in data) && !hasStoredKeys) {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `${pid} has no saved key`,
				});
				return;
			}
			delete data[pid];
			writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n");
			// Clear every stored key so the provider returns to unconfigured.
			delete keyData[pid];
			this.writeProviderKeys(keyData);
			// Drop the runtime override too, then re-read credentials so the
			// provider goes back to unconfigured and its models leave the list.
			const mr = this.host.modelRuntime();
			await mr.removeRuntimeApiKey(pid);
			await mr.refresh({ providers: [pid] });
			this.host.invalidatePiConfig();
			this.host.emit({
				type: "notice",
				level: "info",
				text: `🗑  Cleared keys for ${pid}; provider is now unconfigured`,
			});
			await this.host.pushModels();
			await this.listProviders();
			this.listProviderKeys();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to clear key: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	/**
	 * Copy a BUILT-IN provider (baseUrl + current model catalog) into an
	 * editable custom-provider draft and return it via clone_provider_result.
	 * Nothing is persisted — the user renames the draft, pastes a DIFFERENT
	 * API key in the form, then saves via save_model_config. Credentials are
	 * never copied: the whole point is running a second key alongside the
	 * built-in one without touching it.
	 */
	async cloneProvider(providerId: string, reqId: number): Promise<void> {
		const pid = providerId.trim();
		const fail = (error: string) => {
			this.host.emit({ type: "notice", level: "error", text: error });
			this.host.emit({ type: "clone_provider_result", reqId, ok: false, error });
		};
		try {
			if (!pid) {
				fail("Enter a provider ID");
				return;
			}
			const mr = this.host.modelRuntime();
			const p = mr.getProvider(pid);
			if (!p) {
				fail(`Provider ${pid} does not exist`);
				return;
			}
			const noBaseUrl = !p.baseUrl;
			// Map runtime models → models.json rows; dynamic providers ship an
			// empty catalog until refreshed over the network. Model-level api/
			// baseUrl/compat are carried through verbatim: they decide which
			// upstream endpoint and wire format each model uses. Providers like
			// opencode-go mix apis (anthropic-messages → /zen/go, openai-* →
			// /zen/go/v1), so a single provider-level api/baseUrl cannot
			// represent the catalog and would route half the models to a dead
			// path (see mergeProviderConfigEntry doc above).
			const readModels = (): UiModelConfigEntry[] => {
				try {
					return mr.getModels(pid).map((m) => ({
						id: m.id,
						...(m.name && m.name !== m.id ? { name: m.name } : {}),
						...(m.reasoning ? { reasoning: true } : {}),
						...(m.input?.includes("image") ? { input: ["text", "image"] } : {}),
						...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
						...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
						...(m.api ? { api: m.api } : {}),
						...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
						...(m.compat ? { compat: m.compat as unknown as Record<string, unknown> } : {}),
						...(m.cost ? { cost: m.cost as unknown as Record<string, unknown> } : {}),
						...(m.thinkingLevelMap
							? { thinkingLevelMap: m.thinkingLevelMap as unknown as Record<string, unknown> }
							: {}),
					}));
				} catch {
					return [];
				}
			};
			let models = readModels();
			if (models.length === 0) {
				await mr.refresh({ allowNetwork: true });
				models = readModels();
			}
			if (models.length === 0) {
				fail(`Model list for ${pid} is empty, cannot clone (retry later)`);
				return;
			}
			// ONE deduplicated full model catalog config — no per-api split, no
			// extra provider ids. Per-model api/baseUrl/compat/cost/
			// thinkingLevelMap travel with each row, so a multi-api provider
			// (opencode-go) keeps working after save. The provider-level api is
			// the majority api as a baseline; the provider-level baseUrl comes
			// from p.baseUrl, or the first model of that majority api that has a
			// URL (never a fabricated localhost default).
			const counts = new Map<string, number>();
			for (const m of models) {
				const api = m.api ?? "openai-completions";
				counts.set(api, (counts.get(api) ?? 0) + 1);
			}
			let api = "openai-completions";
			for (const [k, v] of counts) if (v > (counts.get(api) ?? 0)) api = k;
			const providerBaseUrl =
				p.baseUrl || models.find((m) => (m.api ?? "openai-completions") === api && m.baseUrl)?.baseUrl;
			const keptMap = new Map<string, UiModelConfigEntry>();
			for (const m of models) if (!keptMap.has(m.id)) keptMap.set(m.id, m);
			const kept = [...keptMap.values()].sort((a, b) => a.id.localeCompare(b.id));
			const taken = new Set([...Object.keys(this.readModelsConfig().providers), ...mr.getRegisteredProviderIds()]);
			let newId = `${pid}-2`;
			for (let n = 2; taken.has(newId); n++) newId = `${pid}-${n}`;
			const config: UiProviderConfig = {
				providerId: newId,
				name: p.name,
				api,
				...(providerBaseUrl ? { baseUrl: providerBaseUrl } : {}),
				models: kept,
			};
			this.host.emit({
				type: "notice",
				level: noBaseUrl ? "warning" : "info",
				text: noBaseUrl
					? `📋 Cloned ${pid} → ${newId} (${kept.length} models); this provider has no remote baseUrl — template generated, fill in baseUrl and a new API key, then save`
					: `📋 Cloned ${pid} → ${newId} (${kept.length} models); fill in the new API key, then save`,
			});
			this.host.emit({ type: "clone_provider_result", reqId, ok: true, config, configs: [config] });
		} catch (err) {
			fail(`Failed to clone provider: ${(err as Error).message}`);
		}
		this.host.flushSnapshot();
	}

	/** Enumerate pi's built-in providers with auth status (key-only config). */
	async listProviders(): Promise<void> {
		const mr = this.host.modelRuntime();
		let providers;
		try {
			providers = mr.getProviders().map((p) => {
				try {
					const st = mr.getProviderAuthStatus(p.id);
					return {
						id: p.id,
						name: p.name,
						configured: st?.configured ?? false,
						source: st?.source,
					};
				} catch {
					// One odd provider must not blank the whole list.
					return { id: p.id, name: p.name, configured: false };
				}
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to fetch provider list: ${(err as Error).message}`,
			});
			return;
		}
		if (providers.length === 0) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "Provider list is empty — the pi runtime registered no providers",
			});
		}
		this.host.emit({ type: "providers_status", providers });
	}

	// ---------------------------------------------------------------------------
	// Custom model config (agentDir/models.json)
	// ---------------------------------------------------------------------------

	private modelsConfigPath(): string {
		return join(this.host.agentDir, "models.json");
	}

	/** Strip // and /* *\/ comments without touching string literals (URLs contain //). */
	private static stripJsonComments(src: string): string {
		let out = "";
		let inString = false;
		let i = 0;
		while (i < src.length) {
			const c = src[i];
			const next = src[i + 1];
			if (inString) {
				out += c;
				if (c === "\\") {
					out += next ?? "";
					i += 2;
					continue;
				}
				if (c === '"') inString = false;
				i++;
				continue;
			}
			if (c === '"') {
				inString = true;
				out += c;
				i++;
				continue;
			}
			if (c === "/" && next === "/") {
				while (i < src.length && src[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && next === "*") {
				i += 2;
				while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
				i += 2;
				continue;
			}
			out += c;
			i++;
		}
		return out;
	}

	/** Read + parse models.json (tolerating // and /* *\/ comments like the SDK). */
	private readModelsConfig(): {
		providers: Record<string, Record<string, unknown>>;
	} {
		const path = this.modelsConfigPath();
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(stripJsonComments(raw)) as {
				providers?: Record<string, Record<string, unknown>>;
			};
			return { providers: parsed?.providers ?? {} };
		} catch {
			return { providers: {} };
		}
	}

	/** Send the current models.json custom providers to the client. */
	async listModelsConfig(): Promise<void> {
		const { providers } = this.readModelsConfig();
		const list: UiProviderConfig[] = Object.entries(providers).map(([providerId, p]) => {
			const models = Array.isArray(p.models)
				? (p.models as Record<string, unknown>[]).map((m) => ({
						id: String(m.id ?? ""),
						name: m.name as string | undefined,
						reasoning: m.reasoning as boolean | undefined,
						input: Array.isArray(m.input) ? (m.input as string[]) : undefined,
						contextWindow: m.contextWindow as number | undefined,
						maxTokens: m.maxTokens as number | undefined,
						// Per-model routing/metadata must round-trip to the UI: the edit
						// form re-submits what it received, and a model-level baseUrl is
						// what keeps multi-api providers (opencode-go) off a dead path.
						// Dropping it here makes the UI's "model overrides provider
						// baseUrl" precedence warning vanish after save/reopen.
						api: m.api as string | undefined,
						baseUrl: m.baseUrl as string | undefined,
						compat: m.compat as Record<string, unknown> | undefined,
						cost: m.cost as Record<string, unknown> | undefined,
						thinkingLevelMap: m.thinkingLevelMap as Record<string, unknown> | undefined,
					}))
				: [];
			return {
				providerId,
				name: p.name as string | undefined,
				api: p.api as string | undefined,
				baseUrl: p.baseUrl as string | undefined,
				apiKey: p.apiKey as string | undefined,
				authHeader: p.authHeader as boolean | undefined,
				// headers are intentionally NOT sent to the browser — they may
				// contain Authorization / API-key values; kept server-side only.
				models,
			};
		});
		this.host.emit({ type: "models_config", providers: list });
	}

	/** Re-read models.json from disk (hand/script edits outside the UI) and
	 *  repush — same refresh tail that save_model_config runs. */
	async reloadModelsConfig(): Promise<void> {
		try {
			await this.host.modelRuntime().refresh();
			this.host.invalidatePiConfig();
			await this.listModelsConfig();
			await this.host.pushModels();
			this.host.emit({
				type: "notice",
				level: "info",
				text: "🔄 Reloaded model config from disk",
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to reload model config: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	/** Numeric metadata value (NaN/string "unknown" → undefined). */
	private static numMeta(v: unknown): number | undefined {
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	}

	private static boolMeta(v: unknown): boolean | undefined {
		return typeof v === "boolean" ? v : undefined;
	}

	private static strArrMeta(v: unknown): string[] | undefined {
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
	}

	/** Best-effort extraction of model metadata from an OpenAI-compatible
	 *  /models `data[]` item. Most endpoints only return `{ id }` — the extra
	 *  fields (context_window / max_model_len / modalities / supports_vision /
	 *  reasoning / display_name) come from vLLM and other extended
	 *  implementations, and are filled into the form when present. */
	private static parseOpenAiModel(m: unknown): UiModelConfigEntry {
		const r = (m ?? {}) as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id : "";
		const name =
			(typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
			(typeof r.display_name === "string" && r.display_name.trim() ? r.display_name : undefined);
		const modalities = strArrMeta(r.modalities) ?? strArrMeta(r.input_modalities);
		const vision =
			modalities?.includes("image") === true ||
			boolMeta(r.supports_vision) === true ||
			boolMeta(r.vision) === true ||
			strArrMeta(r.input)?.includes("image") === true;
		const reasoning =
			boolMeta(r.reasoning) === true ||
			boolMeta(r.supports_reasoning) === true ||
			modalities?.includes("reasoning") === true;
		const contextWindow =
			numMeta(r.context_window) ??
			numMeta(r.context_length) ??
			numMeta(r.max_model_len) ??
			numMeta(r.max_context_length);
		const maxTokens = numMeta(r.max_tokens) ?? numMeta(r.max_output_tokens) ?? numMeta(r.max_completion_tokens);
		return {
			id,
			...(name ? { name } : {}),
			...(reasoning ? { reasoning: true } : {}),
			...(vision ? { input: ["text", "image"] } : {}),
			...(contextWindow ? { contextWindow } : {}),
			...(maxTokens ? { maxTokens } : {}),
		};
	}

	/** google-generative-ai /models shape:
	 *  { models: [{ name: "models/gemini-flash", displayName, inputTokenLimit,
	 *               outputTokenLimit, supportedGenerationMethods }] } */
	private static parseGoogleModel(m: unknown): UiModelConfigEntry {
		const r = (m ?? {}) as Record<string, unknown>;
		const rawName = typeof r.name === "string" ? r.name : "";
		const id = rawName.replace(/^models\//, "");
		const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
		return {
			id,
			...(displayName && displayName !== id ? { name: displayName } : {}),
			...(numMeta(r.inputTokenLimit) ? { contextWindow: numMeta(r.inputTokenLimit) } : {}),
			...(numMeta(r.outputTokenLimit) ? { maxTokens: numMeta(r.outputTokenLimit) } : {}),
		};
	}

	/** Probe a custom provider's OpenAI-compatible /models endpoint (server-side
	 *  because the baseUrl is often a LAN/loopback host the browser can't reach
	 *  cross-origin) and return the advertised models. reqId is echoed back
	 *  in fetch_models_result so the UI can match concurrent requests. */
	async fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		/** 探测抛错文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
		lang?: () => ServerLang,
	): Promise<void> {
		const emitError = (error: string) => this.host.emit({ type: "fetch_models_result", reqId, ok: false, error });
		try {
			const models = await ModelAdminService.probeModelsEndpoint(baseUrl, apiKey, authHeader, api, undefined, lang);
			this.host.emit({ type: "fetch_models_result", reqId, ok: true, models });
		} catch (err) {
			emitError((err as Error).message);
		}
	}

	/**
	 * Probe a custom provider's model-list endpoint (OpenAI-compatible /models
	 * with a /v1 retry; Google {models:[…]} shape supported). Throws Error with
	 * a user-facing message on any failure; returns deduped+sorted entries.
	 * Shared by the edit-form "auto fetch" and the saved-provider refresh.
	 */
	static async probeModelsEndpoint(
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		extraHeaders?: Record<string, string>,
		/** 抛错文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
		lang?: () => ServerLang,
	): Promise<UiModelConfigEntry[]> {
		const l = lang?.() ?? "en";
		const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
		if (!base) throw new Error("Enter the baseUrl first");
		let url: URL;
		try {
			url = new URL(base);
		} catch {
			throw new Error(`Invalid baseUrl: ${base}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("baseUrl supports http/https only");
		}

		const headers: Record<string, string> = {
			...extraHeaders,
		};
		// Per-api auth conventions (mirror pi's built-in provider configs):
		//   openai-*:      Authorization: Bearer <key>
		//   anthropic:     x-api-key + anthropic-version
		//   google:        x-goog-api-key
		// authHeader=false → no auth header at all (custom gateways).
		if (apiKey?.trim() && authHeader !== false) {
			const key = apiKey.trim();
			if (api === "anthropic-messages") {
				headers["x-api-key"] = key;
				headers["anthropic-version"] = "2023-06-01";
			} else if (api === "google-generative-ai") {
				headers["x-goog-api-key"] = key;
			} else {
				headers["Authorization"] = `Bearer ${key}`;
			}
		}

		const tryFetch = async (u: string): Promise<Response | null> => {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 15000);
			try {
				return await fetch(u, { headers, signal: ac.signal });
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					throw new Error("Request timed out (15s)");
				}
				const errMessage = (err as Error).message;
				throw new Error(`Request failed: ${errMessage}`);
			} finally {
				clearTimeout(timer);
			}
		};

		let res = await tryFetch(`${base}/models`);
		// BaseUrls that omit the /v1 prefix (e.g. https://api.openai.com) 404 on
		// the bare path — retry under /v1.
		if (res && res.status === 404 && !/\/v\d+[a-z-]*$/.test(base)) {
			res = await tryFetch(`${base}/v1/models`);
		}
		if (!res) throw new Error("Request failed");
		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.text()).slice(0, 200);
			} catch {
				// response body already consumed / not text — ignore
			}
			const detailSuffixEn = detail ? `: ${detail}` : "";
			throw new Error(`Upstream returned HTTP ${res.status}${detailSuffixEn}`);
		}
		let models: UiModelConfigEntry[] = [];
		try {
			const json = (await res.json()) as Record<string, unknown>;
			const data = Array.isArray(json.data) ? json.data : null;
			if (data) {
				// OpenAI-compatible: { data: [{ id, context_window, modalities, … }] }
				models = data.map((m) => parseOpenAiModel(m)).filter((m) => m.id);
			} else if (Array.isArray(json.models)) {
				// Google: { models: [{ name: "models/…", displayName, … }] }
				models = (json.models as unknown[]).map((m) => parseGoogleModel(m)).filter((m) => m.id);
			}
		} catch {
			throw new Error("Response is not valid JSON");
		}
		// Dedupe by id (keep the first, most complete entry) and sort by id.
		const seen = new Set<string>();
		models = models
			.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (models.length === 0) throw new Error("The endpoint returned no models");
		return models;
	}

	/**
	 * Re-probe a SAVED custom provider's model list and merge it into its
	 * models.json entry — credentials never leave the server (unlike the
	 * edit-form fetch, which sends whatever the browser typed). Merge rules:
	 * existing ids keep all manually-entered fields and only gain metadata
	 * they were missing; brand-new ids are appended. Hot-reloads the runtime.
	 */
	async refreshProviderModels(providerId: string, reqId: number, lang?: () => ServerLang): Promise<void> {
		const done = (ok: boolean, extra: { added?: number; total?: number; error?: string } = {}) =>
			this.host.emit({ type: "refresh_provider_result", reqId, ok, ...extra });
		try {
			const pid = providerId.trim();
			const { providers } = this.readModelsConfig();
			// models.json 原始形状是 Record<string, unknown>——按已保存条目的结构断言
			const saved = providers[pid] as
				| {
						name?: string;
						api?: string;
						baseUrl?: string;
						apiKey?: string;
						authHeader?: boolean;
						headers?: Record<string, string>;
						models?: UiModelConfigEntry[];
				  }
				| undefined;
			// 纯覆盖条目（只改 models，没有 provider 级 baseUrl）回退到运行时
			// 已知的地址——内置 provider 的 baseUrl 本来就不在 models.json 里。
			// 注意只拿来探测用，不写回磁盘：保持条目仍是纯覆盖。
			const baseUrl =
				saved?.baseUrl?.trim() || (this.host.modelRuntime().getProvider(pid)?.baseUrl ?? "").trim() || undefined;
			if (!saved || !baseUrl) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `Provider ${pid} does not exist or has no baseUrl; cannot refresh`,
				});
				return done(false, { error: "provider missing or no baseUrl" });
			}
			const fetched = await ModelAdminService.probeModelsEndpoint(
				baseUrl,
				saved.apiKey,
				saved.authHeader === true ? true : undefined,
				saved.api,
				saved.headers as Record<string, string> | undefined,
				lang,
			);

			// Merge: manual values win; fetched fills blanks and appends new ids.
			const prev = new Map((saved.models ?? []).map((m) => [m.id, m]));
			let added = 0;
			for (const f of fetched) {
				const cur = prev.get(f.id);
				if (!cur) {
					prev.set(f.id, f);
					added += 1;
					continue;
				}
				prev.set(f.id, {
					...f,
					...cur, // 手填字段优先：cur 覆盖 f 的同名字段
				});
			}
			const merged = [...prev.values()].sort((a, b) => a.id.localeCompare(b.id));
			await this.saveModelConfig(pid, {
				providerId: pid,
				name: saved.name,
				api: saved.api,
				baseUrl: saved.baseUrl,
				// apiKey/headers 不回传浏览器——saveModelConfig 会保留旧值
				authHeader: saved.authHeader === true ? true : undefined,
				models: merged,
			});

			this.host.emit({
				type: "notice",
				level: "info",
				text:
					added > 0
						? `🔄 Refreshed ${pid}: ${added} new models, ${merged.length} total`
						: `🔄 Refreshed ${pid}: no new models (${merged.length} total)`,
			});
			return done(true, { added, total: merged.length });
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to refresh model list: ${(err as Error).message}`,
			});
			return done(false, { error: (err as Error).message });
		}
	}

	/** Upsert one provider into models.json and hot-reload the model runtime. */
	async saveModelConfig(providerId: string, config: UiProviderConfig): Promise<void> {
		const pid = providerId.trim();
		if (!pid || !/^[\w.-]+$/.test(pid)) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "Invalid provider ID (letters/digits/._- only)",
			});
			return;
		}
		const models = (config.models ?? [])
			.filter((m) => m.id && m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				...(m.name?.trim() ? { name: m.name.trim() } : {}),
				...(m.reasoning ? { reasoning: true } : {}),
				...(m.input?.length ? { input: m.input } : {}),
				...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}),
				...(m.maxTokens ? { maxTokens: Number(m.maxTokens) } : {}),
				// Per-model routing/metadata the form carries for cloned multi-api
				// providers: must reach mergeProviderConfigEntry so it can persist.
				...(m.api?.trim() ? { api: m.api.trim() } : {}),
				...(m.baseUrl?.trim() ? { baseUrl: m.baseUrl.trim() } : {}),
				...(m.compat ? { compat: m.compat } : {}),
				...(m.cost ? { cost: m.cost } : {}),
				...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			}));
		if (models.length === 0) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "At least one model is required",
			});
			return;
		}
		try {
			const { providers } = this.readModelsConfig();
			// 合并而不是重建：UI 认识之外的字段（provider 级 headers、模型级 api/
			// baseUrl/cost/compat/thinkingLevelMap）必须原样保留，见 mergeProviderConfigEntry。
			providers[pid] = mergeProviderConfigEntry(providers[pid], config, models);
			mkdirSync(this.host.agentDir, { recursive: true });
			writeFileSync(this.modelsConfigPath(), JSON.stringify({ providers }, null, 2) + "\n");

			// Allow a custom models.json entry to reuse the provider credential
			// already stored in auth.json.  Seed the shared runtime too, because
			// older pi-ai versions did not always fall back to stored credentials
			// for a newly-created custom provider.  Never copy the secret into
			// models.json.
			try {
				const auth = JSON.parse(readFileSync(join(this.host.agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
				const credential = auth[pid];
				if (
					credential &&
					typeof credential === "object" &&
					"key" in credential &&
					typeof credential.key === "string" &&
					credential.key.trim()
				) {
					await this.host.modelRuntime().setRuntimeApiKey(pid, credential.key);
				}
			} catch {
				// auth.json is optional; models.json can still use its own apiKey.
			}
			await this.host.modelRuntime().refresh();
			this.host.invalidatePiConfig();
			await this.listModelsConfig();
			await this.host.pushModels();
			this.host.emit({
				type: "notice",
				level: "info",
				text: `✅ Saved provider ${pid} (${models.length} models) and refreshed the model list`,
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to save model config: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	/** Remove a provider from models.json and hot-reload. */
	async deleteModelConfig(providerId: string): Promise<void> {
		try {
			const { providers } = this.readModelsConfig();
			if (!(providerId in providers)) {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `Provider ${providerId} does not exist`,
				});
				return;
			}
			delete providers[providerId];
			writeFileSync(this.modelsConfigPath(), JSON.stringify({ providers }, null, 2) + "\n");
			await this.host.modelRuntime().refresh();
			this.host.invalidatePiConfig();
			await this.listModelsConfig();
			await this.host.pushModels();
			this.host.emit({
				type: "notice",
				level: "info",
				text: `🗑  Deleted provider ${providerId}`,
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to delete model config: ${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}
}
