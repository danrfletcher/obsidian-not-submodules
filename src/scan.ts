import * as fs from "fs";
import * as path from "path";
import { LocationKind, RepoEntry, RepoLocation, SubmoduleEntry } from "./types";
import { gitRemoteUrl, normalizeOriginUrl } from "./gitUtils";
import { ContinuityResult, matchContinuity, PreviousLocationInfo } from "./registerRepo";

export const ALWAYS_SKIPPED_NAMES = new Set(["node_modules", ".trash", ".space", ".DS_Store", "_to_delete"]);

function toVaultSlashes(p: string): string {
	return p.split(path.sep).join("/");
}

/** Parses a `.gitmodules` file's declared submodule paths. Never throws - a missing or malformed file yields an empty set (best-effort fallback per the PR-2 edge cases). */
export function parseGitmodulesPaths(gitmodulesAbsPath: string): Set<string> {
	const paths = new Set<string>();
	let content: string;
	try {
		content = fs.readFileSync(gitmodulesAbsPath, "utf8");
	} catch {
		return paths;
	}
	try {
		for (const line of content.split(/\r?\n/)) {
			const m = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
			if (m) paths.add(toVaultSlashes(m[1]).replace(/\/+$/, ""));
		}
	} catch (e) {
		console.warn("not-submodules: failed to parse .gitmodules, falling back to file-vs-directory classification only", e);
	}
	return paths;
}

interface RawGitmodulesEntry {
	path: string;
	url: string;
}

/**
 * Parses `.gitmodules`' `[submodule "name"]` sections into path/url pairs,
 * keeping each section's `path` and `url` correlated (unlike
 * `parseGitmodulesPaths`, which only needs the paths). Never throws - a
 * missing or malformed file yields an empty list.
 */
function parseGitmodulesEntries(gitmodulesAbsPath: string): RawGitmodulesEntry[] {
	let content: string;
	try {
		content = fs.readFileSync(gitmodulesAbsPath, "utf8");
	} catch {
		return [];
	}

	const entries: RawGitmodulesEntry[] = [];
	let current: Partial<RawGitmodulesEntry> | null = null;
	try {
		for (const line of content.split(/\r?\n/)) {
			if (/^\s*\[submodule\b/.test(line)) {
				if (current?.path) entries.push({ path: current.path, url: current.url ?? "" });
				current = {};
				continue;
			}
			if (!current) continue;
			const pathMatch = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
			if (pathMatch) {
				current.path = toVaultSlashes(pathMatch[1]).replace(/\/+$/, "");
				continue;
			}
			const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
			if (urlMatch) current.url = urlMatch[1];
		}
		if (current?.path) entries.push({ path: current.path, url: current.url ?? "" });
	} catch (e) {
		console.warn("not-submodules: failed to parse .gitmodules for the submodules section", e);
		return [];
	}
	return entries;
}

/**
 * The read-only Submodules section's data source (PR-5) - driven entirely by
 * `.gitmodules`, not by what the filesystem walk happens to find, so a
 * deinitialized or never-initialized submodule (no working tree on disk)
 * still shows up, correctly flagged rather than silently omitted.
 */
export function scanSubmodules(rootAbsPath: string): SubmoduleEntry[] {
	const declared = parseGitmodulesEntries(path.join(rootAbsPath, ".gitmodules"));
	return declared.map((d) => {
		const gitEntryAbsPath = path.join(rootAbsPath, ...d.path.split("/"), ".git");
		let initialized = false;
		try {
			initialized = fs.existsSync(gitEntryAbsPath);
		} catch {
			initialized = false;
		}
		return { vaultPath: d.path, url: d.url, initialized };
	});
}

/**
 * Classifies a `.git` entry found at `gitEntryAbsPath`. `vaultRelPath` is the
 * vault-relative path of the *location* (the folder the `.git` entry lives
 * directly inside), used to cross-check `.gitmodules`. Never throws -
 * unrecognisable content returns null and the caller excludes it rather than
 * guessing (PR-2 edge case: malformed/unrecognisable `.git` content).
 */
export function classifyGitEntry(
	gitEntryAbsPath: string,
	vaultRelPath: string,
	gitmodulesPaths: Set<string>
): LocationKind | null {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(gitEntryAbsPath);
	} catch {
		return null;
	}

	if (stat.isDirectory()) return "original";
	if (!stat.isFile()) return null;

	if (gitmodulesPaths.has(vaultRelPath)) return "submodule";

	let content: string;
	try {
		content = fs.readFileSync(gitEntryAbsPath, "utf8");
	} catch {
		return null;
	}

	const match = content.match(/^\s*gitdir:\s*(.+?)\s*$/m);
	if (!match) return null;
	const target = toVaultSlashes(match[1]);
	if (target.includes(".git/worktrees/")) return "worktree";
	if (target.includes(".git/modules/")) return "submodule";
	return null;
}

