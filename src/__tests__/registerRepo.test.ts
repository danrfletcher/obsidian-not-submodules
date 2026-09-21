import { test } from "node:test";
import assert from "node:assert";
import { matchContinuity, PreviousLocationInfo, CurrentLocationInfo } from "../registerRepo";

test("matchContinuity: an exact path match short-circuits origin/name comparison entirely", () => {
	const previous: PreviousLocationInfo[] = [
		{ vaultPath: "repo", continuityKey: "stable-id-1", kind: "original", originUrl: "https://github.com/user/repo.git" },
	];
	// Origin AND name both differ from what's on record - should not matter, path matched.
	const current: CurrentLocationInfo[] = [{ vaultPath: "repo", originUrl: "https://github.com/user/renamed-elsewhere.git" }];
	const result = matchContinuity(previous, current);
	assert.strictEqual(result.continuityKeys.get("repo"), "stable-id-1");
	assert.strictEqual(result.vanished.length, 0);
});

test("matchContinuity: single vanished + single new with a matching folder name is recognised as moved", () => {
	const previous: PreviousLocationInfo[] = [
		{ vaultPath: "old/parent/my-repo", continuityKey: "stable-id-1", kind: "original", originUrl: "https://github.com/user/repo.git" },
	];
	const current: CurrentLocationInfo[] = [{ vaultPath: "new/parent/my-repo", originUrl: "https://github.com/user/repo-totally-different.git" }];
	const result = matchContinuity(previous, current);
	assert.strictEqual(result.continuityKeys.get("new/parent/my-repo"), "stable-id-1");
	assert.strictEqual(result.vanished.length, 0);
});

test("matchContinuity: single vanished + single new with only a matching origin is recognised as moved", () => {
	const previous: PreviousLocationInfo[] = [
		{ vaultPath: "old-name", continuityKey: "stable-id-1", kind: "original", originUrl: "https://github.com/user/repo.git" },
	];
	const current: CurrentLocationInfo[] = [{ vaultPath: "new-name", originUrl: "git@github.com:user/repo.git" }];
	const result = matchContinuity(previous, current);
	assert.strictEqual(result.continuityKeys.get("new-name"), "stable-id-1");
	assert.strictEqual(result.vanished.length, 0);
});

test("matchContinuity: multiple vanished candidates fall back to treating everything as new", () => {
	const previous: PreviousLocationInfo[] = [
		{ vaultPath: "old-a", continuityKey: "id-a", kind: "original", originUrl: "https://github.com/user/repo.git" },
		{ vaultPath: "old-b", continuityKey: "id-b", kind: "original", originUrl: "https://github.com/user/other.git" },
	];
	const current: CurrentLocationInfo[] = [{ vaultPath: "new-a", originUrl: "https://github.com/user/repo.git" }];
	const result = matchContinuity(previous, current);
	// Ambiguous (two vanished candidates) - the new location gets a fresh identity, not a guessed one.
	assert.strictEqual(result.continuityKeys.get("new-a"), "new-a");
	assert.strictEqual(result.vanished.length, 2);
});

test("matchContinuity: multiple new candidates fall back to treating everything as new", () => {
	const previous: PreviousLocationInfo[] = [
		{ vaultPath: "old-a", continuityKey: "id-a", kind: "original", originUrl: "https://github.com/user/repo.git" },
	];
	const current: CurrentLocationInfo[] = [
		{ vaultPath: "new-a", originUrl: "https://github.com/user/repo.git" },
		{ vaultPath: "new-b", originUrl: null },
	];
	const result = matchContinuity(previous, current);
	assert.strictEqual(result.continuityKeys.get("new-a"), "new-a");
	assert.strictEqual(result.continuityKeys.get("new-b"), "new-b");
	assert.strictEqual(result.vanished.length, 1);
	assert.strictEqual(result.vanished[0].vaultPath, "old-a");
});

test("matchContinuity: a location present in both scans with no matching counterpart elsewhere is simply unchanged", () => {
	const previous: PreviousLocationInfo[] = [
		{ vaultPath: "a", continuityKey: "id-a", kind: "original", originUrl: "https://github.com/user/a.git" },
		{ vaultPath: "b", continuityKey: "id-b", kind: "original", originUrl: "https://github.com/user/b.git" },
	];
	const current: CurrentLocationInfo[] = [
		{ vaultPath: "a", originUrl: "https://github.com/user/a.git" },
		{ vaultPath: "b", originUrl: "https://github.com/user/b.git" },
	];
	const result = matchContinuity(previous, current);
	assert.strictEqual(result.continuityKeys.get("a"), "id-a");
	assert.strictEqual(result.continuityKeys.get("b"), "id-b");
	assert.strictEqual(result.vanished.length, 0);
});
