export const GITIGNORE_LINE = "*-git-repo/";

/** How a nested `.git` entry was classified during a filesystem scan. */
export type LocationKind = "original" | "worktree" | "submodule";

/**
 * One place in the vault where a repo's working tree lives. A repo can have
 * several locations (multiple clones, or a clone plus its worktrees) - this
 * is the unit the settings panel (PR-4) renders a row for.
 */
export interface RepoLocation {
	/** Vault-relative path of this location's folder. */
	vaultPath: string;
	kind: LocationKind;
	/**
	 * What a rescan matches this location against to recognise it across
	 * drift, rather than treating it as deleted + new (Q28). Primarily the
	 * vault path; PR-2 fills in the leniency logic that falls back to this
	 * when path alone doesn't match.
	 */
	continuityKey: string;
	/** Whether the folder currently exists on disk and contains a .git entry. */
	isCloned: boolean;
	/** Placeholder for PR-4: whether the working tree has uncommitted changes. */
	isDirty: boolean;
	/** Placeholder for PR-4: whether a stash is currently outstanding for this location. */
	hasStash: boolean;
}

/**
 * One tracked repo, grouped by its normalized origin URL (Q30) - every
 * location sharing that origin, however it's named or wherever it lives in
 * the vault, is one entry. `locations` may be empty: a valid transitional
 * state before the first Refresh (PR-2) has populated it, or after every
 * location has been Removed (PR-4).
 */
export interface RepoEntry {
	/** The grouping key - `normalizeOriginUrl(originUrl)`. */
	normalizedOrigin: string;
	/** The origin URL as last seen, unnormalized (for display and git operations). */
	originUrl: string;
	/** Bare repo name derived from the URL, for display purposes. */
	repoName: string;
	locations: RepoLocation[];
}