export interface ScannedGitEntry {
	/** Vault-relative path of the folder this `.git` entry lives directly inside. */
	vaultPath: string;
	kind: LocationKind;
}

export interface ScanResult {
	locations: ScannedGitEntry[];
	warnings: string[];
}

/**
 * Walks every folder under `rootAbsPath` looking for nested `.git` entries,
 * however deeply nested (including a repo nested inside another repo).
 * Symlinked directories are never followed, so a symlink cycle can't loop
 * forever. The root itself is never treated as a candidate - only what's
 * nested inside it (the vault root is assumed to be the one real git root,
 * per this plugin's non-goals).
 */
export function walkForGitEntries(rootAbsPath: string, ignoredNames: Set<string> = ALWAYS_SKIPPED_NAMES): ScanResult {
	const gitmodulesPaths = parseGitmodulesPaths(path.join(rootAbsPath, ".gitmodules"));
	const locations: ScannedGitEntry[] = [];
	const warnings: string[] = [];

	const walk = (absDir: string, relDir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(absDir, { withFileTypes: true });
		} catch {
			return;
		}

		if (relDir !== "") {
			const gitEntry = entries.find((e) => e.name === ".git");
			if (gitEntry) {
				const kind = classifyGitEntry(path.join(absDir, gitEntry.name), relDir, gitmodulesPaths);
				if (kind) locations.push({ vaultPath: relDir, kind });
				else warnings.push(`Skipped an unrecognised ".git" entry at "${relDir}".`);
			}
		}

		for (const entry of entries) {
			if (entry.name === ".git") continue;
			if (ignoredNames.has(entry.name)) continue;
			if (entry.isSymbolicLink()) continue; // never follow - avoids an infinite loop on a symlink cycle
			if (!entry.isDirectory()) continue;
			const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
			walk(path.join(absDir, entry.name), childRel);
		}
	};

	walk(rootAbsPath, "");
	locations.sort((a, b) => a.vaultPath.localeCompare(b.vaultPath));
	return { locations, warnings };
}

export interface RawLocation {
	vaultPath: string;
	kind: LocationKind;
	originUrl: string | null;
	isCloned?: boolean;
	continuityKey?: string;
}

function basenameOfVaultPath(vaultPath: string): string {
	const parts = vaultPath.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? vaultPath;
}

function repoDisplayName(originUrl: string | null, vaultPath: string): string {
	if (!originUrl) return basenameOfVaultPath(vaultPath);
	const cleaned = originUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
	const parts = cleaned.split(/[/:]/).filter(Boolean);
	return parts[parts.length - 1] || basenameOfVaultPath(vaultPath);
}

/**
 * Groups locations sharing a normalized origin (Q30) into one repo entry.
 * A location with no resolvable origin is never merged with anything -
 * including another no-origin location - and gets its own single-location
 * entry instead ("not yet trackable" rather than a crash or a wrong guess).
 */
