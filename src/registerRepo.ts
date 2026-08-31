import { App, TFile, TFolder, normalizePath } from "obsidian";
import { GIT_REPO_SUFFIX } from "./types";
import { gitRemoteUrl, hasGitDir, sanitizeGitUrl } from "./gitUtils";
import { getBasePath } from "./registry";

export type RegisterOutcome =
	| { status: "already-registered"; message: string }
	| { status: "appended-existing-note"; message: string }
	| { status: "created-note"; message: string }
	| { status: "created-parent-and-note"; message: string };

function vaultBasename(p: string): string {
	const parts = p.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? "";
}

function vaultDirname(p: string): string {
	const parts = p.split("/").filter(Boolean);
	parts.pop();
	return parts.join("/");
}

async function ensureFrontmatterHasRepo(app: App, noteFile: TFile, url: string): Promise<boolean> {
	let added = false;
	await app.fileManager.processFrontMatter(noteFile, (fm) => {
		if (!Array.isArray(fm.git_repos)) fm.git_repos = [];
		const existing: string[] = fm.git_repos.map(sanitizeGitUrl);
		if (!existing.includes(url)) {
			fm.git_repos.push(url);
			added = true;
		}
	});
	return added;
}

async function getOrCreateNote(app: App, notePath: string): Promise<TFile> {
	const existing = app.vault.getAbstractFileByPath(notePath);
	if (existing instanceof TFile) return existing;
	return app.vault.create(notePath, "");
}

async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(folderPath);
	if (existing instanceof TFolder) return;
	await app.vault.createFolder(folderPath);
}

/**
 * Registers the -git-repo folder at `relFolderPath` (vault-relative) against
 * the folder-note system, following the not-submodules convention:
 *
 *  - Already listed under its parent's folder note -> no-op.
 *  - Parent folder exists (with or without a folder note / git_repos key)
 *    -> append the repo URL to that folder note's frontmatter, creating the
 *       folder note if needed.
 *  - Repo folder sits at the vault root -> create a new sibling folder named
 *    after the repo (minus the -git-repo suffix), move the repo folder
 *    inside it, and create a folder note there declaring the repo.
 */
export async function registerRepoAtPath(app: App, relFolderPath: string): Promise<RegisterOutcome> {
	const normalizedRel = normalizePath(relFolderPath);
	const folder = app.vault.getAbstractFileByPath(normalizedRel);
	if (!(folder instanceof TFolder)) {
		throw new Error(`"${normalizedRel}" is not a folder in this vault.`);
	}

	const folderName = folder.name;
	if (!folderName.endsWith(GIT_REPO_SUFFIX)) {
		throw new Error(`Folder name must end with "${GIT_REPO_SUFFIX}" (got "${folderName}").`);
	}

	const basePath = getBasePath(app);
	if (!basePath) throw new Error("Could not resolve the vault's location on disk.");
	const absPath = `${basePath}/${normalizedRel}`;

	if (!hasGitDir(absPath)) {
		throw new Error(`"${normalizedRel}" is not a git repository (no .git folder found inside it).`);
	}

	const url = await gitRemoteUrl(absPath);
	if (!url) {
		throw new Error(
			`Could not read a remote "origin" URL for "${normalizedRel}". ` +
				`Push it to GitHub first (git remote add origin <url> && git push -u origin main).`
		);
	}

	const baseName = folderName.slice(0, -GIT_REPO_SUFFIX.length);
	const parentPath = vaultDirname(normalizedRel);

	if (parentPath === "") {
		// Case: repo sits at the vault root. Create a dedicated parent folder,
		// move the repo folder inside it, and declare it in a new folder note.
		const newParentPath = normalizePath(baseName);
		await ensureFolderExists(app, newParentPath);

		const newRepoPath = normalizePath(`${newParentPath}/${folderName}`);
		if (newRepoPath !== normalizedRel) {
			await app.vault.rename(folder, newRepoPath);
		}

		const notePath = normalizePath(`${newParentPath}/${baseName}.md`);
		const note = await getOrCreateNote(app, notePath);
		await ensureFrontmatterHasRepo(app, note, url);
		return {
			status: "created-parent-and-note",
			message: `Created "${newParentPath}/", moved the repo inside it, and registered it in ${notePath}.`,
		};
	}

	// Case: repo already has a parent folder.
	const parentFolderName = vaultBasename(parentPath);
	const notePath = normalizePath(`${parentPath}/${parentFolderName}.md`);
	const existingNote = app.vault.getAbstractFileByPath(notePath);

	if (existingNote instanceof TFile) {
		const fm = app.metadataCache.getFileCache(existingNote)?.frontmatter;
		const rawRepos = fm?.git_repos;
		const repos: string[] = Array.isArray(rawRepos) ? rawRepos.map(sanitizeGitUrl) : [];
		if (repos.includes(url)) {
			return { status: "already-registered", message: `${url} is already registered in ${notePath}.` };
		}
		await ensureFrontmatterHasRepo(app, existingNote, url);
		return { status: "appended-existing-note", message: `Added ${url} to ${notePath}.` };
	}

	const note = await getOrCreateNote(app, notePath);
	await ensureFrontmatterHasRepo(app, note, url);
	return { status: "created-note", message: `Created ${notePath} and registered ${url}.` };
}

/** Walks up from `file` to find the nearest ancestor folder whose name ends with -git-repo. */
export function findEnclosingGitRepoFolder(file: TFile): TFolder | null {
	let current: TFolder | null = file.parent;
	while (current) {
		if (current.name.endsWith(GIT_REPO_SUFFIX)) return current;
		current = current.parent;
	}
	return null;
}
