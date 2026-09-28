/**
 * note-card unit tests: note_write call → card data.
 */
import { describe, expect, it } from "vitest";
import { noteCardData } from "../../web/src/note-card.js";

describe("noteCardData", () => {
	it("prefers the finished result's details", () => {
		const details = {
			kind: "note",
			title: "Closures",
			slug: "closures",
			path: "notes/closures.md",
			content: "# Closures",
			created: false,
		};
		expect(noteCardData('{"title":"Old","content":"old"}', details)).toEqual({
			title: "Closures",
			content: "# Closures",
			path: "notes/closures.md",
			created: false,
		});
	});

	it("falls back to complete call arguments while the call runs", () => {
		expect(noteCardData('{"title":"Closures","content":"# Closures"}', undefined)).toEqual({
			title: "Closures",
			content: "# Closures",
		});
	});

	it("returns null for partial or unusable input", () => {
		expect(noteCardData('{"title":"Clos', undefined)).toBeNull();
		expect(noteCardData('{"title":"x"}', undefined)).toBeNull();
		expect(noteCardData(undefined, { kind: "other", title: "x", content: "y" })).toBeNull();
		expect(noteCardData(undefined, undefined)).toBeNull();
	});
});
