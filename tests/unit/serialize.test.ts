import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { serializeMessage, stripTransientRetryErrors, type AgentMessage } from "../../server/serialize.js";

function assistantError(id: string): UiMessage {
	return { id, role: "assistant", content: [], stopReason: "error", errorMessage: "500 overloaded" };
}

function assistantText(id: string): UiMessage {
	return { id, role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" };
}

function userText(id: string): UiMessage {
	return { id, role: "user", content: [{ type: "text", text: "q" }] };
}

describe("stripTransientRetryErrors", () => {
	it("未重试时原样返回（同一引用）", () => {
		const msgs = [userText("u"), assistantError("a")];
		expect(stripTransientRetryErrors(msgs, false)).toBe(msgs);
	});

	it("重试中去掉末尾连续的 error 气泡", () => {
		const msgs = [userText("u"), assistantText("a1"), assistantError("a2"), assistantError("a3")];
		const out = stripTransientRetryErrors(msgs, true);
		expect(out.map((m) => m.id)).toEqual(["u", "a1"]);
	});

	it("末尾不是 error 时不动", () => {
		const msgs = [assistantError("a1"), assistantText("a2")];
		const out = stripTransientRetryErrors(msgs, true);
		expect(out).toBe(msgs);
	});

	it("user/tool 消息截断剥离", () => {
		const tool: UiMessage = {
			id: "t-x",
			role: "toolResult",
			content: [{ type: "text", text: "boom" }],
			toolCallId: "x",
			isError: true,
		};
		const msgs = [assistantError("a1"), tool];
		expect(stripTransientRetryErrors(msgs, true)).toBe(msgs);
	});

	it("空数组安全", () => {
		expect(stripTransientRetryErrors([], true)).toEqual([]);
	});
});

describe("serializeMessage", () => {
	it("hides Pi transcript system messages from the UI", () => {
		const system = {
			role: "system",
			content: "You are a coding assistant.",
			toolsAdded: [],
			timestamp: 1,
		} as unknown as AgentMessage;
		expect(serializeMessage(system, 0)).toBeNull();
	});
});
