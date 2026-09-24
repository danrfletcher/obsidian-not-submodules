import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildRegistryFromScan } from "../scan";
import { RepoEntry } from "../types";

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
 * Builds a fixture tree with one original+worktree pair (with a resolvable
 * origin), one no-origin repo, and one repo containing a real submodule -
 * all local, no network. Returns the vault root (the subtree that should be
 * scanned - the submodule's own "remote" source repo is deliberately a
 * sibling of it, outside the scanned subtree).
 */
function buildFixtureVault(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-scan-"));
	const vaultRoot = path.join(root, "vault");
	fs.mkdirSync(vaultRoot);

	const remoteForSubmodule = path.join(root, "remote-for-submodule");
	fs.mkdirSync(remoteForSubmodule);
	initCommit(remoteForSubmodule);

	const original = path.join(vaultRoot, "libs", "original-repo");
	fs.mkdirSync(original, { recursive: true });
	initCommit(original);
	git(["remote", "add", "origin", "https://example.com/user/original-repo.git"], original);
	git(["worktree", "add", path.join(vaultRoot, "libs", "worktree-of-original"), "-b", "wt-branch"], original);

	const noOrigin = path.join(vaultRoot, "scratch", "no-origin-repo");
	fs.mkdirSync(noOrigin, { recursive: true });
	git(["init", "-q"], noOrigin);

	const submoduleHost = path.join(vaultRoot, "submodule-host");
	fs.mkdirSync(submoduleHost, { recursive: true });
	initCommit(submoduleHost);
	git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", remoteForSubmodule, "nested-sub"], submoduleHost);

	return vaultRoot;
}

function allLocationPaths(entries: RepoEntry[]): string[] {
	return entries
		.flatMap((e) => e.locations.map((l) => l.vaultPath))
		.sort();
}

test("buildRegistryFromScan: finds original, worktree and no-origin repos, excludes the submodule", async (t) => {
	const vaultRoot = buildFixtureVault();
	t.after(() => fs.rmSync(path.dirname(vaultRoot), { recursive: true, force: true }));

	const { entries, warnings } = await buildRegistryFromScan(vaultRoot, []);
	assert.deepStrictEqual(warnings, []);

	assert.deepStrictEqual(
		allLocationPaths(entries),
		["libs/original-repo", "libs/worktree-of-original", "scratch/no-origin-repo", "submodule-host"].sort()
	);

	const original = entries.find((e) => e.locations.some((l) => l.vaultPath === "libs/original-repo"));
	assert.ok(original, "original clone should be present");
	assert.strictEqual(original!.locations.length, 2, "original + its worktree should be grouped together");
	assert.ok(original!.locations.some((l) => l.kind === "original"));
	assert.ok(original!.locations.some((l) => l.kind === "worktree"));

	const noOrigin = entries.find((e) => e.locations.some((l) => l.vaultPath === "scratch/no-origin-repo"));
	assert.ok(noOrigin, "no-origin repo should still appear, just not grouped by origin");
	assert.strictEqual(noOrigin!.normalizedOrigin, "");
});

test("buildRegistryFromScan: rescanning an unchanged vault twice is idempotent", async (t) => {
	const vaultRoot = buildFixtureVault();
	t.after(() => fs.rmSync(path.dirname(vaultRoot), { recursive: true, force: true }));

	const first = await buildRegistryFromScan(vaultRoot, []);
	const second = await buildRegistryFromScan(vaultRoot, first.entries);

	const shape = (entries: RepoEntry[]) =>
		entries
			.map((e) => ({
				normalizedOrigin: e.normalizedOrigin,
				locations: [...e.locations]
					.map((l) => ({ vaultPath: l.vaultPath, kind: l.kind, continuityKey: l.continuityKey, isCloned: l.isCloned }))
					.sort((a, b) => a.vaultPath.localeCompare(b.vaultPath)),
			}))
			.sort((a, b) => a.normalizedOrigin.localeCompare(b.normalizedOrigin));

	assert.deepStrictEqual(shape(second.entries), shape(first.entries));
});

test("buildRegistryFromScan: an empty vault scans cleanly to an empty registry", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-empty-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const { entries, warnings } = await buildRegistryFromScan(root, []);
	assert.deepStrictEqual(entries, []);
	assert.deepStrictEqual(warnings, []);
});

test("buildRegistryFromScan: a location moved to a new parent folder (same name) is recognised as moved, not deleted + new", async (t) => {
	const vaultRoot = buildFixtureVault();
	t.after(() => fs.rmSync(path.dirname(vaultRoot), { recursive: true, force: true }));

	const first = await buildRegistryFromScan(vaultRoot, []);

	const oldAbsPath = path.join(vaultRoot, "scratch", "no-origin-repo");
	const newParent = path.join(vaultRoot, "archive");
	fs.mkdirSync(newParent);
	fs.renameSync(oldAbsPath, path.join(newParent, "no-origin-repo"));

	const second = await buildRegistryFromScan(vaultRoot, first.entries);

	const before = first.entries.flatMap((e) => e.locations).find((l) => l.vaultPath === "scratch/no-origin-repo");
	const after = second.entries.flatMap((e) => e.locations).find((l) => l.vaultPath === "archive/no-origin-repo");
	assert.ok(before);
	assert.ok(after);
	assert.strictEqual(after!.continuityKey, before!.continuityKey, "moved location should keep its identity");
	assert.strictEqual(after!.isCloned, true);

	const stillListedAsOldPath = second.entries
		.flatMap((e) => e.locations)
		.some((l) => l.vaultPath === "scratch/no-origin-repo");
	assert.strictEqual(stillListedAsOldPath, false, "the old path shouldn't linger as a separate missing entry");
});
