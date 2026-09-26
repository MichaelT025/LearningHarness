/**
 * 工具卡头的「关键参数提示」纯函数：从 tool call 的 argumentsText 里安全取出
 * 文件路径 / 超时 / 命令行，供 ToolCallBlock 显示在卡头状态图标右侧。
 *
 * 为什么用正则扫描而不是 JSON.parse：
 *   1. 流式过程中 argumentsText 可能是**半截 JSON**——正则能在 `"path"` 一落地就显示，
 *      JSON.parse 只能等整串到齐；
 *   2. `write` 这类工具的参数里带着整个文件内容（可能几 MB），每次渲染 JSON.parse
 *      会明显卡顿（只扫描前 SCAN_LIMIT 字节）；
 *   3. AI 可能把参数填错（非 JSON / 类型不对 / 缺字段 / 超长 / 带换行），
 *      扫不到就静默返回空——不抛错、不显示半个值。
 *
 * 已知取舍：只在参数前 SCAN_LIMIT 字节里找（写文件时 path 在 content 之前，
 * 够用）；不解析 `paths: [...]` 这类数组参数。
 */

/** 扫描上限：够覆盖正常工具参数，又不会因 write 的大 content 卡住渲染。 */
const SCAN_LIMIT = 256 * 1024;

/** 单值上限：AI 把整段说明塞进 path 时不至于撑爆卡头（超长截断）。 */
const VALUE_LIMIT = 300;

/** 路径类参数名（SDK 的 read 同时收 path / file_path，见 core/tools/read.js）。 */
const PATH_RE = /"(path|file_path|filePath|filename|file)"\s*:\s*"((?:[^"\\\n]|\\.){0,4000})"/;

/** PiAstra delegate: one `"role": "…"` per task in `tasks[]` — scanned globally
 *  so the card head can count workers while the JSON is still streaming. */
const ROLE_RE = /"role"\s*:\s*"((?:[^"\\\n]|\\.){0,200})"/g;
/** 搜索类参数（grep / find / glob 的 pattern、query、regex、glob）。 */
const PATTERN_RE = /"(pattern|query|regex|glob|search)"\s*:\s*"((?:[^"\\\n]|\\.){0,4000})"/;
/** bash 命令行的流式早显：JSON 未到齐时也能从半截参数里取到开头。 */
const COMMAND_RE = /"command"\s*:\s*"((?:[^"\\\n]|\\.){0,4000})/;
const TIMEOUT_RE =
	/"(timeout|timeoutSeconds|timeout_seconds|timeoutSec|timeoutMs|timeout_ms|timeoutMilliseconds)"\s*:\s*(-?\d+(?:\.\d+)?)(?![0-9eE.])/;

/** 超过这个值（秒）的 timeout 视为脏数据，不显示。 */
const TIMEOUT_MAX = 1e9;

export interface ToolArgHints {
	/** 文件路径（读/写/编辑类工具），已剥离控制字符并按 VALUE_LIMIT 截断。 */
	path?: string;
	/** 超时提示文本，已带单位（"30s" / "1.5s" / "500ms"）。 */
	timeout?: string;
	/** bash 类工具的命令行（正文终端行用；保留原始换行）。 */
	command?: string;
	/** PiAstra delegate: worker roles in task order (card head summary). */
	roles?: string[];
	/** 搜索类工具的 pattern / query（折叠摘要用）。 */
	pattern?: string;
	/** bash 命令行的早显版本：半截 JSON 也能取到，供折叠摘要在流式期间显示。
	 *  完整可解析后与 command 相同。 */
	commandPreview?: string;
}

/**
 * 从 argumentsText 提取卡头提示。任何异常输入（undefined / 空串 / 非 JSON /
 * 类型不对 / 半截 JSON / 超长）都只是少显示一个提示，绝不抛错。
 */
export function toolArgHints(argsText?: string): ToolArgHints {
	if (!argsText) return {};
	const text = argsText.length > SCAN_LIMIT ? argsText.slice(0, SCAN_LIMIT) : argsText;
	return {
		path: pathHint(text),
		timeout: timeoutHint(text),
		command: commandHint(argsText),
		roles: rolesHint(text),
		pattern: stringHint(text, PATTERN_RE, 2),
		commandPreview: stringHint(text, COMMAND_RE, 1),
	};
}

