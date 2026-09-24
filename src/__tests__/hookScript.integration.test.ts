import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { PRE_COMMIT_HOOK_SCRIPT } from "../hookScript";

// Prefer dash - the strictest common /bin/sh - so a POSIX-ism slip gets caught
// here rather than only in a container. Falls back to whatever /bin/sh is.
const SH = (() => {
	try {
		execFileSync("dash", ["-c", "true"]);
		return "dash";
	} catch {
		return "sh";
	}
})();

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

function installHookScript(repoRoot: string): string {
	const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
	fs.mkdirSync(path.dirname(hookPath), { recursive: true });
	fs.writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });
	return hookPath;
}

function runHook(hookPath: string, cwd: string): { status: number; stderr: string } {
	const result = spawnSync(SH, [hookPath], { cwd, encoding: "utf8" });
	return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

function readGitignore(repoRoot: string): string {
	try {
		return fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
	} catch {
		return "";
	}
}

test("hook script: syntax-checks cleanly under dash/sh", () => {
	const tmp = path.join(os.tmpdir(), `not-submodules-hook-syntax-${Date.now()}.sh`);
	fs.writeFileSync(tmp, PRE_COMMIT_HOOK_SCRIPT);
	assert.doesNotThrow(() => execFileSync(SH, ["-n", tmp]));
	fs.rmSync(tmp);
});

test("hook script: zero nested repos produces no managed block and exits 0", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);
	const hookPath = installHookScript(root);

	const result = runHook(hookPath, root);
	assert.strictEqual(result.status, 0);
	assert.strictEqual(readGitignore(root), "");
});

test("hook script: classifies original + worktree + no-origin, excludes submodule, path-anchors every line", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);

	const remoteForSubmodule = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-remote-"));
	t.after(() => fs.rmSync(remoteForSubmodule, { recursive: true, force: true }));
	initCommit(remoteForSubmodule);

	const original = path.join(root, "libs", "original-repo");
	fs.mkdirSync(original, { recursive: true });
	initCommit(original);
	git(["remote", "add", "origin", "https://example.com/user/original-repo.git"], original);
	git(["worktree", "add", path.join(root, "libs", "worktree-of-original"), "-b", "wt"], original);

	const noOrigin = path.join(root, "scratch", "no-origin-repo");
	fs.mkdirSync(noOrigin, { recursive: true });
	git(["init", "-q"], noOrigin);

	const submoduleHost = path.join(root, "submodule-host");
	fs.mkdirSync(submoduleHost, { recursive: true });
	initCommit(submoduleHost);
	git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", remoteForSubmodule, "nested-sub"], submoduleHost);

	const hookPath = installHookScript(root);
	const result = runHook(hookPath, root);
	assert.strictEqual(result.status, 0, result.stderr);

	const gitignore = readGitignore(root);
	assert.ok(gitignore.includes("/libs/original-repo/"));
	assert.ok(gitignore.includes("/libs/worktree-of-original/"));
	assert.ok(!gitignore.includes("scratch/no-origin-repo"), "no-origin repo should never be ignored");
	assert.ok(!gitignore.includes("nested-sub"), "a real submodule must never be ignored");
});

test("hook script: two locations sharing a folder name at different paths get distinct, correct lines", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);

	for (const parent of ["same-name-a", "same-name-b"]) {
		const p = path.join(root, parent, "widgets");
		fs.mkdirSync(p, { recursive: true });
		git(["init", "-q"], p);
		git(["remote", "add", "origin", `https://example.com/${parent}/widgets.git`], p);
	}

	const hookPath = installHookScript(root);
	runHook(hookPath, root);
	const gitignore = readGitignore(root);
	assert.ok(gitignore.includes("/same-name-a/widgets/"));
	assert.ok(gitignore.includes("/same-name-b/widgets/"));
});

test("hook script: a previously-tracked file in a newly-ignored path is untracked but stays on disk", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);

	const nested = path.join(root, "vendor", "plain-then-repo");
	fs.mkdirSync(nested, { recursive: true });
	fs.writeFileSync(path.join(nested, "data.txt"), "plain content\n");
	git(["add", "-A"], root);
	git(["commit", "-q", "-m", "commit plain files"], root);
	assert.ok(
		execFileSync("git", ["ls-files", "vendor/plain-then-repo"], { cwd: root }).toString().length > 0,
		"sanity check: should be tracked before the hook ever runs"
	);

	git(["init", "-q"], nested);
	git(["remote", "add", "origin", "https://example.com/user/plain-then-repo.git"], nested);

	const hookPath = installHookScript(root);
	const result = runHook(hookPath, root);
	assert.strictEqual(result.status, 0, result.stderr);

	const tracked = execFileSync("git", ["ls-files", "vendor/plain-then-repo"], { cwd: root }).toString();
	assert.strictEqual(tracked, "", "should be untracked from the index");
	assert.ok(fs.existsSync(path.join(nested, "data.txt")), "file must remain on disk");
});

