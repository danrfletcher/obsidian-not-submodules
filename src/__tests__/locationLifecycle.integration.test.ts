import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
	gitClone,
	gitCurrentBranch,
	gitIsDirty,
	gitListBranches,
	gitStashPush,
	gitStashPop,
	gitStashStatus,
	gitWorktreeList,
	gitWorktreeRemove,
	gitWorktreeRepair,
} from "../gitUtils";
import { computeLocationUiState, deleteLocation, removeLocationFromRegistry } from "../locationActions";
import { RepoEntry } from "../types";

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeRemote(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-lifecycle-remote-"));
	git(["init", "-q"], dir);
	git(["config", "user.email", "test@example.com"], dir);
	git(["config", "user.name", "Test"], dir);
	fs.writeFileSync(path.join(dir, "README.md"), "remote\n");
	git(["add", "-A"], dir);
	git(["commit", "-q", "-m", "init"], dir);
	return dir;
}

test("full lifecycle: clone -> dirty -> stash -> branch switch -> pop -> delete -> remove -> entry disappears", async (t) => {
	const remote = makeRemote();
	t.after(() => fs.rmSync(remote, { recursive: true, force: true }));

	const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-lifecycle-vault-"));
	t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));
	const clonePath = path.join(vaultRoot, "libs", "new-location");

	// Step 1: "New" - clone the origin again at a user-picked path.
	await gitClone(remote, clonePath);
	assert.ok(fs.existsSync(path.join(clonePath, "README.md")));

	// Step 2: dirty edit.
	fs.writeFileSync(path.join(clonePath, "scratch.txt"), "work in progress\n");
	assert.strictEqual(await gitIsDirty(clonePath), true);
	let ui = computeLocationUiState({
		isCloned: true,
		isDirty: true,
		hasStash: false,
		currentBranch: await gitCurrentBranch(clonePath),
		stashBranch: null,
		worktreeBroken: false,
	});
	assert.strictEqual(ui.stashButtonVisible, true);
	assert.strictEqual(ui.branchDropdownEnabled, false);

	const originalBranch = await gitCurrentBranch(clonePath);
	assert.ok(originalBranch);

	// Step 3: Stash.
	await gitStashPush(clonePath);
	assert.strictEqual(await gitIsDirty(clonePath), false);
	let stashStatus = await gitStashStatus(clonePath);
	assert.strictEqual(stashStatus.hasStash, true);
	assert.strictEqual(stashStatus.branch, originalBranch);

	ui = computeLocationUiState({
		isCloned: true,
		isDirty: false,
		hasStash: true,
		currentBranch: await gitCurrentBranch(clonePath),
		stashBranch: stashStatus.branch,
		worktreeBroken: false,
	});
	assert.strictEqual(ui.popStashEnabled, true, "should be enabled - still on the branch the stash came from");

	// Step 4: switch to a different branch - Pop Stash should become disabled (blocked).
	git(["checkout", "-b", "a-different-branch"], clonePath);
	ui = computeLocationUiState({
		isCloned: true,
		isDirty: false,
		hasStash: true,
		currentBranch: await gitCurrentBranch(clonePath),
		stashBranch: stashStatus.branch,
		worktreeBroken: false,
	});
	assert.strictEqual(ui.popStashEnabled, false, "blocked - not on the branch the stash came from");
	assert.match(ui.popStashNote ?? "", new RegExp(originalBranch!));

	// Step 5: switch back - Pop Stash re-enabled.
	git(["checkout", originalBranch!], clonePath);
	ui = computeLocationUiState({
		isCloned: true,
		isDirty: false,
		hasStash: true,
		currentBranch: await gitCurrentBranch(clonePath),
		stashBranch: stashStatus.branch,
		worktreeBroken: false,
	});
	assert.strictEqual(ui.popStashEnabled, true);

	// Step 6: Pop Stash.
	await gitStashPop(clonePath);
	stashStatus = await gitStashStatus(clonePath);
	assert.strictEqual(stashStatus.hasStash, false);
	assert.strictEqual(await gitIsDirty(clonePath), true, "the popped change should be back as a dirty working tree");

	// Step 7: Delete (Original -> plain folder delete).
	await deleteLocation("original", clonePath, null);
	assert.strictEqual(fs.existsSync(clonePath), false);

	// Step 8: Remove - unregisters the location; the entry disappears once it's the only one.
	const before: RepoEntry[] = [
		{
			normalizedOrigin: "example.com/lifecycle-repo",
			originUrl: "https://example.com/lifecycle-repo.git",
			repoName: "lifecycle-repo",
			locations: [
				{
					vaultPath: "libs/new-location",
					kind: "original",
					continuityKey: "libs/new-location",
					isCloned: false,
					isDirty: false,
					hasStash: false,
				},
			],
		},
	];
	const after = removeLocationFromRegistry(before, "example.com/lifecycle-repo", "libs/new-location");
	assert.deepStrictEqual(after, []);
});