export function groupLocationsByOrigin(raw: RawLocation[]): RepoEntry[] {
	const groups = new Map<string, RepoEntry>();
	const ungrouped: RepoEntry[] = [];

	for (const r of raw) {
		const location: RepoLocation = {
			vaultPath: r.vaultPath,
			kind: r.kind,
			continuityKey: r.continuityKey ?? r.vaultPath,
			isCloned: r.isCloned ?? true,
			isDirty: false,
			hasStash: false,
		};

		const normalized = r.originUrl ? normalizeOriginUrl(r.originUrl) : "";
		if (!normalized) {
			ungrouped.push({
				normalizedOrigin: "",
				originUrl: r.originUrl ?? "",
				repoName: repoDisplayName(r.originUrl, r.vaultPath),
				locations: [location],
			});
			continue;
		}

		let entry = groups.get(normalized);
		if (!entry) {
			entry = {
				normalizedOrigin: normalized,
				originUrl: r.originUrl as string,
				repoName: repoDisplayName(r.originUrl, r.vaultPath),
				locations: [],
			};
			groups.set(normalized, entry);
		}
		entry.locations.push(location);
	}

	return [...groups.values(), ...ungrouped].sort((a, b) => a.repoName.localeCompare(b.repoName));
}

/** Resolves an origin URL for every found location (skips submodules - PR-5 handles those, read-only). */
async function attachOriginUrls(found: ScannedGitEntry[], rootAbsPath: string): Promise<RawLocation[]> {
	const result: RawLocation[] = [];
	for (const entry of found) {
		if (entry.kind === "submodule") continue;
		const absPath = path.join(rootAbsPath, ...entry.vaultPath.split("/"));
		const originUrl = await gitRemoteUrl(absPath);
		result.push({ vaultPath: entry.vaultPath, kind: entry.kind, originUrl });
	}
	return result;
}

function previousLocationsOf(previousRegistry: RepoEntry[]): PreviousLocationInfo[] {
	return previousRegistry.flatMap((entry) =>
		entry.locations.map((loc) => ({
			vaultPath: loc.vaultPath,
			continuityKey: loc.continuityKey,
			kind: loc.kind,
			originUrl: entry.originUrl,
		}))
	);
}

/**
 * The full scan-and-rebuild pipeline, independent of Obsidian's `App` (which
 * is what makes it directly exercisable in an integration test against a
 * real temp-directory fixture, and what keeps this module free of the
 * `obsidian` package - a types-only package with no runtime JS, so it can
 * only ever be imported from code that only ever runs inside Obsidian
 * itself). A previous location that isn't found again by this scan, and
 * wasn't recognised as moved by continuity matching, is carried forward as
 * `isCloned: false` ("missing") rather than silently dropped - PR-4's
 * Delete/Remove flow is what actually clears it out.
 */
export async function buildRegistryFromScan(
	rootAbsPath: string,
	previousRegistry: RepoEntry[],
	ignoredNames?: Set<string>
): Promise<{ entries: RepoEntry[]; warnings: string[]; submodules: SubmoduleEntry[] }> {
	const { locations: found, warnings } = walkForGitEntries(rootAbsPath, ignoredNames);
	const rawFound = await attachOriginUrls(found, rootAbsPath);

	const previousFlat = previousLocationsOf(previousRegistry);
	const { continuityKeys, vanished }: ContinuityResult = matchContinuity(previousFlat, rawFound);

	const combined: RawLocation[] = [
		...rawFound.map((r) => ({ ...r, isCloned: true, continuityKey: continuityKeys.get(r.vaultPath) ?? r.vaultPath })),
		...vanished.map((v) => ({
			vaultPath: v.vaultPath,
			kind: v.kind,
			originUrl: v.originUrl || null,
			isCloned: false,
			continuityKey: v.continuityKey,
		})),
	];

	return { entries: groupLocationsByOrigin(combined), warnings, submodules: scanSubmodules(rootAbsPath) };
}