test("hook script: a moved location's stale line is dropped and the new one added, with no leftover", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);

	const original = path.join(root, "vendor", "movable-repo");
	fs.mkdirSync(original, { recursive: true });
	git(["init", "-q"], original);
	git(["remote", "add", "origin", "https://example.com/user/movable-repo.git"], original);

	const hookPath = installHookScript(root);
	runHook(hookPath, root);
	assert.ok(readGitignore(root).includes("/vendor/movable-repo/"));

	const newParent = path.join(root, "vendor2");
	fs.mkdirSync(newParent);
	fs.renameSync(original, path.join(newParent, "movable-repo"));

	runHook(hookPath, root);
	const gitignore = readGitignore(root);
	assert.ok(gitignore.includes("/vendor2/movable-repo/"));
	assert.ok(!gitignore.includes("/vendor/movable-repo/"), "the stale line for the old path must be gone");
});

test("hook script: a full add-move-remove sequence keeps .gitignore in sync at every step", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);
	const hookPath = installHookScript(root);

	// Step 1: add a nested repo.
	const original = path.join(root, "vendor", "sequence-repo");
	fs.mkdirSync(original, { recursive: true });
	git(["init", "-q"], original);
	git(["remote", "add", "origin", "https://example.com/user/sequence-repo.git"], original);
	runHook(hookPath, root);
	assert.ok(readGitignore(root).includes("/vendor/sequence-repo/"), "step 1: added repo should be ignored");

	// Step 2: move it.
	const movedParent = path.join(root, "vendor2");
	fs.mkdirSync(movedParent);
	fs.renameSync(original, path.join(movedParent, "sequence-repo"));
	runHook(hookPath, root);
	let gitignore = readGitignore(root);
	assert.ok(gitignore.includes("/vendor2/sequence-repo/"), "step 2: moved repo's new path should be ignored");
	assert.ok(!gitignore.includes("/vendor/sequence-repo/"), "step 2: old path should be gone");

	// Step 3: remove it entirely.
	fs.rmSync(path.join(movedParent, "sequence-repo"), { recursive: true, force: true });
	runHook(hookPath, root);
	gitignore = readGitignore(root);
	assert.ok(!gitignore.includes("sequence-repo"), "step 3: removed repo should no longer appear anywhere");
});

test("hook script: existing unrelated .gitignore content survives regeneration untouched", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);
	fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n*.log\n");

	const nested = path.join(root, "libs", "some-repo");
	fs.mkdirSync(nested, { recursive: true });
	git(["init", "-q"], nested);
	git(["remote", "add", "origin", "https://example.com/user/some-repo.git"], nested);

	const hookPath = installHookScript(root);
	runHook(hookPath, root);

	const gitignore = readGitignore(root);
	assert.ok(gitignore.startsWith("node_modules/\n*.log\n"));
	assert.ok(gitignore.includes("/libs/some-repo/"));
});

test("hook script: a manually corrupted managed block is fully overwritten on the next run", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);

	const nested = path.join(root, "libs", "some-repo");
	fs.mkdirSync(nested, { recursive: true });
	git(["init", "-q"], nested);
	git(["remote", "add", "origin", "https://example.com/user/some-repo.git"], nested);

	const hookPath = installHookScript(root);
	runHook(hookPath, root);

	const corrupted = readGitignore(root).replace("/libs/some-repo/", "/some-hand-edited-nonsense/");
	fs.writeFileSync(path.join(root, ".gitignore"), corrupted);

	runHook(hookPath, root);
	const gitignore = readGitignore(root);
	assert.ok(gitignore.includes("/libs/some-repo/"));
	assert.ok(!gitignore.includes("/some-hand-edited-nonsense/"));
});

test("hook script: an internal scan error is caught, warned to stderr, and never blocks the commit", { skip: process.platform === "win32" }, (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	const noPerm = path.join(root, "noperm");
	// Restore permissions before the recursive rm cleanup runs, or it can't read into noPerm to delete it.
	t.after(() => fs.chmodSync(noPerm, 0o755));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);

	fs.mkdirSync(path.join(noPerm, "sub"), { recursive: true });
	fs.chmodSync(noPerm, 0o000);

	const hookPath = installHookScript(root);
	const result = runHook(hookPath, root);
	assert.strictEqual(result.status, 0, "the hook must never block the commit");
	assert.match(result.stderr, /pre-commit hook failed internally/);
});

test("hook script: completes quickly with 50+ nested repos", { timeout: 15000 }, (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hook-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	initCommit(root);

	for (let i = 0; i < 55; i++) {
		const p = path.join(root, "many", `repo-${i}`);
		fs.mkdirSync(p, { recursive: true });
		git(["init", "-q"], p);
		git(["remote", "add", "origin", `https://example.com/repo-${i}.git`], p);
	}

	const hookPath = installHookScript(root);
	const start = Date.now();
	const result = runHook(hookPath, root);
	const elapsedMs = Date.now() - start;

	assert.strictEqual(result.status, 0, result.stderr);
	assert.ok(elapsedMs < 10000, `expected well under 10s, took ${elapsedMs}ms`);
	const gitignore = readGitignore(root);
	assert.strictEqual((gitignore.match(/^\/many\/repo-/gm) ?? []).length, 55);
});
