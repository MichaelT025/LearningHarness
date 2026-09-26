import { describe, expect, it } from "vitest";
import { removeFirstOccurrence } from "../../server/queue-utils.js";

describe("removeFirstOccurrence", () => {
	it("移除唯一匹配项", () => {
		expect(removeFirstOccurrence(["a", "b", "c"], "b")).toEqual(["a", "c"]);
	});

	it("重复文本只移除第一条（✕ 对应一条消息）", () => {
		expect(removeFirstOccurrence(["dup", "x", "dup"], "dup")).toEqual(["x", "dup"]);
		expect(removeFirstOccurrence(["dup", "dup"], "dup")).toEqual(["dup"]);
	});

	it("找不到时原样返回（拷贝，不是同一引用）", () => {
		const list = ["a", "b"];
		const out = removeFirstOccurrence(list, "zzz");
		expect(out).toEqual(["a", "b"]);
		expect(out).not.toBe(list);
	});

	it("空列表与空字符串", () => {
		expect(removeFirstOccurrence([], "a")).toEqual([]);
		expect(removeFirstOccurrence(["", "a"], "")).toEqual(["a"]);
	});

	it("不修改入参", () => {
		const list = ["a", "b", "a"];
		removeFirstOccurrence(list, "a");
		expect(list).toEqual(["a", "b", "a"]);
	});

	it("保持其余项顺序（重新入队依赖原顺序）", () => {
		expect(removeFirstOccurrence(["1", "2", "3", "4"], "3")).toEqual(["1", "2", "4"]);
	});
});
