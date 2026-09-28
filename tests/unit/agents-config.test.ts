/**
 * agents-config unit tests: per-role model defaults (config/agents.json).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsConfigPath, parseRoleModel, roleModel } from "../../server/agents-config.js";

describe("parseRoleModel", () => {
	it("splits provider/model and keeps a known thinking level", () => {
		expect(parseRoleModel({ tutor: { model: "opencode-go/deepseek-v4.1-flash", thinking: "low" } }, "tutor")).toEqual({
			provider: "opencode-go",
			modelId: "deepseek-v4.1-flash",
			thinking: "low",
		});
	});

	it("treats null or unknown thinking as 'leave the default'", () => {
		expect(parseRoleModel({ tutor: { model: "a/b", thinking: null } }, "tutor")?.thinking).toBeUndefined();
		expect(parseRoleModel({ tutor: { model: "a/b", thinking: "ultra" } }, "tutor")?.thinking).toBeUndefined();
	});

	it("keeps slashes inside the model id", () => {
		expect(parseRoleModel({ tutor: { model: "openrouter/z-ai/glm-5.3" } }, "tutor")).toMatchObject({
			provider: "openrouter",
			modelId: "z-ai/glm-5.3",
		});
	});

	it("rejects missing roles and malformed models", () => {
		expect(parseRoleModel({}, "tutor")).toBeUndefined();
		expect(parseRoleModel(null, "tutor")).toBeUndefined();
		expect(parseRoleModel({ tutor: { model: "no-slash" } }, "tutor")).toBeUndefined();
		expect(parseRoleModel({ tutor: { model: "/x" } }, "tutor")).toBeUndefined();
		expect(parseRoleModel({ tutor: { model: "x/" } }, "tutor")).toBeUndefined();
		expect(parseRoleModel({ tutor: "a/b" }, "tutor")).toBeUndefined();
	});
});

describe("roleModel", () => {
	it("reads the shipped config: the tutor defaults to a cheap model", () => {
		expect(roleModel("tutor", agentsConfigPath())).toEqual({
			provider: "opencode-go",
			modelId: "deepseek-v4.1-flash",
			thinking: undefined,
		});
	});

	it("returns undefined for a missing or broken file", () => {
		const dir = mkdtempSync(join(tmpdir(), "agents-config-"));
		try {
			expect(roleModel("tutor", join(dir, "missing.json"))).toBeUndefined();
			writeFileSync(join(dir, "bad.json"), "{ nope");
			expect(roleModel("tutor", join(dir, "bad.json"))).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