/** 通用字符串参数提示：解码 JSON 转义、控制字符归一、超长截断；扫不到静默 undefined。 */
function stringHint(text: string, re: RegExp, group: number): string | undefined {
	const m = re.exec(text);
	if (!m) return undefined;
	const cleaned = decodeJsonString(m[group])
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > VALUE_LIMIT ? `${cleaned.slice(0, VALUE_LIMIT - 1)}…` : cleaned;
}

/** Worker roles of a PiAstra delegate call, in order; undefined when none scanned. */
function rolesHint(text: string): string[] | undefined {
	const roles: string[] = [];
	for (const m of text.matchAll(ROLE_RE)) {
		const v = m[1].replace(/[\u0000-\u001f\u007f]/g, "").trim();
		if (v) roles.push(v.length > 40 ? `${v.slice(0, 40)}…` : v);
	}
	return roles.length > 0 ? roles : undefined;
}

/** A PiAstra delegate task as the orchestrator wrote it (card body). */
export interface DelegateTask {
	role: string;
	access?: string;
	task: string;
}

/** Parsed PiAstra delegate tasks. Dirty input (非 JSON / 类型不对) → [], never throws. */
export function parseDelegateTasks(argsText?: string): DelegateTask[] {
	if (!argsText || argsText.length > SCAN_LIMIT) return [];
	try {
		const o = JSON.parse(argsText) as { tasks?: unknown } | null;
		if (!o || typeof o !== "object" || !Array.isArray(o.tasks)) return [];
		return o.tasks.flatMap((t): DelegateTask[] => {
			const rec = t as { role?: unknown; access?: unknown; task?: unknown } | null;
			if (!rec || typeof rec !== "object" || typeof rec.task !== "string") return [];
			return [
				{
					role: typeof rec.role === "string" ? rec.role : "",
					access: typeof rec.access === "string" ? rec.access : undefined,
					task: rec.task,
				},
			];
		});
	} catch {
		return [];
	}
}

/** 卡头显示用的路径压缩：保住文件名所在的尾段，前面用 …/ 省略。 */
export function shortenPath(path: string, max = 56): string {
	if (path.length <= max) return path;
	const parts = path.split(/[\\/]+/).filter(Boolean);
	const last = parts[parts.length - 1];
	if (!last || parts.length <= 1) return `…${path.slice(-(max - 1))}`;
	let out = last;
	for (let i = parts.length - 2; i >= 0; i--) {
		const next = `${parts[i]}/${out}`;
		if (next.length + 2 > max) break;
		out = next;
	}
	return `…/${out}`;
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function pathHint(text: string): string | undefined {
	const m = PATH_RE.exec(text);
	if (!m) return undefined;
	const raw = decodeJsonString(m[2]);
	// 换行/制表等控制字符按空格归一（AI 误把整段说明或多行值填进 path 时）
	const cleaned = raw
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > VALUE_LIMIT ? `${cleaned.slice(0, VALUE_LIMIT - 1)}…` : cleaned;
}

function timeoutHint(text: string): string | undefined {
	const m = TIMEOUT_RE.exec(text);
	if (!m) return undefined;
	const value = Number(m[2]);
	if (!Number.isFinite(value) || value <= 0 || value > TIMEOUT_MAX) return undefined;
	const key = m[1].toLowerCase();
	if (!key.endsWith("ms") && !key.endsWith("milliseconds")) return `${value}s`;
	if (value < 1000) return `${value}ms`;
	return `${Math.round(value / 100) / 10}s`;
}

/** bash 命令行：只有真能 JSON.parse 出 `command` 字符串时才给（保留原始换行）。 */
function commandHint(argsText: string): string | undefined {
	if (argsText.length > SCAN_LIMIT) return undefined;
	try {
		const parsed = JSON.parse(argsText) as { command?: unknown } | null;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return typeof parsed.command === "string" && parsed.command.trim() ? parsed.command : undefined;
	} catch {
		return undefined; // 半截 / 非法 JSON：正文回落 <pre> 原文
	}
}

/** 解码正则抓到的 JSON 字符串内容（\" \\ \n \uXXXX …）；转义不完整时原样返回。 */
function decodeJsonString(raw: string): string {
	try {
		const decoded: unknown = JSON.parse(`"${raw}"`);
		return typeof decoded === "string" ? decoded : raw;
	} catch {
		return raw;
	}
}
