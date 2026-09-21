import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFileP = promisify(execFileCb);

export interface GitResult {
	stdout: string;
	stderr: string;
}

interface ExecFileError extends Error {
	stderr?: unknown;
}

function toExecFileError(e: unknown): ExecFileError {
	return e instanceof Error ? (e as ExecFileError) : new Error(String(e));
}

/** Stringifies a Buffer/string/anything without referencing the Buffer type directly. */
function stringifyMaybeBuffer(v: unknown): string {
	if (typeof v === "string") return v;
	if (v == null) return "";
	if (typeof v === "object" && "toString" in v && typeof (v as { toString: unknown }).toString === "function") {
		return String(v);
	}
	return "";
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
	} catch (e: unknown) {
		const err = toExecFileError(e);
		const stderrText = stringifyMaybeBuffer(err.stderr);
		const msg = (stderrText && stderrText.trim()) || err.message || String(e);
		throw new Error(msg.trim());
	}
}

export async function gitInit(cwd: string): Promise<GitResult> {
	return runGit(["init"], cwd);
}

/** Clones `url` into `targetAbsPath` (which must not already exist). Creates any missing parent folders first. */
export async function gitClone(url: string, targetAbsPath: string): Promise<GitResult> {
	const parent = path.dirname(targetAbsPath);
	fs.mkdirSync(parent, { recursive: true });
	return runGit(["clone", "--", url, targetAbsPath], parent);
}

export async function gitPull(cwd: string): Promise<GitResult> {
	return runGit(["pull"], cwd);
}

export async function gitPush(cwd: string): Promise<GitResult> {
	return runGit(["push"], cwd);
}

/** Whether `cwd`'s working tree has any uncommitted changes (tracked or untracked). */
export async function gitIsDirty(cwd: string): Promise<boolean> {
	const { stdout } = await runGit(["status", "--porcelain"], cwd);
	return stdout.trim().length > 0;
}

export async function gitCurrentBranch(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
		const branch = stdout.trim();
		return branch && branch !== "HEAD" ? branch : null;
	} catch {
		return null;
	}
}

export interface BranchList {
	local: string[];
	remote: string[];
}

/** Local branch names, and remote branch names (as `<remote>/<branch>`) that have no matching local branch. */
export async function gitListBranches(cwd: string): Promise<BranchList> {
	const [localOut, remoteOut] = await Promise.all([
		runGit(["branch", "--format=%(refname:short)"], cwd),
		runGit(["branch", "-r", "--format=%(refname:short)"], cwd),
	]);
	const local = localOut.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
	const localSet = new Set(local);
	const remote = remoteOut.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)
		// A remote's HEAD symref shows up in --format=%(refname:short) as just
		// the bare remote name (e.g. "origin", not "origin/HEAD") - filter out
		// anything with no "<remote>/<branch>" shape, not just a literal "/HEAD" suffix.
		.filter((r) => r.includes("/"))
		.filter((r) => !r.endsWith("/HEAD"))
		.filter((r) => !localSet.has(r.slice(r.indexOf("/") + 1)));
	return { local, remote };
}

/** Switches to an already-local branch immediately. */
export async function gitCheckoutLocalBranch(cwd: string, branch: string): Promise<GitResult> {
	return runGit(["checkout", branch], cwd);
}

/** Fetches and switches to a remote-only branch (e.g. "origin/feature"), creating a local tracking branch. */
export async function gitCheckoutRemoteBranch(cwd: string, remoteRef: string): Promise<GitResult> {
	const slashIdx = remoteRef.indexOf("/");
	if (slashIdx === -1) throw new Error(`Not a remote branch reference: "${remoteRef}".`);
	const remote = remoteRef.slice(0, slashIdx);
	const branch = remoteRef.slice(slashIdx + 1);
	await runGit(["fetch", remote, branch], cwd);
	return runGit(["checkout", "-B", branch, "--track", remoteRef], cwd);
}

export interface StashStatus {
	hasStash: boolean;
	/** The branch the top stash entry was created from, if determinable. */
	branch: string | null;
}

