import { App, TFile, TFolder, normalizePath, FileSystemAdapter } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { GIT_REPO_SUFFIX, RepoEntry, RepoLocation } from "./types";
import { gitRemoteUrl, hasGitDir, normalizeOriginUrl, repoNameFromUrl, sanitizeGitUrl } from "./gitUtils";

/**
 * A "folder note" is a markdown file that lives directly inside the folder
 * it describes and shares that folder's name (the convention used by the
 * folder-notes community plugin with storageLocation "insideFolder").
 */
function isFolderNote(file: TFile): boolean {
	const parent = file.parent;
	if (!parent) return false;
	if (parent.isRoot()) return false; // root folder notes are not supported
	return file.basename === parent.name;
}

function joinVaultPath(parent: string, child: string): string {
	return normalizePath(parent ? `${parent}/${child}` : child);
}

/** Skip folder notes living inside a "staged for deletion" convention folder (e.g. this
 * vault's `_to_delete/`) or Obsidian's own config folder, so leftover content there
 * never reappears in the registry. */
function ignoredPathSegments(app: App): Set<string> {
	return new Set(["_to_delete", ".trash", app.vault.configDir, ".git", ".space"]);
}
function isUnderIgnoredFolder(app: App, vaultPath: string): boolean {
	const ignored = ignoredPathSegments(app);
	return vaultPath.split("/").some((seg) => ignored.has(seg));
}

/** Scan the whole vault for folder notes declaring `git_repos` frontmatter and build the registry. */
export function buildRegistry(app: App): RepoEntry[] {
	const entries: RepoEntry[] = [];
	const seenLocalPaths = new Set<string>();
	const basePath = getBasePath(app);

	for (const file of app.vault.getMarkdownFiles()) {
		if (!isFolderNote(file)) continue;
		if (isUnderIgnoredFolder(app, file.path)) continue;

		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		const repos = fm?.git_repos;
		if (!Array.isArray(repos)) continue;

		const parentFolderPath = file.parent && !file.parent.isRoot() ? file.parent.path : "";

		for (const raw of repos) {
			const url = sanitizeGitUrl(raw);
			if (!url) continue;

			const repoName = repoNameFromUrl(url);
			const folderName = `${repoName}${GIT_REPO_SUFFIX}`;
			const localFolderPath = joinVaultPath(parentFolderPath, folderName);

			if (seenLocalPaths.has(localFolderPath)) continue;
			seenLocalPaths.add(localFolderPath);

			const absPath = basePath ? `${basePath}/${localFolderPath}` : localFolderPath;
			const folderExists = app.vault.getAbstractFileByPath(localFolderPath) instanceof TFolder;
			const isCloned = folderExists && hasGitDir(absPath);

			const location: RepoLocation = {
				vaultPath: localFolderPath,
				kind: "original",
				continuityKey: localFolderPath,
				isCloned,
				isDirty: false,
				hasStash: false,
			};

			entries.push({
				normalizedOrigin: normalizeOriginUrl(url),
				originUrl: url,
				repoName,
				locations: [location],
			});
		}
	}

	entries.sort((a, b) => a.repoName.localeCompare(b.repoName));
	return entries;
}

function fsSkipDirs(app: App): Set<string> {
	return new Set([".git", app.vault.configDir, "node_modules", ".trash", ".space", ".DS_Store", "_to_delete"]);
}

/**
 * All folders anywhere under the vault root whose name ends with -git-repo,
 * found by walking the real filesystem rather than Obsidian's vault index.
 * This matters because Obsidian does not index a folder that contains only
 * hidden dotfiles (e.g. a freshly `git init`'d repo with no other files
 * yet) - it simply doesn't appear as a TFolder, so the vault-tree approach
 * misses it.
 */
export function findAllGitRepoFolders(app: App): string[] {
	const basePath = getBasePath(app);
	if (!basePath) return [];
	const skipDirs = fsSkipDirs(app);
	const results: string[] = [];

	const walk = (absDir: string, relDir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(absDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (skipDirs.has(entry.name)) continue;
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.name.endsWith(GIT_REPO_SUFFIX)) {
				results.push(rel);
				continue; // no need to descend into a repo folder for this purpose
			}
			walk(path.join(absDir, entry.name), rel);
		}
	};

	walk(basePath, "");
	results.sort((a, b) => a.localeCompare(b));
	return results;
}

/**
 * -git-repo folder paths (vault-relative) not yet declared in any folder
 * note's git_repos frontmatter, matched by the folder's ACTUAL git remote
 * URL rather than by a derived-from-URL path guess (a folder's real name
 * doesn't always follow the repoName-git-repo convention exactly, e.g. it
 * was created/renamed by hand).
 */
export async function findUnregisteredGitRepoFolders(app: App): Promise<string[]> {
	const registry = buildRegistry(app);
	const registeredUrls = new Set(registry.map((r) => r.originUrl));
	const basePath = getBasePath(app);
	const candidates = findAllGitRepoFolders(app);
	if (!basePath) return candidates;

	const result: string[] = [];
	for (const rel of candidates) {
		const abs = `${basePath}/${rel}`;
		if (!hasGitDir(abs)) {
			result.push(rel); // not a git repo yet; still a reasonable suggestion
			continue;
		}
		const url = await gitRemoteUrl(abs);
		if (url && registeredUrls.has(url)) continue; // already registered elsewhere under this exact URL
		result.push(rel);
	}
	return result;
}

/** Fast, synchronous approximation of findUnregisteredGitRepoFolders (path-based, no git calls). */
export function findUnregisteredGitRepoFoldersFast(app: App): string[] {
	const registry = buildRegistry(app);
	const registered = new Set(registry.flatMap((r) => r.locations.map((l) => l.vaultPath)));
	return findAllGitRepoFolders(app).filter((p) => !registered.has(p));
}

export function getBasePath(app: App): string | null {
	const adapter = app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
	return null;
}
