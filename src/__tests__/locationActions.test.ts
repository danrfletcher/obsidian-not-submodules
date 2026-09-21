import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeLocationUiState, validateNewClonePath } from "../locationActions";

const CLEAN = {
	isCloned: true,
	isDirty: false,
	hasStash: false,
	currentBranch: "main",
	stashBranch: null,
	worktreeBroken: false,
};

test("computeLocationUiState: missing location - only Remove is enabled", () => {
	const state = computeLocationUiState({ ...CLEAN, isCloned: false });
	assert.strictEqual(state.removeEnabled, true);
	assert.strictEqual(state.deleteEnabled, false);
	assert.strictEqual(state.branchDropdownEnabled, false);
	assert.strictEqual(state.stashButtonVisible, false);
	assert.strictEqual(state.popStashVisible, false);
});

test("computeLocationUiState: clean location - dropdown enabled, no stash UI, Remove disabled", () => {
	const state = computeLocationUiState(CLEAN);
	assert.strictEqual(state.branchDropdownEnabled, true);
	assert.strictEqual(state.stashButtonVisible, false);
	assert.strictEqual(state.popStashVisible, false);
	assert.strictEqual(state.deleteEnabled, true);
	assert.strictEqual(state.removeEnabled, false);
});

test("computeLocationUiState: dirty location - dropdown greyed out, Stash button visible", () => {
	const state = computeLocationUiState({ ...CLEAN, isDirty: true });
	assert.strictEqual(state.branchDropdownEnabled, false);
	assert.strictEqual(state.stashButtonVisible, true);
	assert.strictEqual(state.popStashVisible, false);
});

test("computeLocationUiState: stashed and back on the stash's branch - Pop Stash enabled, dropdown still blocked (no stacking)", () => {
	const state = computeLocationUiState({
		...CLEAN,
		isDirty: false,
		hasStash: true,
		stashBranch: "main",
		currentBranch: "main",
	});
	assert.strictEqual(state.branchDropdownEnabled, false, "dropdown stays blocked while a stash is outstanding");
	assert.strictEqual(state.stashButtonVisible, false, "no stacking a second stash");
	assert.strictEqual(state.popStashVisible, true);
	assert.strictEqual(state.popStashEnabled, true);
	assert.strictEqual(state.popStashNote, null);
});

test("computeLocationUiState: stashed but on a different branch than the stash came from - Pop Stash disabled with a note", () => {
	const state = computeLocationUiState({
		...CLEAN,
		hasStash: true,
		stashBranch: "main",
		currentBranch: "feature",
	});
	assert.strictEqual(state.popStashVisible, true);
	assert.strictEqual(state.popStashEnabled, false);
	assert.match(state.popStashNote ?? "", /main/);
});

test("computeLocationUiState: a broken worktree offers Repair regardless of clean/dirty/stashed state", () => {
	assert.strictEqual(computeLocationUiState({ ...CLEAN, worktreeBroken: true }).repairVisible, true);
	assert.strictEqual(computeLocationUiState({ ...CLEAN, isDirty: true, worktreeBroken: true }).repairVisible, true);
	assert.strictEqual(
		computeLocationUiState({ ...CLEAN, hasStash: true, stashBranch: "main", worktreeBroken: true }).repairVisible,
		true
	);
});

test("computeLocationUiState: a healthy worktree never offers Repair", () => {
	assert.strictEqual(computeLocationUiState(CLEAN).repairVisible, false);
});

test("validateNewClonePath: a path that doesn't exist yet is accepted", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-pathval-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const result = validateNewClonePath(path.join(dir, "does-not-exist-yet"));
	assert.deepStrictEqual(result, { ok: true });
});

test("validateNewClonePath: an existing empty directory is accepted", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-pathval-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const result = validateNewClonePath(dir);
	assert.deepStrictEqual(result, { ok: true });
});

test("validateNewClonePath: an existing non-empty directory is rejected", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-pathval-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "file.txt"), "x");
	const result = validateNewClonePath(dir);
	assert.strictEqual(result.ok, false);
});

test("validateNewClonePath: an existing plain file at the path is rejected", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-pathval-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const filePath = path.join(dir, "some-file");
	fs.writeFileSync(filePath, "x");
	const result = validateNewClonePath(filePath);
	assert.strictEqual(result.ok, false);
});