/** Whether a stash is outstanding, and which branch it was made from ("WIP on <branch>: ..." / "On <branch>: ..."). */
export async function gitStashStatus(cwd: string): Promise<StashStatus> {
	const { stdout } = await runGit(["stash", "list"], cwd);
	const firstLine = stdout.split("\n").find((l) => l.trim().length > 0);
	if (!firstLine) return { hasStash: false, branch: null };
	const match = firstLine.match(/(?:WIP on|On) ([^:]+):/);
	return { hasStash: true, branch: match ? match[1].trim() : null };
}

/** Stashes both tracked and untracked changes - a "dirty working tree" means either, and the user expects both stashed. */
export async function gitStashPush(cwd: string): Promise<GitResult> {
	return runGit(["stash", "push", "--include-untracked"], cwd);
}

export async function gitStashPop(cwd: string): Promise<GitResult> {
	return runGit(["stash", "pop"], cwd);
}

/** Removes a worktree via git (not a raw folder delete), so the main repo's worktree bookkeeping doesn't go stale. */
export async function gitWorktreeRemove(mainRepoCwd: string, worktreeAbsPath: string): Promise<GitResult> {
	return runGit(["worktree", "remove", "--force", worktreeAbsPath], mainRepoCwd);
}

/** Re-points a worktree's bookkeeping after its folder was moved outside `git worktree move`. */
export async function gitWorktreeRepair(mainRepoCwd: string, worktreeAbsPath: string): Promise<GitResult> {
	return runGit(["worktree", "repair", worktreeAbsPath], mainRepoCwd);
}

export interface WorktreeInfo {
	path: string;
	branch: string | null;
	/** True when git's own bookkeeping can no longer find this worktree's folder (a stale pointer). */
	broken: boolean;
}

/** Lists every worktree git knows about for the repo at `mainRepoCwd`, including whether each is broken. */
export async function gitWorktreeList(mainRepoCwd: string): Promise<WorktreeInfo[]> {
	const { stdout } = await runGit(["worktree", "list", "--porcelain"], mainRepoCwd);
	const entries: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null, broken: !!current.broken });
			current = { path: line.slice("worktree ".length).trim(), branch: null, broken: false };
		} else if (line.startsWith("branch ")) {
			if (current) current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
		} else if (line.startsWith("prunable")) {
			if (current) current.broken = true;
		}
	}
	if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null, broken: !!current.broken });
	return entries;
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
	const parts = cleaned.split(/[/:]/).filter(Boolean);
	return parts[parts.length - 1] || "repo";
}

/**
 * Normalizes a git origin URL so that SSH and HTTPS forms of the same
 * host+path compare equal (Q30) - used both for grouping locations into one
 * repo entry and for continuity matching across an origin spelling change.
 *
 * Handles: scheme-form URLs (https://, ssh://, git://, ...), SCP-like SSH
 * syntax (git@host:path), embedded credentials (user[:pass]@host), a
 * trailing ".git", and host case. Never throws - empty or unparseable input
 * produces a stable (possibly empty) string the caller can treat as falsy.
 */
export function normalizeOriginUrl(url: string): string {
	if (typeof url !== "string") return "";
	const trimmed = url.trim();
	if (!trimmed) return "";

	const schemeMatch = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.*)$/);
	let rest: string;
	if (schemeMatch) {
		rest = schemeMatch[1];
	} else {
		// SCP-like syntax: [user@]host:path (e.g. git@github.com:user/repo.git).
		const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
		rest = scpMatch ? `${scpMatch[1]}/${scpMatch[2]}` : trimmed;
	}

	// Strip embedded credentials (user or user:pass before an "@").
	rest = rest.replace(/^[^@/\s]+@/, "");

	const slashIdx = rest.indexOf("/");
	const rawHost = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
	const rawPath = slashIdx === -1 ? "" : rest.slice(slashIdx + 1);

	const host = rawHost.trim().toLowerCase();
	const pathPart = rawPath
		.trim()
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");

	if (!host && !pathPart) return "";
	if (host && pathPart) return `${host}/${pathPart}`;
	return host || pathPart;
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
