export const GIT_REPO_SUFFIX = "-git-repo";
export const GITIGNORE_LINE = "*-git-repo/";

/** One registered nested git repo, resolved against the vault it lives in. */
export interface RepoEntry {
	/** The repo's remote origin URL, as declared in a folder note's frontmatter. */
	url: string;
	/** The bare repo name derived from the URL (e.g. "my-repo"). */
	repoName: string;
	/** repoName + GIT_REPO_SUFFIX (e.g. "my-repo-git-repo") - the folder's expected name. */
	folderName: string;
	/** Vault-relative path of the folder note's parent folder ("" for the vault root). */
	parentFolderPath: string;
	/** Vault-relative path of the repo's local folder. */
	localFolderPath: string;
	/** Vault-relative path of the folder note declaring this repo. */
	folderNotePath: string;
	/** Whether the folder exists locally and contains a .git directory. */
	isCloned: boolean;
}
