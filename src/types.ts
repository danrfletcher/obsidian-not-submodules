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
	/**
	 * Always `false` in the persisted registry - dirty/stash state goes
	 * stale the moment the user commits or stashes outside a Refresh, so
	 * the settings panel (PR-4) queries it live on render instead of
	 * trusting these fields. Kept on the type for the scan/registry
	 * pipeline's shape, not because anything populates them.
	 */
	isDirty: boolean;
	hasStash: boolean;
}

/**
 * One real, `.gitmodules`-declared submodule - read-only and purely
 * informational (PR-5). Never appears in `RepoEntry`/`RepoLocation` - a
 * submodule's grouping is `.gitmodules` itself, entirely separate from the
 * main registry's origin-based grouping.
 */
export interface SubmoduleEntry {
	/** Vault-relative path exactly as declared in .gitmodules - never corrected or guessed at. */
	vaultPath: string;
	/** The origin URL as declared in .gitmodules. */
	url: string;
	/** Whether the submodule's working tree is actually present on disk (false after `git submodule deinit`, or if never initialized). */
	initialized: boolean;
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
