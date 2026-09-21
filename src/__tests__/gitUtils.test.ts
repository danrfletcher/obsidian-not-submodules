import { test } from "node:test";
import assert from "node:assert";
import { normalizeOriginUrl } from "../gitUtils.ts";

test("normalizeOriginUrl: SSH and HTTPS forms of the same repo are equal", () => {
	assert.strictEqual(
		normalizeOriginUrl("git@github.com:user/repo.git"),
		normalizeOriginUrl("https://github.com/user/repo.git")
	);
});

test("normalizeOriginUrl: HTTPS with and without a trailing .git are equal", () => {
	assert.strictEqual(
		normalizeOriginUrl("https://github.com/user/repo.git"),
		normalizeOriginUrl("https://github.com/user/repo")
	);
});

test("normalizeOriginUrl: host case differences are ignored", () => {
	assert.strictEqual(
		normalizeOriginUrl("https://GitHub.com/user/repo.git"),
		normalizeOriginUrl("https://github.com/user/repo.git")
	);
});

test("normalizeOriginUrl: embedded credentials are stripped before comparison", () => {
	assert.strictEqual(
		normalizeOriginUrl("https://token@github.com/user/repo.git"),
		normalizeOriginUrl("https://github.com/user/repo.git")
	);
	assert.strictEqual(
		normalizeOriginUrl("https://user:pass@github.com/user/repo.git"),
		normalizeOriginUrl("https://github.com/user/repo.git")
	);
});

test("normalizeOriginUrl: empty and malformed input never throws and stays falsy-safe", () => {
	assert.strictEqual(normalizeOriginUrl(""), "");
	assert.strictEqual(normalizeOriginUrl("   "), "");
	assert.doesNotThrow(() => normalizeOriginUrl("not a url at all"));
	assert.doesNotThrow(() => normalizeOriginUrl(undefined as unknown as string));
	assert.doesNotThrow(() => normalizeOriginUrl(null as unknown as string));
	assert.strictEqual(normalizeOriginUrl(undefined as unknown as string), "");
	assert.strictEqual(normalizeOriginUrl(null as unknown as string), "");
});

test("normalizeOriginUrl: ssh:// URI form matches the equivalent SCP-like form", () => {
	assert.strictEqual(
		normalizeOriginUrl("ssh://git@github.com/user/repo.git"),
		normalizeOriginUrl("git@github.com:user/repo.git")
	);
});

test("normalizeOriginUrl: different repos never normalize to the same value", () => {
	assert.notStrictEqual(
		normalizeOriginUrl("https://github.com/user/repo-a.git"),
		normalizeOriginUrl("https://github.com/user/repo-b.git")
	);
});
