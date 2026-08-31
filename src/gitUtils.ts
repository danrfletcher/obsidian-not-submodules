import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFileP = promisify(execFileCb);

export interface GitResult {
	stdout: string;
	stderr: string;
}

/** Run a git command with argv-style args (no shell involved, so no quoting issues). */
export async function runGit(args: string[], cwd: string, timeoutMs = 120000): Promise<GitResult> {
	try {
		const { stdout, stderr } = await execFileP("git", args, {
			cwd,
			maxBuffer: 20 * 1024 * 1024,
			timeout: timeoutMs,
		});
		return { stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" };
	} catch (e: any) {
		const stderr: string = e?.stderr?.toString?.() ?? "";
		const msg = (stderr && stderr.trim()) || e?.message || String(e);
		throw new Error(msg.trim());
	}
}

export async function gitInit(cwd: string): Promise<GitResult> {
	return runGit(["init"], cwd);
}

/** Clones `url` into `targetAbsPath` (which must not already exist). */
export async function gitClone(url: string, targetAbsPath: string): Promise<GitResult> {
	const parent = path.dirname(targetAbsPath);
	return runGit(["clone", "--", url, targetAbsPath], parent);
}

export async function gitPull(cwd: string): Promise<GitResult> {
	return runGit(["pull"], cwd);
}

export async function gitPush(cwd: string): Promise<GitResult> {
	return runGit(["push"], cwd);
}

export async function gitRemoteUrl(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await runGit(["remote", "get-url", "origin"], cwd);
		const url = stdout.trim();
		return url || null;
	} catch {
		return null;
	}
}

export function hasGitDir(absPath: string): boolean {
	try {
		return fs.existsSync(path.join(absPath, ".git"));
	} catch {
		return false;
	}
}

export function repoNameFromUrl(url: string): string {
	const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
	const parts = cleaned.split(/[\/:]/).filter(Boolean);
	return parts[parts.length - 1] || "repo";
}

/**
 * Cleans up a git URL as typed/pasted by hand into frontmatter: trims
 * whitespace and strips stray trailing commas/semicolons - an easy typo
 * when hand-editing a YAML list (e.g. carrying over comma habits from
 * JSON), which would otherwise silently break folder-path matching for
 * that entry (the derived folder name would include the stray punctuation
 * and never match the real -git-repo folder on disk).
 */
export function sanitizeGitUrl(raw: unknown): string {
	return String(raw ?? "")
		.trim()
		.replace(/[,;]+$/, "")
		.trim();
}
