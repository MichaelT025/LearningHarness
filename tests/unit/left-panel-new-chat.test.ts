/** Top New Chat cwd routing: stay in the topic root when active cwd is a topic. */
import { describe, expect, it } from "vitest";
import { newChatCwd } from "../../web/src/components/left-panel-nav.js";
import type { TopicSummary } from "../../web/src/types.js";

function topic(over: Partial<TopicSummary> = {}): TopicSummary {
	return { id: "t1", title: "Algebra", goal: "", createdAt: 1, cwd: "/topics/algebra", ...over };
}

describe("newChatCwd", () => {
	it("returns the active cwd when it matches a topic workspace", () => {
		expect(newChatCwd("/topics/algebra", [topic()])).toBe("/topics/algebra");
	});
	it("preserves projectless behavior (null) for non-topic cwd", () => {
		expect(newChatCwd("/home/user/proj", [topic()])).toBeNull();
	});
	it("returns null with no topics or empty cwd", () => {
		expect(newChatCwd("/home/user/proj", [])).toBeNull();
		expect(newChatCwd("", [topic()])).toBeNull();
	});
	it("matches Windows case variants of the same topic cwd", () => {
		expect(newChatCwd("C:\\Topics\\Algebra", [topic({ cwd: "c:\\topics\\algebra" })])).toBe(
			"C:\\Topics\\Algebra",
		);
	});
});
