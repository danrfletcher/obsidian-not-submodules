import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyGitEntry, parseGitmodulesPaths, groupLocationsByOrigin, walkForGitEntries, RawLocation } from "../scan";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-registry-"));
}

test("classifyGitEntry: a directory .git is an original clone", () => {
	const dir = tmpDir();
	const gitPath = path.join(dir, ".git");
	fs.mkdirSync(gitPath);
	assert.strictEqual(classifyGitEntry(gitPath, "repo", new Set()), "original");
});

test("classifyGitEntry: a file .git pointing under .git/worktrees/<name> is a worktree", () => {
	const dir = tmpDir();
	const gitPath = path.join(dir, ".git");
	fs.writeFileSync(gitPath, "gitdir: /elsewhere/main/.git/worktrees/my-worktree\n");
	assert.strictEqual(classifyGitEntry(gitPath, "repo", new Set()), "worktree");
});

test("classifyGitEntry: a file .git pointing under .git/modules/<name> is a submodule", () => {
	const dir = tmpDir();
	const gitPath = path.join(dir, ".git");
	fs.writeFileSync(gitPath, "gitdir: ../.git/modules/my-sub\n");
	assert.strictEqual(classifyGitEntry(gitPath, "repo", new Set()), "submodule");
});

test("classifyGitEntry: a path listed in .gitmodules is a submodule even without reading its content", () => {
	const dir = tmpDir();
	const gitPath = path.join(dir, ".git");
	fs.writeFileSync(gitPath, "garbage that isn't a gitdir line at all");
	assert.strictEqual(classifyGitEntry(gitPath, "vendor/sub", new Set(["vendor/sub"])), "submodule");
});

test("classifyGitEntry: malformed/unrecognisable .git file content is excluded, not guessed at", () => {
	const dir = tmpDir();
	const gitPath = path.join(dir, ".git");
	fs.writeFileSync(gitPath, "garbage that isn't a gitdir line at all");
	assert.strictEqual(classifyGitEntry(gitPath, "repo", new Set()), null);
});

test("classifyGitEntry: a nonexistent path never throws and returns null", () => {
	assert.doesNotThrow(() => classifyGitEntry("/does/not/exist/.git", "repo", new Set()));
	assert.strictEqual(classifyGitEntry("/does/not/exist/.git", "repo", new Set()), null);
});

test("parseGitmodulesPaths: extracts every declared submodule path", () => {
	const dir = tmpDir();
	const gitmodulesPath = path.join(dir, ".gitmodules");
	fs.writeFileSync(
		gitmodulesPath,
		[
			'[submodule "foo"]',
			"\tpath = foo",
			"\turl = https://example.com/foo.git",
			'[submodule "bar-baz"]',
			"\tpath = bar/baz",
			"\turl = ../local/bar",
			"",
		].join("\n")
	);
	const paths = parseGitmodulesPaths(gitmodulesPath);
	assert.deepStrictEqual([...paths].sort(), ["bar/baz", "foo"]);
});

test("parseGitmodulesPaths: a missing file yields an empty set, never throws", () => {
	assert.doesNotThrow(() => parseGitmodulesPaths("/does/not/exist/.gitmodules"));
	assert.strictEqual(parseGitmodulesPaths("/does/not/exist/.gitmodules").size, 0);
});

test("parseGitmodulesPaths: malformed content yields an empty set, never throws", () => {
	const dir = tmpDir();
	const gitmodulesPath = path.join(dir, ".gitmodules");
	fs.writeFileSync(gitmodulesPath, "\0\0\0not even close to ini format{{{");
	assert.doesNotThrow(() => parseGitmodulesPaths(gitmodulesPath));
});

test("groupLocationsByOrigin: locations sharing a normalized origin group into one entry", () => {
	const raw: RawLocation[] = [
		{ vaultPath: "a", kind: "original", originUrl: "https://github.com/user/repo.git" },
		{ vaultPath: "a-worktree", kind: "worktree", originUrl: "git@github.com:user/repo.git" },
	];
	const entries = groupLocationsByOrigin(raw);
	assert.strictEqual(entries.length, 1);
	assert.strictEqual(entries[0].locations.length, 2);
});

test("groupLocationsByOrigin: locations with different origins never merge", () => {
	const raw: RawLocation[] = [
		{ vaultPath: "a", kind: "original", originUrl: "https://github.com/user/repo-a.git" },
		{ vaultPath: "b", kind: "original", originUrl: "https://github.com/user/repo-b.git" },
	];
	const entries = groupLocationsByOrigin(raw);
	assert.strictEqual(entries.length, 2);
});

test("groupLocationsByOrigin: no-origin locations are excluded from grouping, each gets its own entry", () => {
	const raw: RawLocation[] = [
		{ vaultPath: "same-name", kind: "original", originUrl: null },
		{ vaultPath: "elsewhere/same-name", kind: "original", originUrl: null },
	];
	const entries = groupLocationsByOrigin(raw);
	assert.strictEqual(entries.length, 2);
	for (const entry of entries) {
		assert.strictEqual(entry.normalizedOrigin, "");
		assert.strictEqual(entry.locations.length, 1);
	}
});

test("groupLocationsByOrigin: two unrelated repos sharing a folder name at different paths are not merged", () => {
	const raw: RawLocation[] = [
		{ vaultPath: "libs/widgets", kind: "original", originUrl: "https://github.com/org-a/widgets.git" },
		{ vaultPath: "vendor/widgets", kind: "original", originUrl: "https://github.com/org-b/widgets.git" },
	];
	const entries = groupLocationsByOrigin(raw);
	assert.strictEqual(entries.length, 2);
});

test("walkForGitEntries: a repo nested inside another repo is discovered independently, without double-counting", () => {
	const root = tmpDir();
	fs.mkdirSync(path.join(root, "outer", ".git"), { recursive: true });
	fs.mkdirSync(path.join(root, "outer", "inner", ".git"), { recursive: true });

	const { locations, warnings } = walkForGitEntries(root);
	assert.deepStrictEqual(warnings, []);
	assert.deepStrictEqual(
		locations.map((l) => l.vaultPath).sort(),
		["outer", "outer/inner"]
	);
});

test("walkForGitEntries: a symlinked directory is never followed, so a symlink cycle can't loop forever", () => {
	const root = tmpDir();
	fs.mkdirSync(path.join(root, "real", ".git"), { recursive: true });
	// A symlink back to the root itself - if followed, this would recurse forever.
	fs.symlinkSync(root, path.join(root, "real", "loop-back"), "dir");

	const { locations } = walkForGitEntries(root);
	assert.deepStrictEqual(locations.map((l) => l.vaultPath), ["real"]);
});
