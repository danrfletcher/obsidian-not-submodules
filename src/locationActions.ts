import * as fs from "fs";
import { LocationKind, RepoEntry } from "./types";
import { gitWorktreeRemove } from "./gitUtils";

export interface LocationUiStateInput {
	/** Whether the location's files currently exist on disk. */
	isCloned: boolean;
	isDirty: boolean;
	hasStash: boolean;
	currentBranch: string | null;
	/** The branch the outstanding stash was created from, if `hasStash`. */
	stashBranch: string | null;
	/** Only meaningful for a worktree location - whether git's own bookkeeping has gone stale. */
	worktreeBroken: boolean;
}

export interface LocationUiState {
	branchDropdownEnabled: boolean;
	stashButtonVisible: boolean;
	popStashVisible: boolean;
	popStashEnabled: boolean;
	/** Set when Pop Stash is visible but disabled, naming the branch to switch back to. */
	popStashNote: string | null;
	deleteEnabled: boolean;
	removeEnabled: boolean;
	repairVisible: boolean;
}

/**
 * Encodes every button/dropdown enablement rule for a single location row,
 * as a pure function of its state - independently unit-testable without a
 * live git repo or the Obsidian UI.
 */
export function computeLocationUiState(input: LocationUiStateInput): LocationUiState {
	if (!input.isCloned) {
		return {
			branchDropdownEnabled: false,
			stashButtonVisible: false,
			popStashVisible: false,
			popStashEnabled: false,
			popStashNote: null,
			deleteEnabled: false,
			removeEnabled: true,
			repairVisible: false,
		};
	}

	const repairVisible = input.worktreeBroken;

	if (input.hasStash) {
		const onStashBranch = !!input.stashBranch && input.currentBranch === input.stashBranch;
		return {
			branchDropdownEnabled: false,
			stashButtonVisible: false,
			popStashVisible: true,
			popStashEnabled: onStashBranch,
			popStashNote: onStashBranch ? null : `Switch back to "${input.stashBranch ?? "?"}" to pop this stash.`,
			deleteEnabled: true,
			removeEnabled: false,
			repairVisible,
		};
	}

	if (input.isDirty) {
		return {
			branchDropdownEnabled: false,
			stashButtonVisible: true,
			popStashVisible: false,
			popStashEnabled: false,
			popStashNote: null,
			deleteEnabled: true,
			removeEnabled: false,
			repairVisible,
		};
	}

	return {
		branchDropdownEnabled: true,
		stashButtonVisible: false,
		popStashVisible: false,
		popStashEnabled: false,
		popStashNote: null,
		deleteEnabled: true,
		removeEnabled: false,
		repairVisible,
	};
}

export type NewClonePathValidation = { ok: true } | { ok: false; reason: string };

/** Validates a vault path chosen for "New" (cloning the origin again) - rejects an existing, non-empty path. */
export function validateNewClonePath(absPath: string): NewClonePathValidation {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absPath);
	} catch {
		return { ok: true };
	}
	if (!stat.isDirectory()) {
		return { ok: false, reason: "A file already exists at that path." };
	}
	if (fs.readdirSync(absPath).length > 0) {
		return { ok: false, reason: "That folder already exists and isn't empty." };
	}
	return { ok: true };
}

/**
 * Delete never unregisters a location - it stays listed as "missing" until
 * Remove is used. An Original gets a plain folder delete; a Worktree goes
 * through `git worktree remove` so the main repo's bookkeeping doesn't go
 * stale (a raw `rm -rf` on a worktree folder leaves a dangling entry in
 * `git worktree list`).
 */
export async function deleteLocation(kind: LocationKind, absPath: string, mainRepoAbsPath: string | null): Promise<void> {
	if (kind === "worktree") {
		if (!mainRepoAbsPath) {
			throw new Error("Can't remove this worktree - its main repo location isn't available.");
		}
		await gitWorktreeRemove(mainRepoAbsPath, absPath);
	}
	if (fs.existsSync(absPath)) {
		fs.rmSync(absPath, { recursive: true, force: true });
	}
}

/**
 * Remove unregisters one location from the registry. A repo entry left with
 * zero locations (across both sections) disappears entirely, matching what
 * the next Refresh would produce anyway.
 */
export function removeLocationFromRegistry(entries: RepoEntry[], normalizedOrigin: string, vaultPath: string): RepoEntry[] {
	return entries
		.map((e) =>
			e.normalizedOrigin === normalizedOrigin
				? { ...e, locations: e.locations.filter((l) => l.vaultPath !== vaultPath) }
				: e
		)
		.filter((e) => e.locations.length > 0);
}
