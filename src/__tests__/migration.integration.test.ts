import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { runMigrationAt, needsMigration } from "../migration";
import { HOOK_MARKER } from "../hookScript";

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initCommit(repoAbsPath: string): void {
	git(["init", "-q"], repoAbsPath);
	git(["config", "user.email", "test@example.com"], repoAbsPath);
	git(["config", "user.name", "Test"], repoAbsPath);
	fs.writeFileSync(path.join(repoAbsPath, "README.md"), "fixture\n");
	git(["add", "-A"], repoAbsPath);
	git(["commit", "-q", "-m", "init"], repoAbsPath);
}

/**
 * A vault that looks like a real v1.0.3 install: an old-style
 * `<repo>-git-repo` folder (with a folder note declaring `git_repos`
 * frontmatter - left untouched, unused, but present) and the old static
 * `.gitignore` wildcard line.
 */
function buildPreMigrationVault(): string {
	const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-premigration-"));
	initCommit(vaultRoot);

	const repoFolder = path.join(vaultRoot, "my-project", "my-project-git-repo");
	fs.mkdirSync(repoFolder, { recursive: true });
	initCommit(repoFolder);
	git(["remote", "add", "origin", "https://example.com/user/my-project.git"], repoFolder);

	fs.writeFileSync(
		path.join(vaultRoot, "my-project", "my-project.md"),
		["---", "git_repos:", "  - https://example.com/user/my-project.git", "---", ""].join("\n")
	);

	fs.writeFileSync(path.join(vaultRoot, ".gitignore"), "*-git-repo/\n");

	return vaultRoot;
}

test("needsMigration: true for a fresh pre-migration vault, false once migrated", async (t) => {
	const vaultRoot = buildPreMigrationVault();
	t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));

	assert.strictEqual(needsMigration(vaultRoot), true);
	await runMigrationAt(vaultRoot, []);
	assert.strictEqual(needsMigration(vaultRoot), false);
});

test("runMigrationAt: full migration - registry, .gitignore, and hook all match the fully-migrated state", async (t) => {
	const vaultRoot = buildPreMigrationVault();
	t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));

	const result = await runMigrationAt(vaultRoot, []);

	// (1) The old frontmatter-registered repo is found by the fresh scan, sourced from disk not frontmatter.
	const allPaths = result.entries.flatMap((e) => e.locations.map((l) => l.vaultPath));
	assert.ok(allPaths.includes("my-project/my-project-git-repo"));

	// (2) Hook installed.
	assert.strictEqual(result.hookOutcome, "installed");
	const hookContent = fs.readFileSync(path.join(vaultRoot, ".git", "hooks", "pre-commit"), "utf8");
	assert.ok(hookContent.includes(HOOK_MARKER));

	// (3) Old gitignore line gone.
	assert.strictEqual(result.gitignoreStripped, true);
	const gitignore = fs.readFileSync(path.join(vaultRoot, ".gitignore"), "utf8");
	assert.ok(!gitignore.includes("*-git-repo/"));

	// Old frontmatter is left untouched - unused, harmless.
	const noteContent = fs.readFileSync(path.join(vaultRoot, "my-project", "my-project.md"), "utf8");
	assert.ok(noteContent.includes("git_repos:"));

	// The -git-repo-suffixed folder itself is not renamed.
	assert.ok(fs.existsSync(path.join(vaultRoot, "my-project", "my-project-git-repo")));
});

test("runMigrationAt: a vault where the hook is already installed skips reinstalling, no error", async (t) => {
	const vaultRoot = buildPreMigrationVault();
	t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));

	const first = await runMigrationAt(vaultRoot, []);
	assert.strictEqual(first.hookOutcome, "installed");

	// Manually recreate the pre-migration gitignore line to re-trigger needsMigration, but leave the hook alone.
	fs.writeFileSync(path.join(vaultRoot, ".gitignore"), "*-git-repo/\n");

	const second = await runMigrationAt(vaultRoot, first.entries);
	assert.strictEqual(second.hookOutcome, "already-installed");
	assert.strictEqual(second.gitignoreStripped, true);
});

