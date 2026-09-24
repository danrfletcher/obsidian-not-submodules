import * as path from "path";
import { RepoEntry, SubmoduleEntry } from "./types";
import { hasOldGitignoreLine, stripOldGitignoreLine } from "./gitUtils";
import { buildRegistryFromScan } from "./scan";
import { checkHookStatus, installHook } from "./hookInstall";

/** Whether this vault still shows the one reliable sign of a pre-rebuild (v1.0.3) install. */
export function needsMigration(basePath: string): boolean {
	return hasOldGitignoreLine(path.join(basePath, ".gitignore"));
}

export interface MigrationResult {
	entries: RepoEntry[];
	submodules: SubmoduleEntry[];
	scanWarnings: string[];
	hookOutcome: "already-installed" | "installed" | "reinstalled" | "foreign-hook-exists";
	gitignoreStripped: boolean;
}

/**
 * The one atomic "Migrate now" action (PR-6). Takes a plain vault base path
 * rather than Obsidian's `App` - deliberately independent of the `obsidian`
 * package (a types-only package with no runtime JS outside the app itself),
 * same reasoning as `scan.ts`, and what makes this directly exercisable in
 * an integration test against a real temp-directory fixture. Callers with
 * an `App` resolve the base path via `registry.ts`'s `getBasePath` first.
 *
 * Rescans the vault fresh (no dependency on the old frontmatter - a repo
 * registered the old way is found by the new scan exactly like any other,
 * since naming/frontmatter no longer matter for discovery), installs the
 * hook if it isn't already, and *only then* strips the old gitignore line.
 *
 * That ordering is deliberate, not arbitrary: `needsMigration` uses the old
 * line's presence as its sole, disk-derived signal (no stored "migration
 * complete" flag to go stale). Stripping it last means the line stays put -
 * and migration is correctly re-offered - for as long as any earlier step
 * hasn't actually finished, including a crash mid-migration or a foreign
 * hook blocking installation. Never strip the old (if weaker) protection
 * before the new protection is confirmed in place.
 */
export async function runMigrationAt(rootAbsPath: string, previousRegistry: RepoEntry[]): Promise<MigrationResult> {
	const { entries, warnings, submodules } = await buildRegistryFromScan(rootAbsPath, previousRegistry);

	let hookOutcome: MigrationResult["hookOutcome"];
	if (checkHookStatus(rootAbsPath) === "installed") {
		hookOutcome = "already-installed";
	} else {
		hookOutcome = installHook(rootAbsPath).status;
	}

	const gitignoreStripped =
		hookOutcome === "foreign-hook-exists" ? false : stripOldGitignoreLine(path.join(rootAbsPath, ".gitignore"));

	return { entries, submodules, scanWarnings: warnings, hookOutcome, gitignoreStripped };
}

/** A human-readable summary of a migration run, for a Notice - shared so the popup and the banner report identically. */
export function describeMigrationResult(result: MigrationResult): string {
	const locationCount = result.entries.reduce((sum, e) => sum + e.locations.length, 0);
	const parts = [`Migrated: found ${locationCount} repo location${locationCount === 1 ? "" : "s"}.`];

	if (result.hookOutcome === "foreign-hook-exists") {
		parts.push(
			"A pre-commit hook this plugin didn't install already exists, so the new hook could not be installed - " +
				"resolve it manually, then migrate again to finish."
		);
	} else if (result.hookOutcome === "already-installed") {
		parts.push("Git hook was already installed.");
	} else {
		parts.push("Git hook installed.");
	}

	if (result.hookOutcome !== "foreign-hook-exists") {
		parts.push(result.gitignoreStripped ? "Removed the old ignore rule." : "No old ignore rule to remove.");
	}

	return parts.join(" ");
}
