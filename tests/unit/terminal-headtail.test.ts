import { describe, expect, it } from "vitest";
import { applyHeadTail } from "../../server/terminals.js";

describe("applyHeadTail", () => {
	it("omission notes are English", () => {
		expect(applyHeadTail("a\nb\nc", undefined, 1)).toBe("…[2 lines omitted above]…\nc");
		expect(applyHeadTail("a\nb\nc", 1, undefined)).toBe("a\n…[2 lines omitted below]…");
	});

	it("head + tail together: the note line is not re-truncated", () => {
		expect(applyHeadTail("a\nb\nc\nd\ne", 3, 2)).toBe("…[1 lines omitted above]…\nb\nc\n…[2 lines omitted below]…");
	});
});
