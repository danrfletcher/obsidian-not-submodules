import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasOldGitignoreLine, stripOldGitignoreLine } from "../gitUtils";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-migration-"));
}

test("hasOldGitignoreLine: true when the old wildcard line is present", () => {
	const dir = tmpDir();
	const gitignorePath = path.join(dir, ".gitignore");
	fs.writeFileSync(gitignorePath, "node_modules/\n*-git-repo/\n");
	assert.strictEqual(hasOldGitignoreLine(gitignorePath), true);
});

test("hasOldGitignoreLine: false when absent - never migrated started, or already migrated", () => {
	const dir = tmpDir();
	const gitignorePath = path.join(dir, ".gitignore");
	fs.writeFileSync(gitignorePath, "node_modules/\n");
	assert.strictEqual(hasOldGitignoreLine(gitignorePath), false);
});

test("hasOldGitignoreLine: false, never throws, when .gitignore doesn't exist at all", () => {
	const dir = tmpDir();
	assert.doesNotThrow(() => hasOldGitignoreLine(path.join(dir, ".gitignore")));
	assert.strictEqual(hasOldGitignoreLine(path.join(dir, ".gitignore")), false);
});

test("stripOldGitignoreLine: removes the exact old line, leaves everything else untouched", () => {
	const dir = tmpDir();
	const gitignorePath = path.join(dir, ".gitignore");
	fs.writeFileSync(gitignorePath, "node_modules/\n*-git-repo/\n*.log\n");
	const changed = stripOldGitignoreLine(gitignorePath);
	assert.strictEqual(changed, true);
	const result = fs.readFileSync(gitignorePath, "utf8");
	assert.ok(!result.includes("*-git-repo/"));
	assert.ok(result.includes("node_modules/"));
	assert.ok(result.includes("*.log"));
});

test("stripOldGitignoreLine: a no-op (returns false) when the pattern is already absent", () => {
	const dir = tmpDir();
	const gitignorePath = path.join(dir, ".gitignore");
	const original = "node_modules/\n*.log\n";
	fs.writeFileSync(gitignorePath, original);
	const changed = stripOldGitignoreLine(gitignorePath);
	assert.strictEqual(changed, false);
	assert.strictEqual(fs.readFileSync(gitignorePath, "utf8"), original);
});

test("stripOldGitignoreLine: a no-op, never throws, when .gitignore doesn't exist", () => {
	const dir = tmpDir();
	assert.doesNotThrow(() => stripOldGitignoreLine(path.join(dir, ".gitignore")));
	assert.strictEqual(stripOldGitignoreLine(path.join(dir, ".gitignore")), false);
});

test("stripOldGitignoreLine: a commented-out or embedded occurrence is left alone (only an exact full-line match is stripped)", () => {
	const dir = tmpDir();
	const gitignorePath = path.join(dir, ".gitignore");
	fs.writeFileSync(gitignorePath, "# *-git-repo/ (kept for reference)\n*.log\n");
	const changed = stripOldGitignoreLine(gitignorePath);
	assert.strictEqual(changed, false);
	assert.ok(fs.readFileSync(gitignorePath, "utf8").includes("*-git-repo/"));
});