test("Delete dispatches the correct git operation: Original is a plain folder delete, Worktree goes through git worktree remove", async (t) => {
	const main = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-lifecycle-main-"));
	t.after(() => fs.rmSync(main, { recursive: true, force: true }));
	git(["init", "-q"], main);
	git(["config", "user.email", "test@example.com"], main);
	git(["config", "user.name", "Test"], main);
	fs.writeFileSync(path.join(main, "README.md"), "x\n");
	git(["add", "-A"], main);
	git(["commit", "-q", "-m", "init"], main);

	const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-lifecycle-wtparent-")));
	t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
	const worktreePath = path.join(parent, "a-worktree");
	git(["worktree", "add", worktreePath, "-b", "wt-branch"], main);

	const before = await gitWorktreeList(main);
	assert.ok(before.some((w) => w.path === worktreePath), "sanity check: worktree should be registered before delete");

	await deleteLocation("worktree", worktreePath, main);
	assert.strictEqual(fs.existsSync(worktreePath), false, "worktree folder should be gone");

	const worktrees = await gitWorktreeList(main);
	assert.ok(
		!worktrees.some((w) => w.path === worktreePath),
		"the main repo's worktree bookkeeping should no longer reference it"
	);
});

test("Worktree repair: git worktree repair restores a worktree whose folder was moved outside git worktree move", async (t) => {
	const main = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-lifecycle-repair-"));
	t.after(() => fs.rmSync(main, { recursive: true, force: true }));
	git(["init", "-q"], main);
	git(["config", "user.email", "test@example.com"], main);
	git(["config", "user.name", "Test"], main);
	fs.writeFileSync(path.join(main, "README.md"), "x\n");
	git(["add", "-A"], main);
	git(["commit", "-q", "-m", "init"], main);

	// Resolve symlinks (e.g. macOS's /var -> /private/var) up front, since
	// git itself reports fully-resolved paths in its porcelain output.
	const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-lifecycle-repairparent-")));
	t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
	const oldWorktreePath = path.join(parent, "worktree-old-spot");
	git(["worktree", "add", oldWorktreePath, "-b", "wt-branch"], main);

	const newWorktreePath = path.join(parent, "worktree-new-spot");
	fs.renameSync(oldWorktreePath, newWorktreePath);

	let worktrees = await gitWorktreeList(main);
	const brokenEntry = worktrees.find((w) => w.path === oldWorktreePath);
	assert.ok(brokenEntry?.broken, "moving the folder outside git worktree move should leave a stale pointer");

	await gitWorktreeRepair(main, newWorktreePath);

	worktrees = await gitWorktreeList(main);
	const repaired = worktrees.find((w) => w.path === newWorktreePath);
	assert.ok(repaired, "the worktree should now be tracked at its new path");
	assert.strictEqual(repaired?.broken, false, "no longer broken after repair");

	// Confirm it's actually usable - a git command inside it should succeed.
	assert.doesNotThrow(() => git(["status"], newWorktreePath));
});

test("gitListBranches: a remote's HEAD symref never appears as a checkout target, only real remote-only branches do", async (t) => {
	const remote = makeRemote();
	t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
	git(["branch", "feature-branch"], remote);

	const clonePath = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-branchlist-"));
	fs.rmSync(clonePath, { recursive: true, force: true });
	t.after(() => fs.rmSync(clonePath, { recursive: true, force: true }));
	await gitClone(remote, clonePath);

	const { local, remote: remoteBranches } = await gitListBranches(clonePath);
	assert.ok(local.length > 0, "sanity check: the checked-out branch should be local");
	assert.ok(!remoteBranches.includes("origin"), "origin/HEAD's bare short-form must never appear as a branch option");
	assert.ok(remoteBranches.includes("origin/feature-branch"));
	// The remote branch matching the already-checked-out local branch shouldn't be offered twice.
	for (const r of remoteBranches) {
		assert.ok(r.includes("/"), `every remote branch entry should have a <remote>/<branch> shape: "${r}"`);
	}
});

test("Worktree repair: fails gracefully with a clear error when the main repo itself is missing", async (t) => {
	const main = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-lifecycle-repair2-"));
	fs.rmSync(main, { recursive: true, force: true }); // the main repo never actually exists

	await assert.rejects(() => gitWorktreeRepair(main, "/tmp/does-not-matter"));
});