test("runMigrationAt: a foreign existing hook - gitignore/registry steps still complete, hook step reports the refusal", async (t) => {
	const vaultRoot = buildPreMigrationVault();
	t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));

	const hookPath = path.join(vaultRoot, ".git", "hooks", "pre-commit");
	fs.mkdirSync(path.dirname(hookPath), { recursive: true });
	const foreignContent = "#!/bin/sh\necho 'someone else'\n";
	fs.writeFileSync(hookPath, foreignContent);

	const result = await runMigrationAt(vaultRoot, []);

	assert.strictEqual(result.hookOutcome, "foreign-hook-exists");
	assert.strictEqual(fs.readFileSync(hookPath, "utf8"), foreignContent, "the foreign hook must be untouched");
	// The old gitignore line is deliberately NOT stripped while the hook is blocked - so migration is correctly re-offered.
	assert.strictEqual(result.gitignoreStripped, false);
	assert.strictEqual(needsMigration(vaultRoot), true);

	const allPaths = result.entries.flatMap((e) => e.locations.map((l) => l.vaultPath));
	assert.ok(allPaths.includes("my-project/my-project-git-repo"), "the scan/registry step should still have completed");
});

test("runMigrationAt: a vault with zero previously-registered repos completes cleanly", async (t) => {
	const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-premigration-empty-"));
	t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));
	initCommit(vaultRoot);
	fs.writeFileSync(path.join(vaultRoot, ".gitignore"), "*-git-repo/\n");

	const result = await runMigrationAt(vaultRoot, []);
	assert.deepStrictEqual(result.entries, []);
	assert.strictEqual(result.hookOutcome, "installed");
	assert.strictEqual(result.gitignoreStripped, true);
});

test("runMigrationAt: migrating twice in a row is idempotent", async (t) => {
	const vaultRoot = buildPreMigrationVault();
	t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));

	const first = await runMigrationAt(vaultRoot, []);
	const second = await runMigrationAt(vaultRoot, first.entries);

	assert.strictEqual(second.hookOutcome, "already-installed");
	assert.strictEqual(second.gitignoreStripped, false, "already stripped by the first run - nothing left to do");
	assert.deepStrictEqual(
		second.entries.flatMap((e) => e.locations.map((l) => l.vaultPath)).sort(),
		first.entries.flatMap((e) => e.locations.map((l) => l.vaultPath)).sort()
	);
});

test("runMigrationAt: a .gitignore already manually stripped of the old line is a no-op for that step, no error", async (t) => {
	const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-premigration-clean-"));
	t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));
	initCommit(vaultRoot);
	fs.writeFileSync(path.join(vaultRoot, ".gitignore"), "node_modules/\n");

	const result = await runMigrationAt(vaultRoot, []);
	assert.strictEqual(result.gitignoreStripped, false);
	assert.strictEqual(fs.readFileSync(path.join(vaultRoot, ".gitignore"), "utf8"), "node_modules/\n");
});

test("runMigrationAt: old frontmatter referencing a repo no longer on disk is not preserved - the fresh scan simply doesn't find it", async (t) => {
	const vaultRoot = buildPreMigrationVault();
	t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));

	// Simulate a stale frontmatter registration for a repo that was deleted before ever migrating.
	fs.mkdirSync(path.join(vaultRoot, "gone"), { recursive: true });
	fs.writeFileSync(
		path.join(vaultRoot, "gone", "gone.md"),
		["---", "git_repos:", "  - https://example.com/user/long-gone.git", "---", ""].join("\n")
	);

	const result = await runMigrationAt(vaultRoot, []);
	const allPaths = result.entries.flatMap((e) => e.locations.map((l) => l.vaultPath));
	assert.ok(!allPaths.some((p) => p.includes("gone")), "a stale frontmatter entry with nothing on disk should never appear");
});
